import { useRealtime } from './RealtimeProvider';

const LABEL = { live: 'Live', connecting: 'Connecting…', offline: 'Offline' } as const;
// On the crimson band; the word next to the dot carries the meaning, the colour only backs it up.
const DOT = { live: 'border-live bg-live', connecting: 'border-thread bg-thread animate-pulse', offline: 'border-band-ink bg-transparent' } as const;

/** A small dot and word on the header band: are changes arriving live? */
export function ConnectionStatus() {
  const rt = useRealtime();
  if (!rt) return null;
  const { status } = rt;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-band-ink" title={status === 'live' ? 'Changes from others appear as they happen' : 'Changes from others will appear when the connection is back'}>
      <span
        aria-hidden="true"
        className={`inline-block size-2.5 rounded-full border-2 ${DOT[status]}`}
      />
      <span data-testid="connection-status" data-status={status}>{LABEL[status]}</span>
    </span>
  );
}
