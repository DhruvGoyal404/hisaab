# Settling up: algorithms

How Hisaab turns a group's balances into a list of payments. The code is in [`api/src/settle/`](../api/src/settle/), as pure functions with no database access. The endpoint is `GET /api/groups/:id/settle-plan?mode=auto|greedy|exact|raw`.

## The problem

Each member *i* of a group has a net balance bᵢ in paise. It is positive if the group owes them and negative if they owe. The balances sum to 0, because every ledger transaction does. A **plan** is a list of transfers (from, to, amount > 0) which, once paid, brings every balance to 0. We want plans with **few transfers**.

Members with bᵢ = 0 never need to appear in a plan. Below, **k** is the number of members with a non-zero balance.

## Why the minimum is k − m

Let **m** be the largest number of disjoint, non-empty, zero-sum groups the k members can be split into, with every member in some group. (m ≥ 1, since everyone together sums to 0.)

**Lower bound.** Take any valid plan and draw it as a graph: members are vertices, transfers are edges.
- Inside one connected component C, money moves only between members of C, and the plan zeroes all of them. So Σ_{i∈C} bᵢ = 0, which makes every component a zero-sum group.
- The components are disjoint and cover all k members, so there are at most m of them.
- A connected component with |C| vertices needs at least |C| − 1 edges.
- Summing over components: transfers ≥ Σ(|C| − 1) = k − (number of components) ≥ **k − m**.

**Upper bound.** Take a partition into m zero-sum groups and settle each group G on its own with |G| − 1 transfers. Greedy does this: every transfer zeroes at least one member, and the final transfer zeroes two. The total is Σ(|G| − 1) = **k − m**.

So **the minimum number of transfers is exactly k − m**. Finding the minimum is the same as finding the most disjoint zero-sum groups.

**Corollary: pair cancellation is free.** If bₐ = +x and b_b = −x, some optimal partition contains {a, b} as its own group. Suppose a and b sit in different zero-sum groups G₁ and G₂. Then G₁ ∪ G₂ splits into {a, b} and (G₁ ∪ G₂) \ {a, b}, both zero-sum, so the number of groups doesn't drop. Auto mode therefore pays every exact opposite pair directly before solving the rest.

## Why it is NP-hard

**From SUBSET-SUM.** Given positive integers a₁…aₙ and a target 0 < t < Σa, form the balances:

> creditors a₁, …, aₙ, and debtors −t and −(Σa − t)

- A proper zero-sum subset must contain exactly one debtor. With neither, it has only positives; with both, it needs every creditor, so it is the whole set.
- If it contains −t, its creditors sum to t. If it contains −(Σa − t), the creditors left out sum to t.
- So **"can this be settled in at most k − 2 transfers?"** (that is, m ≥ 2) is true exactly when some subset of the aᵢ sums to t.

SUBSET-SUM is NP-complete, so finding the minimum number of transfers is NP-hard.

**Strongly NP-hard, from 3-PARTITION.** Given 3q integers with each B/4 < aᵢ < B/2 and Σaᵢ = qB, take creditors aᵢ and q debtors of −B each.
- Every zero-sum group needs at least one debtor, so m ≤ q.
- m = q means each group is one −B and creditors summing to B. Because of the bounds on aᵢ, that is exactly three creditors.
- So the minimum is 4q − q = 3q transfers exactly when a 3-partition exists.

3-PARTITION is NP-complete even when the numbers are written in unary. So an algorithm that is pseudo-polynomial in the amounts is not expected either. It wouldn't help anyway, since amounts reach 10¹¹ paise.

The practical way out is that k is small: a trip or a flat rarely has more than a dozen people with non-zero balances.

## The algorithms

### Greedy ([`greedy.ts`](../api/src/settle/greedy.ts))

Keep two max-heaps, one of creditors and one of debtors. Repeatedly the largest debtor pays the largest creditor min(|debt|, credit), and any remainder goes back on its heap. Equal amounts are ordered by membership id, so the output is deterministic and doesn't depend on input order.

