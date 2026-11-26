import { migrate } from '../db/migrate.ts';
import { createPool } from '../db/pool.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (copy .env.example to .env).');
  process.exit(1);
}
const pool = createPool(url, 1);
try {
  const { applied, skipped } = await migrate(pool);
  console.log(`Applied ${applied.length} migration(s)${applied.length ? `: ${applied.join(', ')}` : ''}. Already applied: ${skipped.length}.`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
