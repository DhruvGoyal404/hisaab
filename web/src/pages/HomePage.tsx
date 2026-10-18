import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { AppShell, BalanceWords, Button, ErrorNote, Field, LedgerSection, Loading, Money, Stamp } from '../components/ui';
import { api, keys } from '../lib/api';
import { useMe } from '../lib/auth';

export function HomePage() {
  const me = useMe();
  const groups = useQuery({ queryKey: keys.myGroups, queryFn: api.myGroups });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation({
    mutationFn: api.logout,
    onSuccess: async () => {
      qc.clear();
      await navigate('/signin', { replace: true });
    },
  });

  const total = groups.data?.totals.find((t) => t.currency === 'INR');
  return (
    <AppShell
      title={<span className="font-display text-3xl leading-none">Hisaab</span>}
      actions={
        <Button variant="quiet" className="text-band-ink" onClick={() => { signOut.mutate(); }}>
          Sign out
        </Button>
      }
    >
      <p className="mb-1 text-muted">Signed in as {me.data?.user.name}</p>
      {groups.isPending && <Loading what="your groups" />}
      <ErrorNote error={groups.error} />
      {groups.data && (
        <>
          <section aria-labelledby="overall" className="mb-8">
            <h1 id="overall" className="sr-only">Your balance across groups</h1>
            {!total || total.netMinor === 0 ? (
              <div className="flex items-center gap-4 py-2">
                <Stamp />
                <p className="text-muted">{groups.data.groups.length === 0 ? 'Nothing to settle yet.' : 'You don’t owe anyone, and nobody owes you.'}</p>
              </div>
            ) : (
              <>
                <p className={`font-display text-4xl leading-tight ${total.netMinor > 0 ? 'text-owed' : 'text-owe'}`}>
                  {total.netMinor > 0 ? 'You are owed ' : 'You owe '}
                  <Money paise={total.netMinor} />
                </p>
                {total.owedToMeMinor > 0 && total.iOweMinor > 0 && (
                  <p className="mt-1 text-muted">
                    Owed <Money paise={total.owedToMeMinor} /> in some groups, owing <Money paise={total.iOweMinor} /> in others.
                  </p>
                )}
              </>
            )}
          </section>

          <LedgerSection title="Your groups">
            {groups.data.groups.length === 0 ? (
              <p className="text-muted">No groups yet. Start one for your next trip, your flat or your Friday dinners.</p>
            ) : (
              <ul className="ledger">
                {groups.data.groups.map((g) => (
                  <li key={g.groupId}>
                    <Link to={`/groups/${g.groupId}`} className="flex min-h-14 items-center justify-between gap-3 py-2 hover:bg-sheet">
                      <span className="truncate text-lg font-medium">{g.name}</span>
                      <span className="text-right"><BalanceWords paise={g.balanceMinor} self /></span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </LedgerSection>
          <NewGroup />
        </>
      )}
    </AppShell>
  );
}

function NewGroup() {
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: (n: string) => api.createGroup(n),
    onSuccess: async ({ groupId }) => {
      await qc.invalidateQueries({ queryKey: keys.myGroups });
      await navigate(`/groups/${groupId}`);
    },
  });
  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    if (name.trim() === '') {
      setError('Give the group a name, like “Goa trip”');
      return;
    }
    setError(undefined);
    create.mutate(name.trim());
  };
  return (
    <form onSubmit={submit} noValidate className="max-w-md space-y-3">
      <h2 className="font-display text-2xl">Start a group</h2>
      <Field label="Group name" value={name} maxLength={80} onChange={(e) => { setName(e.target.value); }} error={error} />
      <ErrorNote error={create.error} />
      <Button type="submit" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create group'}</Button>
    </form>
  );
}
