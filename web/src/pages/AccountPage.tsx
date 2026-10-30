import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { AppShell, btn, Button, dateLabel, ErrorNote, LedgerSection, LegalLinks, Loading, ThemePicker } from '../components/ui';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { signInError } from './SignInPage';

const NAME = { google: 'Google', github: 'GitHub' } as const;

function linkMessage(params: URLSearchParams): { ok: boolean; text: string } | null {
  const linked = params.get('linked');
  if (linked === 'google' || linked === 'github') return { ok: true, text: `${NAME[linked]} is linked. You can sign in with it from now on.` };
  const error = params.get('error');
  if (!error) return null;
  const raw = params.get('provider');
  const p = raw === 'google' || raw === 'github' ? NAME[raw] : 'That account';
  const text: Record<string, string> = {
    identity_in_use: `That ${p} account already belongs to another Hisaab account, so it can’t be linked here.`,
    provider_already_linked: `You already have a ${p} account linked.`,
    link_session_changed: 'You signed in as someone else while linking. Start again.',
  };
  return { ok: false, text: text[error] ?? signInError(error, params.get('provider')) ?? 'Linking failed. Try again.' };
}

export function AccountPage() {
  const me = useMe();
  const [params] = useSearchParams();
  const identities = useQuery({ queryKey: ['identities'], queryFn: api.identities });
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers, staleTime: Infinity });
  const message = linkMessage(params);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const leave = async () => {
    qc.clear();
    await navigate('/signin', { replace: true });
  };
  const signOut = useMutation({ mutationFn: api.logout, onSuccess: leave });
  const signOutEverywhere = useMutation({ mutationFn: api.logoutAll, onSuccess: leave });
  const deleteAccount = useMutation({ mutationFn: api.deleteAccount, onSuccess: leave });
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const linked = new Set(identities.data?.identities.map((i) => i.provider));
  const linkable = (['google', 'github'] as const).filter((p) => providers.data?.[p] && !linked.has(p));

  return (
    <AppShell back={{ to: '/', label: 'All groups' }} title={<h1 className="font-display text-3xl leading-tight">Your account</h1>}>
      <div className="max-w-xl">
        <p className="mb-6 text-lg">Signed in as <span className="font-semibold">{me.data?.user.name}</span></p>
        {message && (
          <p role={message.ok ? 'status' : 'alert'} className={`mb-6 rounded px-3 py-2 font-medium ${message.ok ? 'bg-sheet' : 'bg-danger-bg text-owe'}`}>
            {message.text}
          </p>
        )}

        <LedgerSection title="Ways to sign in">
          {identities.isPending && <Loading what="sign-in methods" />}
          <ErrorNote error={identities.error} />
          {identities.data && identities.data.identities.length === 0 && (
            <p className="text-muted">None yet: this account uses the development sign-in.</p>
          )}
          <ul className="ledger">
            {identities.data?.identities.map((i) => (
              <li key={i.provider} className="flex items-center justify-between gap-3 py-3">
                <span className="font-medium">{NAME[i.provider]}</span>
                <span className="text-right text-muted">{i.email}<span className="block text-sm">linked {dateLabel(i.linkedAt)}</span></span>
              </li>
            ))}
          </ul>
          {linkable.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-3">
              {linkable.map((p) => (
                <a key={p} className={btn.secondary} href={`/api/auth/${p}/link`}>Link {NAME[p]}</a>
              ))}
            </div>
          )}
          <p className="mt-3 text-sm text-muted">
            Linking lets you sign in with either. Accounts are never joined just because the email addresses match.
          </p>
        </LedgerSection>

        <LedgerSection title="Appearance">
          <ThemePicker />
          <p className="mt-1 text-sm text-muted">Remembered on this browser. System follows your device’s setting.</p>
        </LedgerSection>

        <LedgerSection title="Sessions">
          <p className="mb-3 text-muted">Signed in on another phone or laptop you no longer use? Sign out everywhere ends every session, including this one.</p>
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => { signOut.mutate(); }} disabled={signOut.isPending}>Sign out</Button>
            <Button variant="secondary" onClick={() => { signOutEverywhere.mutate(); }} disabled={signOutEverywhere.isPending}>Sign out everywhere</Button>
          </div>
          <ErrorNote error={signOut.error ?? signOutEverywhere.error} />
        </LedgerSection>

        <LedgerSection title="Delete account">
          <p className="mb-3 text-muted">
            Your groups keep every expense and balance. Where you were a member you become “Deleted user”, so what you owe
            or are owed stays on the books. Your sign-ins and sessions are removed, and this can’t be undone.
          </p>
          {confirmingDelete ? (
            <div className="flex flex-wrap gap-3">
              <Button
                variant="secondary" className="border-owe text-owe"
                onClick={() => { deleteAccount.mutate(); }} disabled={deleteAccount.isPending}
              >Delete my account</Button>
              <Button variant="quiet" onClick={() => { setConfirmingDelete(false); }}>Keep my account</Button>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => { setConfirmingDelete(true); }}>Delete account…</Button>
          )}
          <ErrorNote error={deleteAccount.error} />
        </LedgerSection>
        <LegalLinks />
      </div>
    </AppShell>
  );
}
