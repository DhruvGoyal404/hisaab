import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests need the database setup in vitest.int.config.ts.
    exclude: [...configDefaults.exclude, 'test/**/*.int.test.ts'],
    environment: 'node',
    setupFiles: ['test/fc.ts'],
  },
});
