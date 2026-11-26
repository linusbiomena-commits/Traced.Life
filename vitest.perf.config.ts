import { defineConfig } from 'vitest/config';

// `npm run test:perf`: synthetic-data performance run (not part of `npm test`). Writes
// docs/performance/results.md. See docs/performance/README.md for what it does and does not prove.
export default defineConfig({
  test: {
    include: ['server/test/perf/**/*.perf.ts'],
    globalSetup: ['server/test/perf/global-setup.ts'],
    pool: 'forks',
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
  },
});
