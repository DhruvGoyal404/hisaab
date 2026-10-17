import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    environment: 'node',
    globalSetup: ['test/db/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
