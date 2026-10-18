import type { Server as HttpServer } from 'node:http';
import { parseCookie } from 'cookie';
import type pg from 'pg';
import type { Logger } from 'pino';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import type { RateLimit } from '../limits.js';
import { findSession, SESSION_COOKIE } from '../sessions.js';
import type { GroupSignal, PgListener } from './listener.js';

export const SOCKET_PATH = '/api/socket.io';

/** Activity types after which a group's room membership must be recomputed. */
const MEMBERSHIP_TYPES = new Set([
  'group.created', 'member.joined', 'member.rejoined', 'member.claimed', 'member.merged', 'member.left', 'member.removed',
  'member.deleted_account',
]);

export type ServerToClient = {
  /** Something changed in the group; fetch activity after your last seen seq over REST. */
  'group:changed': (signal: { groupId: string; seq: number }) => void;
  /** Signals may have been lost (server-side gap): sync every group. */
  resync: () => void;
  /** Rooms are joined; send `sync` now. */
  ready: (info: { groups: string[] }) => void;
};
/** The only inbound event: what the client has already seen, per group. */
export type ClientToServer = { sync: (lastSeen: Record<string, number>) => void };
type SocketData = { userId: string; sessionId: string };
type HisaabSocket = Socket<ClientToServer, ServerToClient, Record<string, never>, SocketData>;

const syncPayload = z.record(z.uuid(), z.number().int().min(0)).refine((o) => Object.keys(o).length <= 500);

const groupRoom = (groupId: string) => `group:${groupId}`;
const userRoom = (userId: string) => `user:${userId}`;
const sessionRoom = (sessionId: string) => `session:${sessionId}`;
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Token bucket for inbound events: `burst` at once, refilled at `perSecond`. */
class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly burst: number, private readonly perSecond: number) {
    this.tokens = burst;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export type RealtimeOptions = {
  httpServer: HttpServer;
  pool: pg.Pool;
  listener: PgListener;
  logger: Logger;
  allowedOrigins: readonly string[];
  rateLimit?: { burst: number; perSecond: number };
  /** Connections per user (rate-limiter-flexible); a refused handshake gets `rate_limited` with retryAfterSeconds. */
  connectLimit?: RateLimit;
};

export type Realtime = {
  io: Server<ClientToServer, ServerToClient, Record<string, never>, SocketData>;
  /** Resolves when every signal received so far has been handled (tests). */
  idle(): Promise<void>;
  close(): Promise<void>;
};

/**
 * Socket.IO as a signal bus (docs/REALTIME.md): sockets only carry "group X changed at seq N";
 * data always comes from the snapshot REST endpoints. The server alone decides rooms.
 */
export function createRealtime(opts: RealtimeOptions): Realtime {
  const { pool, listener, logger } = opts;
  const allowed = new Set(opts.allowedOrigins);
  const limits = opts.rateLimit ?? { burst: 10, perSecond: 2 };

  const io = new Server<ClientToServer, ServerToClient, Record<string, never>, SocketData>(opts.httpServer, {
    path: SOCKET_PATH,
    serveClient: false,
    maxHttpBufferSize: 16 * 1024,
    // Exact Origin allow-list on every engine.io request, including the WebSocket upgrade:
    // the defence against cross-site WebSocket hijacking (cookies ride along cross-site).
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      callback(origin === undefined || !allowed.has(origin) ? 'origin not allowed' : null, origin !== undefined && allowed.has(origin));
    },
  });

  io.use((socket, next) => {
    const token = parseCookie(socket.request.headers.cookie ?? '')[SESSION_COOKIE];
    if (!token) {
      next(new Error('unauthenticated'));
      return;
    }
    findSession(pool, token).then(
      async (session) => {
        if (!session) {
          next(new Error('unauthenticated'));
          return;
        }
        try {
          await opts.connectLimit?.(session.userId);
        } catch (err) {
          next(err instanceof HttpError ? Object.assign(new Error('rate_limited'), { data: err.details }) : new Error('unavailable'));
          return;
        }
        socket.data.userId = session.userId;
        socket.data.sessionId = session.sessionId;
        const expiresIn = Math.min(session.expiresAt.getTime() - Date.now(), MAX_TIMER_MS);
        const timer = setTimeout(() => socket.disconnect(true), Math.max(0, expiresIn));
        socket.on('disconnect', () => {
          clearTimeout(timer);
        });
        next();
      },
      (err: unknown) => {
        logger.error({ err }, 'socket session lookup failed');
        next(new Error('unavailable'));
      },
    );
  });

  async function groupsOf(userIds: string[]): Promise<Map<string, Set<string>>> {
    const { rows } = await pool.query<{ user_id: string; group_id: string }>(
      `select m.user_id, m.group_id from memberships m join groups g on g.id = m.group_id
        where m.user_id = any($1::uuid[]) and m.status = 'active' and g.archived_at is null`,
      [userIds],
    );
    const byUser = new Map<string, Set<string>>(userIds.map((u) => [u, new Set()]));
    for (const r of rows) byUser.get(r.user_id)?.add(r.group_id);
    return byUser;
  }

