import { formatPaise } from '@hisaab/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { AppShell, Button, btn, dateLabel, ErrorNote, Loading, Money, todayLocal } from '../../components/ui';
import { api, ApiError, keys, type Expense, type ExpenseInput, type GroupDetail } from '../../lib/api';
import { draftFromExpense, emptyDraft, evaluateDraft, formatBasisPoints, type Draft } from '../../lib/expenseDraft';
import { useGroup } from '../../lib/groupQueries';
import { useIdempotencyKey } from '../../lib/idempotency';
import { ExpenseForm } from './ExpenseForm';

const METHOD_LABEL = { equal: 'equally', exact: 'by exact amounts', percent: 'by percentage', shares: 'by shares' } as const;

function Shell({ group, title, children, back }: { group: GroupDetail | undefined; title: string; back: string; children: ReactNode }) {
  return (
    <AppShell
      back={{ to: back, label: 'Back' }}
      title={
        <>
          <p className="truncate text-band-ink">{group?.name ?? ''}</p>
          <h1 className="font-display text-3xl leading-tight">{title}</h1>
        </>
      }
    >
      {children}
    </AppShell>
  );
}

export function NewExpensePage() {
  const { groupId = '' } = useParams();
  const group = useGroup(groupId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Chosen once when the form opens: the expense id doubles as the preview's tie-break seed.
  const [expenseId] = useState(() => crypto.randomUUID());
  const idempotency = useIdempotencyKey();
  const create = useMutation({
    mutationFn: (input: ExpenseInput) => api.createExpense(groupId, expenseId, input, idempotency.key),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.group(groupId) });
      await qc.invalidateQueries({ queryKey: keys.myGroups });
      await navigate(`/groups/${groupId}`);
    },
  });
  const g = group.data;
  return (
    <Shell group={g} title="Add expense" back={`/groups/${groupId}`}>
      {group.isPending && <Loading what="the group" />}
      <ErrorNote error={group.error} />
      {g && (
        <ExpenseForm
          group={g}
          initial={emptyDraft(g.members.map((m) => m.memberId), g.me.memberId, todayLocal())}
          seed={expenseId}
          submitLabel="Add expense"
          submitting={create.isPending}
          serverError={create.error}
          onSubmit={(input) => { idempotency.submit(() => create.mutateAsync(input)); }}
        />
      )}
    </Shell>
  );
}

/** One-line descriptions of an expense's parts, for comparing two versions. */
function summarize(e: { description: string; occurredOn: string; totalMinor: number; method: string; paid: [string, number][]; owed: [string, number][] }, nameOf: (id: string) => string) {
  const list = (pairs: [string, number][]) => pairs.filter(([, v]) => v > 0).map(([id, v]) => `${nameOf(id)} ${formatPaise(v)}`).join(', ');
  return {
    'What it was for': e.description,
    Date: dateLabel(e.occurredOn),
    Amount: formatPaise(e.totalMinor),
    'Paid by': list(e.paid),
    Split: `${METHOD_LABEL[e.method as keyof typeof METHOD_LABEL]}: ${list(e.owed)}`,
  };
}

