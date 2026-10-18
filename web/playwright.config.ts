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
  // Locally, running dev servers (npm run dev:api / dev:web) are reused. In CI both are started here:
  // the API against E2E_DATABASE_URL with dev login on, and the built web app via vite preview.
  webServer: [
    {
      command: 'node --import tsx src/server.ts',
      cwd: '../api',
      url: 'http://127.0.0.1:8081/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        DEV_LOGIN: 'true',
        HOST: '127.0.0.1',
        PORT: '8081',
        WEB_ORIGINS: BASE_URL,
        LOG_LEVEL: 'warn',
        DATABASE_URL: process.env.E2E_DATABASE_URL ?? '',
      },
    },
    { command: 'npx vite preview', url: BASE_URL, reuseExistingServer: !process.env.CI, timeout: 60_000 },
  ],
});
