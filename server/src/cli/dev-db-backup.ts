import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import pg from 'pg';

// LOCAL DEVELOPMENT ONLY. Online physical backup of the running dev database (.dev-db/data) with
// PostgreSQL's non-exclusive backup API (pg_backup_start / pg_backup_stop): no downtime, no
// pg_dump needed (the bundled PostgreSQL has none). Then proves the backup restores: starts the
// copy as a separate server on a free port (WAL replay from backup_label), compares row counts and
// content hashes of every table with the live database, and stops the copy.
//
//   npm run dev:db-backup                 # backup + restore test into .dev-db-backups/<timestamp>/
//   npm run dev:db-backup -- --keep-running   (leave the restored copy running for inspection)
//
// Refuses anything but a local database. Never touches the live server's files except reading them.

const raw = process.env.DATABASE_URL;
if (!raw) throw new Error('DATABASE_URL is not set');
const url = new URL(raw);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || process.env.NODE_ENV === 'production') {
  console.error('dev-db-backup only works on a local development database.');
  process.exit(1);
}
const dataDir = path.resolve('.dev-db/data');
if (!existsSync(path.join(dataDir, 'PG_VERSION'))) {
  console.error(`No database cluster at ${dataDir}. Run from the repository that holds .dev-db/.`);
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve('.dev-db-backups', stamp);
const copyDir = path.join(outDir, 'data');
mkdirSync(outDir, { recursive: true });

async function pgCtl(): Promise<string> {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  return ((await import(`@embedded-postgres/${os}-${process.arch}`)) as { pg_ctl: string }).pg_ctl;
}
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore', windowsHide: true }); // no inherited pipes (Windows)
    p.once('error', reject);
    p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`pg_ctl ${args[0]} exited with ${code}`))));
  });
}
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});

async function fingerprint(client: pg.Client) {
  const tables = (await client.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.t);
  const out: Record<string, { rows: number; md5: string }> = {};
  for (const t of tables) {
    const r = await client.query<{ n: string; h: string | null }>(`SELECT count(*) AS n, md5(string_agg(x::text, E'\\n' ORDER BY x::text)) AS h FROM "${t}" x`);
    out[t] = { rows: Number(r.rows[0]!.n), md5: r.rows[0]!.h ?? '' };
  }
  return out;
}

const live = new pg.Client({ connectionString: raw });
await live.connect();
const migrations = (await live.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version);

// 1. Online backup.
console.log(`Backing up ${dataDir} (online) → ${copyDir}`);
await live.query(`SELECT pg_backup_start('traced-dev-${stamp}', true)`);
cpSync(dataDir, copyDir, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(dataDir, src).replace(/\\/g, '/');
    // Excluded per the PostgreSQL docs: runtime files and WAL (WAL is copied after pg_backup_stop).
    return !/^(postmaster\.(pid|opts)|pg_wal\/.+|pg_replslot\/.+|pg_dynshmem\/.+|pg_notify\/.+|pg_serial\/.+|pg_snapshots\/.+|pg_stat_tmp\/.+|pg_subtrans\/.+|log\/.+)$/.test(rel) && !/(^|\/)pgsql_tmp/.test(rel);
  },
});
const stop = await live.query<{ labelfile: string; spcmapfile: string | null }>('SELECT labelfile, spcmapfile FROM pg_backup_stop(true)');
writeFileSync(path.join(copyDir, 'backup_label'), stop.rows[0]!.labelfile);
if (stop.rows[0]!.spcmapfile) writeFileSync(path.join(copyDir, 'tablespace_map'), stop.rows[0]!.spcmapfile);
// WAL written up to the end of the backup (pg_backup_stop waits for the needed segments).
mkdirSync(path.join(copyDir, 'pg_wal'), { recursive: true });
for (const f of readdirSync(path.join(dataDir, 'pg_wal'))) {
  if (/^[0-9A-F]{24}(\.partial)?$/.test(f) || /\.history$/.test(f)) cpSync(path.join(dataDir, 'pg_wal', f), path.join(copyDir, 'pg_wal', f));
}
const before = await fingerprint(live);
await live.end();

// 2. Restore test on a separate port.
const port = await freePort();
console.log(`Restore test: starting the copy on 127.0.0.1:${port}`);
await run(await pgCtl(), ['start', '-D', copyDir, '-w', '-t', '120', '-l', path.join(outDir, 'restore-test.log'), '-o', `-p ${port} -c max_connections=10`]);
let ok = false;
let report = '';
try {
  const restoredUrl = new URL(raw);
  restoredUrl.port = String(port);
  const copy = new pg.Client({ connectionString: restoredUrl.toString() });
  await copy.connect();
  const after = await fingerprint(copy);
  const chain = (await copy.query<{ r: string | null }>('SELECT audit_verify_chain() AS r')).rows[0]!.r;
  await copy.end();
  const tables = Object.keys(before);
  const diff = tables.filter((t) => !after[t] || after[t]!.rows !== before[t]!.rows || after[t]!.md5 !== before[t]!.md5);
  ok = diff.length === 0 && chain === null;
  const totalRows = tables.reduce((n, t) => n + before[t]!.rows, 0);
  report = [
    `TRACED dev DB backup ${stamp}`,
    `migrations: ${migrations.at(-1)} (${migrations.length})`,
    `tables: ${tables.length}, rows: ${totalRows}`,
    `restore test: ${ok ? 'PASS' : 'FAIL'} (tables differing: ${diff.length ? diff.join(', ') : 'none'}; audit chain ${chain === null ? 'intact' : `broken at ${chain}`})`,
    '',
    ...tables.map((t) => `${t}\t${before[t]!.rows}\t${before[t]!.md5.slice(0, 12)}\t${diff.includes(t) ? 'DIFF' : 'ok'}`),
    '',
  ].join('\n');
} finally {
  if (!process.argv.includes('--keep-running')) await run(await pgCtl(), ['stop', '-D', copyDir, '-m', 'fast', '-w', '-t', '60']).catch(() => {});
}
writeFileSync(path.join(outDir, 'REPORT.txt'), report);
console.log(report);
console.log(`Checksum of the report: ${createHash('sha256').update(report).digest('hex').slice(0, 16)}`);
if (!ok) {
  console.error('Restore verification FAILED. Keep the live database as it is and investigate before any upgrade.');
  process.exit(1);
}
if (!process.argv.includes('--keep')) rmSync(path.join(outDir, 'restore-test.log'), { force: true });
console.log(`Backup verified and kept at ${outDir} (contains personal test data; gitignored; delete when no longer needed).`);
