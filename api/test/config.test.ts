import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { baseEnv } from './helpers.js';

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    const config = loadConfig({ ...baseEnv, LOG_LEVEL: undefined, WEB_ORIGINS: 'http://localhost:5174, https://hisaab.example' });
    expect(config).toMatchObject({
      nodeEnv: 'test',
      host: '127.0.0.1',
      port: 8081,
      logLevel: 'info',
      webOrigins: ['http://localhost:5174', 'https://hisaab.example'],
    });
  });

  it('rejects a missing NODE_ENV and DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/NODE_ENV[\s\S]*DATABASE_URL/);
  });

  it('rejects a non-postgres DATABASE_URL without echoing its value', () => {
    const secret = 'mysql://user:s3cret-pass@db/x';
    let message = '';
    try {
      loadConfig({ ...baseEnv, DATABASE_URL: secret });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain('s3cret-pass');
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: '70000' })).toThrow(/PORT/);
  });
});
