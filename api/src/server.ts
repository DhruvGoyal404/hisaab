import { createApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createPool } from './db.js';
import { createLogger } from './logger.js';

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

const server = app.listen(config.port, config.host, () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  logger.info({ host: config.host, port, nodeEnv: config.nodeEnv }, 'api listening');
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
