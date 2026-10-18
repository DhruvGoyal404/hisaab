import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from './helpers.js';
import { mockGithub, mockGoogle, type GithubUser } from './oauth/mocks.js';

let google: Awaited<ReturnType<typeof mockGoogle>>;
let github: Awaited<ReturnType<typeof mockGithub>>;
let stack: ReturnType<typeof buildApp>;

beforeAll(async () => {
  google = await mockGoogle();
  github = await mockGithub();
  stack = buildApp({ DATABASE_URL: inject('appDatabaseUrl'), ...google.env, ...github.env });
});
afterAll(async () => {
  await stack.pool.end();
  await google.close();
  await github.close();
});

type Agent = ReturnType<typeof request.agent>;

/** GET /start, and read what the browser would carry to the provider. */
async function begin(agent: Agent, provider: 'google' | 'github', next?: string) {
  const res = await agent.get(`/api/auth/${provider}/start${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  expect(res.status).toBe(302);
  const url = new URL(res.headers.location ?? '');
  expect(res.headers['set-cookie']?.toString()).toMatch(/hisaab_oauth=[\w-]+;.*HttpOnly/);
  return {
    url,
    state: url.searchParams.get('state') ?? '',
    challenge: url.searchParams.get('code_challenge') ?? '',
    nonce: url.searchParams.get('nonce') ?? '',
  };
}

/** The provider redirects back; returns where the API sends the browser next. */
async function finish(agent: Agent, provider: 'google' | 'github', code: string, state: string) {
  const res = await agent.get(`/api/auth/${provider}/callback?code=${code}&state=${state}`);
  expect(res.status).toBe(302);
  return { location: res.headers.location ?? '', setCookie: res.headers['set-cookie']?.toString() ?? '' };
}

const person = () => {
  const id = randomUUID().slice(0, 8);
  return { sub: `g-${id}`, email: `asha.${id}@example.com`, name: `Asha ${id}` };
};

async function googleSignIn(claims: Record<string, unknown> = {}, opts: { impostor?: boolean; expiresInSeconds?: number } = {}) {
  const agent = request.agent(stack.app);
  const p = person();
  const f = await begin(agent, 'google', '/groups');
  const code = randomUUID();
  google.register(code, f.challenge, await google.idToken({ ...p, email_verified: true, nonce: f.nonce, ...claims }, opts));
  return { agent, p, f, ...(await finish(agent, 'google', code, f.state)) };
}

describe('Google sign-in (OIDC code + PKCE)', () => {
  it('sends the right authorization request', async () => {
    const f = await begin(request.agent(stack.app), 'google');
    expect(f.url.origin + f.url.pathname).toBe(`${google.url}/authorize`);
    expect(Object.fromEntries(f.url.searchParams)).toMatchObject({
      client_id: google.env.GOOGLE_CLIENT_ID,
      redirect_uri: 'http://localhost:5174/api/auth/google/callback',
      response_type: 'code',
      scope: 'openid email profile',
      code_challenge_method: 'S256',
    });
    expect(f.state).toMatch(/^[\w-]{43}$/);
    expect(f.nonce).toMatch(/^[\w-]{32}$/);
    expect(f.challenge).toMatch(/^[\w-]{43}$/);
  });

  it('signs in with a valid ID token, creates the account and returns to ?next', async () => {
    const r = await googleSignIn();
    expect(r.location).toBe('/groups');
    expect(r.setCookie).toMatch(/hisaab_session=[\w-]{43};.*HttpOnly/);
    const me = await r.agent.get('/api/me');
    expect(me.body).toMatchObject({ user: { name: r.p.name } });
    // Same Google account again: same user, no duplicate.
    const again = request.agent(stack.app);
    const f = await begin(again, 'google');
    google.register('code-again', f.challenge, await google.idToken({ ...r.p, email_verified: true, nonce: f.nonce }));
    await finish(again, 'google', 'code-again', f.state);
    expect((await again.get('/api/me')).body).toEqual(me.body);
  });

  it.each([
    ['a bad signature', {}, { impostor: true }, 'invalid_id_token'],
    ['the wrong audience', { aud: 'someone-elses-client' }, {}, 'invalid_id_token'],
    ['the wrong issuer', { iss: 'https://evil.example' }, {}, 'invalid_id_token'],
    ['an expired token', {}, { expiresInSeconds: -120 }, 'invalid_id_token'],
    ['a nonce mismatch', { nonce: 'not-the-nonce' }, {}, 'invalid_id_token'],
    ['an unverified email', { email_verified: false }, {}, 'email_unverified'],
  ] as const)('rejects %s', async (_label, claims, opts, error) => {
    const r = await googleSignIn(claims, opts);
    expect(r.location).toBe(`/signin?error=${error}&provider=google`);
    expect(r.setCookie).not.toMatch(/hisaab_session=/);
  });

  it('rejects a code redeemed with the wrong PKCE verifier (the provider refuses)', async () => {
    const agent = request.agent(stack.app);
    const f = await begin(agent, 'google');
    google.register('pkce', 'challenge-for-a-different-verifier', await google.idToken({ ...person(), email_verified: true, nonce: f.nonce }));
    expect((await finish(agent, 'google', 'pkce', f.state)).location).toBe('/signin?error=token_exchange_failed&provider=google');
  });
});

describe('state', () => {
  it('rejects a callback without the browser-bound cookie (login CSRF)', async () => {
    const f = await begin(request.agent(stack.app), 'google');
    const res = await request(stack.app).get(`/api/auth/google/callback?code=x&state=${f.state}`);
    expect(res.headers.location).toBe('/signin?error=state_mismatch&provider=google');
  });

  it('rejects a replayed state even with the cookie', async () => {
    const r = await googleSignIn();
    expect(r.location).toBe('/groups');
    const replay = await request(stack.app)
      .get(`/api/auth/google/callback?code=again&state=${r.f.state}`)
      .set('Cookie', `hisaab_oauth=${r.f.state}`);
    expect(replay.headers.location).toBe('/signin?error=state_invalid&provider=google');
  });

  it('reports a cancelled consent screen', async () => {
    const res = await request(stack.app).get('/api/auth/google/callback?error=access_denied&state=x');
    expect(res.headers.location).toBe('/signin?error=cancelled&provider=google');
  });

  it('never redirects off-site after sign-in', async () => {
    for (const next of ['https://evil.example', '//evil.example', '/\\evil.example']) {
      const agent = request.agent(stack.app);
      const f = await begin(agent, 'google', next);
      google.register(`n-${f.state}`, f.challenge, await google.idToken({ ...person(), email_verified: true, nonce: f.nonce }));
      expect((await finish(agent, 'google', `n-${f.state}`, f.state)).location).toBe('/');
    }
  });
});

describe('GitHub sign-in (OAuth code + PKCE)', () => {
  const user = (overrides: Partial<GithubUser> = {}): GithubUser => {
    const n = Math.floor(Math.random() * 1e9);
    return {
      id: n, login: `bilal${n}`, name: 'Bilal Khan',
      emails: [{ email: `bilal${n}@example.com`, primary: true, verified: true }], ...overrides,
    };
  };

  async function githubSignIn(u: GithubUser) {
    const agent = request.agent(stack.app);
    const f = await begin(agent, 'github');
    expect(Object.fromEntries(f.url.searchParams)).toMatchObject({
      client_id: github.env.GITHUB_CLIENT_ID, scope: 'read:user user:email', code_challenge_method: 'S256',
      redirect_uri: 'http://localhost:5174/api/auth/github/callback',
    });
    const code = randomUUID();
    github.register(code, f.challenge, u);
    return { agent, ...(await finish(agent, 'github', code, f.state)) };
  }

  it('signs in with the verified primary email', async () => {
    const r = await githubSignIn(user());
    expect(r.location).toBe('/');
    expect((await r.agent.get('/api/me')).body).toMatchObject({ user: { name: 'Bilal Khan' } });
  });

  it('falls back to the login when there is no display name', async () => {
    const u = user({ name: null });
    const r = await githubSignIn(u);
    expect((await r.agent.get('/api/me')).body).toMatchObject({ user: { name: u.login } });
  });

  it('refuses an account whose primary email is unverified', async () => {
    const r = await githubSignIn(user({ emails: [
      { email: 'old@example.com', primary: false, verified: true },
      { email: 'new@example.com', primary: true, verified: false },
    ] }));
    expect(r.location).toBe('/signin?error=email_unverified&provider=github');
  });
});

describe('linking', () => {
  const ghUser = (email?: string): GithubUser => {
    const n = Math.floor(Math.random() * 1e9);
    return { id: n, login: `gh${n}`, name: `GH ${n}`, emails: [{ email: email ?? `gh${n}@example.com`, primary: true, verified: true }] };
  };

  /** Runs a GitHub link flow for whoever `agent` is signed in as. */
  async function linkGithub(agent: Agent, u: GithubUser) {
    const res = await agent.get('/api/auth/github/link');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location ?? '');
    const code = randomUUID();
    github.register(code, url.searchParams.get('code_challenge') ?? '', u);
    return finish(agent, 'github', code, url.searchParams.get('state') ?? '');
  }

  async function githubLogin(u: GithubUser) {
    const agent = request.agent(stack.app);
    const f = await begin(agent, 'github');
    const code = randomUUID();
    github.register(code, f.challenge, u);
    return { agent, ...(await finish(agent, 'github', code, f.state)) };
  }

  it('a signed-in user links GitHub, then can sign in with either', async () => {
    const g = await googleSignIn();
    const u = ghUser();
    expect((await linkGithub(g.agent, u)).location).toBe('/account?linked=github');
    const identities = (await g.agent.get('/api/auth/identities')).body as { identities: { provider: string }[] };
    expect(identities.identities.map((i) => i.provider)).toEqual(['github', 'google']);
    const viaGithub = await githubLogin(u);
    expect((await viaGithub.agent.get('/api/me')).body).toEqual((await g.agent.get('/api/me')).body);
  });

  it('refuses to link an identity that belongs to another account, or a second GitHub', async () => {
    const owner = await githubLogin(ghUser());
    expect(owner.location).toBe('/');
    const taken = ((await owner.agent.get('/api/auth/identities')).body as { identities: { email: string }[] }).identities[0]?.email ?? '';
    const someoneElse = await googleSignIn();
    const takenUser = ghUser(taken);
    takenUser.id = Number(/^gh(\d+)@/.exec(taken)?.[1]);
    expect((await linkGithub(someoneElse.agent, takenUser)).location).toBe('/account?error=identity_in_use&provider=github');

    const g = await googleSignIn();
    expect((await linkGithub(g.agent, ghUser())).location).toBe('/account?linked=github');
    expect((await linkGithub(g.agent, ghUser())).location).toBe('/account?error=provider_already_linked&provider=github');
  });

  it('never links by email: a new GitHub sign-in with an existing account’s email is refused', async () => {
    const g = await googleSignIn();
    const sameEmail = ghUser(g.p.email);
    const r = await githubLogin(sameEmail);
    expect(r.location).toBe('/signin?error=account_exists&provider=github');
    expect(r.setCookie).not.toMatch(/hisaab_session=/);
  });

  it('starting a link needs a session', async () => {
    expect((await request(stack.app).get('/api/auth/github/link')).status).toBe(401);
  });

  it('refuses to finish a link if the browser signed in as someone else meanwhile', async () => {
    const a = await googleSignIn();
    const res = await a.agent.get('/api/auth/github/link');
    const url = new URL(res.headers.location ?? '');
    // Same browser signs in as another Google account before the link returns.
    const f = await begin(a.agent, 'google');
    google.register('switch', f.challenge, await google.idToken({ ...person(), email_verified: true, nonce: f.nonce }));
    await finish(a.agent, 'google', 'switch', f.state);
    const code = randomUUID();
    github.register(code, url.searchParams.get('code_challenge') ?? '', ghUser());
    const r = await a.agent
      .get(`/api/auth/github/callback?code=${code}&state=${url.searchParams.get('state') ?? ''}`)
      .set('Cookie', `hisaab_oauth=${url.searchParams.get('state') ?? ''}`);
    expect(r.headers.location).toBe('/account?error=link_session_changed&provider=github');
  });
});
