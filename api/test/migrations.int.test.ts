import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { withDatabase } from '../scripts/db-roles.js';
import { runDbmate } from './db/dbmate.js';

// Everything a migration can create, as sorted text: columns, constraints, indexes, triggers,
// functions and the app role's table privileges.
const SNAPSHOT = `
  select coalesce(string_agg(x, E'\\n' order by x), '') as snapshot from (
    select format('col %s.%s %s null=%s default=%s', table_name, column_name, data_type, is_nullable, column_default)
      from information_schema.columns where table_schema = 'public'
    union all
    select format('con %s %s %s', conrelid::regclass, conname, pg_get_constraintdef(oid))
      from pg_constraint where connamespace = 'public'::regnamespace
    union all
    select format('idx %s', indexdef) from pg_indexes where schemaname = 'public'
    union all
    select format('trg %s %s %s', tgrelid::regclass, tgname, tgenabled) from pg_trigger where not tgisinternal
    union all
    select format('fn %s', p.oid::regprocedure) from pg_proc p where pronamespace = 'public'::regnamespace
    union all
    select format('acl %s %s', table_name, privilege_type)
      from information_schema.role_table_grants where grantee = 'hisaab_app'
    union all
    select format('colacl %s.%s %s', table_name, column_name, privilege_type)
      from information_schema.column_privileges where grantee = 'hisaab_app'
  ) s(x)
  where x not like '%schema_migrations%'`;

const scratch = `hisaab_migcheck_${Date.now()}_${process.pid}`;
const ownerUrl = withDatabase(inject('ownerDatabaseUrl'), scratch);
const admin = new pg.Client({ connectionString: inject('ownerDatabaseUrl') });

async function snapshot(): Promise<string> {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    const { rows } = await c.query<{ snapshot: string }>(SNAPSHOT);
    return rows[0]?.snapshot ?? '';
  } finally {
    await c.end();
  }
}

async function appliedMigrations(): Promise<string[]> {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    const { rows } = await c.query<{ version: string }>('select version from schema_migrations order by version');
    return rows.map((r) => r.version);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  await admin.connect();
  await admin.query(`create database ${admin.escapeIdentifier(scratch)}`);
});

afterAll(async () => {
  await admin.query(`drop database if exists ${admin.escapeIdentifier(scratch)} with (force)`);
  await admin.end();
});

describe('migrations', () => {
  it('apply, roll back completely, and re-apply to an identical schema', async () => {
    await runDbmate(ownerUrl, ['up']);
    const applied = await appliedMigrations();
    expect(applied.length).toBeGreaterThanOrEqual(4);
    const first = await snapshot();
    expect(first).toContain('col ledger_entries.delta_minor bigint');
    expect(first).toContain('trg activity_log activity_log_append_only');

    for (let i = 0; i < applied.length; i++) await runDbmate(ownerUrl, ['rollback']);
    expect(await appliedMigrations()).toEqual([]);
    expect(await snapshot()).toBe('');

    await runDbmate(ownerUrl, ['up']);
    expect(await snapshot()).toBe(first);
  }, 120_000);
});
