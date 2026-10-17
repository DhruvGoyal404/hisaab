import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { ensureAppLoginRole, withCredentials, withDatabase } from '../../scripts/db-roles.js';
import { runDbmate } from './dbmate.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Owner (migration) role, connected to this run's throwaway database. */
    ownerDatabaseUrl: string;
    /** Login role that only has hisaab_app's privileges, same database. */
    appDatabaseUrl: string;
  }
}

export const TEST_APP_ROLE = 'hisaab_test_app';

/**
 * Integration tests get a fresh database per run: created, migrated with dbmate, used through
 * the privilege-limited app role, then dropped. Append-only tables never accumulate test data.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (!process.env.MIGRATE_DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
  const ownerUrl = process.env.MIGRATE_DATABASE_URL;
  if (!ownerUrl) throw new Error('integration tests need MIGRATE_DATABASE_URL (an owner/superuser URL; see api/.env.example)');

  const database = `hisaab_test_${Date.now()}_${process.pid}`;
  const admin = new pg.Client({ connectionString: ownerUrl });
  await admin.connect();
  await admin.query(`create database ${admin.escapeIdentifier(database)}`);

  const ownerTestUrl = withDatabase(ownerUrl, database);
  await runDbmate(ownerTestUrl, ['up']);

  const password = randomBytes(24).toString('base64url');
  await ensureAppLoginRole(admin, TEST_APP_ROLE, password);

  project.provide('ownerDatabaseUrl', ownerTestUrl);
  project.provide('appDatabaseUrl', withCredentials(ownerTestUrl, TEST_APP_ROLE, password));

  return async () => {
    await admin.query(`drop database if exists ${admin.escapeIdentifier(database)} with (force)`);
    await admin.end();
  };
}
