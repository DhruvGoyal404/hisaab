import type pg from 'pg';

/**
 * Creates (or re-passwords) a LOGIN role that is a member of hisaab_app, the privilege-limited
 * group role created by the migrations. Dev and test only; production roles come from SSM.
 */
export async function ensureAppLoginRole(owner: pg.ClientBase, name: string, password: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`invalid role name: ${name}`);
  const role = owner.escapeIdentifier(name);
  const secret = owner.escapeLiteral(password);
  const { rowCount } = await owner.query('select 1 from pg_roles where rolname = $1', [name]);
  if (rowCount === 0) {
    await owner.query(`create role ${role} login password ${secret} noinherit`);
  } else {
    await owner.query(`alter role ${role} login password ${secret}`);
  }
  // INHERIT on the grant (not the role) so the login role gets hisaab_app's privileges and nothing else.
  await owner.query(`grant hisaab_app to ${role} with inherit true`);
}

export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function withCredentials(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}
