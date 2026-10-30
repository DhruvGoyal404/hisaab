import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { btn, cap, ErrorNote, LedgerSection, Loading, Money, Stamp } from '../../components/ui';
import { api, keys, type GroupDetail } from '../../lib/api';

type Mode = 'auto' | 'raw';

export function SettlePlanSection({ group }: { group: GroupDetail }) {
  const [mode, setMode] = useState<Mode>(group.simplifyDebts ? 'auto' : 'raw');
  const plan = useQuery({ queryKey: keys.plan(group.groupId, mode), queryFn: () => api.settlePlan(group.groupId, mode) });
  const names = new Map(group.members.map((m) => [m.memberId, m.isMe ? 'you' : m.name]));
  const nameOf = (id: string) => names.get(id) ?? 'a former member';
  const transfers = plan.data?.transfers ?? [];

  return (
    <LedgerSection title="Settle up" tabbed>
      <fieldset className="mb-3">
        <legend className="sr-only">Show payments as</legend>
        <div className="inline-flex rounded border border-field-line p-0.5">
          {([['auto', 'Fewest payments'], ['raw', 'Every debt']] as const).map(([m, label]) => (
            <label key={m} className={`cursor-pointer rounded px-3 py-2 font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--focus)] ${mode === m ? 'bg-ink text-page' : 'text-ink'}`}>
              <input type="radio" name={`mode-${group.groupId}`} value={m} checked={mode === m} onChange={() => { setMode(m); }} className="sr-only" />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <details className="mb-4 text-muted">
        <summary className="cursor-pointer font-medium text-ink">Why fewer payments?</summary>
        <p className="mt-2">
          “Fewest payments” works out the smallest number of transfers that leaves everyone square. Each person still pays or
          gets back exactly the same total; only who pays whom changes, so someone may pay a friend they never shared a bill with.
          “Every debt” shows who owes whom from the expenses themselves.
        </p>
      </details>

      {plan.isPending && <Loading what="payments" />}
      <ErrorNote error={plan.error} />
      {plan.data && transfers.length === 0 && (
        <div className="flex items-center gap-4 py-2">
          <Stamp />
          <p className="text-muted">No payments needed.</p>
        </div>
      )}
      {transfers.length > 0 && (
        <>
          <p className="mb-2 text-muted">
            {transfers.length === 1 ? '1 payment settles everyone.' : `${transfers.length} payments settle everyone.`}
          </p>
          <ul className="ledger">
            {transfers.map((t) => (
              <li key={`${t.from}-${t.to}`} className="flex items-center justify-between gap-3 py-3">
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  <span className="inline-block font-semibold">{cap(nameOf(t.from))}</span> {t.from === group.me.memberId ? 'pay' : 'pays'}{' '}
                  <span className="inline-block font-semibold">{nameOf(t.to)}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <Money paise={t.amountMinor} className="font-semibold" />
                  <Link
                    to={`/groups/${group.groupId}/settle?from=${t.from}&to=${t.to}&amount=${t.amountMinor}`}
                    className={`${btn.secondary} min-h-9 px-3 text-sm`}
                    aria-label={`Record ${nameOf(t.from)} paying ${nameOf(t.to)}`.replace(/^Record you paying/, 'Record your payment to')}
                  >
                    Record
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </LedgerSection>
  );
}
