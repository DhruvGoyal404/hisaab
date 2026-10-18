import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { io } from 'socket.io-client';
import { api, keys, type Activity } from '../lib/api';
import { useMe } from '../lib/auth';
import { GroupSync, type Status } from './sync';

type Realtime = { status: Status; track: (groupId: string, seq: number) => void };
const RealtimeContext = createContext<Realtime | null>(null);

export const useRealtime = (): Realtime | null => useContext(RealtimeContext);

/** A short sentence for screen readers about what just changed. */
function announce(items: Activity[]): string {
  const last = items.at(-1);
  if (!last) return '';
  const who = last.actorName ?? 'Someone';
  const what = typeof last.payload.description === 'string' ? last.payload.description : '';
  const text: Record<string, string> = {
    'expense.created': `${who} added ${what}`,
    'expense.edited': `${who} edited ${what}`,
    'expense.deleted': `${who} deleted ${what}`,
    'expense.restored': `${who} restored ${what}`,
    'settlement.created': 'A payment was recorded',
  };
  const line = text[last.type] ?? `${who} updated the group`;
  return items.length > 1 ? `${line}, and ${items.length - 1} more ${items.length === 2 ? 'change' : 'changes'}` : line;
}

/**
 * Real-time for a signed-in user (docs/REALTIME.md): one socket through the /api proxy; signals
 * invalidate the affected group's queries after catching up on activity over REST.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const qc = useQueryClient();
  const userId = me.data?.user.id;
  const [status, setStatus] = useState<Status>('offline');
  const [message, setMessage] = useState('');
  const sync = useRef<GroupSync | null>(null);
  // Seqs tracked before the socket exists (child effects run first) are replayed into it.
  const seen = useRef(new Map<string, number>());

  useEffect(() => {
    if (!userId) return;
    const socket = io({ path: '/api/socket.io', transports: ['websocket'] });
    const s = new GroupSync({
      socket,
      fetchAfter: api.activityAfter,
      onGroupChanged: (groupId, items) => {
        void qc.invalidateQueries({ queryKey: keys.group(groupId) });
        void qc.invalidateQueries({ queryKey: keys.myGroups });
        setMessage(announce(items));
      },
      onUnknownGroup: () => { void qc.invalidateQueries({ queryKey: keys.myGroups }); },
      onStatus: setStatus,
      onServerDisconnect: () => { void qc.invalidateQueries({ queryKey: keys.me }); },
    });
    for (const [g, seq] of seen.current) s.track(g, seq);
    sync.current = s;
    return () => {
      s.stop();
      sync.current = null;
      setStatus('offline');
    };
  }, [userId, qc]);

  const track = useCallback((groupId: string, seq: number) => {
    seen.current.set(groupId, Math.max(seq, seen.current.get(groupId) ?? -1));
    sync.current?.track(groupId, seq);
  }, []);

  const value = useMemo(() => ({ status, track }), [status, track]);
  return (
    <RealtimeContext.Provider value={value}>
      {children}
      <p className="sr-only" role="status" aria-live="polite">{message}</p>
    </RealtimeContext.Provider>
  );
}
