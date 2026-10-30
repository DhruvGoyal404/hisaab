import { z } from 'zod';

const DEV_LOGIN_ENVS: readonly string[] = ['development', 'test'];

export function devLoginAllowed(nodeEnv: string): boolean {
  return DEV_LOGIN_ENVS.includes(nodeEnv);
}

/** Unset or empty (the .env.example placeholders) both mean "not configured". */
const optional = z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional());
const optionalUrl = z.preprocess((v) => (v === '' ? undefined : v), z.url().optional());

// Provider endpoints default to the real ones; overrides exist only so tests can point at mock
// servers, and are refused in production.
const ENDPOINT_OVERRIDES = [
  'GOOGLE_ISSUER', 'GOOGLE_AUTH_URL', 'GOOGLE_TOKEN_URL', 'GOOGLE_JWKS_URL',
  'GITHUB_AUTH_URL', 'GITHUB_TOKEN_URL', 'GITHUB_API_URL',
] as const;

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(8081),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Comma-separated list of origins allowed to send non-GET requests.
  WEB_ORIGINS: z
    .string()
    .default('http://localhost:5174')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean))
    .pipe(z.array(z.url()).min(1)),
  // Where the browser reaches the app; OAuth redirect URIs are built on it. Defaults to the first WEB_ORIGIN.
  PUBLIC_URL: optionalUrl,
  DEV_LOGIN: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // How many reverse proxies sit in front (production: exactly one, the edge Caddy), so req.ip and
  // the per-IP sign-in limit see the client, not the proxy. 0 trusts no X-Forwarded-For at all.
  TRUST_PROXY: z.coerce.number().int().min(0).max(3).default(0),
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  GITHUB_CLIENT_ID: optional,
  GITHUB_CLIENT_SECRET: optional,
  GOOGLE_ISSUER: optionalUrl,
  GOOGLE_AUTH_URL: optionalUrl,
  GOOGLE_TOKEN_URL: optionalUrl,
  GOOGLE_JWKS_URL: optionalUrl,
  GITHUB_AUTH_URL: optionalUrl,
  GITHUB_TOKEN_URL: optionalUrl,
  GITHUB_API_URL: optionalUrl,
}).superRefine((env, ctx) => {
  if (env.DEV_LOGIN && !devLoginAllowed(env.NODE_ENV)) {
    ctx.addIssue({
      code: 'custom',
      path: ['DEV_LOGIN'],
      message: `dev login may only be enabled when NODE_ENV is ${DEV_LOGIN_ENVS.join(' or ')}`,
    });
  }
  for (const [id, secret] of [['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']] as const) {
    if ((env[id] === undefined) !== (env[secret] === undefined)) {
      ctx.addIssue({ code: 'custom', path: [secret], message: `set both ${id} and ${secret}, or neither` });
    }
  }
  if (env.NODE_ENV === 'production') {
    // OAuth redirect URIs and the Origin check are built on these: production must be https.
    if (env.PUBLIC_URL === undefined) ctx.addIssue({ code: 'custom', path: ['PUBLIC_URL'], message: 'required in production' });
    else if (!env.PUBLIC_URL.startsWith('https://')) ctx.addIssue({ code: 'custom', path: ['PUBLIC_URL'], message: 'must be https in production' });
    if (env.WEB_ORIGINS.some((o) => !o.startsWith('https://'))) ctx.addIssue({ code: 'custom', path: ['WEB_ORIGINS'], message: 'must all be https in production' });
    for (const key of ENDPOINT_OVERRIDES) {
      if (env[key] !== undefined) ctx.addIssue({ code: 'custom', path: [key], message: 'endpoint overrides are for tests only' });
    }
  }
});

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  /** Accepted `iss` values for ID tokens. */
  issuers: string[];
  authUrl: string;
  tokenUrl: string;
  jwksUrl: string;
};
export type GithubConfig = { clientId: string; clientSecret: string; authUrl: string; tokenUrl: string; apiUrl: string };

export type Config = {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: string;
  webOrigins: string[];
  publicUrl: string;
  devLogin: boolean;
  trustProxy: number;
  google: GoogleConfig | undefined;
  github: GithubConfig | undefined;
};

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Validates the environment once at startup. Messages never include values (secrets and DATABASE_URL). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const google: GoogleConfig | undefined =
    e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET
      ? {
          clientId: e.GOOGLE_CLIENT_ID,
          clientSecret: e.GOOGLE_CLIENT_SECRET,
          issuers: e.GOOGLE_ISSUER ? [e.GOOGLE_ISSUER] : ['https://accounts.google.com', 'accounts.google.com'],
          authUrl: e.GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenUrl: e.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
          jwksUrl: e.GOOGLE_JWKS_URL ?? 'https://www.googleapis.com/oauth2/v3/certs',
        }
      : undefined;
  const github: GithubConfig | undefined =
    e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET
      ? {
          clientId: e.GITHUB_CLIENT_ID,
          clientSecret: e.GITHUB_CLIENT_SECRET,
          authUrl: e.GITHUB_AUTH_URL ?? 'https://github.com/login/oauth/authorize',
          tokenUrl: e.GITHUB_TOKEN_URL ?? 'https://github.com/login/oauth/access_token',
          apiUrl: e.GITHUB_API_URL ?? 'https://api.github.com',
        }
      : undefined;
  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    logLevel: e.LOG_LEVEL,
    webOrigins: e.WEB_ORIGINS,
    publicUrl: (e.PUBLIC_URL ?? e.WEB_ORIGINS[0] ?? '').replace(/\/$/, ''),
    devLogin: e.DEV_LOGIN,
    trustProxy: e.TRUST_PROXY,
    google,
    github,
  };
}
