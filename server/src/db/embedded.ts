import type { ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import type EmbeddedPostgres from 'embedded-postgres';

// Development/test only. embedded-postgres stops Windows servers with `taskkill /f /t`, which
// skips a clean shutdown and can orphan PostgreSQL 18 I/O workers. Stop with pg_ctl instead.

const exec = promisify(execFile);

/** initdb otherwise inherits the OS code page (WIN1252 on Windows), which cannot store Arabic. */
export const UTF8_INITDB_FLAGS = ['--encoding=UTF8', '--locale=C'] as const;

async function pgCtlPath(): Promise<string> {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  const mod = (await import(`@embedded-postgres/${os}-${process.arch}`)) as { pg_ctl: string };
  return mod.pg_ctl;
}

export async function stopEmbeddedPostgres(pg: EmbeddedPostgres, databaseDir: string): Promise<void> {
  const proc = (pg as unknown as { process?: ChildProcess }).process;
  if (!proc || proc.exitCode !== null) return;
  const exited = once(proc, 'exit');
  try {
    await exec(await pgCtlPath(), ['stop', '-D', databaseDir, '-m', 'fast', '-w', '-t', '30']);
    await exited;
    (pg as unknown as { process?: ChildProcess }).process = undefined;
  } catch {
    await pg.stop(); // fall back to the library's own (forceful) stop
  }
}
