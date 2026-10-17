import pg from 'pg';
import type { Logger } from 'pino';

export function createPool(databaseUrl: string, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 5_000,
  });
  // An idle client losing its connection emits 'error' on the pool; unhandled, that would crash the process.
  pool.on('error', (err) => {
    logger.error({ err }, 'idle postgres client error');
  });
  return pool;
}

export async function pingDatabase(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}
