import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    environment: 'node',
    globalSetup: ['test/db/global-setup.ts'],
    setupFiles: ['test/fc.ts'],
    // CI is quiet, so 20 s there means a real hang; this shared dev machine gets more room.
    testTimeout: process.env.CI ? 20_000 : 90_000,
    hookTimeout: 60_000,
  },
});
