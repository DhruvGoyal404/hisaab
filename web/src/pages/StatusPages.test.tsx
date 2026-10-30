import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundPage, RootBoundary, RouteError } from './StatusPages';

const SECRET = 'select * from users at /srv/api/repo.ts:42';
function Boom(): never {
  throw new Error(SECRET);
}

function visit(path: string) {
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router's own way to answer 404
  const lost = () => { throw new Response('', { status: 404 }); };
  const router = createMemoryRouter(
    [{
      errorElement: <RouteError />,
      children: [
        { path: '/boom', element: <Boom /> },
        { path: '/lost', loader: lost, element: null },
        { path: '*', element: <NotFoundPage /> },
      ],
    }],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
}

const expectFriendly = (title: string) => {
  expect(screen.getByRole('heading', { level: 1, name: title })).toBeTruthy();
  expect(document.body.textContent).not.toContain(SECRET);
  expect(document.body.textContent).not.toMatch(/Unexpected Application Error|Hey developer|ErrorBoundary|errorElement/);
};

describe('status pages', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('shows the 404 page for an unknown route', async () => {
    visit('/no/such/page');
    await screen.findByRole('heading', { name: 'Page not found' });
    expectFriendly('Page not found');
  });

  it('shows the 404 page when a route answers 404', async () => {
    visit('/lost');
    await screen.findByRole('heading', { name: 'Page not found' });
    expectFriendly('Page not found');
  });

  it('shows the friendly page, without the error, when a route throws while rendering', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined); // React reports the caught error
    visit('/boom');
    await screen.findByRole('button', { name: 'Reload the page' });
    expectFriendly('Something went wrong');
  });

  it('catches what is thrown outside the router', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<RootBoundary><Boom /></RootBoundary>);
    expectFriendly('Something went wrong');
  });
});
