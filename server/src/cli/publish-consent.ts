import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createPool } from '../db/pool.ts';
import { describePlan, type Manifest, planRelease, publishRelease, ReleaseError, type Target, validateRelease } from '../modules/consents/publish.ts';

// Publishes APPROVED consent documents (privacy notice, sample-collection consent, accuracy declaration,
// guardian authorisation; English + Arabic) from a release folder. See docs/deploy/consent-publishing.md.
//
//   node --import tsx server/src/cli/publish-consent.ts --manifest <release>/manifest.json \
//        --publisher <super-admin email> --target production|preview|development (--dry-run | --publish) [--partial]
//
// Connects with DATABASE_URL (on the server: the least-privilege traced_app role, which can only INSERT/SELECT
// consent documents). --dry-run validates everything and writes nothing. --publish writes all documents of the
// release in one transaction, each with an audit entry. Existing versions are never overwritten.

const { values } = parseArgs({
  options: {
    manifest: { type: 'string' }, publisher: { type: 'string' }, target: { type: 'string' },
    'dry-run': { type: 'boolean', default: false }, publish: { type: 'boolean', default: false }, partial: { type: 'boolean', default: false },
  },
});
const usage = 'Usage: publish-consent --manifest <file> --publisher <email> --target production|preview|development (--dry-run | --publish) [--partial]';
const target = values.target as Target;
if (!values.manifest || !values.publisher || !['production', 'preview', 'development'].includes(target) || values['dry-run'] === values.publish) {
  console.error(usage);
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(2);
}

let manifest: Manifest;
try {
  manifest = JSON.parse(readFileSync(values.manifest, 'utf8').replace(/^﻿/, '')) as Manifest;
} catch (err) {
  console.error(`Cannot read the manifest: ${(err as Error).message}`);
  process.exit(2);
}

const db = createPool(process.env.DATABASE_URL, 2);
try {
  const release = validateRelease(manifest, { baseDir: path.dirname(path.resolve(values.manifest)), target, partial: values.partial });
  const plan = await planRelease(db, release, { publisherEmail: values.publisher, target, partial: values.partial });
  console.log(values.publish ? 'PUBLISHING (approved, immutable):' : 'DRY RUN (nothing is written):');
  for (const line of describePlan(plan)) console.log(line);
  if (values.publish) {
    const { ids } = await publishRelease(db, plan);
    console.log(`Published ${ids.length} approved consent documents in one transaction; ${ids.length} audit entries written (consent.published).`);
  } else {
    console.log(`Dry run OK: ${plan.documents.length} documents would be published. Re-run with --publish to write them.`);
  }
} catch (err) {
  console.error(err instanceof ReleaseError ? err.message : `Failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
