import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dbmateCli = join(dirname(require.resolve('dbmate/package.json')), 'dist', 'cli.js');
const migrationsDir = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

/** Runs dbmate against `databaseUrl` with the repo's migrations; rejects with its output on failure. */
export function runDbmate(databaseUrl: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [dbmateCli, '--no-dump-schema', '--migrations-dir', migrationsDir, ...args],
      { env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`dbmate ${args.join(' ')} exited ${code}:\n${out}`));
    });
  });
}
