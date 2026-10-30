// Production migrate job, after `dbmate up` (api/Dockerfile, target migrate): creates or
// re-passwords the API's login role from DATABASE_URL, connecting as the owner
// (MIGRATE_DATABASE_URL), then proves the API can log in and holds nothing beyond hisaab_app.
import pg from 'pg';
import { ensureAppLoginRole } from './dbRoles.js';

const { DATABASE_URL, MIGRATE_DATABASE_URL } = process.env;
if (!DATABASE_URL || !MIGRATE_DATABASE_URL) throw new Error('DATABASE_URL and MIGRATE_DATABASE_URL must both be set');
const api = new URL(DATABASE_URL);
const name = decodeURIComponent(api.username);
const password = decodeURIComponent(api.password);
if (name !== 'hisaab_api') throw new Error('DATABASE_URL must connect as hisaab_api, never as the owner');
if (password.length < 16) throw new Error('the hisaab_api password must be at least 16 characters');

const owner = new pg.Client({ connectionString: MIGRATE_DATABASE_URL });
await owner.connect();
try {
  await ensureAppLoginRole(owner, name, password);
} finally {
  await owner.end();
}

const check = new pg.Client({ connectionString: DATABASE_URL });
await check.connect();
try {
  const { rows: [r] } = await check.query<{ who: string; super: boolean; createrole: boolean; createdb: boolean; app: boolean }>(
    `select current_user as who, rolsuper as super, rolcreaterole as createrole, rolcreatedb as createdb,
            pg_has_role(current_user, 'hisaab_app', 'USAGE') as app
       from pg_roles where rolname = current_user`,
  );
  if (!r || r.who !== name || r.super || r.createrole || r.createdb || !r.app) throw new Error('hisaab_api is misconfigured');
  process.stdout.write('hisaab_api ready: login verified, member of hisaab_app, no other privileges\n');
} finally {
  await check.end();
}
