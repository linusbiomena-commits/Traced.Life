#!/usr/bin/env node
// Lists (and with --yes stops) orphaned PostgreSQL processes left behind by TRACED test runs.
//
// On Windows, PostgreSQL 18 I/O workers can survive when a test server is force-killed. They hold
// files in throw-away test folders but serve nothing. This script only ever selects a process when
// ALL of these hold:
//   1. it is postgres.exe from THIS repository's node_modules/@embedded-postgres (not a system or
//      other project's PostgreSQL);
//   2. its parent process no longer exists (an orphan), and it is not a descendant of a live
//      postmaster;
//   3. its command line does not mention the development database folder (.dev-db) and it is not
//      listening on a TCP port.
// Everything else is reported as "kept" with the reason. Default is a dry run.
//
//   node scripts/cleanup-orphan-test-postgres.mjs         # list only
//   node scripts/cleanup-orphan-test-postgres.mjs --yes   # stop the selected orphans

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('Only needed on Windows (orphaned PostgreSQL 18 I/O workers). Nothing to do.');
  process.exit(0);
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binDir = path.join(repo, 'node_modules', '@embedded-postgres').toLowerCase().replace(/\\/g, '/');
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });

const all = JSON.parse(ps('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress') || '[]');
const byPid = new Map(all.map((p) => [p.ProcessId, p]));
const listening = new Set(JSON.parse(ps('Get-NetTCPConnection -State Listen | Select-Object -ExpandProperty OwningProcess | ConvertTo-Json -Compress') || '[]'));

const isRepoPostgres = (p) => p.Name?.toLowerCase() === 'postgres.exe'
  && String(p.ExecutablePath ?? p.CommandLine ?? '').toLowerCase().replace(/\\/g, '/').includes(binDir);
const livePostmasterAncestor = (p) => {
  for (let cur = byPid.get(p.ParentProcessId), hops = 0; cur && hops < 10; cur = byPid.get(cur.ParentProcessId), hops++) {
    if (cur.Name?.toLowerCase() === 'postgres.exe' && / -D /.test(cur.CommandLine ?? '')) return cur;
  }
  return null;
};

const selected = [];
const kept = [];
for (const p of all.filter(isRepoPostgres)) {
  const cmd = p.CommandLine ?? '';
  const role = /--forkchild="([^"]+)"/.exec(cmd)?.[1] ?? (/ -D /.test(cmd) ? 'postmaster' : 'unknown');
  const parentAlive = byPid.has(p.ParentProcessId);
  let reason = null;
  if (/[\\/]\.dev-db[\\/]/i.test(cmd)) reason = 'development database';
  else if (listening.has(p.ProcessId)) reason = 'listening on a port';
  else if (parentAlive) reason = 'parent process is alive';
  else if (livePostmasterAncestor(p)) reason = 'belongs to a live server';
  (reason ? kept : selected).push({ pid: p.ProcessId, parent: p.ParentProcessId, role, reason });
}

for (const k of kept) console.log(`kept     pid ${k.pid} (${k.role}): ${k.reason}`);
for (const s of selected) console.log(`orphan   pid ${s.pid} (${s.role}), parent ${s.parent} is gone`);
if (!selected.length) {
  console.log('No orphaned TRACED test PostgreSQL processes.');
  process.exit(0);
}
if (!process.argv.includes('--yes')) {
  console.log(`\nDry run: ${selected.length} orphan(s) found. Re-run with --yes to stop them.`);
  process.exit(0);
}
for (const s of selected) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(s.pid), '/F'], { stdio: 'ignore' });
    console.log(`stopped  pid ${s.pid}`);
  } catch {
    console.log(`could not stop pid ${s.pid} (already gone?)`);
  }
}
