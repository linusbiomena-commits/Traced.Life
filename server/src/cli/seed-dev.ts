import { createPool } from '../db/pool.ts';
import { seedDevData } from '../modules/dev/seed.ts';

// Adds clearly-marked [DEV] collection branches and PROVISIONAL consent texts to the local database.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (copy .env.example to .env).');
  process.exit(1);
}
const pool = createPool(url, 1);
try {
  const r = await seedDevData(pool, process.env.NODE_ENV ?? 'development');
  console.log(`Seeded ${r.branches} new dev branch(es); ensured ${r.consents} provisional consent document(s).`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
