import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button, btn, ErrorNote, Field, LegalLinks, Loading } from '../components/ui';
import { api } from '../lib/api';

/** Only relative paths inside the app, so ?next= can't send someone to another site. */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

const PROVIDER_NAME: Record<string, string> = { google: 'Google', github: 'GitHub' };

/** What went wrong, in words, for the ?error= codes the API redirects with. */
export function signInError(code: string | null, provider: string | null): string | null {
  if (!code) return null;
  const p = PROVIDER_NAME[provider ?? ''] ?? 'the provider';
  const other = provider === 'google' ? 'GitHub' : provider === 'github' ? 'Google' : 'the other provider';
  const messages: Record<string, string> = {
    account_exists: `An account with this email already exists. Sign in with ${other} (the way you signed in before), then link ${p} from your account page.`,
    email_unverified: `Your ${p} email address isn’t verified. Verify it with ${p}, then try again.`,
    cancelled: 'Sign-in was cancelled.',
    state_mismatch: 'That sign-in didn’t start in this browser, or took too long. Start again.',
    state_invalid: 'That sign-in link has expired or was already used. Start again.',
    account_disabled: 'This account has been deleted.',
    rate_limited: 'Too many sign-in attempts. Wait a few minutes, then try again.',
  };
  return messages[code] ?? `${p} couldn’t confirm your sign-in. Try again.`;
}

export function SignInPage() {
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers, staleTime: Infinity });
  const next = safeNext(params.get('next'));
  const failure = signInError(params.get('error'), params.get('provider'));
  const signIn = useMutation({
    mutationFn: (n: string) => api.devLogin(n),
    onSuccess: async () => {
      await qc.invalidateQueries();
      await navigate(next, { replace: true });
    },
  });

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    if (name.trim() === '') {
      setError('Enter the name your friends know you by');
      return;
    }
    setError(undefined);
    signIn.mutate(name.trim());
  };

  const p = providers.data;
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="stitch bg-band px-4 pb-10 pt-12 text-band-ink">
        <div className="mx-auto max-w-md">
          <h1 className="font-display text-5xl leading-none">Hisaab</h1>
          <p className="mt-3 text-lg">Split the bill at the table. Settle up in as few payments as possible.</p>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-md flex-1 space-y-6 px-4 py-8">
        <h2 className="font-display text-2xl">Sign in</h2>
        {failure && <p role="alert" className="rounded bg-danger-bg px-3 py-2 font-medium text-owe">{failure}</p>}
        {providers.isPending && <Loading what="sign-in options" />}
        <ErrorNote error={providers.error} />
        {p && (p.google || p.github) && (
          <div className="space-y-3">
            {p.google && (
              <a className={`${btn.primary} w-full`} href={`/api/auth/google/start?next=${encodeURIComponent(next)}`}>Continue with Google</a>
            )}
            {p.github && (
              <a className={`${btn.secondary} w-full`} href={`/api/auth/github/start?next=${encodeURIComponent(next)}`}>Continue with GitHub</a>
            )}
          </div>
        )}
        {p?.dev && (
          <form onSubmit={submit} noValidate className="space-y-4 border-t border-rule pt-6">
            <Field label="Your name" autoComplete="nickname" value={name} onChange={(e) => { setName(e.target.value); }} error={error} />
            <ErrorNote error={signIn.error} />
            <Button type="submit" variant={p.google || p.github ? 'secondary' : 'primary'} className="w-full" disabled={signIn.isPending}>
              {signIn.isPending ? 'Signing in…' : 'Sign in'}
            </Button>
            <p className="text-sm text-muted">Development sign-in: anyone can use any name. It is switched off in production.</p>
          </form>
        )}
        {p && !p.google && !p.github && !p.dev && <p>Sign-in isn’t set up on this server yet.</p>}
        <LegalLinks />
      </main>
    </div>
  );
}
