// Local stand-ins for Google and GitHub, so the real sign-in code runs end to end in tests.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  return body;
}

const json = (res: ServerResponse, status: number, body: unknown): ServerResponse =>
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<ServerResponse>): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    handler(req, res).catch(() => json(res, 500, { error: 'mock_failure' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

export const GOOGLE_CLIENT_ID = 'hisaab-test.apps.googleusercontent.com';

/**
 * Google: a JWKS endpoint publishing one RSA key, and a token endpoint that checks the PKCE verifier
 * against the challenge registered for a code and returns the ID token the test prepared.
 */
export async function mockGoogle() {
  const real = await generateKeyPair('RS256');
  const impostor = await generateKeyPair('RS256'); // same kid, not published
  const jwk = { ...(await exportJWK(real.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { challenge: string; idToken: string }>();

  const { server, url } = await listen(async (req, res) => {
    if (req.method === 'GET' && req.url === '/jwks') return json(res, 200, { keys: [jwk] });
    if (req.method === 'POST' && req.url === '/token') {
      const form = new URLSearchParams(await readBody(req));
      const entry = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      if (!entry || form.get('client_id') !== GOOGLE_CLIENT_ID || form.get('grant_type') !== 'authorization_code') {
        return json(res, 400, { error: 'invalid_grant' });
      }
      if (s256(form.get('code_verifier') ?? '') !== entry.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
      return json(res, 200, { access_token: 'ya29.test', id_token: entry.idToken, token_type: 'Bearer', expires_in: 3599 });
    }
    return json(res, 404, {});
  });

  return {
    url,
    issuer: url,
    env: {
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: 'test-secret',
      GOOGLE_ISSUER: url,
      GOOGLE_AUTH_URL: `${url}/authorize`,
      GOOGLE_TOKEN_URL: `${url}/token`,
      GOOGLE_JWKS_URL: `${url}/jwks`,
    },
    /** An ID token; override any claim, or sign with the unpublished key. */
    idToken: async (claims: JWTPayload & Record<string, unknown>, opts: { impostor?: boolean; expiresInSeconds?: number } = {}) => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ iss: url, aud: GOOGLE_CLIENT_ID, iat: now, exp: now + (opts.expiresInSeconds ?? 3600), ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .sign((opts.impostor ? impostor : real).privateKey);
    },
    register: (code: string, challenge: string, idToken: string) => { codes.set(code, { challenge, idToken }); },
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
  };
}

export type GithubUser = { id: number; login: string; name: string | null; emails: { email: string; primary: boolean; verified: boolean }[] };

/** GitHub: token endpoint (PKCE-checked), /user and /user/emails behind the issued token. */
export async function mockGithub() {
  const codes = new Map<string, { challenge: string; user: GithubUser }>();
  const tokens = new Map<string, GithubUser>();

  const { server, url } = await listen(async (req, res) => {
    if (req.method === 'POST' && req.url === '/login/oauth/access_token') {
      const body = JSON.parse(await readBody(req)) as Record<string, string>;
      const entry = codes.get(body.code ?? '');
      codes.delete(body.code ?? '');
      if (!entry) return json(res, 200, { error: 'bad_verification_code' });
      if (s256(body.code_verifier ?? '') !== entry.challenge) return json(res, 200, { error: 'invalid_grant' });
      const token = `gho_${Math.random().toString(36).slice(2)}`;
      tokens.set(token, entry.user);
      return json(res, 200, { access_token: token, token_type: 'bearer', scope: 'read:user,user:email' });
    }
    const user = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!user) return json(res, 401, { message: 'Bad credentials' });
    if (req.url === '/user') return json(res, 200, { id: user.id, login: user.login, name: user.name });
    if (req.url === '/user/emails') return json(res, 200, user.emails);
    return json(res, 404, {});
  });

  return {
    url,
    env: {
      GITHUB_CLIENT_ID: 'Iv1.testclient',
      GITHUB_CLIENT_SECRET: 'test-secret',
      GITHUB_AUTH_URL: `${url}/login/oauth/authorize`,
      GITHUB_TOKEN_URL: `${url}/login/oauth/access_token`,
      GITHUB_API_URL: url,
    },
    register: (code: string, challenge: string, user: GithubUser) => { codes.set(code, { challenge, user }); },
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
  };
}
