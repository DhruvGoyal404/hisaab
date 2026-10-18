import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button, ErrorNote, Field } from '../components/ui';
import { api } from '../lib/api';

/** Only relative paths inside the app, so ?next= can't send someone to another site. */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function SignInPage() {
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const signIn = useMutation({
    mutationFn: (n: string) => api.devLogin(n),
    onSuccess: async () => {
      await qc.invalidateQueries();
      await navigate(safeNext(params.get('next')), { replace: true });
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

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="stitch bg-band px-4 pb-10 pt-12 text-band-ink">
        <div className="mx-auto max-w-md">
          <h1 className="font-display text-5xl leading-none">Hisaab</h1>
          <p className="mt-3 text-lg">Split the bill at the table. Settle up in as few payments as possible.</p>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-md flex-1 px-4 py-8">
        <form onSubmit={submit} noValidate className="space-y-4">
          <h2 className="font-display text-2xl">Sign in</h2>
          <Field label="Your name" autoComplete="nickname" value={name} onChange={(e) => { setName(e.target.value); }} error={error} />
          <ErrorNote error={signIn.error} />
          <Button type="submit" className="w-full" disabled={signIn.isPending}>
            {signIn.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
          <p className="text-sm text-muted">This is the development sign-in: anyone can use any name. Google and GitHub sign-in come later.</p>
        </form>
      </main>
    </div>
  );
}
