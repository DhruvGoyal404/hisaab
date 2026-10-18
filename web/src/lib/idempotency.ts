import { useRef, useState } from 'react';

/**
 * One Idempotency-Key per form opening. Every submit from that form (a retry after a network
 * error, a double tap) carries the same key, so the server records the write at most once.
 * A submit while one is already in flight is dropped here too, before it reaches the network.
 */
export function useIdempotencyKey(): { key: string; submit: (send: () => Promise<unknown>) => void } {
  const [key] = useState(() => crypto.randomUUID());
  const inFlight = useRef(false);
  const submit = (send: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    send()
      .catch(() => undefined) // the caller's mutation state shows the error; a retry reuses the key
      .finally(() => { inFlight.current = false; });
  };
  return { key, submit };
}
