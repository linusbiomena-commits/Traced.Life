import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts'],
    globalSetup: ['server/test/helpers/global-setup.ts'],
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
