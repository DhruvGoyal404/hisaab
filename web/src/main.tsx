import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router';
import './index.css';
import { ApiError } from './lib/api';
import { RequireAuth } from './lib/auth';
import { GroupPage } from './pages/group/GroupPage';
import { HomePage } from './pages/HomePage';
import { SignInPage } from './pages/SignInPage';
import { RealtimeProvider } from './realtime/RealtimeProvider';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 4xx won't fix itself; only retry network trouble and 5xx.
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

// Less-visited screens load on demand to keep the first load small.
const expensePages = () => import('./pages/expense/ExpensePages');

const router = createBrowserRouter([
  { path: '/signin', element: <SignInPage /> },
  {
    element: <RequireAuth><Outlet /></RequireAuth>,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/groups/:groupId', element: <GroupPage /> },
      { path: '/groups/:groupId/expenses/new', lazy: async () => ({ Component: (await expensePages()).NewExpensePage }) },
      { path: '/groups/:groupId/expenses/:expenseId', lazy: async () => ({ Component: (await expensePages()).ExpensePage }) },
      { path: '/groups/:groupId/expenses/:expenseId/edit', lazy: async () => ({ Component: (await expensePages()).EditExpensePage }) },
      { path: '/groups/:groupId/settle', lazy: async () => ({ Component: (await import('./pages/SettleUpPage')).SettleUpPage }) },
      { path: '/join/:token', lazy: async () => ({ Component: (await import('./pages/JoinPage')).JoinPage }) },
    ],
  },
  { path: '/status', lazy: async () => ({ Component: (await import('./pages/HealthPage')).HealthPage }) },
]);

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RealtimeProvider>
        <RouterProvider router={router} />
      </RealtimeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
