import { defineConfig } from 'vitest/config';

// `npm run drill:backup`: backup-and-restore drill on a throw-away synthetic cluster (not part of
// `npm test`). Writes docs/backup/drill-results.md. See docs/backup/README.md.
export default defineConfig({
  test: {
    include: ['server/test/drills/**/*.drill.ts'],
    globalSetup: ['server/test/perf/global-setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
