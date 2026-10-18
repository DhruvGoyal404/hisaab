import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { inject } from 'vitest';
import { createApp } from '../../src/app.js';
import { createPool } from '../../src/db.js';
import { PgListener } from '../../src/realtime/listener.js';
import { createRealtime, SOCKET_PATH, type ClientToServer, type ServerToClient } from '../../src/realtime/server.js';
import { testConfig, WEB_ORIGIN } from '../helpers.js';

export type TestSocket = ClientSocket<ServerToClient, ClientToServer>;

export async function until(cond: () => boolean, ms = 5_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`${what} not met within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const quiet = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The real app + listener + Socket.IO server on an ephemeral port, against the test database. */
export async function startStack(rateLimit?: { burst: number; perSecond: number }) {
  const config = testConfig({ DEV_LOGIN: 'true', DATABASE_URL: inject('appDatabaseUrl') });
  const logger = pino({ level: 'silent' });
  const pool = createPool(config.databaseUrl, logger);
  const listener = new PgListener(config.databaseUrl, logger, { minMs: 20, maxMs: 200 });
  listener.start();
  const app = createApp({ config, logger, pool });
  const httpServer = createServer(app);
  const realtime = createRealtime({ httpServer, pool, listener, logger, allowedOrigins: config.webOrigins, ...(rateLimit && { rateLimit }) });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  await until(() => listener.listening, 10_000, 'listener connected');

  const sockets: TestSocket[] = [];

  /** Dev-login as `name`; returns the session cookie and user id. */
  async function login(name: string): Promise<{ cookie: string; userId: string }> {
    const res = await request(app).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ name });
    const cookie = /hisaab_session=[\w-]+/.exec(String(res.headers['set-cookie']))?.[0] ?? '';
    return { cookie, userId: (res.body as { user: { id: string } }).user.id };
  }

  /** A real socket.io-client over WebSocket with the given headers; not auto-reconnecting. */
  function socket(headers: { cookie?: string; origin?: string | null }): TestSocket {
    const extraHeaders: Record<string, string> = {};
    if (headers.cookie) extraHeaders.Cookie = headers.cookie;
    if (headers.origin !== null) extraHeaders.Origin = headers.origin ?? WEB_ORIGIN;
    const s: TestSocket = ioClient(url, { path: SOCKET_PATH, transports: ['websocket'], extraHeaders, reconnection: false, forceNew: true });
    sockets.push(s);
    return s;
  }

  /** Resolves with the groups the server put the socket in, or rejects with the connect error. */
  function ready(s: TestSocket): Promise<string[]> {
    return new Promise((resolve, reject) => {
      s.once('ready', ({ groups }) => {
        resolve(groups);
      });
      s.once('connect_error', reject);
    });
  }

  return {
    url, app, pool, listener, realtime, login, socket, ready,
    close: async () => {
      for (const s of sockets) s.disconnect();
      await realtime.close();
      await listener.stop();
      await pool.end();
    },
  };
}

/** Records every group:changed a socket receives. */
export function recorder(s: TestSocket): { groupId: string; seq: number }[] {
  const got: { groupId: string; seq: number }[] = [];
  s.on('group:changed', (signal) => got.push(signal));
  return got;
}
