import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseEnv, WEB_ORIGIN } from './helpers.js';
import { startServer } from './spawn.js';

describe('server process', () => {
  let child: ChildProcess;
  let url: string;

  beforeAll(async () => {
    ({ child, url } = await startServer(baseEnv));
  }, 20_000);

  afterAll(() => {
    child.kill();
  });

  it('answers a garbage POST body with 400 and stays up', async () => {
    const bad = await fetch(`${url}/api/health`, {
      method: 'POST',
      headers: { Origin: WEB_ORIGIN, 'Content-Type': 'application/json' },
      body: '{{{ not json',
    });
    expect(bad.status).toBe(400);

    // Same process still serves requests afterwards.
    const health = await fetch(`${url}/api/health`);
    expect([200, 503]).toContain(health.status);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  }, 15_000);
});
