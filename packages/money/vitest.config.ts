import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['test/fc.ts'],
    // Property tests run thousands of cases; 5 s is too tight when the machine is busy.
    testTimeout: 60_000,
  },
});
