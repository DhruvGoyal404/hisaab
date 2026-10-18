// Runs Playwright against its own throwaway database, never the dev one: create it, migrate it,
// give it a login role with only hisaab_app's privileges, run the tests with fresh API and web
// servers pointed at it, then drop it. Same pattern as the API integration tests.
//
//   npm run e2e -w web                  all specs
//   npm run e2e -w web -- conflict      a filter, passed through to Playwright
//   npm run screenshots -w web          regenerate docs/img
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ensureAppLoginRole, withCredentials, withDatabase } from '../../api/scripts/db-roles.js';
import { runDbmate } from '../../api/test/db/dbmate.js';

const apiEnv = fileURLToPath(new URL('../../api/.env', import.meta.url));
if (!process.env.MIGRATE_DATABASE_URL && existsSync(apiEnv)) process.loadEnvFile(apiEnv);
const ownerUrl = process.env.MIGRATE_DATABASE_URL;
if (!ownerUrl) throw new Error('e2e needs MIGRATE_DATABASE_URL (an owner URL; see api/.env.example)');

const args = process.argv.slice(2);
const screenshots = args.includes('--screenshots');
const playwrightArgs = screenshots ? ['screenshots', ...args.filter((a) => a !== '--screenshots')] : args;

const database = `hisaab_e2e_${Date.now()}_${process.pid}`;
const role = 'hisaab_e2e_app';
const password = randomBytes(24).toString('base64url');
const admin = new pg.Client({ connectionString: ownerUrl });
await admin.connect();

let code: number;
try {
  await admin.query(`create database ${admin.escapeIdentifier(database)}`);
  await runDbmate(withDatabase(ownerUrl, database), ['up']);
  await ensureAppLoginRole(admin, role, password);
  process.stdout.write(`e2e database ${database} ready\n`);

  code = await new Promise<number>((resolve) => {
    const child = spawn('npx', ['playwright', 'test', ...playwrightArgs], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        E2E_DATABASE_URL: withCredentials(withDatabase(ownerUrl, database), role, password),
        E2E_FRESH: '1',
        ...(screenshots && { SCREENSHOTS: '1' }),
      },
    });
    child.on('exit', (c) => { resolve(c ?? 1); });
  });
} finally {
  await admin.query(`drop database if exists ${admin.escapeIdentifier(database)} with (force)`);
  await admin.end();
}
process.exit(code);
