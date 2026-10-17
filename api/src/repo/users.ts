import type pg from 'pg';

export async function createUser(pool: pg.Pool, input: { displayName: string; email?: string }): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'insert into users (display_name, email) values ($1, $2) returning id',
    [input.displayName, input.email ?? null],
  );
  const row = rows[0];
  if (!row) throw new Error('insert returned no row');
  return row.id;
}
