import type { Activity, ActivityAfter } from '../lib/api';

/** The slice of a socket.io-client Socket this uses, so tests can pass a fake. */
export interface SignalSocket {
  on(event: 'ready', fn: (info: { groups: string[] }) => void): unknown;
  on(event: 'group:changed', fn: (signal: { groupId: string; seq: number }) => void): unknown;
  on(event: 'resync', fn: () => void): unknown;
  on(event: 'disconnect', fn: (reason: string) => void): unknown;
  on(event: 'connect_error', fn: (err: Error) => void): unknown;
  emit(event: 'sync', lastSeen: Record<string, number>): unknown;
  disconnect(): unknown;
}

export type Status = 'connecting' | 'live' | 'offline';

export type SyncDeps = {
  socket: SignalSocket;
  /** GET /groups/:id/activity?afterSeq= (one page). */
  fetchAfter: (groupId: string, afterSeq: number) => Promise<ActivityAfter>;
  /** The group changed: refresh what is shown. `items` are the new activity rows, oldest first. */
  onGroupChanged: (groupId: string, items: Activity[]) => void;
  /** A group the client knows nothing about yet changed (e.g. it was just added): refresh lists. */
  onUnknownGroup: (groupId: string) => void;
  onStatus: (status: Status) => void;
  /** The server dropped us (logout, revoked or expired session): re-check the session. */
  onServerDisconnect: () => void;
};

/**
 * The client half of docs/REALTIME.md. Signals only say "group X is at seq N"; data comes from
 * REST. Tracks lastSeen per group and fetches activity after it whenever a signal is newer.
 * Late or duplicate signals (seq <= lastSeen) are ignored; several signals during one fetch
 * coalesce into one more pass. On ready (first connect or reconnect) and on resync, it tells the
 * server what it has seen, and the server answers for every group it is behind on.
 */
export class GroupSync {
  private readonly lastSeen = new Map<string, number>();
  private readonly running = new Map<string, Promise<void>>();
  /** Highest seq signalled while a catch-up was running; another pass runs only if still ahead. */
  private readonly pending = new Map<string, number>();

  constructor(private readonly deps: SyncDeps) {
    const { socket } = deps;
    deps.onStatus('connecting');
    socket.on('ready', () => {
      deps.onStatus('live');
      this.sendSync();
    });
    socket.on('resync', () => { this.sendSync(); });
    socket.on('group:changed', ({ groupId, seq }) => { this.onSignal(groupId, seq); });
    socket.on('disconnect', (reason) => {
      deps.onStatus('offline');
      if (reason === 'io server disconnect') deps.onServerDisconnect();
    });
    socket.on('connect_error', () => { deps.onStatus('offline'); });
  }

  /** Record what a REST read showed (e.g. group detail's lastSeq). Only ever moves forward. */
  track(groupId: string, seq: number): void {
    if (seq > (this.lastSeen.get(groupId) ?? -1)) this.lastSeen.set(groupId, seq);
  }

  seen(groupId: string): number | undefined {
    return this.lastSeen.get(groupId);
  }

  stop(): void {
    this.deps.socket.disconnect();
  }

  private sendSync(): void {
    this.deps.socket.emit('sync', Object.fromEntries(this.lastSeen));
  }

  private onSignal(groupId: string, seq: number): void {
    const seen = this.lastSeen.get(groupId);
    if (seen === undefined) {
      // Not open on this device: no feed to catch up, just refresh lists and start tracking.
      this.lastSeen.set(groupId, seq);
      this.deps.onUnknownGroup(groupId);
      return;
    }
    if (seq <= seen) return; // late or duplicate: already have it
    if (this.running.has(groupId)) {
      this.pending.set(groupId, Math.max(seq, this.pending.get(groupId) ?? 0));
      return;
    }
    const run = this.catchUp(groupId).finally(() => {
      this.running.delete(groupId);
      const next = this.pending.get(groupId);
      this.pending.delete(groupId);
      if (next !== undefined) this.onSignal(groupId, next); // no-op if the last fetch already covered it
    });
    this.running.set(groupId, run);
  }

  /** Fetch every activity row after lastSeen (following pages), then advance lastSeen. */
  private async catchUp(groupId: string): Promise<void> {
    const items: Activity[] = [];
    for (;;) {
      const after = this.lastSeen.get(groupId) ?? 0;
      let page: ActivityAfter;
      try {
        page = await this.deps.fetchAfter(groupId, after);
      } catch {
        return; // offline or forbidden: the next signal, sync or reconnect retries
      }
      items.push(...page.items);
      const newest = page.items.at(-1)?.seq ?? page.lastSeq;
      this.track(groupId, page.hasMore ? newest : page.lastSeq);
      if (!page.hasMore) break;
    }
    if (items.length > 0) this.deps.onGroupChanged(groupId, items);
  }
}
