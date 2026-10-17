import { createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'hisaab_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 256-bit opaque token handed to the client. Only its hash is ever stored. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type Session = { userName: string; expiresAt: number };

export interface SessionStore {
  create(tokenHash: string, session: Session): Promise<void>;
  get(tokenHash: string): Promise<Session | undefined>;
  delete(tokenHash: string): Promise<void>;
}

/** In-process store for the dev login. Phase 2 replaces it with the Postgres `sessions` table. */
export class MemorySessionStore implements SessionStore {
  /** Visible for tests: the store holds hashes, never raw tokens. */
  get hashes(): string[] {
    return [...this.byHash.keys()];
  }

  private readonly byHash = new Map<string, Session>();

  create(tokenHash: string, session: Session): Promise<void> {
    this.byHash.set(tokenHash, session);
    return Promise.resolve();
  }

  get(tokenHash: string): Promise<Session | undefined> {
    const session = this.byHash.get(tokenHash);
    if (session && session.expiresAt <= Date.now()) {
      this.byHash.delete(tokenHash);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(session);
  }

  delete(tokenHash: string): Promise<void> {
    this.byHash.delete(tokenHash);
    return Promise.resolve();
  }
}
