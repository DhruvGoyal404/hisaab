import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { requireSession, sessionOf } from './auth.js';
import { HttpError } from './errors.js';
import { activityAfter, activityFeed } from './repo/reads.js';
import { settlePlan } from './repo/settlePlan.js';

const settlePlanQuery = z.object({ mode: z.enum(['auto', 'greedy', 'exact', 'raw']).optional() });

const activityQuery = z.object({
  afterSeq: z.coerce.number().int().min(0).optional(),
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});

export function groupsRouter(pool: pg.Pool): Router {
  const router = Router();
  router.use('/groups', requireSession(pool));

  // Suggested transfers. Default mode follows the group's "simplify debts" setting (auto or raw).
  router.get('/groups/:groupId/settle-plan', async (req, res) => {
    const { mode } = settlePlanQuery.parse(req.query);
    const { cached, ...plan } = await settlePlan(pool, { groupId: req.params.groupId, userId: sessionOf(res).userId, mode });
    res.set('X-Settle-Plan-Cache', cached ? 'hit' : 'miss').json(plan);
  });

  // ?afterSeq=N: catch-up after a real-time signal or reconnect (oldest first, with lastSeq).
  // Otherwise: the feed, newest first, paged with ?before=.
  router.get('/groups/:groupId/activity', async (req, res) => {
    const { afterSeq, before, limit } = activityQuery.parse(req.query);
    const base = { groupId: req.params.groupId, userId: sessionOf(res).userId, ...(limit !== undefined && { limit }) };
    if (afterSeq !== undefined) {
      if (before !== undefined) throw new HttpError(400, 'invalid_request', 'Use either afterSeq or before, not both');
      res.json(await activityAfter(pool, { ...base, afterSeq }));
      return;
    }
    res.json(await activityFeed(pool, { ...base, ...(before !== undefined && { before }) }));
  });

  return router;
}
