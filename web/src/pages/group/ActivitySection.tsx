import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Button, cap, dateLabel, ErrorNote, LedgerSection, Loading, Money } from '../../components/ui';
import { api, keys, type Activity, type GroupDetail } from '../../lib/api';

type Line = { text: ReactNode; amount?: number; struck?: boolean; href?: string };

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** One activity row in plain words. Names for member ids come from the group's member list. */
export function describe(a: Activity, nameOf: (memberId: string) => string, groupId: string): Line {
  const who = a.actorName ?? 'Someone';
  const p = a.payload;
  const expense = (verb: string, struck = false): Line => {
    const amount = num(p.totalMinor);
    return {
      text: <>{who} {verb} <span className="font-semibold">{str(p.description, 'an expense')}</span></>,
      ...(amount !== undefined && { amount }), struck,
      ...(a.subjectId && { href: `/groups/${groupId}/expenses/${a.subjectId}` }),
    };
  };
  switch (a.type) {
    case 'expense.created': return expense('added');
    case 'expense.edited': return expense('edited');
    case 'expense.deleted': return expense('deleted', true);
    case 'expense.restored': return expense('restored');
    case 'settlement.created': {
      const amount = num(p.amountMinor);
      return {
        text: <><span className="font-semibold">{cap(nameOf(str(p.fromMemberId)))}</span> paid <span className="font-semibold">{nameOf(str(p.toMemberId))}</span></>,
        ...(amount !== undefined && { amount }),
      };
    }
    case 'group.created': return { text: <>{who} started the group</> };
    case 'member.added': return { text: <>{who} added {str(p.displayName, 'someone')}</> };
    case 'member.joined': return { text: <>{who} joined</> };
    case 'member.rejoined': return { text: <>{who} rejoined</> };
    case 'member.claimed': return { text: <>{who} joined as {str(p.ghostName, 'a placeholder')}</> };
    case 'member.merged': return { text: <>{who} linked {str(p.ghostName, 'a placeholder')} to their account</> };
    case 'member.left': return { text: <>{who} left the group</> };
    case 'invite.created': return { text: <>{who} created an invite link</> };
    case 'group.settings_changed':
      return { text: <>{who} {p.simplifyDebts === true ? 'turned on fewest payments' : 'switched to showing every debt'}</> };
    default: return { text: <>{who} made a change</> };
  }
}

export function ActivitySection({ group }: { group: GroupDetail }) {
  const feed = useInfiniteQuery({
    queryKey: keys.activity(group.groupId),
    queryFn: ({ pageParam }) => api.activity(group.groupId, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const names = new Map(group.members.map((m) => [m.memberId, m.isMe ? 'you' : m.name]));
  const nameOf = (id: string) => names.get(id) ?? 'a former member';

  // Keyset infinite scroll: load the next older page when the end of the list comes into view.
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = feed;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && hasNextPage && !isFetchingNextPage) void fetchNextPage();
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => { io.disconnect(); };
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <LedgerSection title="Activity" tabbed>
      {feed.isPending && <Loading what="activity" />}
      <ErrorNote error={feed.error} />
      <ol className="ledger" aria-label="Group activity, newest first">
        {items.map((a) => {
          const line = describe(a, nameOf, group.groupId);
          const body = (
            <>
              <span className="min-w-0">
                <span className="block">{line.text}</span>
                <span className="text-sm text-muted">{dateLabel(a.createdAt)}</span>
              </span>
              {line.amount !== undefined && (
                <Money paise={line.amount} className={`text-right font-medium ${line.struck ? 'text-muted line-through' : ''}`} />
              )}
            </>
          );
          return (
            <li key={a.seq}>
              {line.href ? (
                <Link to={line.href} className="flex items-start justify-between gap-3 py-3 hover:bg-sheet">{body}</Link>
              ) : (
                <div className="flex items-start justify-between gap-3 py-3">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
      <div ref={sentinel} />
      {hasNextPage && (
        <Button variant="secondary" className="mt-3" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
          {isFetchingNextPage ? 'Loading older activity…' : 'Show older activity'}
        </Button>
      )}
    </LedgerSection>
  );
}