  /** Makes a socket's group rooms exactly the groups its user is an active member of. */
  async function setRooms(socket: { rooms: Set<string>; join(r: string[]): unknown; leave(r: string): unknown }, groups: Set<string>) {
    for (const r of socket.rooms) {
      if (r.startsWith('group:') && !groups.has(r.slice(6))) await socket.leave(r);
    }
    await socket.join([...groups].map(groupRoom));
  }

  async function handleSync(socket: HisaabSocket, payload: unknown): Promise<void> {
    const parsed = syncPayload.safeParse(payload);
    if (!parsed.success) {
      socket.disconnect(true);
      return;
    }
    // Answer for every group the socket is in (unknown ones count as seen = 0); ignore the rest.
    const groups = [...socket.rooms].filter((r) => r.startsWith('group:')).map((r) => r.slice(6));
    if (groups.length === 0) return;
    const { rows } = await pool.query<{ id: string; last_seq: number }>('select id, last_seq from groups where id = any($1::uuid[])', [groups]);
    for (const g of rows) {
      if (g.last_seq > (parsed.data[g.id] ?? 0)) socket.emit('group:changed', { groupId: g.id, seq: g.last_seq });
    }
  }

  io.on('connection', (socket: HisaabSocket) => {
    const bucket = new TokenBucket(limits.burst, limits.perSecond);
    socket.onAny((event: string, ...args: unknown[]) => {
      if (!bucket.take()) {
        logger.warn({ userId: socket.data.userId }, 'socket rate limit exceeded; disconnecting');
        socket.disconnect(true);
        return;
      }
      if (event !== 'sync') {
        logger.warn({ userId: socket.data.userId, event }, 'client sent a forbidden event; disconnecting');
        socket.disconnect(true);
        return;
      }
      handleSync(socket, args[0]).catch((err: unknown) => { logger.error({ err }, 'sync failed'); });
    });

    void (async () => {
      await socket.join([userRoom(socket.data.userId), sessionRoom(socket.data.sessionId)]);
      const groups = (await groupsOf([socket.data.userId])).get(socket.data.userId) ?? new Set<string>();
      await setRooms(socket, groups);
      socket.emit('ready', { groups: [...groups] });
    })().catch((err: unknown) => {
      logger.error({ err }, 'joining rooms failed');
      socket.disconnect(true);
    });
  });

  async function onGroupSignal(signal: GroupSignal): Promise<void> {
    if (MEMBERSHIP_TYPES.has(signal.type)) {
      const { rows } = await pool.query<{ user_id: string }>(
        `select m.user_id from memberships m join groups g on g.id = m.group_id
          where m.group_id = $1 and m.status = 'active' and m.user_id is not null and g.archived_at is null`,
        [signal.groupId],
      );
      const members = new Set(rows.map((r) => r.user_id));
      const room = groupRoom(signal.groupId);
      for (const s of await io.in(room).fetchSockets()) if (!members.has(s.data.userId)) s.leave(room);
      for (const userId of members) io.in(userRoom(userId)).socketsJoin(room);
    }
    io.to(groupRoom(signal.groupId)).emit('group:changed', { groupId: signal.groupId, seq: signal.seq });
  }

  /** After a listener gap: drop sockets whose session ended, recompute every room, tell clients to sync. */
  async function onResync(): Promise<void> {
    const sockets = await io.fetchSockets();
    const sessionIds = [...new Set(sockets.map((s) => s.data.sessionId))];
    const { rows } = await pool.query<{ id: string }>(
      'select id from sessions where id = any($1::uuid[]) and revoked_at is null and expires_at > now()',
      [sessionIds],
    );
    const live = new Set(rows.map((r) => r.id));
    const alive = sockets.filter((s) => {
      if (live.has(s.data.sessionId)) return true;
      s.disconnect(true);
      return false;
    });
    const byUser = await groupsOf([...new Set(alive.map((s) => s.data.userId))]);
    for (const s of alive) await setRooms(s, byUser.get(s.data.userId) ?? new Set());
    io.emit('resync');
  }

  // One queue for everything the listener reports, so signals reach clients in commit order even
  // when a membership signal has to wait for a room refresh.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (what: string, task: () => Promise<void>) => {
    queue = queue.then(task).catch((err: unknown) => { logger.error({ err }, `realtime ${what} failed`); });
  };
  const onGroup = (s: GroupSignal) => { enqueue('group signal', () => onGroupSignal(s)); };
  const onRevoked = (sessionId: string) => {
    enqueue('revocation', () => {
      io.in(sessionRoom(sessionId)).disconnectSockets(true);
      return Promise.resolve();
    });
  };
  const onListenerResync = () => { enqueue('resync', onResync); };
  listener.on('group', onGroup);
  listener.on('sessionRevoked', onRevoked);
  listener.on('resync', onListenerResync);

  return {
    io,
    idle: () => queue,
    close: async () => {
      listener.off('group', onGroup);
      listener.off('sessionRevoked', onRevoked);
      listener.off('resync', onListenerResync);
      await new Promise<void>((resolve) => {
        void io.close(() => {
          resolve();
        });
      });
    },
  };
}
