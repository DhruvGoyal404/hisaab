import { formatPaise, parseRupees } from '@hisaab/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { AppShell, Button, ErrorNote, Field, Loading, Money } from '../components/ui';
import { api, keys, type GroupDetail } from '../lib/api';
import { useGroup } from '../lib/groupQueries';
import { useIdempotencyKey } from '../lib/idempotency';

function MemberSelect({ id, label, value, onChange, group, error }: {
  id: string; label: string; value: string; onChange: (v: string) => void; group: GroupDetail; error?: string | undefined;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block font-medium">{label}</label>
      <select
        id={id}
        value={value}
        onChange={(e) => { onChange(e.target.value); }}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        className={`min-h-11 w-full rounded border bg-field px-3 ${error ? 'border-owe' : 'border-field-line'}`}
      >
        <option value="">Choose someone</option>
        {group.members.map((m) => <option key={m.memberId} value={m.memberId}>{m.isMe ? `${m.name} (you)` : m.name}</option>)}
      </select>
      {error && <p id={`${id}-err`} className="mt-1 text-sm font-medium text-owe">{error}</p>}
    </div>
  );
}

export function SettleUpPage() {
  const { groupId = '' } = useParams();
  const [params] = useSearchParams();
  const group = useGroup(groupId);
  const g = group.data;
  const plan = useQuery({
    queryKey: keys.plan(groupId, g?.simplifyDebts === false ? 'raw' : 'auto'),
    queryFn: () => api.settlePlan(groupId, g?.simplifyDebts === false ? 'raw' : 'auto'),
    enabled: g !== undefined,
  });
  const prefillAmount = Number(params.get('amount') ?? '');
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');
  const [amount, setAmount] = useState(Number.isSafeInteger(prefillAmount) && prefillAmount > 0 ? formatPaise(prefillAmount).replace(/^₹/, '') : '');
  const [tried, setTried] = useState(false);
  const idempotency = useIdempotencyKey();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const record = useMutation({
    mutationFn: (t: { from: string; to: string; amountMinor: number }) => api.createSettlement(groupId, t, idempotency.key),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.group(groupId) });
      await qc.invalidateQueries({ queryKey: keys.myGroups });
      await navigate(`/groups/${groupId}?tab=balances`);
    },
  });

  const parsed = parseRupees(amount);
  const errors = {
    from: from === '' ? 'Choose who paid' : undefined,
    to: to === '' ? 'Choose who received the money' : to === from ? 'Pick two different people' : undefined,
    amount: !parsed.ok ? parsed.error : parsed.paise === 0 ? 'Enter an amount above ₹0.00' : undefined,
  };
  const show = (e: string | undefined) => (tried ? e : undefined);
  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    setTried(true);
    if (errors.from || errors.to || errors.amount || !parsed.ok) return;
    const t = { from, to, amountMinor: parsed.paise };
    idempotency.submit(() => record.mutateAsync(t));
  };
  const nameOf = (id: string) => g?.members.find((m) => m.memberId === id)?.name ?? 'A former member';

  return (
    <AppShell
      back={{ to: `/groups/${groupId}?tab=settle`, label: 'Back to the group' }}
      title={<><p className="truncate">{g?.name ?? ''}</p><h1 className="font-display text-3xl leading-tight">Record a payment</h1></>}
    >
      {group.isPending && <Loading what="the group" />}
      <ErrorNote error={group.error} />
      {g && (
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <form onSubmit={submit} noValidate className="max-w-md space-y-4">
            <p className="text-muted">Record money that has already changed hands, by UPI, cash or anything else.</p>
            <MemberSelect id="from" label="Who paid" value={from} onChange={setFrom} group={g} error={show(errors.from)} />
            <MemberSelect id="to" label="Who received it" value={to} onChange={setTo} group={g} error={show(errors.to)} />
            <Field label="Amount" prefix="₹" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); }} error={show(errors.amount)} />
            <ErrorNote error={record.error} />
            <Button type="submit" className="w-full sm:w-auto" disabled={record.isPending}>{record.isPending ? 'Recording…' : 'Record payment'}</Button>
          </form>
          <section aria-labelledby="suggested">
            <h2 id="suggested" className="mb-2 font-display text-2xl">Suggested</h2>
            {plan.isPending && <Loading what="suggestions" />}
            {plan.data?.transfers.length === 0 && <p className="text-muted">Everyone is square already.</p>}
            <ul className="ledger">
              {plan.data?.transfers.map((t) => (
                <li key={`${t.from}-${t.to}`}>
                  <button
                    type="button"
                    className="flex min-h-12 w-full items-center justify-between gap-3 py-2 text-left hover:bg-sheet"
                    onClick={() => { setFrom(t.from); setTo(t.to); setAmount(formatPaise(t.amountMinor).replace(/^₹/, '')); }}
                  >
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]"><span className="inline-block font-semibold">{nameOf(t.from)}</span> pays <span className="inline-block font-semibold">{nameOf(t.to)}</span></span>
                    <Money paise={t.amountMinor} className="shrink-0 font-semibold" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </AppShell>
  );
}