- **Bound:** every transfer zeroes at least one member, so there are at most **k − 1** transfers.
- **Cost:** O(k log k) time, O(k) memory. At k = 1000 it takes about 1 ms.
- **Not optimal.** For balances {A +3, B +2, C +2, D −4, E −3}, greedy pays D→A 3, E→B 2, D→C 1, E→C 1, which is 4 transfers. The optimum is 3: E→A 3, D→B 2 and D→C 2, using the groups {A, E} and {B, C, D}. This case is a fixed regression test.

### Exact ([`exact.ts`](../api/src/settle/exact.ts))

A bitmask DP over the k non-zero members, indexed in id order.

**Setup.**
- `zero[mask] = 1` when the members in `mask` sum to 0. Each subset sum is built from the subset without its lowest bit.
- The sums use a `Float64Array` when Σ|bᵢ| ≤ 2⁵³, where every partial sum is an exact integer. Otherwise they use a `BigInt64Array`, so a "zero" can never be a rounding artefact.

**Recurrence.**
- `dp[mask] = max over i ∈ mask of dp[mask \ {i}] + zero[mask]`, with dp[∅] = 0.
- Read dp[mask] as: over all orders of the members in `mask`, the most prefixes that sum to zero. Consecutive zero-sum prefixes cut that order into zero-sum blocks.
- Any partition can be laid out as consecutive blocks. So for the full set (which sums to zero), `dp[full] = m`.

**Reconstruction.**
- Walk back from the full mask, at each step removing the lowest-index member that keeps dp on its optimal value.
- The zero-sum masks reached along the way cut the members into m zero-sum groups. Each group is settled greedily with |G| − 1 transfers, for k − m in total.

**Cost.**
- O(2ᵏ · k) time.
- Memory: 2ᵏ bytes each for `dp` and `zero`, plus 8 · 2ᵏ bytes for the sums. At k = 19 that is about 5 MB.

### Auto ([`auto.ts`](../api/src/settle/auto.ts))

1. Pay every exact opposite pair (+x, −x) directly. This is free, by the corollary above.
2. If at most **18** members remain, solve them exactly; otherwise use greedy.

The response's `k` counts members before pair cancellation. Auto is what a group gets by default.

### Raw ([`raw.ts`](../api/src/settle/raw.ts))

No simplification: each participant owes the people who paid for each expense, netted per pair across all expenses and settlements. A settlement from A to B reduces A's debt to B.

**Several payers.** Participants are taken in id order. Each one's share is split across the payers in proportion to what each payer is *still* owed, using the same largest-remainder core as `allocate()` (`largestRemainder`).
- This stays close to proportional.
- It keeps both margins exact: every participant owes exactly their share, and every payer is owed exactly what they paid.
- So raw transfers settle exactly the balances the ledger shows. A property test checks this on random multi-payer groups.

## Choosing the threshold (measured)

The budget: a plan is computed on the API's event loop, so no computation should block it for more than about **50 ms**.

The benchmark is `npm run bench:settle -w api` ([script](../api/scripts/bench-settle.ts)). It uses the worst case for each k, with random large balances so there is no zero-sum proper subset, and runs 30 iterations (10 for k ≥ 19) after a JIT warm-up. CI appends the same table to every run's job summary.

**Dev machine** (Intel i5-1235U, Node 22.19, shared with a heavy concurrent workload):

| algorithm | k | median ms | p95 ms | max ms | transfers |
|---|---|---|---|---|---|
| exact | 12 | 0.1 | 2.5 | 2.9 | 11 |
| exact | 14 | 0.3 | 1.1 | 1.3 | 13 |
| exact | 16 | 1.1 | 1.6 | 1.8 | 15 |
| exact | 17 | 2.2 | 2.7 | 2.8 | 16 |
| exact | 18 | 5.3 | 15.0 | 16.7 | 17 |
| exact | 19 | 14.8 | 21.8 | 21.8 | 18 |
| exact | 20 | 37.4 | 63.4 | 63.4 | 19 |
| greedy | 100 | 0.4 | 1.0 | 1.4 | 99 |
| greedy | 1000 | 1.2 | 5.6 | 5.8 | 998 |

