import type pg from 'pg';
import { inTransaction } from '../repo/tx.js';
import type { Provider } from './flows.js';
import type { Profile } from './google.js';

export type SignInResult = { userId: string } | { error: 'account_exists' | 'account_disabled' };

/**
 * Signs in by (provider, subject). A new identity creates a new account, unless its email already
 * belongs to an account: identities are never linked automatically by email (a provider vouching
 * for an address is not proof of owning the existing account), so that sign-in is refused and the
 * person is told to sign in the way they did before, then link this provider.
 */
export function signInWith(pool: pg.Pool, provider: Provider, profile: Profile): Promise<SignInResult> {
  return inTransaction(pool, async (client) => {
    const { rows: known } = await client.query<{ user_id: string; disabled: boolean }>(
      `select i.user_id, u.disabled_at is not null as disabled
         from oauth_identities i join users u on u.id = i.user_id
        where i.provider = $1 and i.subject = $2`,
      [provider, profile.subject],
    );
    const existing = known[0];
    if (existing) {
      if (existing.disabled) return { error: 'account_disabled' as const };
      await client.query(
        'update oauth_identities set email = $3, email_verified = true, last_login_at = now() where provider = $1 and subject = $2',
        [provider, profile.subject, profile.email],
      );
      return { userId: existing.user_id };
    }

    const { rowCount: clash } = await client.query(
      `select 1 from users where email = $1 and disabled_at is null
       union all
       select 1 from oauth_identities i join users u on u.id = i.user_id where i.email = $1 and u.disabled_at is null`,
      [profile.email],
    );
    if (clash) return { error: 'account_exists' as const };

    const { rows } = await client.query<{ id: string }>(
      'insert into users (display_name, email) values ($1, $2) returning id',
      [profile.name.slice(0, 60), profile.email],
    );
    const userId = rows[0]?.id ?? '';
    await client.query(
      'insert into oauth_identities (user_id, provider, subject, email, email_verified) values ($1, $2, $3, $4, true)',
      [userId, provider, profile.subject, profile.email],
    );
    return { userId };
  }).catch((err: unknown) => {
    // Two first sign-ins racing for one email: the unique index decides, the loser is told to link.
    if ((err as { constraint?: string }).constraint === 'users_email_key') return { error: 'account_exists' as const };
    throw err;
  });
}
