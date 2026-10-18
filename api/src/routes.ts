import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { requireSession, sessionOf } from './auth.js';
import { HttpError } from './errors.js';
import { createExpense, deleteExpense, editExpense, getExpense, restoreExpense } from './repo/expenses.js';
import {
  acceptInvite, addGhost, createGroup, createInvite, leaveGroup, previewInvite, setSimplifyDebts,
} from './repo/groups.js';
import { activityAfter, activityFeed, groupBalances, groupDetail, userBalances } from './repo/reads.js';
import { settlePlan } from './repo/settlePlan.js';
import { createSettlement } from './repo/settlements.js';

// Shapes only; the repository layer owns the business rules (amount ranges, split validity, membership).
const expenseBody = z.object({
  description: z.string().max(200),
  occurredOn: z.string().max(10),
  totalMinor: z.number().int(),
  payers: z.array(z.object({ memberId: z.string(), paidMinor: z.number().int() })).min(1).max(200),
  split: z.object({
    method: z.enum(['equal', 'exact', 'percent', 'shares']),
    weights: z.array(z.object({ memberId: z.string(), weight: z.number().int() })).min(1).max(200),
  }),
});
const settlementBody = z.object({
  fromMemberId: z.string(),
  toMemberId: z.string(),
  amountMinor: z.number().int(),
  note: z.string().max(200).optional(),
});
const groupBody = z.object({ name: z.string().max(80) });
const groupPatch = z.object({ simplifyDebts: z.boolean() });
const ghostBody = z.object({ displayName: z.string().max(60) });
const inviteBody = z.object({ ghostMemberId: z.string().optional() });
const settlePlanQuery = z.object({ mode: z.enum(['auto', 'greedy', 'exact', 'raw']).optional() });
const activityQuery = z.object({
  afterSeq: z.coerce.number().int().min(0).optional(),
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});

const idempotencyKey = (req: Request): string | undefined => req.get('idempotency-key') ?? undefined;

/** Optimistic concurrency: edits, deletes and restores must name the version they were based on. */
function ifMatch(req: Request): number {
  const m = /^(?:W\/)?"?(\d+)"?$/.exec(req.get('if-match')?.trim() ?? '');
  if (!m) throw new HttpError(428, 'precondition_required', 'Send If-Match with the expense version you edited');
  return Number(m[1]);
}