function ConflictPanel({ group, latest, draft, onKeepMine, onUseSaved, saving }: {
  group: GroupDetail; latest: Expense; draft: Draft; onKeepMine: () => void; onUseSaved: () => void; saving: boolean;
}) {
  const nameOf = (id: string) => group.members.find((m) => m.memberId === id)?.name ?? 'A former member';
  const ids = group.members.map((m) => m.memberId);
  const mine = evaluateDraft(draft, ids, latest.expenseId);
  const saved = summarize({
    description: latest.description, occurredOn: latest.occurredOn, totalMinor: latest.totalMinor, method: latest.splitMethod,
    paid: latest.lines.map((l) => [l.memberId, l.paidMinor]), owed: latest.lines.map((l) => [l.memberId, l.owedMinor]),
  }, nameOf);
  const yours = mine.input
    ? summarize({
        description: mine.input.description, occurredOn: mine.input.occurredOn, totalMinor: mine.input.totalMinor, method: mine.input.split.method,
        paid: mine.input.payers.map((p) => [p.memberId, p.paidMinor]), owed: mine.preview.map((p) => [p.memberId, p.owedMinor]),
      }, nameOf)
    : null;
  const rows = (Object.keys(saved) as (keyof typeof saved)[]).filter((k) => !yours || yours[k] !== saved[k]);
  return (
    <section role="alert" aria-labelledby="conflict-title" className="rounded border-2 border-owe bg-danger-bg p-4">
      <h2 id="conflict-title" className="font-display text-xl">Someone changed this expense while you were editing</h2>
      <p className="mt-1">Here is what is saved now, next to your version.</p>
      <table className="mt-3 w-full text-left">
        <thead>
          <tr><th scope="col" className="pr-2 font-semibold">Field</th><th scope="col" className="pr-2 font-semibold">Saved now</th><th scope="col" className="font-semibold">Yours</th></tr>
        </thead>
        <tbody>
          {rows.map((k) => (
            <tr key={k} className="border-t border-rule align-top">
              <th scope="row" className="py-2 pr-2 font-medium">{k}</th>
              <td className="py-2 pr-2">{saved[k]}</td>
              <td className="py-2">{yours ? yours[k] : 'Your draft has fields to fix'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button onClick={onKeepMine} disabled={saving || !mine.input}>Save my version</Button>
        <Button variant="secondary" onClick={onUseSaved}>Use the saved version</Button>
      </div>
    </section>
  );
}

export function EditExpensePage() {
  const { groupId = '', expenseId = '' } = useParams();
  const group = useGroup(groupId);
  const expense = useQuery({ queryKey: keys.expense(groupId, expenseId), queryFn: () => api.expense(groupId, expenseId), staleTime: Infinity });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [base, setBase] = useState<{ version: number; draft: Draft; formKey: number } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [conflict, setConflict] = useState<Expense | null>(null);

  const g = group.data;
  const ids = g?.members.map((m) => m.memberId) ?? [];
  if (!base && expense.data && g) {
    const initial = draftFromExpense(expense.data, ids);
    setBase({ version: expense.data.version, draft: initial, formKey: 0 });
    setDraft(initial);
  }

  const save = useMutation({
    mutationFn: ({ input, version }: { input: ExpenseInput; version: number }) => api.editExpense(groupId, expenseId, version, input),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.group(groupId) });
      await qc.invalidateQueries({ queryKey: keys.myGroups });
      await navigate(`/groups/${groupId}/expenses/${expenseId}`);
    },
    onError: async (err) => {
      if (err instanceof ApiError && err.code === 'version_conflict') {
        setConflict(await api.expense(groupId, expenseId));
      }
    },
  });

  return (
    <Shell group={g} title="Edit expense" back={`/groups/${groupId}/expenses/${expenseId}`}>
      {(group.isPending || expense.isPending) && <Loading what="the expense" />}
      <ErrorNote error={group.error ?? expense.error} />
      {expense.data?.deleted && <p className="font-medium">This expense is deleted. Restore it before editing.</p>}
      {g && base && draft && !expense.data?.deleted && (
        <ExpenseForm
          key={base.formKey}
          group={g}
          initial={base.draft}
          seed={expenseId}
          submitLabel="Save changes"
          submitting={save.isPending}
          serverError={conflict ? null : save.error}
          onDraftChange={setDraft}
          onSubmit={(input) => { save.mutate({ input, version: base.version }); }}
          banner={conflict && (
            <ConflictPanel
              group={g}
              latest={conflict}
              draft={draft}
              saving={save.isPending}
              onKeepMine={() => {
                const input = evaluateDraft(draft, ids, expenseId).input;
                if (!input) return;
                setBase({ ...base, version: conflict.version });
                setConflict(null);
                save.mutate({ input, version: conflict.version });
              }}
              onUseSaved={() => {
                const saved = draftFromExpense(conflict, ids);
                setBase({ version: conflict.version, draft: saved, formKey: base.formKey + 1 });
                setDraft(saved);
                setConflict(null);
              }}
            />
          )}
        />
      )}
    </Shell>
  );
}

export function ExpensePage() {
  const { groupId = '', expenseId = '' } = useParams();
  const group = useGroup(groupId);
  const expense = useQuery({ queryKey: keys.expense(groupId, expenseId), queryFn: () => api.expense(groupId, expenseId) });
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string>();
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: keys.group(groupId) });
    await qc.invalidateQueries({ queryKey: keys.myGroups });
  };
  const onConflict = async (err: unknown) => {
    if (err instanceof ApiError && err.code === 'version_conflict') {
      setNotice('Someone changed this expense a moment ago. Here is the latest version; try again if you still want to.');
      await refresh();
    }
  };
  const remove = useMutation({
    mutationFn: (version: number) => api.deleteExpense(groupId, expenseId, version),
    onSuccess: refresh,
    onError: onConflict,
  });
  const restore = useMutation({
    mutationFn: (version: number) => api.restoreExpense(groupId, expenseId, version),
    onSuccess: refresh,
    onError: onConflict,
  });

  const g = group.data;
  const e = expense.data;
  const nameOf = (id: string) => g?.members.find((m) => m.memberId === id)?.name ?? 'A former member';
  return (
    <Shell group={g} title={e?.description ?? 'Expense'} back={`/groups/${groupId}`}>
      {(group.isPending || expense.isPending) && <Loading what="the expense" />}
      <ErrorNote error={group.error ?? expense.error} />
      {notice && <p role="status" className="mb-4 rounded bg-sheet px-3 py-2">{notice}</p>}
      {e && (
        <article className="space-y-6">
          <div className="flex flex-wrap items-center gap-4">
            <p className={`font-display text-4xl ${e.deleted ? 'text-muted line-through' : ''}`}><Money paise={e.totalMinor} /></p>
            {e.deleted && <span className="stamp" role="img" aria-label="Deleted"><span className="font-display text-xl" aria-hidden="true">Deleted</span></span>}
          </div>
          <p className="text-muted">{dateLabel(e.occurredOn)}, split {METHOD_LABEL[e.splitMethod]}</p>
          <section>
            <h2 className="mb-2 font-display text-2xl">Who paid, who owes</h2>
            <ul className="ledger">
              {e.lines.map((l) => (
                <li key={l.memberId} className="flex items-center justify-between gap-3 py-3">
                  <span className="font-medium">{nameOf(l.memberId)}</span>
                  <span className="text-right">
                    {l.paidMinor > 0 && <span className="block">paid <Money paise={l.paidMinor} /></span>}
                    {l.weight !== null && (
                      <span className="block text-muted">
                        share <Money paise={l.owedMinor} />
                        {e.splitMethod === 'percent' && ` (${formatBasisPoints(l.weight)})`}
                        {e.splitMethod === 'shares' && ` (${l.weight} ${l.weight === 1 ? 'share' : 'shares'})`}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <ErrorNote error={remove.error instanceof ApiError && remove.error.code === 'version_conflict' ? null : remove.error} />
          <ErrorNote error={restore.error instanceof ApiError && restore.error.code === 'version_conflict' ? null : restore.error} />
          <div className="flex flex-wrap gap-3">
            {e.deleted ? (
              <Button onClick={() => { restore.mutate(e.version); }} disabled={restore.isPending}>Restore expense</Button>
            ) : (
              <>
                <Link to={`/groups/${groupId}/expenses/${expenseId}/edit`} className={btn.primary}>Edit expense</Link>
                <Button variant="secondary" disabled={remove.isPending} onClick={() => { if (window.confirm(`Delete “${e.description}”?`)) remove.mutate(e.version); }}>
                  Delete expense
                </Button>
              </>
            )}
          </div>
          <p className="text-sm text-muted">Version {e.version}. Every change is kept in the group’s activity.</p>
        </article>
      )}
    </Shell>
  );
}
