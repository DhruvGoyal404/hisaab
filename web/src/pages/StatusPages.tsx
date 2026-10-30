import { Component, type ReactNode } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { btn, Button, Stamp } from '../components/ui';

// What a visitor sees when no page can: an unknown address, or a screen that crashed. Plain <a>
// links and no lazy loading, so these still work outside the router and when a chunk failed.
function StatusScreen({ title, word, label, children }: { title: string; word: string; label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="stitch bg-band px-4 pb-8 pt-10 text-band-ink">
        <div className="mx-auto max-w-md">
          <a href="/" className="font-display text-2xl">Hisaab</a>
          <h1 className="mt-3 font-display text-4xl leading-none">{title}</h1>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-md flex-1 space-y-5 px-4 py-8">
        <Stamp word={word} label={label} />
        {children}
      </main>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <StatusScreen title="Page not found" word="नहीं मिला" label="not found">
      {/* The server answers 200 for every app path, so this keeps a dead link out of search results. */}
      <meta name="robots" content="noindex" />
      <p className="text-lg">This page isn’t in the ledger. The link may be old or mistyped.</p>
      <a href="/" className={btn.primary}>Back to Hisaab</a>
    </StatusScreen>
  );
}

/** Never shows the error itself: it can name internals, and it means nothing to the reader. */
export function ErrorPage() {
  return (
    <StatusScreen title="Something went wrong" word="गड़बड़" label="went wrong">
      <p className="text-lg">This page couldn’t be shown. Your saved expenses and balances aren’t affected.</p>
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => { window.location.reload(); }}>Reload the page</Button>
        <a href="/" className={btn.secondary}>Back to Hisaab</a>
      </div>
    </StatusScreen>
  );
}

/** The router's errorElement: anything a route throws while loading or rendering. */
export function RouteError() {
  const error = useRouteError();
  return isRouteErrorResponse(error) && error.status === 404 ? <NotFoundPage /> : <ErrorPage />;
}

/** Around the whole app, for what happens outside the router (its errorElement can't catch those). */
export class RootBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <ErrorPage /> : this.props.children;
  }
}
