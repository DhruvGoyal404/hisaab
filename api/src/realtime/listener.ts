import { EventEmitter } from 'node:events';
import pg from 'pg';
import type { Logger } from 'pino';

export const GROUP_CHANNEL = 'hisaab_group';
export const SESSION_CHANNEL = 'hisaab_session';

export type GroupSignal = { groupId: string; seq: number; type: string };

type ListenerEvents = {
  group: [GroupSignal];
  sessionRevoked: [sessionId: string];
  /** Connected again after a gap: notifications sent meanwhile were lost. */
  resync: [];
  connected: [];
};

export type Backoff = { minMs: number; maxMs: number };

/**
 * The API's one LISTEN connection: a dedicated pg.Client, never a pool member (a pooled client
 * would be handed to queries and lose its LISTEN on release). On any error or disconnect it
 * reconnects with exponential backoff and jitter, and emits `resync` once it is listening again,
 * because notifications sent while it was down are gone for good.
 */
export class PgListener extends EventEmitter<ListenerEvents> {
  private client: pg.Client | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private everConnected = false;
  private failures = 0;
  /** Backend pid of the current LISTEN connection (tests use it to kill the connection). */
  backendPid: number | undefined;

  constructor(
    private readonly connectionString: string,
    private readonly logger: Logger,
    private readonly backoff: Backoff = { minMs: 100, maxMs: 10_000 },
  ) {
    super();
  }

  get listening(): boolean {
    return this.client !== undefined;
  }

  start(): void {
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.connectionString, keepAlive: true });
    let lost = false;
    const onLost = (err?: unknown) => {
      if (lost) return;
      lost = true;
      if (this.client === client) this.client = undefined;
      this.backendPid = undefined;
      void client.end().catch(() => undefined);
      if (this.stopped) return;
      this.failures += 1;
      this.logger.warn({ err, failures: this.failures }, 'postgres listener connection lost; reconnecting');
      this.scheduleReconnect();
    };
    client.on('error', onLost);
    client.on('end', () => {
      onLost();
    });
    client.on('notification', (msg) => {
      this.onNotification(msg);
    });

    try {
      await client.connect();
      await client.query(`listen ${GROUP_CHANNEL}`);
      await client.query(`listen ${SESSION_CHANNEL}`);
      const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
      this.backendPid = rows[0]?.pid;
    } catch (err) {
      onLost(err);
      return;
    }
    // Both can flip during the awaits above (stop() or an error/end event); TS narrowing cannot see that.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (this.stopped || lost) {
      await client.end().catch(() => undefined);
      return;
    }

    // Any earlier connection or failed attempt means sockets may have missed signals.
    const resync = this.everConnected || this.failures > 0;
    this.client = client;
    this.everConnected = true;
    this.failures = 0;
    this.logger.info({ pid: this.backendPid }, 'postgres listener connected');
    this.emit('connected');
    if (resync) this.emit('resync');
  }

  private scheduleReconnect(): void {
    const exp = Math.min(this.backoff.maxMs, this.backoff.minMs * 2 ** Math.min(this.failures - 1, 20));
    const delay = Math.round(exp * (0.5 + Math.random() / 2));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), delay);
  }

  private onNotification(msg: pg.Notification): void {
    try {
      const body = JSON.parse(msg.payload ?? '') as Record<string, unknown>;
      if (msg.channel === GROUP_CHANNEL && typeof body.group_id === 'string' && typeof body.seq === 'number') {
        this.emit('group', { groupId: body.group_id, seq: body.seq, type: typeof body.type === 'string' ? body.type : '' });
      } else if (msg.channel === SESSION_CHANNEL && typeof body.session_id === 'string') {
        this.emit('sessionRevoked', body.session_id);
      }
    } catch (err) {
      this.logger.error({ err, channel: msg.channel }, 'unparseable notification');
    }
  }
}