/** Every route here needs a signed-in user; group routes also need membership (404 otherwise). */
export function apiRoutes(pool: pg.Pool): Router {
  const router = Router();
  router.use(['/me', '/groups', '/invites'], requireSession(pool));
  const user = (res: Parameters<typeof sessionOf>[0]) => sessionOf(res).userId;

  router.get('/me', (_req, res) => {
    const s = sessionOf(res);
    res.json({ user: { id: s.userId, name: s.userName } });
  });

  // Groups
  router.get('/groups', async (_req, res) => {
    res.json(await userBalances(pool, { userId: user(res) }));
  });
  router.post('/groups', async (req, res) => {
    const { name } = groupBody.parse(req.body);
    res.status(201).json(await createGroup(pool, { userId: user(res), name }));
  });
  router.get('/groups/:groupId', async (req, res) => {
    res.json(await groupDetail(pool, { groupId: req.params.groupId, userId: user(res) }));
  });
  router.patch('/groups/:groupId', async (req, res) => {
    const { simplifyDebts } = groupPatch.parse(req.body);
    await setSimplifyDebts(pool, { groupId: req.params.groupId, userId: user(res), simplifyDebts });
    res.status(204).end();
  });
  router.get('/groups/:groupId/balances', async (req, res) => {
    res.json({ members: await groupBalances(pool, { groupId: req.params.groupId, userId: user(res) }) });
  });
  router.get('/groups/:groupId/settle-plan', async (req, res) => {
    const { mode } = settlePlanQuery.parse(req.query);
    const { cached, ...plan } = await settlePlan(pool, { groupId: req.params.groupId, userId: user(res), mode });
    res.set('X-Settle-Plan-Cache', cached ? 'hit' : 'miss').json(plan);
  });
  // ?afterSeq=N: catch-up after a real-time signal or reconnect (oldest first, with lastSeq).
  // Otherwise: the feed, newest first, paged with ?before=.
  router.get('/groups/:groupId/activity', async (req, res) => {
    const { afterSeq, before, limit } = activityQuery.parse(req.query);
    const base = { groupId: req.params.groupId, userId: user(res), ...(limit !== undefined && { limit }) };
    if (afterSeq !== undefined) {
      if (before !== undefined) throw new HttpError(400, 'invalid_request', 'Use either afterSeq or before, not both');
      res.json(await activityAfter(pool, { ...base, afterSeq }));
      return;
    }
    res.json(await activityFeed(pool, { ...base, ...(before !== undefined && { before }) }));
  });
  router.post('/groups/:groupId/leave', async (req, res) => {
    await leaveGroup(pool, { groupId: req.params.groupId, userId: user(res) });
    res.status(204).end();
  });

  // Members and invites
  router.post('/groups/:groupId/ghosts', async (req, res) => {
    const { displayName } = ghostBody.parse(req.body);
    res.status(201).json({ memberId: await addGhost(pool, { groupId: req.params.groupId, userId: user(res), displayName }) });
  });
  router.post('/groups/:groupId/invites', async (req, res) => {
    const { ghostMemberId } = inviteBody.parse(req.body ?? {});
    const invite = await createInvite(pool, {
      groupId: req.params.groupId, userId: user(res), ...(ghostMemberId !== undefined && { ghostMemberId }),
    });
    res.status(201).json(invite);
  });
  router.get('/invites/:token', async (req, res) => {
    res.json(await previewInvite(pool, { token: req.params.token, userId: user(res) }));
  });
  router.post('/invites/:token/accept', async (req, res) => {
    res.json(await acceptInvite(pool, { token: req.params.token, userId: user(res) }));
  });

  // Expenses
  router.post('/groups/:groupId/expenses', async (req, res) => {
    const { expenseId, ...expense } = expenseBody.extend({ expenseId: z.string().optional() }).parse(req.body);
    const key = idempotencyKey(req);
    const r = await createExpense(pool, {
      groupId: req.params.groupId, userId: user(res), expense,
      ...(key !== undefined && { idempotencyKey: key }), ...(expenseId !== undefined && { expenseId }),
    });
    res.status(r.replayed ? 200 : 201).set('Idempotent-Replay', String(r.replayed)).json({ expenseId: r.expenseId, version: r.version });
  });
  router.get('/groups/:groupId/expenses/:expenseId', async (req, res) => {
    const view = await getExpense(pool, { groupId: req.params.groupId, userId: user(res), expenseId: req.params.expenseId });
    res.set('ETag', `"${view.version}"`).json(view);
  });
  router.put('/groups/:groupId/expenses/:expenseId', async (req, res) => {
    const expectedVersion = ifMatch(req);
    const expense = expenseBody.parse(req.body);
    const r = await editExpense(pool, {
      groupId: req.params.groupId, userId: user(res), expenseId: req.params.expenseId, expectedVersion, expense,
    });
    res.set('ETag', `"${r.version}"`).json(r);
  });
  router.delete('/groups/:groupId/expenses/:expenseId', async (req, res) => {
    const r = await deleteExpense(pool, {
      groupId: req.params.groupId, userId: user(res), expenseId: req.params.expenseId, expectedVersion: ifMatch(req),
    });
    res.set('ETag', `"${r.version}"`).json(r);
  });
  router.post('/groups/:groupId/expenses/:expenseId/restore', async (req, res) => {
    const r = await restoreExpense(pool, {
      groupId: req.params.groupId, userId: user(res), expenseId: req.params.expenseId, expectedVersion: ifMatch(req),
    });
    res.set('ETag', `"${r.version}"`).json(r);
  });

  // Settlements
  router.post('/groups/:groupId/settlements', async (req, res) => {
    const settlement = settlementBody.parse(req.body);
    const key = idempotencyKey(req);
    const r = await createSettlement(pool, {
      groupId: req.params.groupId, userId: user(res), settlement: {
        fromMemberId: settlement.fromMemberId, toMemberId: settlement.toMemberId, amountMinor: settlement.amountMinor,
        ...(settlement.note !== undefined && { note: settlement.note }),
      }, ...(key !== undefined && { idempotencyKey: key }),
    });
    res.status(r.replayed ? 200 : 201).set('Idempotent-Replay', String(r.replayed)).json({ settlementId: r.settlementId });
  });

  return router;
}
