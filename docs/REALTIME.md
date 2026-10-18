# Real-time: notify, then pull

Hisaab's real-time layer tells a client that a group changed. It never tells the client *what* changed. The client always fetches data from the same snapshot REST endpoints it uses anyway.

The code:
- triggers: [`20261018000004_notify.sql`](../db/migrations/20261018000004_notify.sql)
- the LISTEN connection: [`api/src/realtime/listener.ts`](../api/src/realtime/listener.ts)
- the Socket.IO server: [`api/src/realtime/server.ts`](../api/src/realtime/server.ts)
- catch-up: `GET /api/groups/:id/activity?afterSeq=`

## The pipeline

```
write transaction ──► activity_log row (group_id, seq) ──► trigger: pg_notify('hisaab_group', {group_id, seq, type})
                                                                       │  delivered only after COMMIT, in commit order
                                                                       ▼
                 API: one dedicated LISTEN connection (PgListener) ──► signal queue (one at a time, in order)
                                                                       │  membership-type signal? recompute that group's room
                                                                       ▼
                 Socket.IO room group:<id> ──► client: group:changed {groupId, seq}
                                                                       │
                                                                       ▼
                 client: GET /api/groups/:id/activity?afterSeq=<lastSeen> ──► rows + lastSeq, one snapshot
```

Session revocation takes the same path. A trigger on `sessions` sends `pg_notify('hisaab_session', {session_id})` when `revoked_at` is first set, and every API instance disconnects that session's sockets.

## Why notify-then-pull

- **One data path.** Everything a client sees comes from the snapshot REST reads (REPEATABLE READ, READ ONLY), with their authorization (active member or 404), money formatting and pagination. Sockets add no second copy of those rules to keep in sync or get wrong.
- **Nothing to leak.** A signal is `{groupId, seq}` for a group the socket's user belongs to. Even a room bug would leak only "group X changed at seq N", never amounts, names or descriptions. The REST call that follows still checks membership.
- **Lost signals heal themselves.** Data is pulled by `seq`, so a client that misses signals for any reason recovers by asking for everything after the last seq it saw. The REST response carries the group's `lastSeq` from the same snapshot, so the client knows when it has caught up. Push-the-data designs need acknowledgements or replay buffers to get the same property.
- **Signals only exist after commit.** The trigger fires on the activity row that every write transaction inserts, and NOTIFY is transactional. A rolled-back write never signals, and no client can see a change that later disappears.
- **Several API instances need no shared adapter.** Each instance LISTENs on its own connection and gets every notification, and rooms are local to the instance, so a Valkey/Redis Socket.IO adapter isn't needed. (Port 6380 stays reserved for one in case it ever is.)

**Deviation from the original sketch:** the NOTIFY payload also carries the activity `type`. With it, the server refreshes room membership only for membership changes, without an extra query for every signal.

## Protocol

**Server → client:**

| Event | Payload | Meaning |
|---|---|---|
| `ready` | `{ groups: string[] }` | Handshake done and rooms joined. Send `sync` now. |
| `group:changed` | `{ groupId, seq }` | The group's newest committed write is `seq`. |
| `resync` | none | The server may have missed signals. Sync every group. |

**Client → server:** only `sync`, with payload `{ [groupId]: lastSeenSeq }` (up to 500 entries). The server answers with `group:changed` for every group the socket is in whose `last_seq` is higher. A group the client didn't mention counts as last seen 0.

Any other event, or a malformed `sync`, disconnects the socket. So does going past the token bucket (burst 10, then 2 per second). Inbound frames are capped at 16 KB. **Clients never write over the socket**; every write is REST.

### Client algorithm (implemented in Phase 5)

```
state: lastSeen[groupId] (from the last REST read)

on ready, on resync, on reconnect → emit sync(lastSeen)
on group:changed {groupId, seq}:
    if seq <= lastSeen[groupId]: ignore          // late or duplicate signal for data already held
    else: fetch GET /groups/:id/activity?afterSeq=lastSeen[groupId]
          (follow hasMore pages), apply rows, set lastSeen = lastSeq from the response,
          then invalidate the group's balance and expense queries (TanStack Query) and refetch them
```

**Fetch on any increase, not only on a gap.** One fetch handles one signal, a gap, or several coalesced signals, and duplicate fetches for the same group are folded into one request in flight. "seq > lastSeen + 1" is the gap case, but there's no need to treat it separately.

## Authentication and authorization

