import { formatPaise, type SplitMethod } from '@hisaab/money';
import { useId, useMemo, useState, type SubmitEvent, type ReactNode } from 'react';
import { Button, ErrorNote, Field, Money } from '../../components/ui';
import type { ExpenseInput, GroupDetail } from '../../lib/api';
import { evaluateDraft, type Draft } from '../../lib/expenseDraft';

const METHODS: { id: SplitMethod; label: string; hint: string }[] = [
  { id: 'equal', label: 'Equally', hint: 'Tick who shares it.' },
  { id: 'exact', label: 'Exact amounts', hint: 'Enter what each person owes; it must add up to the total.' },
  { id: 'percent', label: 'Percentages', hint: 'Enter each person’s percentage; it must add up to 100.' },
  { id: 'shares', label: 'Shares', hint: 'Enter shares, like 2 for someone who had twice as much.' },
];

function Choice<T extends string>({ legend, value, options, onChange }: {
  legend: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void;
}) {
  const name = useId();
  return (
    <fieldset>
      <legend className="mb-1 font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <label
            key={o.id}
            className={`cursor-pointer rounded border px-3 py-2 font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--focus)] ${value === o.id ? 'border-ink bg-ink text-page' : 'border-field-line'}`}
          >
            <input type="radio" name={name} value={o.id} checked={value === o.id} onChange={() => { onChange(o.id); }} className="sr-only" />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export type ExpenseFormProps = {
  group: GroupDetail;
  initial: Draft;
  /** Tie-break seed: the expense id, so the preview matches the server to the paisa. */
  seed: string;
  submitLabel: string;
  submitting: boolean;
  serverError: unknown;
  onSubmit: (input: ExpenseInput, draft: Draft) => void;
  /** Rendered above the form, e.g. an edit conflict. */
  banner?: ReactNode;
  onDraftChange?: (draft: Draft) => void;
};

export function ExpenseForm({ group, initial, seed, submitLabel, submitting, serverError, onSubmit, banner, onDraftChange }: ExpenseFormProps) {
  const [draft, setDraftState] = useState<Draft>(initial);
  const [tried, setTried] = useState(false);
  const setDraft = (d: Draft) => {
    setDraftState(d);
    onDraftChange?.(d);
  };
  const memberIds = useMemo(() => group.members.map((m) => m.memberId), [group.members]);
  const r = useMemo(() => evaluateDraft(draft, memberIds, seed), [draft, memberIds, seed]);
  const errorOf = (field: string) => (tried ? r.errors.find((e) => e.field === field)?.message : undefined);
  const preview = new Map(r.preview.map((p) => [p.memberId, p]));

  const setValue = (method: SplitMethod, id: string, text: string) =>
    { setDraft({ ...draft, values: { ...draft.values, [method]: { ...draft.values[method], [id]: text } } }); };

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    setTried(true);
    if (r.input) onSubmit(r.input, draft);
  };

  const splitError = errorOf('split');
  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      {banner}
      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <Field
          label="What was it for?"
          value={draft.description}
          maxLength={200}
          onChange={(e) => { setDraft({ ...draft, description: e.target.value }); }}
          error={errorOf('description')}
        />
        <Field label="Date" type="date" value={draft.occurredOn} onChange={(e) => { setDraft({ ...draft, occurredOn: e.target.value }); }} error={errorOf('occurredOn')} />
      </div>
      <Field
        label="Amount"
        prefix="₹"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0.00"
        value={draft.amount}
        onChange={(e) => { setDraft({ ...draft, amount: e.target.value }); }}
        error={errorOf('amount')}
        hint={r.totalMinor !== null ? formatPaise(r.totalMinor) : 'Like 1,250 or 99.50'}
        className="max-w-xs"
      />

      <section className="space-y-3">
        <Choice
          legend="Paid by"
          value={draft.payerMode}
          options={[{ id: 'single', label: 'One person' }, { id: 'multiple', label: 'Several people' }]}
          onChange={(payerMode) => { setDraft({ ...draft, payerMode }); }}
        />
        {draft.payerMode === 'single' ? (
          <div className="max-w-xs">
            <label htmlFor="payer" className="sr-only">Who paid</label>
            <select
              id="payer"
              value={draft.payer}
              onChange={(e) => { setDraft({ ...draft, payer: e.target.value }); }}
              className="min-h-11 w-full rounded border border-field-line bg-field px-3"
            >
              {group.members.map((m) => <option key={m.memberId} value={m.memberId}>{m.isMe ? `${m.name} (you)` : m.name}</option>)}
            </select>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {group.members.map((m) => (
              <Field
                key={m.memberId}
                label={`${m.name} paid`}
                prefix="₹"
                inputMode="decimal"
                value={draft.payerAmounts[m.memberId] ?? ''}
                onChange={(e) => { setDraft({ ...draft, payerAmounts: { ...draft.payerAmounts, [m.memberId]: e.target.value } }); }}
                error={errorOf(`paid:${m.memberId}`)}
              />
            ))}
          </div>
        )}
        {errorOf('payers') && <p className="font-medium text-owe" role="alert">{errorOf('payers')}</p>}
      </section>

      <section className="space-y-3">
        <Choice legend="Split" value={draft.method} options={METHODS} onChange={(method) => { setDraft({ ...draft, method }); }} />
        <p className="text-sm text-muted">{METHODS.find((m) => m.id === draft.method)?.hint}</p>
        <ul className="ledger" aria-label="Each person’s share">
          {group.members.map((m) => {
            const p = preview.get(m.memberId);
            return (
              <li key={m.memberId} className="grid grid-cols-[minmax(0,1fr)_auto_6.5rem] items-center gap-3 py-2">
                {draft.method === 'equal' ? (
                  <label className="col-span-2 flex min-h-11 cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      className="size-5 accent-[var(--accent)]"
                      checked={draft.included[m.memberId] ?? false}
                      onChange={(e) => { setDraft({ ...draft, included: { ...draft.included, [m.memberId]: e.target.checked } }); }}
                    />
                    <span className="font-medium">{m.isMe ? `${m.name} (you)` : m.name}</span>
                  </label>
                ) : (
                  <>
                    <span className="truncate font-medium">{m.isMe ? 'You' : m.name}</span>
                    <Field
                      compact
                      label={draft.method === 'exact' ? `${m.name} owes` : draft.method === 'percent' ? `${m.name}’s percentage` : `${m.name}’s shares`}
                      {...(draft.method === 'exact' && { prefix: '₹' })}
                      inputMode={draft.method === 'shares' ? 'numeric' : 'decimal'}
                      placeholder={draft.method === 'percent' ? '%' : draft.method === 'shares' ? '0' : '0.00'}
                      value={draft.values[draft.method][m.memberId] ?? ''}
                      onChange={(e) => { setValue(draft.method, m.memberId, e.target.value); }}
                      error={errorOf(`split:${m.memberId}`)}
                      className="w-32"
                    />
                  </>
                )}
                <span className="text-right">
                  {p ? <Money paise={p.owedMinor} className={p.owedMinor === 0 ? 'text-muted' : 'font-semibold'} /> : <span className="text-muted" aria-hidden="true">–</span>}
                </span>
              </li>
            );
          })}
        </ul>
        <p aria-live="polite" className={`font-medium ${r.remaining ? 'text-owe' : 'text-muted'}`}>
          {r.remaining ?? (r.preview.length > 0 ? `Shares add up to ${formatPaise(r.totalMinor ?? 0)}.` : '')}
        </p>
        {splitError && !r.remaining && <p role="alert" className="font-medium text-owe">{splitError}</p>}
      </section>

      <ErrorNote error={serverError} />
      {tried && r.errors.length > 0 && (
        <p role="alert" className="font-medium text-owe">Fix {r.errors.length === 1 ? 'the highlighted field' : `the ${r.errors.length} highlighted fields`} to save.</p>
      )}
      <Button type="submit" className="w-full sm:w-auto" disabled={submitting}>{submitting ? 'Saving…' : submitLabel}</Button>
    </form>
  );
}
