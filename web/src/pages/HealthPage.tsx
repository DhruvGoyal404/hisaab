import { useQuery } from '@tanstack/react-query';
import { fetchHealth } from '../api';

function Row({ label, ok, text }: { label: string; ok: boolean; text: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <dt className="text-slate-600">{label}</dt>
      <dd className={`font-medium ${ok ? 'text-emerald-700' : 'text-rose-700'}`}>{text}</dd>
    </div>
  );
}

export function HealthPage() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => fetchHealth(signal),
    refetchInterval: 10_000,
    retry: false,
  });

  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <h1 className="text-2xl font-semibold text-slate-900">Hisaab</h1>
      <p className="mt-1 text-slate-600">System status</p>
      <section className="mt-6 rounded-lg border border-slate-200 bg-white px-4 py-2" aria-live="polite">
        {health.isPending ? (
          <p className="py-2 text-slate-500">Checking…</p>
        ) : health.isError ? (
          <dl>
            <Row label="API" ok={false} text="Unreachable" />
          </dl>
        ) : (
          <dl className="divide-y divide-slate-100">
            <Row label="API" ok text="Up" />
            <Row label="Database" ok={health.data.db === 'ok'} text={health.data.db === 'ok' ? 'Connected' : 'Unreachable'} />
          </dl>
        )}
      </section>
    </main>
  );
}
