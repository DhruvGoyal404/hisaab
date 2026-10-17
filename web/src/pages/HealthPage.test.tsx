import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthPage } from './HealthPage';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <HealthPage />
    </QueryClientProvider>,
  );
}

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HealthPage', () => {
  it('shows API up and database connected', async () => {
    mockFetch(200, { status: 'ok', db: 'ok' });
    renderPage();
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.getByText('Up')).toBeTruthy();
  });

  it('shows the database as unreachable when the API reports 503', async () => {
    mockFetch(503, { status: 'degraded', db: 'unreachable' });
    renderPage();
    expect(await screen.findByText('Up')).toBeTruthy();
    expect(screen.getByText('Unreachable')).toBeTruthy();
  });

  it('shows the API as unreachable when the proxy fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('Bad gateway', { status: 502 }))));
    renderPage();
    expect(await screen.findByText('Unreachable')).toBeTruthy();
    expect(screen.queryByText('Up')).toBeNull();
  });
});
