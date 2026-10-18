import { describe, expect, it, vi } from 'vitest';
import type { Activity, ActivityAfter } from '../lib/api';
import { GroupSync, type SignalSocket, type Status } from './sync';

/** A socket that records emits and lets the test fire server events. */
class FakeSocket implements SignalSocket {
  private readonly handlers = new Map<string, ((...a: never[]) => void)[]>();
  readonly emitted: [string, unknown][] = [];
  disconnected = false;
  on(event: string, fn: (...a: never[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string, payload: unknown) {
    this.emitted.push([event, payload]);
    return this;
  }
  disconnect() {
    this.disconnected = true;
    return this;
  }
  fire(event: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(event) ?? []) (fn as (...a: unknown[]) => void)(...args);
  }
}

const G = 'group-1';
const row = (seq: number): Activity => ({ seq, id: `a${seq}`, type: 'expense.created', subjectId: null, payload: {}, createdAt: '', actorName: 'Asha' });

/** A fake REST endpoint over activity rows 1..head, paged `pageSize` at a time. */
function server(head: () => number, pageSize = 200) {
  const calls: number[] = [];
  const fetchAfter = vi.fn(async (_g: string, after: number): Promise<ActivityAfter> => {
    calls.push(after);
    // Snapshot at request time, like a real REST read; the response arrives a tick later.
    const top = head();
    const items: Activity[] = [];
    for (let s = after + 1; s <= top && items.length < pageSize; s++) items.push(row(s));
    await Promise.resolve();
    return { items, lastSeq: top, hasMore: after + items.length < top };
  });
  return { fetchAfter, calls };
}

function setup(head: () => number, pageSize?: number) {
  const socket = new FakeSocket();
  const { fetchAfter, calls } = server(head, pageSize);
  const changed: [string, number[]][] = [];
  const statuses: Status[] = [];
  const onUnknownGroup = vi.fn();
  const onServerDisconnect = vi.fn();
  const sync = new GroupSync({
    socket, fetchAfter, onUnknownGroup, onServerDisconnect,
    onGroupChanged: (g, items) => changed.push([g, items.map((i) => i.seq)]),
    onStatus: (s) => statuses.push(s),
  });
  return { socket, sync, calls, changed, statuses, onUnknownGroup, onServerDisconnect };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('GroupSync', () => {
  it('a contiguous signal fetches exactly the new row and advances lastSeen', async () => {
    let head = 5;
    const t = setup(() => head);
    t.sync.track(G, 5);
    head = 6;
    t.socket.fire('group:changed', { groupId: G, seq: 6 });
    await settle();
    expect(t.calls).toEqual([5]);
    expect(t.changed).toEqual([[G, [6]]]);
    expect(t.sync.seen(G)).toBe(6);
  });

  it('a gap (missed signals) fetches everything after lastSeen in one catch-up', async () => {
    let head = 5;
    const t = setup(() => head);
    t.sync.track(G, 5);
    head = 9;
    t.socket.fire('group:changed', { groupId: G, seq: 9 });
    await settle();
    expect(t.calls).toEqual([5]);
    expect(t.changed).toEqual([[G, [6, 7, 8, 9]]]);
    expect(t.sync.seen(G)).toBe(9);
  });

  it('ignores duplicate and late signals', async () => {
    const head = 7;
    const t = setup(() => head);
    t.sync.track(G, 7);
    t.socket.fire('group:changed', { groupId: G, seq: 7 }); // duplicate
    t.socket.fire('group:changed', { groupId: G, seq: 3 }); // late
    await settle();
    expect(t.calls).toEqual([]);
    expect(t.changed).toEqual([]);
  });

  it('coalesces signals that arrive during a fetch into one more pass', async () => {
    let head = 2;
    const t = setup(() => head);
    t.sync.track(G, 1);
    t.socket.fire('group:changed', { groupId: G, seq: 2 });
    head = 4;
    t.socket.fire('group:changed', { groupId: G, seq: 3 });
    t.socket.fire('group:changed', { groupId: G, seq: 4 });
    await settle();
    await settle();
    expect(t.calls).toEqual([1, 2]); // two fetches, not three
    expect(t.changed.flatMap(([, s]) => s)).toEqual([2, 3, 4]);
    expect(t.sync.seen(G)).toBe(4);
  });

  it('skips the extra pass when the running fetch already covered the coalesced signals', async () => {
    let head = 1;
    const t = setup(() => head);
    t.sync.track(G, 1);
    head = 4; // the write for seq 4 already committed when the first fetch reads
    t.socket.fire('group:changed', { groupId: G, seq: 2 });
    t.socket.fire('group:changed', { groupId: G, seq: 3 });
    t.socket.fire('group:changed', { groupId: G, seq: 4 });
    await settle();
    await settle();
    expect(t.calls).toEqual([1]);
    expect(t.changed).toEqual([[G, [2, 3, 4]]]);
  });

  it('follows pages until caught up', async () => {
    let head = 0;
    const t = setup(() => head, 2);
    t.sync.track(G, 0);
    head = 5;
    t.socket.fire('group:changed', { groupId: G, seq: 5 });
    await settle();
    await settle();
    expect(t.calls).toEqual([0, 2, 4]);
    expect(t.changed).toEqual([[G, [1, 2, 3, 4, 5]]]);
  });

  it('on ready and on resync, sends what it has seen; the server answers per group', async () => {
    const t = setup(() => 0);
    t.sync.track(G, 12);
    t.sync.track('group-2', 3);
    t.socket.fire('ready', { groups: [G, 'group-2'] });
    t.socket.fire('resync');
    await settle();
    expect(t.socket.emitted).toEqual([
      ['sync', { [G]: 12, 'group-2': 3 }],
      ['sync', { [G]: 12, 'group-2': 3 }],
    ]);
  });

  it('a reconnect after missing signals catches up via sync and the reply', async () => {
    let head = 4;
    const t = setup(() => head);
    t.sync.track(G, 4);
    t.socket.fire('disconnect', 'transport close');
    head = 8; // writes while offline
    t.socket.fire('ready', { groups: [G] }); // reconnected
    expect(t.socket.emitted.at(-1)).toEqual(['sync', { [G]: 4 }]);
    t.socket.fire('group:changed', { groupId: G, seq: 8 }); // the server's reply
    await settle();
    expect(t.changed).toEqual([[G, [5, 6, 7, 8]]]);
    expect(t.statuses).toEqual(['connecting', 'offline', 'live']);
  });

  it('a signal for a group not tracked on this device refreshes lists without a catch-up', async () => {
    const t = setup(() => 9);
    t.socket.fire('group:changed', { groupId: 'new-group', seq: 9 });
    await settle();
    expect(t.onUnknownGroup).toHaveBeenCalledWith('new-group');
    expect(t.calls).toEqual([]);
    expect(t.sync.seen('new-group')).toBe(9);
  });

  it('reports a server-side disconnect (logout, revoked session) but not a network drop', () => {
    const t = setup(() => 0);
    t.socket.fire('disconnect', 'transport close');
    expect(t.onServerDisconnect).not.toHaveBeenCalled();
    t.socket.fire('disconnect', 'io server disconnect');
    expect(t.onServerDisconnect).toHaveBeenCalledOnce();
  });

  it('track() only moves forward', () => {
    const t = setup(() => 0);
    t.sync.track(G, 10);
    t.sync.track(G, 4);
    expect(t.sync.seen(G)).toBe(10);
  });
});
