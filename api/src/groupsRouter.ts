import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { requireSession, sessionOf } from './auth.js';
import { settlePlan } from './repo/settlePlan.js';

const settlePlanQuery = z.object({ mode: z.enum(['auto', 'greedy', 'exact', 'raw']).optional() });

export function groupsRouter(pool: pg.Pool): Router {
  const router = Router();
  router.use('/groups', requireSession(pool));

  // Suggested transfers. Default mode follows the group's "simplify debts" setting (auto or raw).
  router.get('/groups/:groupId/settle-plan', async (req, res) => {
    const { mode } = settlePlanQuery.parse(req.query);
    const { cached, ...plan } = await settlePlan(pool, { groupId: req.params.groupId, userId: sessionOf(res).userId, mode });
    res.set('X-Settle-Plan-Cache', cached ? 'hit' : 'miss').json(plan);
  });

  return router;
}
