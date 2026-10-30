import { useEffect } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { AppShell, balanceText, btn, ErrorNote, Loading } from '../../components/ui';
import { useBalances, useGroup } from '../../lib/groupQueries';
import { useRealtime } from '../../realtime/RealtimeProvider';
import { ActivitySection } from './ActivitySection';
import { BalancesSection } from './BalancesSection';
import { MembersSection } from './MembersSection';
import { SettlePlanSection } from './SettlePlanSection';

const TABS = [
  { id: 'activity', label: 'Activity' },
  { id: 'balances', label: 'Balances' },
  { id: 'settle', label: 'Settle up' },
  { id: 'members', label: 'Members' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export function GroupPage() {
  const { groupId = '' } = useParams();
  const [params] = useSearchParams();
  const tab: Tab = TABS.some((t) => t.id === params.get('tab')) ? (params.get('tab') as Tab) : 'activity';
  const group = useGroup(groupId);
  const balances = useBalances(groupId);
  const mine = balances.data?.members.find((m) => m.memberId === group.data?.me.memberId);
  const realtime = useRealtime();
  const lastSeq = group.data?.lastSeq;
  useEffect(() => {
    if (lastSeq !== undefined) realtime?.track(groupId, lastSeq);
  }, [realtime, groupId, lastSeq]);
  const show = (t: Tab) => (tab === t ? '' : 'hidden lg:block');

  const addExpense = `/groups/${groupId}/expenses/new`;
  const settleUp = `/groups/${groupId}/settle`;
  return (
    <AppShell
      back={{ to: '/', label: 'All groups' }}
      title={
        <>
          <h1 className="truncate font-display text-3xl leading-tight">{group.data?.name ?? 'Group'}</h1>
          {/* Plain text on the cover band: the owe/owed colours don't have contrast on crimson. */}
          {mine && <p className="text-band-ink">{balanceText(mine.balanceMinor, true)}</p>}
        </>
      }
      actions={
        <div className="hidden gap-2 lg:flex">
          <Link to={settleUp} className="inline-flex min-h-11 items-center rounded border-2 border-band-ink px-4 font-semibold text-band-ink hover:bg-band-ink/15">Settle up</Link>
          <Link to={addExpense} className="inline-flex min-h-11 items-center rounded bg-page px-4 font-semibold text-ink">Add expense</Link>
        </div>
      }
      bottomBar={
        <>
          <Link to={settleUp} className={`${btn.secondary} flex-1`}>Settle up</Link>
          <Link to={addExpense} className={`${btn.primary} flex-[2]`}>Add expense</Link>
        </>
      }
    >
      {group.isPending && <Loading what="the group" />}
      <ErrorNote error={group.error} />
      {group.data && (
        <>
          <nav aria-label="Group sections" className="-mx-4 mb-6 overflow-x-auto border-b border-rule px-4 lg:hidden">
            <ul className="flex gap-1">
              {TABS.map((t) => (
                <li key={t.id}>
                  <Link
                    to={`?tab=${t.id}`}
                    replace
                    aria-current={tab === t.id ? 'page' : undefined}
                    className={`inline-flex min-h-11 items-center whitespace-nowrap border-b-2 px-3 font-medium ${tab === t.id ? 'border-accent text-ink' : 'border-transparent text-muted'}`}
                  >
                    {t.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_23rem] lg:gap-12">
            <div className={show('activity')}>
              <ActivitySection group={group.data} />
            </div>
            <div>
              <div className={show('balances')}><BalancesSection group={group.data} /></div>
              <div className={show('settle')}><SettlePlanSection group={group.data} /></div>
              <div className={show('members')}><MembersSection group={group.data} /></div>
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}
