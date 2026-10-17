import type { RequestHandler } from 'express';
import { HttpError } from './errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence: every state-changing request must carry an Origin header from the allowlist.
 * Browsers always send Origin on cross-site and same-site POST/PUT/PATCH/DELETE; a missing
 * Origin is rejected too, so non-browser clients must set it explicitly.
 */
export function requireAllowedOrigin(allowed: readonly string[]): RequestHandler {
  const allowSet = new Set(allowed);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const origin = req.get('origin');
    if (origin === undefined || !allowSet.has(origin)) {
      next(new HttpError(403, 'bad_origin', 'Origin not allowed'));
      return;
    }
    next();
  };
}
