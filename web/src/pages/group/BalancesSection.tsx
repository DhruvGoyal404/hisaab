import { BalanceWords, ErrorNote, LedgerSection, Loading, Stamp } from '../../components/ui';
import type { GroupDetail } from '../../lib/api';
import { useBalances } from '../../lib/groupQueries';

export function BalancesSection({ group }: { group: GroupDetail }) {
  const balances = useBalances(group.groupId);
  const members = balances.data?.members ?? [];
  const allSquare = members.length > 0 && members.every((m) => m.balanceMinor === 0);
  return (
    <LedgerSection title="Balances" tabbed>
      {balances.isPending && <Loading what="balances" />}
      <ErrorNote error={balances.error} />
      {allSquare ? (
        <div className="flex items-center gap-4 py-3">
          <Stamp animate />
          <p className="text-muted">Everyone is square. Nobody owes anything.</p>
        </div>
      ) : (
        <ul className="ledger">
          {members.map((m) => (
            <li key={m.memberId} className="flex items-center justify-between gap-3 py-3">
              <span className="min-w-0 truncate font-medium">
                {m.memberId === group.me.memberId ? 'You' : m.name}
                {m.isGhost && <span className="ml-2 text-sm font-normal text-muted">not joined yet</span>}
              </span>
              <span className="text-right"><BalanceWords paise={m.balanceMinor} /></span>
            </li>
          ))}
        </ul>
      )}
    </LedgerSection>
  );
}
