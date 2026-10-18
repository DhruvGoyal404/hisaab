import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useIdempotencyKey } from './idempotency';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('useIdempotencyKey', () => {
  it('keeps one UUID for the life of the form', () => {
    const { result, rerender } = renderHook(() => useIdempotencyKey());
    const first = result.current.key;
    rerender();
    rerender();
    expect(result.current.key).toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('drops a second submit while the first is in flight (double tap)', async () => {
    const { result } = renderHook(() => useIdempotencyKey());
    const pending = deferred();
    let calls = 0;
    const send = () => { calls += 1; return pending.promise; };
    act(() => {
      result.current.submit(send);
      result.current.submit(send);
    });
    expect(calls).toBe(1);
    pending.resolve();
    await flush();
  });

  it('allows a retry after a failure, with the same key', async () => {
    const { result } = renderHook(() => useIdempotencyKey());
    const keys: string[] = [];
    const first = deferred();
    act(() => { result.current.submit(() => { keys.push(result.current.key); return first.promise; }); });
    first.reject(new Error('network'));
    await flush();
    act(() => { result.current.submit(() => { keys.push(result.current.key); return Promise.resolve(); }); });
    await flush();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});
