import { formatPaise } from '@hisaab/money';
import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../lib/api';
import { ConnectionStatus } from '../realtime/ConnectionStatus';

export const btn = {
  primary:
    'inline-flex min-h-11 items-center justify-center gap-2 rounded px-4 font-semibold bg-accent text-accent-ink hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed',
  secondary:
    'inline-flex min-h-11 items-center justify-center gap-2 rounded border border-field-line px-4 font-medium text-ink hover:bg-sheet disabled:opacity-50 disabled:cursor-not-allowed',
  // Inherits its colour, so it works on the page and on the header band.
  quiet: 'inline-flex min-h-11 items-center gap-1 rounded px-2 font-medium underline-offset-4 hover:underline',
};

export function Button({ variant = 'primary', className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof btn }) {
  return <button type="button" className={`${btn[variant]} ${className}`} {...rest} />;
}

/** A labelled text input with its error and hint wired to aria-describedby. */
export function Field({
  label, error, hint, prefix, compact = false, className = '', ...input
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string; error?: string | undefined; hint?: ReactNode; prefix?: string;
  /** Visually hidden label for dense rows where the row already names the person. */
  compact?: boolean;
}) {
  const id = useId();
  const described = [error && `${id}-err`, hint && `${id}-hint`].filter(Boolean).join(' ') || undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className={compact ? 'sr-only' : 'mb-1 block font-medium'}>{label}</label>
      <div className={`flex items-center rounded border bg-field focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus)] ${error ? 'border-owe' : 'border-field-line'}`}>
        {prefix && <span className="pl-3 text-muted" aria-hidden="true">{prefix}</span>}
        <input
          id={id}
          className="min-h-11 w-full min-w-0 bg-transparent px-3 py-2 text-ink outline-none placeholder:text-muted"
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          {...input}
        />
      </div>
      {hint && !error && <p id={`${id}-hint`} className="mt-1 text-sm text-muted">{hint}</p>}
      {error && <p id={`${id}-err`} className="mt-1 text-sm font-medium text-owe">{error}</p>}
    </div>
  );
}

export function Money({ paise, className = '' }: { paise: number; className?: string }) {
  return <span className={`amount ${className}`}>{formatPaise(Math.abs(paise))}</span>;
}

/** "You owe ₹300.00", "gets back ₹50.00", "settled": the words, for places that can't use colour. */
export function balanceText(paise: number, self = false): string {
  if (paise === 0) return self ? 'You are all square' : 'settled';
  const words = self ? (paise > 0 ? 'You are owed' : 'You owe') : paise > 0 ? 'gets back' : 'owes';
  return `${words} ${formatPaise(Math.abs(paise))}`;
}

/** A balance in words and colour (colour never carries meaning alone). */
export function BalanceWords({ paise, self = false }: { paise: number; self?: boolean }) {
  if (paise === 0) return <span className="text-muted">{self ? 'You are all square' : 'settled'}</span>;
  const owed = paise > 0;
  const words = self ? (owed ? 'You are owed' : 'You owe') : owed ? 'gets back' : 'owes';
  return (
    <span className={owed ? 'text-owed' : 'text-owe'}>
      {words} <Money paise={paise} className="font-semibold" />
    </span>
  );
}

/** The ledger's ink stamp. By default hisaab barabar: the account is closed. */
export function Stamp({ word = 'बराबर', label = 'all square', animate = false }: { word?: string; label?: string; animate?: boolean }) {
  return (
    <span className={`stamp ${animate ? 'stamp-in' : ''}`} role="img" aria-label={`${word}, ${label}`}>
      <span className="font-display text-2xl" lang="hi" aria-hidden="true">{word}</span>
      <span className="text-sm font-semibold" aria-hidden="true">{label}</span>
    </span>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof ApiError ? error.message : 'Something went wrong. Check your connection and try again.';
  return <p role="alert" className="rounded bg-danger-bg px-3 py-2 font-medium text-owe">{message}</p>;
}

export function Loading({ what }: { what: string }) {
  return <p className="py-6 text-muted" role="status">Loading {what}…</p>;
}

/** A ruled ledger section with a heading. `tabbed`: on phones the tab bar already names it. */
export function LedgerSection({ title, action, tabbed = false, children }: { title: string; action?: ReactNode; tabbed?: boolean; children: ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className={`font-display text-2xl leading-tight ${tabbed ? 'max-lg:sr-only' : ''}`}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function AppShell({
  title, back, actions, bottomBar, children, status,
}: {
  title: ReactNode;
  back?: { to: string; label: string };
  actions?: ReactNode;
  bottomBar?: ReactNode;
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-page focus:px-3 focus:py-2">
        Skip to content
      </a>
      <header className="stitch bg-band text-band-ink">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 pb-6 pt-3">
          {back ? (
            <Link to={back.to} className="-ml-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded text-2xl" aria-label={back.label}>
              <span aria-hidden="true">‹</span>
            </Link>
          ) : null}
          <div className="min-w-0 flex-1">{title}</div>
          {status ?? <ConnectionStatus />}
          {actions}
        </div>
      </header>
      <main id="main" className={`mx-auto w-full max-w-5xl flex-1 px-4 pt-6 ${bottomBar ? 'pb-28 lg:pb-10' : 'pb-10'}`}>
        {children}
      </main>
      {bottomBar && (
        <div className="fixed inset-x-0 bottom-0 border-t border-rule bg-page/95 px-4 py-3 backdrop-blur lg:hidden">
          <div className="mx-auto flex max-w-5xl gap-3">{bottomBar}</div>
        </div>
      )}
    </div>
  );
}

/** Sentence-start capital: "you paid" -> "You paid". */
export const LegalLinks = () => (
  <p className="text-sm text-muted">
    <Link to="/privacy" className="underline underline-offset-2">Privacy</Link> and{' '}
    <Link to="/terms" className="underline underline-offset-2">terms</Link>
  </p>
);

export const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export const dateLabel = (iso: string): string =>
  new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(new Date(iso));

export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
