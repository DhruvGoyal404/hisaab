import { parseCookie } from 'cookie';
import { Router, type Response } from 'express';
import type pg from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { notFound } from '../repo/tx.js';
import { startSession } from '../sessions.js';
import { signInWith } from './accounts.js';
import { consumeFlow, isProvider, OAuthError, safeReturnTo, startFlow, type Flow, type Provider } from './flows.js';
import { githubAuthorizeUrl, githubProfile } from './github.js';
import { googleAuthorizeUrl, googleProfile, type Profile } from './google.js';

/** Binds a flow to the browser that started it (login CSRF defence); compared with ?state on return. */
export const FLOW_COOKIE = 'hisaab_oauth';
const FLOW_COOKIE_PATH = '/api/auth';

export function oauthRouter(pool: pg.Pool, config: Config, logger: Logger): Router {
  const router = Router();
  const secure = config.nodeEnv === 'production';
  const redirectUri = (p: Provider) => `${config.publicUrl}/api/auth/${p}/callback`;
  const configured = (p: string): p is Provider => isProvider(p) && config[p] !== undefined;

  const authorizeUrl = (p: Provider, f: { state: string; codeChallenge: string; nonce: string | null }): string => {
    if (p === 'google' && config.google) return googleAuthorizeUrl(config.google, redirectUri(p), f);
    if (p === 'github' && config.github) return githubAuthorizeUrl(config.github, redirectUri(p), f);
    throw notFound();
  };
  const profileFor = (p: Provider, code: string, flow: Flow): Promise<Profile> => {
    if (p === 'google' && config.google) return googleProfile(config.google, redirectUri(p), code, flow);
    if (p === 'github' && config.github) return githubProfile(config.github, redirectUri(p), code, flow);
    throw notFound();
  };

  async function begin(res: Response, provider: Provider, purpose: 'login' | 'link', returnTo: string, userId?: string) {
    const f = await startFlow(pool, { provider, purpose, returnTo, ...(userId !== undefined && { userId }) });
    res.cookie(FLOW_COOKIE, f.state, { httpOnly: true, sameSite: 'lax', secure, path: FLOW_COOKIE_PATH, maxAge: 10 * 60 * 1000 });
    res.redirect(302, authorizeUrl(provider, f));
  }

  /** Which sign-in options the sign-in page should offer. */
  router.get('/auth/providers', (_req, res) => {
    res.json({ google: config.google !== undefined, github: config.github !== undefined, dev: config.devLogin });
  });

  router.get('/auth/:provider/start', async (req, res) => {
    const { provider } = req.params;
    if (!configured(provider)) throw notFound();
    await begin(res, provider, 'login', safeReturnTo(req.query.next));
  });

  router.get('/auth/:provider/callback', async (req, res) => {
    const { provider } = req.params;
    if (!configured(provider)) throw notFound();
    const cookieState = parseCookie(req.get('cookie') ?? '')[FLOW_COOKIE];
    res.clearCookie(FLOW_COOKIE, { path: FLOW_COOKIE_PATH });
    const fail = (code: string, flow?: Flow) => {
      const page = flow?.purpose === 'link' ? '/account' : '/signin';
      res.redirect(302, `${page}?error=${encodeURIComponent(code)}&provider=${provider}`);
    };

    const { state, code, error } = req.query;
    if (typeof error === 'string') {
      fail(error === 'access_denied' ? 'cancelled' : 'provider_error');
      return;
    }
    if (typeof state !== 'string' || typeof code !== 'string' || !cookieState || cookieState !== state) {
      fail('state_mismatch');
      return;
    }
    const flow = await consumeFlow(pool, state);
    if (!flow || flow.provider !== provider) {
      fail('state_invalid');
      return;
    }

    let profile: Profile;
    try {
      profile = await profileFor(provider, code, flow);
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      logger.warn({ provider, code: err.code, detail: err.message }, 'sign-in rejected');
      fail(err.code, flow);
      return;
    }

    if (flow.purpose === 'login') {
      const result = await signInWith(pool, provider, profile);
      if ('error' in result) {
        fail(result.error, flow);
        return;
      }
      await startSession(pool, req, res, result.userId, secure);
      res.redirect(302, flow.returnTo);
      return;
    }
    // Linking is handled in a later step; until then a link flow cannot complete.
    fail('state_invalid', flow);
  });

  return router;
}

