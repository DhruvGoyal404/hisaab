# Hisaab: schema proposal (Phase 2, step 1)

**Status:** implemented in Phase 2 as `db/migrations/20261018000001-3_*.sql`, after review. Appendix A shows the reviewed proposal. The migrations are authoritative where they differ, and §8 and §14 note the one change: a merged ghost may still appear on new lines.

**Validation:** I loaded that DDL into a throwaway database on the project's Postgres 18.6 container (since dropped) and ran a smoke script as the app role. It covers every rule below, including the failure cases: each one was rejected with the expected error. The real migrations and their automated tests come after your review. The test plan is in [§13](#13-test-plan-for-the-migrations).

## Contents

1. [Shape of the model](#1-shape-of-the-model)
2. [Splits sum to the total; split methods](#2-splits-sum-to-the-total-split-methods)
3. [Edits and deletes on an append-only ledger](#3-edits-and-deletes-on-an-append-only-ledger)
4. [Idempotency keys](#4-idempotency-keys)
5. [Concurrency: group sequence and expense versions](#5-concurrency-group-sequence-and-expense-versions)
6. [Balances: computed from the journal](#6-balances-computed-from-the-journal)
7. [Leaving a group](#7-leaving-a-group)
8. [Ghost members and invite links](#8-ghost-members-and-invite-links)
9. [Currency](#9-currency)
10. [Users, identities, sessions, roles](#10-users-identities-sessions-roles)
11. [Queries and indexes](#11-queries-and-indexes)
12. [Write paths](#12-write-paths)
13. [Test plan for the migrations](#13-test-plan-for-the-migrations)
14. [Decisions I need from you](#14-decisions-i-need-from-you)

---

## 1. Shape of the model

```
users ─┬─ oauth_identities (google | github, ≤ 1 each)
       ├─ sessions (sha256 token hashes)
       └─ memberships ──┐   (a user in a group; user_id null = ghost)
groups ─┬─ memberships ◄┘
        ├─ invites (single-use; optionally targets a ghost)
        ├─ activity_log (group_id, seq)   ◄── every write transaction adds exactly one row
        ├─ expenses ── expense_versions ── expense_lines (per member: paid, owed, weight)
        ├─ settlements ── settlement_voids
        └─ ledger_entries (the journal: signed paise per member, written only by triggers)
```

Five ideas carry the design:

- **The ledger references memberships, not users.** Every amount points at a `memberships.id`. A ghost is a membership with no user. Claiming a ghost re-points one membership row, and no money row is ever rewritten. This is what makes "move the ghost's history to the real user" atomic *and* compatible with an append-only ledger (§8).
- **`ledger_entries` is a double-entry journal.** Each write transaction posts signed deltas that net to zero. Balances are sums of the journal. Edits and deletes post **reversals**, never updates (§3).
- **Database triggers are the only writers to the journal.** They are `SECURITY DEFINER` functions that derive postings from expense lines and settlements. The app role has `SELECT` only on `ledger_entries`, so app code cannot post a wrong amount, forget a reversal, or double-post.
- **`groups.last_seq` is both the per-group sequence number and the group's write lock** (§5). A trigger rejects ledger writes unless they carry the current sequence value.
- **The database itself enforces every invariant on this list:** sums, allocation bounds, append-only tables, version order, leave rules, and merge rules. App-side checks become a convenience for nicer error messages, not the safety net.

**Money:** all amounts are `bigint` paise. No column anywhere is `numeric` or float; `numeric` appears only inside checks, to multiply without overflow. Totals are capped at ₹100 crore (10¹¹ paise), so every intermediate value fits in a JS safe integer.

**Driver caveat:** node-pg returns `int8` values as strings. The API will register an `int8` type parser that throws on values beyond `Number.MAX_SAFE_INTEGER`. Every `sum()` is cast back to `bigint` in SQL, because `sum(bigint)` returns `numeric`.

## 2. Splits sum to the total; split methods

**The app turns every split into integer paise before inserting.** All four split methods go through one function, `allocate(total, weights, tiebreak)`:

| Method | `weight` stored per participant | Allocation |
|---|---|---|
| `equal` | `1` | largest remainder over equal weights |
| `exact` | the exact paise (`weight = owed_minor`) | none; amounts must already sum to the total |
| `percent` | basis points; Σ = 10000 (33.34% = 3334) | largest remainder |
| `shares` | positive integer shares | largest remainder |

- **Tie-break:** ties go by `sha256(expense_id ‖ member_id)`. It uses the *logical* `expense_id`, so editing an expense doesn't reshuffle who absorbs the leftover paisa.
- **Payers:** each line also carries `paid_minor`. Several people can pay one expense, and a payer doesn't have to be a participant; a payer-only row has `weight = null`.

**What the database enforces at COMMIT** (deferred constraint trigger `check_expense_version`, `DEFERRABLE INITIALLY DEFERRED`):

1. Σ `paid_minor` = `total_minor`, and Σ `owed_minor` = `total_minor`.
2. There is at least one participant. A `delete` version has no lines at all.
3. Weights match the split method: equal → all 1; exact → `weight = owed_minor`; percent → Σ = 10000.
4. **Every share satisfies the allocation function's guarantee:** each owed amount is floor or ceil of `total × w / Σw`. The check is `|owed·W − total·w| < W`, computed in `numeric`.

   So even a hand-written INSERT that sums correctly but is unfair gets rejected. In the smoke test, 298/300/302 for an equal ₹9.00 split was rejected.

**Why it's deferred:** the check fires from both `expense_versions` and `expense_lines` inserts, so a version and its lines can be inserted in any order within the transaction. A separate deferred trigger, `check_seq_balanced`, verifies that each transaction's journal postings net to zero.

## 3. Edits and deletes on an append-only ledger

- **`expenses`** is the logical expense. Its only mutable column, `head_version`, is advanced by a trigger; the app has no `UPDATE` on it.
- **`expense_versions`** is append-only, with `kind` ∈ `create | edit | delete`.
  - **Edit:** insert version *n+1* (`edit`) with its new lines. The trigger posts a **reversal** (negated copies) of version *n*'s journal entries, and the new lines post fresh entries. The old version and its lines stay forever.
  - **Delete:** insert version *n+1* (`delete`) with no lines. The trigger posts the reversal only.
  - **Restore:** an `edit` after a `delete` (nothing to reverse) brings it back. Deleting twice fails with `ZV002`.
- **Settlements** can't be edited. Voiding one inserts a `settlement_voids` row, which posts the reversal; record a corrected settlement as a new one. The primary key on `settlement_id` makes a second void impossible.
- **Append-only, two layers:**

  | Layer | Covers | Effect |
  |---|---|---|
  | `forbid_mutation()` triggers | `activity_log`, `expense_versions`, `expense_lines`, `settlements`, `settlement_voids`, `ledger_entries` | Reject UPDATE, DELETE and TRUNCATE (`ZA001`), even for the owner role |
  | Privileges | the app role (`hisaab_app`) | No UPDATE/DELETE on those tables, and no write at all on `ledger_entries`; permission is denied before any trigger runs |

  Both layers were verified in the smoke test.
- **Not append-only, on purpose:** `users`, `oauth_identities`, `sessions`, `groups` (name, flags, `last_seq`), `memberships` (status, role, claim), `invites` (used/revoked) and `idempotency_keys` (purged on expiry). Every change to `groups` and `memberships` still goes through the group sequence and gets an activity row.

## 4. Idempotency keys

- **Table:** `idempotency_keys (user_id, key)` is the primary key, so keys are **unique per user**.
- **Scope:** `scope` ∈ `expense.create | settlement.create`.
- **Stored with each key:** `request_hash` (sha256 of the canonical request body) and `resource_id`.
- **Expiry:** `expires_at` defaults to now + 24 h. A periodic `delete … where expires_at < now()` purges old keys, and the app can do only that one kind of delete on this table.

**Flow** (inside the create transaction, after taking the group lock, §12):

1. Delete an *expired* row with the same `(user_id, key)`, if any.
2. `insert … on conflict do nothing returning resource_id`. Then:

| Result | Meaning | Response |
|---|---|---|
| Row inserted | First time this key is seen | Proceed; the resource uses the pre-generated `resource_id` |
| Conflict, same scope and hash | A retry of a committed request | Roll back; **replay**: 200 with the existing resource and an `Idempotent-Replay: true` header |
| Conflict, different hash or scope | The key was reused for a different request | Roll back; 422 `idempotency_key_reused` |

A concurrent duplicate blocks on the group lock, then on the unique index, until the first request commits, and then takes the replay path. If the first request rolls back, the duplicate simply proceeds. **Net effect: exactly one expense per key.**

Edits and deletes don't need keys: they carry `If-Match: <version>`, which already makes a retry safe (a retried edit gets `409`; the client sees that its version is already head).

## 5. Concurrency: group sequence and expense versions

**The group lock:** every write transaction starts with

```sql
update groups set last_seq = last_seq + 1 where id = $group returning last_seq;
```

That one statement:
- takes the group's row lock, so writes to one group are serialized;
- assigns the transaction's **sequence number**, gap-free because a rollback undoes the bump;
- is what every ledger-bearing table is stamped with.

The `assert_write_seq` triggers reject inserts and updates whose `seq` isn't the group's current `last_seq` (`ZS001`), so a code path that forgets the lock fails loudly. Deferred foreign keys `(group_id, seq) → activity_log` guarantee the transaction also wrote its single activity row, and the primary key `(group_id, seq)` on `activity_log` makes that row unique.

**Why a row lock and not SERIALIZABLE:**
- Writes to one group happen at human speed (a few per minute at most), so serializing them costs nothing.
- It gives a deterministic, gap-free `seq` for the real-time catch-up protocol.
- It avoids retry loops on serialization failures (`40001`) in every handler.
- A transaction only ever locks one group, so there are no deadlocks.

**Two members editing the same expense at once.** Both load it at version 3 and both send `PUT /expenses/:id` with `If-Match: 3`:

1. Asha's transaction takes the group lock and inserts version 4. The trigger checks `4 = head + 1` and advances `head_version` to 4. She commits.
2. Bilal's transaction was blocked on the group lock. Once it gets the lock, it inserts version 4. The trigger sees head = 4 and raises `ZV001`, and the API returns **409** with the current version 4 attached.
3. Bilal's client shows "Asha changed this expense": her version next to his draft, with "apply my change on top" or "discard". Reapplying sends `If-Match: 4`.

There is never a silent last-write-wins. The primary key `(expense_id, version)` is the second line of defence.

## 6. Balances: computed from the journal

**Choice: compute balances from `ledger_entries`; no materialized balances table in v1.**

- **One source of truth, nothing to drift.** A materialized table needs either trusted app code or triggers to keep it in step, plus a reconciliation job and a runbook for when they disagree. The journal is already the ledger.
- **It's cheap at our scale.** Balances are sums over the covering index `ledger_entries (member_id) INCLUDE (delta_minor)`, so each member's sum is an index-only scan over that member's entries. Rough size: a busy group posts about 3–6 entries per expense, so 5,000 expenses ≈ 30,000 entries. That is a few milliseconds per group, and the cross-group query touches only your own entries. The table is insert-only, so autovacuum keeps the visibility map current and the scans stay index-only.
- **It keeps the leave rule in the database.** The `memberships` trigger computes the member's balance (including merged ghosts) inside the leave transaction, with the group lock held.
- **The escape hatch is mechanical.** If profiling ever shows balance reads dominate, add `member_balances` maintained by the same definer triggers that write the journal. The check `select member_id, sum(delta_minor) … except select member_id, balance_minor from member_balances` then runs in CI and as a nightly job. That design doesn't need the app to change.

**Sign convention:** a positive balance means the group owes this member; negative means they owe. An expense posts `paid − owed` per member. A settlement posts `+amount` to the payer and `−amount` to the receiver. The invariant **Σ balances per group = 0** holds by construction, since every transaction nets to zero, and it is also asserted in tests.

## 7. Leaving a group

- **Leaving:** sets `status = 'left'` and `left_at`, inside the group-locked transaction.
- **The `memberships_guard` trigger rejects leaving when:**
  - the balance is non-zero, counting ghosts merged into this member (`ZB001` → **409** "settle up first");
  - the member is the owner, who must transfer ownership first (`ZM002`).

  An admin removing someone goes through the same rule.
- **Memberships are never deleted.** History keeps pointing at them, and rejoining reactivates the same row.
- **History involving someone who has left is frozen:** new lines can't reference them, and editing, deleting or voiding anything whose postings touch them is rejected (`ZM001`). Otherwise a reversal could give a departed member a balance again. To change such an expense, re-add the person first.

## 8. Ghost members and invite links

**Ghost:** a `memberships` row with `user_id = null` and a `display_name` that is unique among the group's active ghosts. Ghosts have the `member` role, can't sign in, and can be on expenses and settlements like anyone else.

**Invites:**
- **Token:** a random 256-bit value, sent in the link; only its sha256 is stored.
- **Expiry:** at most 30 days (app default: 7). Single-use via `used_at`/`used_by`, and revocable.
- **Target:** `ghost_member_id` makes the link claim a specific ghost; null means a plain "join the group" link. Each ghost has at most one open invite, and issuing a new one revokes the old.

**Consuming an invite is a single atomic statement:**
```sql
update invites set used_at = now(), used_by = $user
 where token_hash = $hash and used_at is null and revoked_at is null and expires_at > now()
returning group_id, ghost_member_id;   -- 0 rows → 410 "invite invalid, used or expired"
```
It runs in the same transaction as the group lock and the membership change. If anything later fails, the rollback "un-uses" the invite.

**Cases:**

| Invite | Claimer's state in the group | What happens |
|---|---|---|
| plain | not a member | New membership. If they once left, their old row is reactivated instead, so their history stays theirs |
| plain | already active | Roll back (invite not consumed); 409 "already a member" |
| ghost | not a member | **Claim:** `update memberships set user_id = $user, display_name = null where id = $ghost and user_id is null and status = 'active'`. Every past expense and settlement is now theirs, through one row update. 0 rows (already claimed or merged) → roll back, 409 |
| ghost | already active | **Merge:** ghost → `status = 'merged'`, `merged_into = <their membership>`. Balance queries resolve `coalesce(merged_into, id)`, so both histories show as one person. Old lines keep pointing at the ghost row. A merged ghost counts as active while the member it merged into is active (`effective_member()`), so an expense with lines for both stays valid through edits, deletes and restores, and new lines may use either row. Final and one level only (the target must be an active real member) |
| ghost | left earlier | Reactivate their old row, then merge the ghost into it, all in one transaction |

**The activity row records:** the ghost's former name, plus the merge as `member.claimed` or `member.merged`, so the feed can say "Dev claimed 'Chirag'".

## 9. Currency

- **`groups.currency char(3) not null default 'INR' check (currency = 'INR')`.**
- `expense_versions.currency` and `settlements.currency` have composite foreign keys `(group_id, currency) → groups (id, currency)`, so a row can't disagree with its group.
- A group's currency is immutable: there is no column grant, and `groups_guard` rejects the change (`ZG001`).
- **Going multi-currency later:**
  1. Relax the check.
  2. Add `currency` to `ledger_entries` (and to the balance queries' `GROUP BY`).
  3. Make the allocation function aware of minor-unit exponents.

  No data migration is needed for existing INR rows.

## 10. Users, identities, sessions, roles

**`users`:** display name, optional primary `email` (citext, unique when present), optional avatar, and `disabled_at`.

**`oauth_identities`:**
- `(provider, subject)` is unique, where subject is Google's `sub` or GitHub's numeric id, never an email.
- `(user_id, provider)` is unique, so one user can link at most one Google and one GitHub identity.
- A check enforces `email_verified` for Google.
- **Linking is explicit:** a signed-in user adds the second provider. **No automatic linking by email.** If a new login's verified email matches an existing user, the API refuses to create a duplicate and says "sign in with Google, then link GitHub". This closes the classic account-takeover hole where one provider vouches for an email the other doesn't.

**`sessions`:**
- `token_hash bytea` is the sha256 of a 256-bit random token. That's enough entropy that no salt is needed.
- Columns `expires_at`, `revoked_at`, `last_seen_at` and a short `user_agent`.
- Lookup is `token_hash = $1 and revoked_at is null and expires_at > now()`. "Log out everywhere" sets `revoked_at` on all of a user's sessions.
- The OAuth `state`/PKCE verifier/nonce live in a short-lived signed cookie (Phase 6), not in the database.

**Membership roles:**
- `owner`: exactly one active per group, enforced by a partial unique index.
- `admin`: manages members and invites.
- `member`: the default.
- Ghosts are always `member`.

**Database roles:**
- **Owner role:** runs dbmate and owns every table and function.
- **`hisaab_app` (NOLOGIN):** gets the grants in Appendix A §5, which include column-level `UPDATE` only where a column is meant to change.
- **The API's login role:** created outside migrations (dev bootstrap script; SSM in prod) as a member of `hisaab_app`.
- **Config change in Phase 2:** the API's `DATABASE_URL` switches to that role, and dbmate gets its own owner URL.

## 11. Queries and indexes

Every group-scoped query below runs after the API's membership check:
```sql
select id, role from memberships where group_id = $1 and user_id = $2 and status = 'active'
```
No row → **404**, so another group's ids are indistinguishable from nonexistent ones.

### 11.1 Group balances

```sql
-- $1 group_id. Ghosts merged into a member are folded into that member.
with posted as (
  select coalesce(m.merged_into, m.id) as member_id, le.delta_minor
    from memberships m
    join ledger_entries le on le.member_id = m.id
   where m.group_id = $1
)
select m.id                                   as member_id,
       coalesce(u.display_name, m.display_name) as name,
       m.user_id is null                      as is_ghost,
       coalesce(sum(p.delta_minor), 0)::bigint as balance_minor
  from memberships m
  left join users u   on u.id = m.user_id
  left join posted p  on p.member_id = m.id
 where m.group_id = $1 and m.status = 'active'
 group by m.id, u.display_name, m.display_name, m.user_id
 order by balance_minor desc, m.id;
```
Uses `memberships (group_id, id)` (from the unique constraint) and `ledger_entries_member_idx` (index-only). Debt simplification (Phase 3) takes this result as its input.

### 11.2 One user's balance across all groups

```sql
-- $1 user_id. One row per group; the API also returns per-currency totals.
select g.id as group_id, g.name, g.currency,
       coalesce(sum(le.delta_minor), 0)::bigint as balance_minor
  from memberships me
  join groups g on g.id = me.group_id
  cross join lateral (
        select me.id as member_id
        union all
        select x.id from memberships x where x.merged_into = me.id   -- ghosts merged into me
  ) src
  left join ledger_entries le on le.member_id = src.member_id
 where me.user_id = $1 and me.status = 'active' and g.archived_at is null
 group by g.id, g.name, g.currency
 order by g.name, g.id;

-- Totals (wrap the query above as t):
select currency,
       coalesce(sum(balance_minor) filter (where balance_minor > 0), 0)::bigint  as owed_to_me,
       coalesce(-sum(balance_minor) filter (where balance_minor < 0), 0)::bigint as i_owe,
       sum(balance_minor)::bigint                                                as net
  from t group by currency;
```
Uses `memberships_user_idx`, `memberships_merged_into_idx` and `ledger_entries_member_idx`.

### 11.3 Activity feed (keyset pagination)

```sql
-- Newest first. $2 = cursor: the last seq of the previous page, or null for the first page.
-- coalesce() instead of "$2 is null or …" keeps the predicate sargable in a generic plan.
select a.seq, a.id, a.type, a.subject_id, a.payload, a.created_at, u.display_name as actor_name
  from activity_log a
  left join users u on u.id = a.actor_user_id
 where a.group_id = $1
   and a.seq < coalesce($2::bigint, 9223372036854775807)
 order by a.seq desc
 limit $3;          -- page size ≤ 50; fetch $3 + 1 rows to know whether a next page exists
```
On Postgres 18 the plan is `Index Only Scan Backward using activity_log_pkey` with `Index Cond: group_id = … AND seq < …`, checked with `EXPLAIN` in the scratch run.

Reconnect catch-up (Phase 4) reads the same index forwards:
```sql
select … from activity_log where group_id = $1 and seq > $2 order by seq limit 200;
```

### 11.4 Index list

| Table | Index | Serves |
|---|---|---|
| users | `users_email_key` unique (email) where not null | sign-in duplicate check |
| oauth_identities | unique (provider, subject); unique (user_id, provider) | sign-in; linking |
| sessions | unique (token_hash); (user_id); (expires_at) | every request; log out everywhere; purge |
| memberships | unique (group_id, id); unique (group_id, user_id) where user_id not null; (user_id) where not null; (merged_into) where not null; one active owner per group; unique active ghost name per group | authz check; 11.1; 11.2; merge resolution |
| invites | unique (token_hash); (group_id); one open invite per ghost | consume; list; revoke-on-reissue |
| idempotency_keys | pk (user_id, key); (expires_at) | create paths; purge |
| expenses | pk; unique (group_id, id); (group_id) | composite FKs; expense list |
| expense_versions | pk (expense_id, version); unique (group_id, expense_id, version); (group_id, seq) | head lookup; FKs; catch-up |
| expense_lines | pk (expense_id, version, member_id); (member_id) | version display; "expenses involving me" later |
| settlements | pk; unique (group_id, id); (group_id, seq) | FKs; catch-up |
| ledger_entries | (member_id) include (delta_minor); (group_id, seq); (expense_id, expense_version); (settlement_id) | balances; seq zero-sum check; reversals |
| activity_log | pk (group_id, seq); unique (id) | feed and catch-up |

## 12. Write paths

Every mutating transaction has the same skeleton (READ COMMITTED):

```sql
begin;
-- authz (§11), then the group lock + sequence:
update groups set last_seq = last_seq + 1 where id = $g and archived_at is null
returning last_seq, currency, uuidv7() as new_id;              -- $seq, $currency, $id
-- [create only] idempotency claim (§4)
insert into activity_log (group_id, seq, actor_user_id, type, subject_id, payload) values (…, $seq, …);
-- … the change itself, stamped with $seq …
commit;   -- deferred checks run here: splits = total, allocation bounds, journal nets to 0,
          -- every seq-stamped row has its activity row
```

| Operation | The change |
|---|---|
| Create expense | `insert expenses (id, group_id, created_seq)`; `insert expense_versions (…, version 1, kind 'create', seq)`; `insert expense_lines` from `allocate()` |
| Edit expense | `insert expense_versions (…, version = If-Match + 1, kind 'edit')` + new lines. `ZV001` → 409 with the current version |
| Delete expense | `insert expense_versions (…, version = If-Match + 1, kind 'delete')`, no lines |
| Record settlement | idempotency claim; `insert settlements` |
| Void settlement | `insert settlement_voids` |
| Add ghost | `insert memberships (display_name, created_seq, updated_seq)` |
| Join / claim / merge | §8 |
| Leave / remove | `update memberships set status = 'left', left_at = now(), updated_seq = $seq`. `ZB001` → 409 |

**Error mapping** (SQLSTATE → HTTP):

| SQLSTATE | Meaning | HTTP |
|---|---|---|
| `ZV001` | version conflict | 409 |
| `ZV002` | already deleted | 409 |
| `ZB001` | non-zero balance on leave | 409 |
| `ZM001`–`ZM003` | member not active / owner must transfer / invalid merge | 409 |
| `ZL002` | invalid expense version (should be unreachable because zod and `allocate()` run first) | 422 |
| `ZA*`, `ZS*`, `ZL001`, `ZG*`, `ZM004` | append-only, missing lock, unbalanced journal, immutable column, identity change: programming errors | 500, logged |

## 13. Test plan for the migrations

These run as integration tests against real Postgres, connected **as the app role**, not the owner. Each item below was already exercised once in the scratch run; the migrations will turn them into permanent tests.

- **Splits:** a sum ≠ total is rejected at COMMIT; an out-of-bounds share is rejected; a percent split not summing to 10000 is rejected; an exact split whose weight ≠ owed is rejected; a delete version with lines is rejected.
- **Append-only:** the app role is denied UPDATE/DELETE on the six append-only tables and any write on `ledger_entries`; the owner role is still blocked by the triggers; TRUNCATE is blocked.
- **Versioning:** create → edit → delete → restore. The journal shows the reversals, the balances match a hand calculation, and a stale `If-Match` raises `ZV001`. A real two-connection test checks the concurrent edit.
- **Locking:** a write without the seq bump raises `ZS001`; a rolled-back write leaves no gap in `last_seq`.
- **Leave:** leaving with a non-zero balance raises `ZB001`; leaving after settling works; the owner can't leave; touching a departed member's expense raises `ZM001`.
- **Ghosts:** claiming re-points history; merging folds balances; merging into a departed member is rejected; a merged ghost can't appear on new lines; a used, expired or revoked invite matches 0 rows; a concurrent double-claim gives exactly one winner.
- **Idempotency:** the same key and body replays; the same key with a different body is rejected; two concurrent duplicates produce exactly one expense; an expired key is reusable.
- **Authorization:** another group's ids return 404 from every endpoint.
- **Phase 3 hook:** a property test generates random operation sequences and asserts Σ balances = 0 and journal = Σ head-version lines after each step.

## 14. Decisions (resolved 2026-10-18)

Resolved: merge, keeping the ghost row linked and lines for both valid (tested in `api/test/ghosts.int.test.ts`). Members who left lose read access. Any member can edit or delete; the activity log records who. Balances are computed from the journal. Confirmed: the ₹100 crore cap and 0.01% precision. Restore after delete stays.

Original questions:

1. **Claimer is already in the group:** I propose **merge** (§8). The alternative is to refuse and make them pick one identity, which is simpler but means re-entering expenses.
2. **Can a member who left still read the group's history?** I propose **no**: they get the same 404 as a stranger, and rejoining restores access.
3. **Expense edit rights:** any active member, or only the author plus admins? The schema supports both; this is API policy. I propose any member, since every edit is versioned and visible in the feed.
4. **Balances computed, not materialized** (§6). Confirm.
5. **Total cap of ₹100 crore per expense, and percent precision of 0.01% (basis points).** Confirm, or name other limits.
6. **Restore after delete** (an `edit` following a `delete`). Keep it, or make delete final?

---

## Appendix A: full DDL

Runs after the baseline migration (`citext`). The migrations will split it into three files: (1) roles and identity, (2) groups, memberships, activity and invites, (3) ledger, triggers and grants. This is exactly the script that ran in the scratch database.

```sql
-- ============================================================================
-- 0. Roles
-- ============================================================================
-- Migrations run as the owner role (dev: compose superuser "hisaab"; prod: RDS master).
-- The API connects as a LOGIN role that is a member of hisaab_app (created outside
-- migrations, password from env/SSM). hisaab_app never owns anything.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'hisaab_app') then
    create role hisaab_app nologin;
  end if;
end $$;
grant usage on schema public to hisaab_app;

-- ============================================================================
-- 1. Identity: users, OAuth identities, sessions
-- ============================================================================
create table users (
  id            uuid primary key default uuidv7(),
  display_name  text not null check (char_length(display_name) between 1 and 60),
  email         citext check (char_length(email) <= 254),  -- primary contact, from a verified IdP email
  avatar_url    text check (avatar_url ~ '^https://'),
  created_at    timestamptz not null default now(),
  disabled_at   timestamptz
);
create unique index users_email_key on users (email) where email is not null;

create table oauth_identities (
  id              uuid primary key default uuidv7(),
  user_id         uuid not null references users (id) on delete cascade,
  provider        text not null check (provider in ('google', 'github')),
  subject         text not null check (char_length(subject) between 1 and 255),  -- Google "sub", GitHub numeric id
  email           citext,
  email_verified  boolean not null,
  created_at      timestamptz not null default now(),
  last_login_at   timestamptz not null default now(),
  unique (provider, subject),
  unique (user_id, provider),                     -- at most one Google and one GitHub per user
  check (provider <> 'google' or email_verified)  -- Google sign-in requires email_verified
);

create table sessions (
  id            uuid primary key default uuidv7(),
  user_id       uuid not null references users (id) on delete cascade,
  token_hash    bytea not null unique check (octet_length(token_hash) = 32),  -- sha256(256-bit token)
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  user_agent    text check (char_length(user_agent) <= 200),
  check (expires_at > created_at)
);
create index sessions_user_idx on sessions (user_id);
create index sessions_expires_idx on sessions (expires_at);

-- ============================================================================
-- 2. Groups, activity log, memberships, invites
-- ============================================================================
create table groups (
  id              uuid primary key default uuidv7(),
  name            text not null check (char_length(name) between 1 and 80),
  currency        char(3) not null default 'INR' check (currency = 'INR'),  -- v1: INR only
  simplify_debts  boolean not null default true,
  created_by      uuid not null references users (id),
  created_at      timestamptz not null default now(),
  archived_at     timestamptz,
  last_seq        bigint not null default 0 check (last_seq >= 0),  -- per-group write sequence; its row is the group lock
  unique (id, currency)                                             -- target for (group_id, currency) FKs
);

create table activity_log (
  group_id       uuid not null references groups (id),
  seq            bigint not null check (seq > 0),
  id             uuid not null default uuidv7() unique,
  actor_user_id  uuid references users (id),
  type           text not null check (type ~ '^[a-z]+\.[a-z_]+$'),
  subject_id     uuid,
  payload        jsonb not null default '{}' check (jsonb_typeof(payload) = 'object'),
  created_at     timestamptz not null default now(),
  primary key (group_id, seq)  -- exactly one activity row per write transaction
);

create table memberships (
  id            uuid primary key default uuidv7(),
  group_id      uuid not null references groups (id),
  user_id       uuid references users (id),  -- null = ghost (added by name, not signed up)
  display_name  text check (char_length(display_name) between 1 and 60),  -- ghosts only; real members use users.display_name
  role          text not null default 'member' check (role in ('owner', 'admin', 'member')),
  status        text not null default 'active' check (status in ('active', 'left', 'merged')),
  merged_into   uuid,
  created_seq   bigint not null,
  updated_seq   bigint not null,
  created_at    timestamptz not null default now(),
  left_at       timestamptz,
  unique (group_id, id),
  foreign key (group_id, merged_into) references memberships (group_id, id),
  foreign key (group_id, created_seq) references activity_log (group_id, seq) deferrable initially deferred,
  foreign key (group_id, updated_seq) references activity_log (group_id, seq) deferrable initially deferred,
  check (user_id is not null or display_name is not null),
  check ((status = 'merged') = (merged_into is not null)),
  check (status <> 'merged' or user_id is null),   -- only ghosts are merged
  check (merged_into <> id),
  check ((status = 'left') = (left_at is not null)),
  check (user_id is not null or role = 'member')   -- ghosts hold no privileges
);
create unique index memberships_group_user_key on memberships (group_id, user_id) where user_id is not null;
create index memberships_user_idx on memberships (user_id) where user_id is not null;
create index memberships_merged_into_idx on memberships (merged_into) where merged_into is not null;
create unique index memberships_one_owner_key on memberships (group_id) where role = 'owner' and status = 'active';
create unique index memberships_ghost_name_key on memberships (group_id, lower(display_name))
  where user_id is null and status = 'active';

create table invites (
  id               uuid primary key default uuidv7(),
  group_id         uuid not null references groups (id),
  token_hash       bytea not null unique check (octet_length(token_hash) = 32),
  ghost_member_id  uuid,  -- set: claims that ghost; null: plain "join the group" invite
  created_by       uuid not null references users (id),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  used_at          timestamptz,
  used_by          uuid references users (id),
  revoked_at       timestamptz,
  foreign key (group_id, ghost_member_id) references memberships (group_id, id),
  check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  check ((used_at is null) = (used_by is null)),
  check (used_at is null or revoked_at is null)
);
create index invites_group_idx on invites (group_id);
create unique index invites_one_open_per_ghost_key on invites (ghost_member_id)
  where ghost_member_id is not null and used_at is null and revoked_at is null;

create table idempotency_keys (
  user_id       uuid not null references users (id) on delete cascade,
  key           uuid not null,  -- client-generated Idempotency-Key header
  scope         text not null check (scope in ('expense.create', 'settlement.create')),
  request_hash  bytea not null check (octet_length(request_hash) = 32),  -- sha256 of canonical request body
  resource_id   uuid not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '24 hours',
  primary key (user_id, key)
);
create index idempotency_keys_expires_idx on idempotency_keys (expires_at);

-- ============================================================================
-- 3. Ledger: expenses (versioned), settlements, postings
-- ============================================================================
create table expenses (
  id            uuid primary key default uuidv7(),
  group_id      uuid not null references groups (id),
  head_version  integer not null default 0 check (head_version >= 0),  -- advanced only by trigger
  created_seq   bigint not null,
  created_at    timestamptz not null default now(),
  unique (group_id, id),
  foreign key (group_id, created_seq) references activity_log (group_id, seq) deferrable initially deferred
);
create index expenses_group_idx on expenses (group_id);

create table expense_versions (
  expense_id      uuid not null,
  version         integer not null check (version >= 1),
  group_id        uuid not null,
  currency        char(3) not null,
  kind            text not null check (kind in ('create', 'edit', 'delete')),
  description     text check (char_length(description) between 1 and 200),
  total_minor     bigint check (total_minor between 1 and 100000000000),  -- ≤ ₹100 crore; keeps every product inside numeric/JS-safe range
  split_method    text check (split_method in ('equal', 'exact', 'percent', 'shares')),
  occurred_on     date,
  author_user_id  uuid not null references users (id),
  seq             bigint not null,
  created_at      timestamptz not null default now(),
  primary key (expense_id, version),
  unique (group_id, expense_id, version),
  foreign key (group_id, expense_id) references expenses (group_id, id),
  foreign key (group_id, currency) references groups (id, currency),
  foreign key (group_id, seq) references activity_log (group_id, seq) deferrable initially deferred,
  check ((kind = 'create') = (version = 1)),
  check (
    (kind = 'delete' and description is null and total_minor is null and split_method is null and occurred_on is null)
    or (kind <> 'delete' and description is not null and total_minor is not null
        and split_method is not null and occurred_on is not null)
  )
);
create index expense_versions_group_seq_idx on expense_versions (group_id, seq);

-- One row per member involved in a version. weight is the allocation input:
-- equal → 1, exact → the exact paise (= owed), percent → basis points (Σ = 10000), shares → integer shares.
-- weight null = paid but not a participant.
create table expense_lines (
  expense_id  uuid not null,
  version     integer not null,
  group_id    uuid not null,
  member_id   uuid not null,
  paid_minor  bigint not null default 0 check (paid_minor >= 0),
  owed_minor  bigint not null default 0 check (owed_minor >= 0),
  weight      bigint check (weight between 1 and 100000000000),
  primary key (expense_id, version, member_id),
  foreign key (group_id, expense_id, version) references expense_versions (group_id, expense_id, version),
  foreign key (group_id, member_id) references memberships (group_id, id),
  check (weight is not null or (owed_minor = 0 and paid_minor > 0))
);
create index expense_lines_member_idx on expense_lines (member_id);

create table settlements (
  id              uuid primary key default uuidv7(),
  group_id        uuid not null,
  currency        char(3) not null,
  from_member_id  uuid not null,  -- who paid
  to_member_id    uuid not null,  -- who received
  amount_minor    bigint not null check (amount_minor between 1 and 100000000000),
  note            text check (char_length(note) <= 200),
  author_user_id  uuid not null references users (id),
  seq             bigint not null,
  created_at      timestamptz not null default now(),
  unique (group_id, id),
  foreign key (group_id, currency) references groups (id, currency),
  foreign key (group_id, from_member_id) references memberships (group_id, id),
  foreign key (group_id, to_member_id) references memberships (group_id, id),
  foreign key (group_id, seq) references activity_log (group_id, seq) deferrable initially deferred,
  check (from_member_id <> to_member_id)
);
create index settlements_group_seq_idx on settlements (group_id, seq);

create table settlement_voids (
  settlement_id   uuid primary key,  -- a settlement is voided at most once
  group_id        uuid not null,
  author_user_id  uuid not null references users (id),
  seq             bigint not null,
  created_at      timestamptz not null default now(),
  foreign key (group_id, settlement_id) references settlements (group_id, id),
  foreign key (group_id, seq) references activity_log (group_id, seq) deferrable initially deferred
);

-- The journal. Written only by SECURITY DEFINER triggers; the app role can only SELECT.
-- delta_minor > 0: the group owes this member more; < 0: this member owes more.
create table ledger_entries (
  id               bigint generated always as identity primary key,
  group_id         uuid not null,
  seq              bigint not null,
  member_id        uuid not null,
  delta_minor      bigint not null check (delta_minor <> 0),
  source           text not null check (source in ('expense', 'expense_reversal', 'settlement', 'settlement_reversal')),
  expense_id       uuid,
  expense_version  integer,  -- for a reversal: the version being reversed
  settlement_id    uuid,
  created_at       timestamptz not null default now(),
  foreign key (group_id, member_id) references memberships (group_id, id),
  foreign key (group_id, seq) references activity_log (group_id, seq) deferrable initially deferred,
  foreign key (expense_id, expense_version) references expense_versions (expense_id, version),
  foreign key (settlement_id) references settlements (id),
  check (
    (source in ('expense', 'expense_reversal')
       and expense_id is not null and expense_version is not null and settlement_id is null)
    or (source in ('settlement', 'settlement_reversal')
       and settlement_id is not null and expense_id is null and expense_version is null)
  )
);
create index ledger_entries_member_idx on ledger_entries (member_id) include (delta_minor);
create index ledger_entries_group_seq_idx on ledger_entries (group_id, seq);
create index ledger_entries_expense_idx on ledger_entries (expense_id, expense_version) where expense_id is not null;
create index ledger_entries_settlement_idx on ledger_entries (settlement_id) where settlement_id is not null;

-- ============================================================================
-- 4. Functions and triggers
-- ============================================================================
-- Custom SQLSTATEs (class Z), mapped to HTTP by the API:
--   ZA001 append-only violation      ZS001 write without the group lock/seq   ZG001 immutable group column
--   ZV001 version conflict (409)     ZV002 expense already deleted (409)
--   ZL001 ledger seq not zero-sum    ZL002 invalid expense version (splits ≠ total, bad weights, out-of-bounds share)
--   ZM001 member not active          ZM002 owner must transfer ownership first   ZM003 invalid merge
--   ZM004 identity change refused    ZB001 non-zero balance on leave (409)

-- 4.1 Append-only guard (activity_log, expense_versions, expense_lines, settlements, settlement_voids, ledger_entries)
create function forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only: % rejected', tg_table_name, tg_op using errcode = 'ZA001';
end $$;

do $$
declare t text;
begin
  foreach t in array array['activity_log', 'expense_versions', 'expense_lines', 'settlements',
                           'settlement_voids', 'ledger_entries'] loop
    execute format('create trigger %I before update or delete on %I for each row execute function forbid_mutation()',
                   t || '_append_only', t);
    execute format('create trigger %I before truncate on %I for each statement execute function forbid_mutation()',
                   t || '_no_truncate', t);
  end loop;
end $$;

-- expenses: only head_version may change (and only via the definer trigger below).
create function expenses_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE'
     or (new.id, new.group_id, new.created_seq, new.created_at)
        is distinct from (old.id, old.group_id, old.created_seq, old.created_at) then
    raise exception 'expenses rows are immutable apart from head_version' using errcode = 'ZA001';
  end if;
  return new;
end $$;
create trigger expenses_guard before update or delete on expenses
  for each row execute function expenses_guard();
create trigger expenses_no_truncate before truncate on expenses
  for each statement execute function forbid_mutation();

-- 4.2 Every ledger-affecting write must carry the group's current seq, which only the transaction
-- that just ran `update groups set last_seq = last_seq + 1` (and so holds the row lock) can know.
create function assert_write_seq() returns trigger
language plpgsql as $$
declare
  v_seq bigint := (to_jsonb(new) ->> tg_argv[0])::bigint;
  v_current bigint;
begin
  select last_seq into v_current from groups where id = new.group_id;
  if v_seq is distinct from v_current then
    raise exception '% write uses seq % but group % is at %; bump groups.last_seq first',
      tg_table_name, v_seq, new.group_id, v_current using errcode = 'ZS001';
  end if;
  return new;
end $$;
create trigger activity_log_seq before insert on activity_log for each row execute function assert_write_seq('seq');
create trigger memberships_seq before insert or update on memberships for each row execute function assert_write_seq('updated_seq');
create trigger expenses_seq before insert on expenses for each row execute function assert_write_seq('created_seq');
create trigger expense_versions_seq before insert on expense_versions for each row execute function assert_write_seq('seq');
create trigger settlements_seq before insert on settlements for each row execute function assert_write_seq('seq');
create trigger settlement_voids_seq before insert on settlement_voids for each row execute function assert_write_seq('seq');

create function groups_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'groups are archived, never deleted' using errcode = 'ZA001';
  end if;
  if new.id <> old.id or new.currency <> old.currency or new.created_by <> old.created_by
     or new.created_at <> old.created_at then
    raise exception 'immutable group column changed' using errcode = 'ZG001';
  end if;
  if new.last_seq not in (old.last_seq, old.last_seq + 1) then
    raise exception 'last_seq may only advance by 1' using errcode = 'ZG001';
  end if;
  return new;
end $$;
create trigger groups_guard before update or delete on groups for each row execute function groups_guard();

-- 4.3 Versioning: advance the head, reverse the previous head's postings.
create function expense_versions_apply() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_head integer;
  v_head_kind text;
begin
  select head_version into v_head from expenses where id = new.expense_id for update;
  if new.version <> v_head + 1 then
    raise exception 'expense % is at version %, cannot write version %', new.expense_id, v_head, new.version
      using errcode = 'ZV001';
  end if;
  if v_head > 0 then
    select kind into v_head_kind from expense_versions where expense_id = new.expense_id and version = v_head;
    if v_head_kind = 'delete' and new.kind = 'delete' then
      raise exception 'expense % is already deleted', new.expense_id using errcode = 'ZV002';
    end if;
    -- A member who left has a zero balance by rule; reversing postings would break that.
    if exists (select 1 from ledger_entries le join memberships m on m.id = le.member_id
                where le.expense_id = new.expense_id and le.expense_version = v_head
                  and le.source = 'expense' and m.status = 'left') then
      raise exception 'expense % involves a member who has left; re-add them first', new.expense_id
        using errcode = 'ZM001';
    end if;
    -- Reverse whatever the previous head posted (nothing if it was a delete).
    insert into ledger_entries (group_id, seq, member_id, delta_minor, source, expense_id, expense_version)
    select group_id, new.seq, member_id, -delta_minor, 'expense_reversal', expense_id, expense_version
      from ledger_entries
     where expense_id = new.expense_id and expense_version = v_head and source = 'expense';
  end if;
  update expenses set head_version = new.version where id = new.expense_id;
  return null;
end $$;
create trigger expense_versions_apply after insert on expense_versions
  for each row execute function expense_versions_apply();

-- 4.4 Lines post to the journal; only in the version's own transaction, only for active members.
create function expense_lines_post() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_seq bigint;
  v_current bigint;
  v_status text;
begin
  select seq into v_seq from expense_versions where expense_id = new.expense_id and version = new.version;
  select last_seq into v_current from groups where id = new.group_id;
  if v_seq <> v_current then
    raise exception 'lines for %/% can only be added in the transaction that created the version',
      new.expense_id, new.version using errcode = 'ZS001';
  end if;
  select status into v_status from memberships where id = new.member_id;
  if v_status <> 'active' then
    raise exception 'member % is %, not active', new.member_id, v_status using errcode = 'ZM001';
  end if;
  if new.paid_minor <> new.owed_minor then
    insert into ledger_entries (group_id, seq, member_id, delta_minor, source, expense_id, expense_version)
    values (new.group_id, v_seq, new.member_id, new.paid_minor - new.owed_minor, 'expense', new.expense_id, new.version);
  end if;
  return null;
end $$;
create trigger expense_lines_post after insert on expense_lines
  for each row execute function expense_lines_post();

-- 4.5 Settlements and voids post to the journal.
create function settlements_post() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from memberships
              where id in (new.from_member_id, new.to_member_id) and status <> 'active') then
    raise exception 'settlement members must be active' using errcode = 'ZM001';
  end if;
  insert into ledger_entries (group_id, seq, member_id, delta_minor, source, settlement_id)
  values (new.group_id, new.seq, new.from_member_id,  new.amount_minor, 'settlement', new.id),
         (new.group_id, new.seq, new.to_member_id,   -new.amount_minor, 'settlement', new.id);
  return null;
end $$;
create trigger settlements_post after insert on settlements
  for each row execute function settlements_post();

create function settlement_voids_post() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from ledger_entries le join memberships m on m.id = le.member_id
              where le.settlement_id = new.settlement_id and le.source = 'settlement' and m.status = 'left') then
    raise exception 'settlement % involves a member who has left; re-add them first', new.settlement_id
      using errcode = 'ZM001';
  end if;
  insert into ledger_entries (group_id, seq, member_id, delta_minor, source, settlement_id)
  select group_id, new.seq, member_id, -delta_minor, 'settlement_reversal', settlement_id
    from ledger_entries
   where settlement_id = new.settlement_id and source = 'settlement';
  return null;
end $$;
create trigger settlement_voids_post after insert on settlement_voids
  for each row execute function settlement_voids_post();

-- 4.6 Deferred (checked at COMMIT): a version's lines sum to its total and match the allocation rule.
create function check_expense_version() returns trigger
language plpgsql as $$
declare
  v         expense_versions%rowtype;
  n_lines   integer;
  n_part    integer;
  s_paid    numeric;
  s_owed    numeric;
  s_weight  numeric;
begin
  select * into v from expense_versions where expense_id = new.expense_id and version = new.version;
  select count(*), count(weight), coalesce(sum(paid_minor), 0), coalesce(sum(owed_minor), 0), coalesce(sum(weight), 0)
    into n_lines, n_part, s_paid, s_owed, s_weight
    from expense_lines where expense_id = v.expense_id and version = v.version;

  if v.kind = 'delete' then
    if n_lines > 0 then
      raise exception 'delete version %/% must not have lines', v.expense_id, v.version using errcode = 'ZL002';
    end if;
    return null;
  end if;

  if n_part = 0 then
    raise exception 'expense %/% has no participants', v.expense_id, v.version using errcode = 'ZL002';
  end if;
  if s_paid <> v.total_minor then
    raise exception 'expense %/%: payers sum to % but total is %', v.expense_id, v.version, s_paid, v.total_minor
      using errcode = 'ZL002';
  end if;
  if s_owed <> v.total_minor then
    raise exception 'expense %/%: splits sum to % but total is %', v.expense_id, v.version, s_owed, v.total_minor
      using errcode = 'ZL002';
  end if;

  if (v.split_method = 'equal' and exists (
        select 1 from expense_lines where expense_id = v.expense_id and version = v.version and weight <> 1))
     or (v.split_method = 'exact' and exists (
        select 1 from expense_lines where expense_id = v.expense_id and version = v.version and weight <> owed_minor))
     or (v.split_method = 'percent' and s_weight <> 10000) then
    raise exception 'expense %/%: weights do not match split method %', v.expense_id, v.version, v.split_method
      using errcode = 'ZL002';
  end if;

  -- The allocation function's guarantee: every share is floor or ceil of total * weight / Σweight,
  -- i.e. |owed * W - total * w| < W.
  if exists (
    select 1 from expense_lines
     where expense_id = v.expense_id and version = v.version and weight is not null
       and abs(owed_minor::numeric * s_weight - v.total_minor::numeric * weight) >= s_weight) then
    raise exception 'expense %/%: a share is outside its floor/ceil bound', v.expense_id, v.version
      using errcode = 'ZL002';
  end if;
  return null;
end $$;
create constraint trigger expense_versions_valid after insert on expense_versions
  deferrable initially deferred for each row execute function check_expense_version();
create constraint trigger expense_lines_valid after insert on expense_lines
  deferrable initially deferred for each row execute function check_expense_version();

-- 4.7 Deferred: every write transaction's postings net to zero.
create function check_seq_balanced() returns trigger
language plpgsql as $$
declare
  v_sum numeric;
begin
  select sum(delta_minor) into v_sum from ledger_entries where group_id = new.group_id and seq = new.seq;
  if v_sum <> 0 then
    raise exception 'ledger postings for group % seq % sum to %, not 0', new.group_id, new.seq, v_sum
      using errcode = 'ZL001';
  end if;
  return null;
end $$;
create constraint trigger ledger_entries_balanced after insert on ledger_entries
  deferrable initially deferred for each row execute function check_seq_balanced();

-- 4.8 Membership rules: never deleted; identity only null → user (claim); leave needs a zero balance.
create function memberships_guard() returns trigger
language plpgsql as $$
declare
  v_balance numeric;
begin
  if tg_op = 'DELETE' then
    raise exception 'memberships are never deleted; set status = ''left''' using errcode = 'ZA001';
  end if;
  if new.group_id <> old.group_id or new.created_seq <> old.created_seq or new.created_at <> old.created_at then
    raise exception 'immutable membership column changed' using errcode = 'ZM004';
  end if;
  if old.user_id is not null and new.user_id is distinct from old.user_id then
    raise exception 'membership % already belongs to a user', old.id using errcode = 'ZM004';
  end if;
  if old.status = 'merged' then
    raise exception 'membership % was merged and is final', old.id using errcode = 'ZM003';
  end if;

  if old.status = 'active' and new.status = 'left' then
    if old.role = 'owner' then
      raise exception 'the owner must transfer ownership before leaving' using errcode = 'ZM002';
    end if;
    select coalesce(sum(le.delta_minor), 0) into v_balance
      from memberships m join ledger_entries le on le.member_id = m.id
     where m.id = old.id or m.merged_into = old.id;
    if v_balance <> 0 then
      raise exception 'member % has a non-zero balance (% paise); settle up before leaving', old.id, v_balance
        using errcode = 'ZB001';
    end if;
  end if;

  if new.status = 'merged' and old.status <> 'merged' then
    if old.user_id is not null or old.status <> 'active' then
      raise exception 'only an active ghost can be merged' using errcode = 'ZM003';
    end if;
    perform 1 from memberships t
     where t.id = new.merged_into and t.status = 'active' and t.user_id is not null;
    if not found then
      raise exception 'merge target must be an active real member of the same group' using errcode = 'ZM003';
    end if;
  end if;
  return new;
end $$;
create trigger memberships_guard before update or delete on memberships
  for each row execute function memberships_guard();

-- ============================================================================
-- 5. Privileges for the app role
-- ============================================================================
grant select, insert on users, oauth_identities, sessions, groups, activity_log, memberships, invites,
                        idempotency_keys, expenses, expense_versions, expense_lines, settlements, settlement_voids
  to hisaab_app;
grant select on ledger_entries to hisaab_app;  -- written only by definer triggers
grant update (display_name, email, avatar_url, disabled_at) on users to hisaab_app;
grant update (email, email_verified, last_login_at) on oauth_identities to hisaab_app;
grant delete on oauth_identities to hisaab_app;  -- unlink a provider (app keeps at least one)
grant update (last_seen_at, revoked_at) on sessions to hisaab_app;
grant delete on sessions to hisaab_app;          -- purge expired
grant update (name, simplify_debts, archived_at, last_seq) on groups to hisaab_app;
grant update (user_id, display_name, role, status, merged_into, left_at, updated_seq) on memberships to hisaab_app;
grant update (used_at, used_by, revoked_at) on invites to hisaab_app;
grant delete on idempotency_keys to hisaab_app;  -- purge expired
-- Deliberately not granted: UPDATE/DELETE on activity_log, expenses, expense_versions, expense_lines,
-- settlements, settlement_voids; INSERT/UPDATE/DELETE on ledger_entries; TRUNCATE on anything.
```
