import { createApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createPool } from './db.js';
import { createLogger } from './logger.js';
import { PgListener } from './realtime/listener.js';
import { createRealtime } from './realtime/server.js';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const logger = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl, logger);
const app = createApp({ config, logger, pool });

// The LISTEN connection retries in the background, so an unreachable database never blocks startup.
const listener = new PgListener(config.databaseUrl, logger);
listener.start();

const server = app.listen(config.port, config.host, () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  logger.info({ host: config.host, port, nodeEnv: config.nodeEnv }, 'api listening');
});
const realtime = createRealtime({ httpServer: server, pool, listener, logger, allowedOrigins: config.webOrigins });

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  // Closing Socket.IO also closes the HTTP server.
  void realtime
    .close()
    .then(() => listener.stop())
    .then(() => pool.end())
    .finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
