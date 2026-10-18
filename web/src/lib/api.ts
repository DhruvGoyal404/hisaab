import type { SplitMethod } from '@hisaab/money';

/** An error response from the API: { error: { code, message, details? } }. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown> | unknown[];

async function request<T>(method: string, path: string, init: { body?: Json; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { ...(init.body !== undefined && { 'Content-Type': 'application/json' }), ...init.headers },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'http_error', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return body as T;
}

const get = <T,>(path: string) => request<T>('GET', path);

// ---- Shapes returned by the API (integers are paise) ----
export type Me = { user: { id: string; name: string } };
export type Providers = { google: boolean; github: boolean; dev: boolean };
export type Identity = { provider: 'google' | 'github'; email: string | null; linkedAt: string };
export type GroupSummary = { groupId: string; name: string; currency: string; balanceMinor: number };
export type MyGroups = {
  groups: GroupSummary[];
  totals: { currency: string; owedToMeMinor: number; iOweMinor: number; netMinor: number }[];
};
export type Role = 'owner' | 'admin' | 'member';
export type Member = { memberId: string; name: string; isGhost: boolean; role: Role; isMe: boolean };
export type GroupDetail = {
  groupId: string;
  name: string;
  currency: string;
  simplifyDebts: boolean;
  lastSeq: number;
  me: { memberId: string; role: Role };
  members: Member[];
};
export type MemberBalance = { memberId: string; name: string; isGhost: boolean; balanceMinor: number };
export type Transfer = { from: string; to: string; amountMinor: number };
export type SettlePlan = {
  groupId: string;
  seq: number;
  mode: 'auto' | 'greedy' | 'exact' | 'raw';
  algorithm: 'greedy' | 'exact' | 'raw';
  k: number;
  transferCount: number;
  transfers: Transfer[];
};
export type Activity = {
  seq: number;
  id: string;
  type: string;
  subjectId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  actorName: string | null;
};
export type ActivityPage = { items: Activity[]; nextBefore: number | null };
export type ActivityAfter = { items: Activity[]; lastSeq: number; hasMore: boolean };
export type ExpenseLine = { memberId: string; paidMinor: number; owedMinor: number; weight: number | null };
export type Expense = {
  expenseId: string;
  version: number;
  deleted: boolean;
  description: string;
  occurredOn: string;
  totalMinor: number;
  splitMethod: SplitMethod;
  lines: ExpenseLine[];
};
export type ExpenseInput = {
  description: string;
  occurredOn: string;
  totalMinor: number;
  payers: { memberId: string; paidMinor: number }[];
  split: { method: SplitMethod; weights: { memberId: string; weight: number }[] };
};
export type InvitePreview = {
  groupId: string;
  groupName: string;
  invitedBy: string;
  ghostName: string | null;
  usable: boolean;
  alreadyMember: boolean;
};

export const api = {
  me: () => get<Me>('/me'),
  providers: () => get<Providers>('/auth/providers'),
  identities: () => get<{ identities: Identity[] }>('/auth/identities'),
  devLogin: (name: string) => request<Me>('POST', '/dev/login', { body: { name } }),
  logout: () => request<undefined>('POST', '/auth/logout'),
  logoutAll: () => request<{ revoked: number }>('POST', '/auth/logout-all'),
  deleteAccount: () => request<{ deleted: true; groups: number }>('DELETE', '/me', { body: { confirm: true } }),
  myGroups: () => get<MyGroups>('/groups'),
  createGroup: (name: string) => request<{ groupId: string; memberId: string }>('POST', '/groups', { body: { name } }),
  group: (groupId: string) => get<GroupDetail>(`/groups/${groupId}`),
  setSimplify: (groupId: string, simplifyDebts: boolean) =>
    request<undefined>('PATCH', `/groups/${groupId}`, { body: { simplifyDebts } }),
  balances: (groupId: string) => get<{ members: MemberBalance[] }>(`/groups/${groupId}/balances`),
  settlePlan: (groupId: string, mode: 'auto' | 'raw') => get<SettlePlan>(`/groups/${groupId}/settle-plan?mode=${mode}`),
  activity: (groupId: string, before?: number) =>
    get<ActivityPage>(`/groups/${groupId}/activity?limit=30${before === undefined ? '' : `&before=${before}`}`),
  activityAfter: (groupId: string, afterSeq: number) =>
    get<ActivityAfter>(`/groups/${groupId}/activity?afterSeq=${afterSeq}`),
  expense: (groupId: string, expenseId: string) => get<Expense>(`/groups/${groupId}/expenses/${expenseId}`),
  createExpense: (groupId: string, expenseId: string, expense: ExpenseInput, idempotencyKey: string) =>
    request<{ expenseId: string; version: number }>('POST', `/groups/${groupId}/expenses`, {
      body: { ...expense, expenseId },
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
  editExpense: (groupId: string, expenseId: string, version: number, expense: ExpenseInput) =>
    request<{ version: number }>('PUT', `/groups/${groupId}/expenses/${expenseId}`, {
      body: expense,
      headers: { 'If-Match': `"${version}"` },
    }),
  deleteExpense: (groupId: string, expenseId: string, version: number) =>
    request<{ version: number }>('DELETE', `/groups/${groupId}/expenses/${expenseId}`, { headers: { 'If-Match': `"${version}"` } }),
  restoreExpense: (groupId: string, expenseId: string, version: number) =>
    request<{ version: number }>('POST', `/groups/${groupId}/expenses/${expenseId}/restore`, {
      headers: { 'If-Match': `"${version}"` },
    }),
  createSettlement: (groupId: string, s: Transfer, idempotencyKey: string) =>
    request<{ settlementId: string }>('POST', `/groups/${groupId}/settlements`, {
      body: { fromMemberId: s.from, toMemberId: s.to, amountMinor: s.amountMinor },
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
  addGhost: (groupId: string, displayName: string) =>
    request<{ memberId: string }>('POST', `/groups/${groupId}/ghosts`, { body: { displayName } }),
  createInvite: (groupId: string, ghostMemberId?: string) =>
    request<{ inviteId: string; token: string; expiresAt: string }>('POST', `/groups/${groupId}/invites`, {
      body: ghostMemberId === undefined ? {} : { ghostMemberId },
    }),
  previewInvite: (token: string) => get<InvitePreview>(`/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string) =>
    request<{ groupId: string; memberId: string; outcome: string }>('POST', `/invites/${encodeURIComponent(token)}/accept`),
  leave: (groupId: string) => request<undefined>('POST', `/groups/${groupId}/leave`),
};

/** Query keys. Everything about one group lives under ['group', id] so one invalidation refreshes it. */
export const keys = {
  me: ['me'] as const,
  myGroups: ['groups'] as const,
  group: (id: string) => ['group', id] as const,
  detail: (id: string) => ['group', id, 'detail'] as const,
  balances: (id: string) => ['group', id, 'balances'] as const,
  plan: (id: string, mode: 'auto' | 'raw') => ['group', id, 'plan', mode] as const,
  activity: (id: string) => ['group', id, 'activity'] as const,
  expense: (id: string, expenseId: string) => ['group', id, 'expense', expenseId] as const,
};
