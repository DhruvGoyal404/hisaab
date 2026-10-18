import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// Browsers live inside this repo (web/.playwright), never in the shared per-user cache.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= fileURLToPath(new URL('./.playwright', import.meta.url));

export const BASE_URL = 'http://localhost:5174';

export default defineConfig({
  testDir: './e2e',
  // The screenshot spec writes into docs/img; run it on purpose with SCREENSHOTS=1.
  testIgnore: process.env.SCREENSHOTS ? [] : ['**/screenshots.spec.ts'],
  // One worker: the machine is shared and memory is tight; tests use their own users and groups.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list']],
  use: { baseURL: BASE_URL, trace: 'retain-on-failure', locale: 'en-IN', timezoneId: 'Asia/Kolkata' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Started fresh for every run by e2e/run.ts (npm run e2e), which creates a throwaway database and
  // passes E2E_DATABASE_URL: the API runs against it with dev login on; the web app is the Vite dev
  // server locally and the built app (vite preview) in CI. Dev servers are never reused, so a run
  // can't touch the dev database (stop them first if they hold ports 8081/5174).
  webServer: [
    {
      command: 'node --import tsx src/server.ts',
      cwd: '../api',
      url: 'http://127.0.0.1:8081/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        DEV_LOGIN: 'true',
        HOST: '127.0.0.1',
        PORT: '8081',
        WEB_ORIGINS: BASE_URL,
        LOG_LEVEL: 'warn',
        DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://run-e2e-via-npm-run-e2e@127.0.0.1:1/none',
      },
    },
    { command: process.env.CI ? 'npx vite preview' : 'npx vite', url: BASE_URL, reuseExistingServer: false, timeout: 60_000 },
  ],
});
