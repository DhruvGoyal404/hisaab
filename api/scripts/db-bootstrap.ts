// Creates the API's login role for local development from the credentials in DATABASE_URL.
// Run after `npm run db:migrate` (which creates the hisaab_app group role).
import pg from 'pg';
import { ensureAppLoginRole } from './db-roles.js';

const { NODE_ENV, DATABASE_URL, MIGRATE_DATABASE_URL } = process.env;
if (NODE_ENV !== 'development' && NODE_ENV !== 'test') {
  throw new Error('db-bootstrap is for development and test only');
}
if (!DATABASE_URL || !MIGRATE_DATABASE_URL) throw new Error('DATABASE_URL and MIGRATE_DATABASE_URL are required');

const app = new URL(DATABASE_URL);
const owner = new pg.Client({ connectionString: MIGRATE_DATABASE_URL });
await owner.connect();
try {
  await ensureAppLoginRole(owner, decodeURIComponent(app.username), decodeURIComponent(app.password));
  process.stdout.write(`login role ${app.username} ready (member of hisaab_app)\n`);
} finally {
  await owner.end();
}
