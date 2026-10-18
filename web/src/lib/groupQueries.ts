import { useQuery } from '@tanstack/react-query';
import { api, keys } from './api';

export function useGroup(groupId: string) {
  return useQuery({ queryKey: keys.detail(groupId), queryFn: () => api.group(groupId) });
}

export function useBalances(groupId: string) {
  return useQuery({ queryKey: keys.balances(groupId), queryFn: () => api.balances(groupId) });
}
