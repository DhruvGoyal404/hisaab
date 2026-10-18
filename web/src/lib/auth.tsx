import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Loading } from '../components/ui';
import { api, ApiError, keys, type Me } from './api';

export function useMe() {
  return useQuery<Me | null>({
    queryKey: keys.me,
    queryFn: async () => {
      try {
        return await api.me();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });
}

/** Renders children for a signed-in user; otherwise sends them to sign in and back here afterwards. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <div className="p-6"><Loading what="your account" /></div>;
  if (me.data === null || me.isError) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/signin?next=${encodeURIComponent(next)}`} replace />;
  }
  return children;
}