- **Origin, exactly.** `allowRequest` checks every engine.io request, including the WebSocket upgrade, against the `WEB_ORIGINS` allow-list. A missing Origin is rejected too. This is the defence against cross-site WebSocket hijacking: browsers attach the session cookie to cross-site WebSocket requests, and CORS doesn't apply to them.
- **Session cookie.** The handshake middleware looks the cookie's token hash up in `sessions`: not revoked, not expired, user not disabled. Otherwise the client gets `connect_error: unauthenticated`. A timer disconnects the socket at the session's `expires_at`.
- **Revocation.** Logout, or any update that sets `revoked_at`, notifies `hisaab_session`. Every instance then disconnects all sockets in that session's room.
- **Rooms are server-only.** On connect, the server joins `group:<id>` for every non-archived group where the user is an active member, plus `user:<id>` and `session:<id>`. Clients can't join or leave rooms.
- **Live membership updates.** On a membership-type signal (`group.created`, `member.joined`, `member.rejoined`, `member.claimed`, `member.merged`, `member.left`, `member.removed`), the server recomputes that group's room before emitting the signal:
  - a user who joined, or claimed or merged a ghost, receives the signal for their own join;
  - a member who left doesn't receive the signal for their leaving, or anything after it.

## Consistency guarantees

1. **Only committed writes signal**, at most once per activity row per delivery path.
2. **Per-group order.** Writes to a group serialize on the group lock, NOTIFY is delivered in commit order, and the server handles signals one at a time. So `group:changed` reaches a socket in increasing `seq` for that group.
3. **Signals may be late or duplicated.** One for a seq the client already holds can arrive after it joined a room or reconnected (the tests see this under load). Clients ignore `seq <= lastSeen`.
4. **Signals may be lost; the data never is.** A client recovers everything it missed in one REST round trip, because it pulls by `seq`. The cases where signals are lost:
   - the client was offline: it sends `sync` on reconnect;
   - the server's LISTEN connection dropped: on reconnect the server emits `resync`;
   - a signal was emitted between the socket connecting and its rooms being joined: it sends `sync` after `ready`.
5. **Snapshot reads.** The catch-up response's rows and `lastSeq` come from one REPEATABLE READ snapshot. After applying it, the client matches a committed state of the group exactly.
6. **Freshness.** Commit-to-signal latency, measured below, is tens of milliseconds. A client converges one REST round trip after that.

## Failure modes

| Failure | What happens | Recovery |
|---|---|---|
| LISTEN connection dropped (network, `pg_terminate_backend`, DB restart) | Notifications sent meanwhile are lost | Reconnect with exponential backoff and jitter (100 ms → 10 s). Then: drop sockets whose session ended, recompute every socket's rooms, emit `resync` to all. Tested by killing the backend. |
| Database down at API startup | API starts; listener retries in the background | First successful connect counts as a gap and triggers `resync`. |
| Client offline or sleeping | Misses signals | On reconnect: `ready`, then `sync(lastSeen)`, then REST catch-up. Tested. |
| Session revoked while the listener is down | The revocation notification is lost | `resync` re-checks every connected socket's session and disconnects ended ones. |
| Session expires | No notification | A per-socket timer disconnects at `expires_at`. |
| Membership changes while the listener is down | Rooms are stale | `resync` recomputes all rooms from the database. |
| Leaver receives a signal already in flight | At most `{groupId, seq}` for a group they just left | The following REST call returns 404. No data leaks. |
| API instance restarts | Its sockets drop | Clients reconnect, possibly to another instance, then sync. |
| Postgres NOTIFY queue fills (listener stalled for hours) | Postgres refuses further NOTIFYs, failing the writes that send them | Not expected at this volume (8 GB queue, one small payload per write). The listener is a plain connection that reads continuously; alert on `pg_notification_queue_usage()` when deployed. |
| Abusive client | Floods events, sends unknown events, or sends oversized frames | Disconnected by the token bucket, the inbound policy and the 16 KB cap. Tested. |

## Measured

Load test (`realtime.int.test.ts`): 200 concurrent sockets for 20 users in one group, 10 writes, 2,000 signal deliveries. Latency is measured from sending COMMIT to each socket receiving `group:changed`. Server and clients share one Node process, so the memory figures include the client side of every socket.

| Where | connect 200 | p50 | p95 | max | RSS growth |
|---|---|---|---|---|---|
| CI (GitHub ubuntu-24.04, AMD EPYC) | 419 ms | 8.0 ms | 14.5 ms | 16.8 ms | +10.6 MB (≈ 54 KB/socket incl. client) |
| Dev machine, test suite running in parallel, heavily loaded | 1.3–1.8 s | 42–56 ms | 59–82 ms | 68–88 ms | +15–16 MB (≈ 80 KB/socket incl. client) |
| Dev machine, single run while another suite was busy | 0.5–1.5 s | 27–60 ms | 44–265 ms | 51–272 ms | +8–20 MB |

The single-run numbers come from runs that overlapped the 50,000-run property soak and other test files. The p95 outliers are scheduler noise on a machine with under 1 GB of RAM free, not queueing in the server.

## Not done yet

- **Phase 5:** the web client (connect through the Vite proxy at `/api/socket.io`, `lastSeen` tracking, query invalidation).
- **Phase 6:** connection rate limits per IP and user at the handshake, and an alert on notification queue usage.