A second local run gave k = 20 at 38.5 ms median and 66.3 ms p95.

**CI** (GitHub-hosted ubuntu-24.04, AMD EPYC 9V74, Node 22.23):

| algorithm | k | median ms | p95 ms | max ms | transfers |
|---|---|---|---|---|---|
| exact | 12 | 0.1 | 3.1 | 3.1 | 11 |
| exact | 14 | 0.4 | 2.1 | 3.8 | 13 |
| exact | 16 | 2.0 | 2.0 | 3.7 | 15 |
| exact | 17 | 2.1 | 3.5 | 3.8 | 16 |
| exact | 18 | 3.6 | 4.6 | 5.0 | 17 |
| exact | 19 | 7.5 | 26.2 | 26.2 | 18 |
| exact | 20 | 15.3 | 16.6 | 16.6 | 19 |
| greedy | 100 | 0.1 | 0.3 | 1.2 | 99 |
| greedy | 1000 | 0.9 | 1.4 | 1.5 | 998 |

**Decisions:**

- **Auto threshold: 18.** Its worst case is 15 ms p95 on the loaded dev machine and 4.6 ms in CI. That leaves more than 3× headroom against the 50 ms budget, so **no worker thread is needed**, and the response time is dominated by the database.
- **Hard cap for `mode=exact`: 19 members** (`MAX_EXACT_MEMBERS`). At k = 20 the dev machine went over budget (63–66 ms p95). Above the cap the endpoint answers 422 and points to `auto`.
- **Plans are cached** by (group, `last_seq`, mode) in a 500-entry LRU. A busy page refetching the plan costs one cheap snapshot query, not a recomputation. The key includes `last_seq`, so a cached plan always matches the data it was computed from.
- **If groups grow:** Each extra member doubles the DP's time and memory. Past about 20 members, move exact into a `worker_thread` with a time limit, or prune the DP. Greedy is already fine at k = 1000.

## Raw or simplified?

Both settle everyone exactly. Each person pays or receives the same *net* amount either way. They differ in **who pays whom**.

| | Simplified (auto, the default) | Raw |
|---|---|---|
| Number of payments | Minimal (exact) or at most k − 1 (greedy) | One per pair that has unsettled expenses, up to k(k − 1)/2 |
| Who pays whom | Possibly someone you never shared an expense with ("Dev pays Esha", although Dev only owed Bilal) | Only people you actually owe, from expenses you were part of |
| Stability | A new expense can reshuffle the whole plan | Only the pairs in that expense change |
| Good for | Trips, flatmates, close friends who want the fewest UPI transfers | Loose groups, colleagues, anyone who wants payments to mirror the expenses, groups that settle pair by pair over time |

Each group switches with its **simplify debts** setting (on by default). When it is off, the default mode is `raw`. Any mode can still be requested explicitly.

A plan is advice and is never stored. Paying someone is recorded as a settlement in the ledger, and the next plan is computed from the new balances.

## How it is tested

- **Properties** ([`properties.test.ts`](../api/test/settle/properties.test.ts)), 10,000 runs each, run with fast-check:
  - Every algorithm returns a valid plan: transfers zero all balances; amounts are positive safe integers; there are no self-transfers; and in simplified plans only net debtors pay and only net creditors receive.
  - Greedy uses at most k − 1 transfers; exact uses no more than greedy; auto uses no more than greedy and equals exact while k ≤ 18.
  - **Exact equals a brute-force minimum** over all set partitions for k ≤ 7.
  - Output is deterministic and doesn't depend on input order.
  - Raw transfers settle exactly the ledger balances on random multi-payer groups, with at most one transfer per pair.
- **Unit tests:** heap tie-breaking, BigInt fallback for sums beyond 2⁵³, the member cap, and pair cancellation.
- **API integration tests** ([`settlePlan.int.test.ts`](../api/test/settlePlan.int.test.ts)):
  - each mode on the 4-versus-3 case, built from real expenses;
  - cache hit, then a miss after a write;
  - raw becomes the default when simplification is off;
  - 401 without a session and 404 for non-members;
  - every plan zeroes the group's balances.
