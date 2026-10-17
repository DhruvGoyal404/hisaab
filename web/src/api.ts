export type Health = { status: 'ok' | 'degraded'; db: 'ok' | 'unreachable' };

/**
 * /api/health answers 503 with a JSON body when the database is down, so any JSON body
 * of the right shape is a result; only network or proxy failures are errors.
 */
export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  const res = await fetch('/api/health', { signal: signal ?? null });
  const body: unknown = await res.json().catch(() => null);
  if (typeof body === 'object' && body !== null && 'status' in body && 'db' in body) {
    return body as Health;
  }
  throw new Error(`API unreachable (HTTP ${res.status})`);
}
