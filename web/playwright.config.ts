import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// Browsers live inside this repo (web/.playwright), never in the shared per-user cache.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= fileURLToPath(new URL('./.playwright', import.meta.url));

export const BASE_URL = 'http://localhost:5174';

export default defineConfig({
  testDir: './e2e',
  // One worker: the machine is shared and memory is tight; tests use their own users and groups.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list']],
  use: { baseURL: BASE_URL, trace: 'retain-on-failure', locale: 'en-IN', timezoneId: 'Asia/Kolkata' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
