import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { AuthStatus, Member, api } from './api';

export function useAuthStatus() {
  return useQuery({ queryKey: ['auth'], queryFn: () => api<AuthStatus>('/auth/status'), staleTime: 60_000 });
}

export function useMe(): Member {
  const { data } = useAuthStatus();
  return data!.user!;
}

export function useMembers() {
  const q = useQuery({ queryKey: ['members'], queryFn: () => api<Member[]>('/members'), staleTime: 60_000 });
  const members = q.data ?? [];
  const byId = new Map(members.map((m) => [m.id, m]));
  return { ...q, members, byId };
}

/** Mutation helper that invalidates the given query keys on success and reports errors through the toast. */
export function useAction<TVars = void, TRes = unknown>(fn: (v: TVars) => Promise<TRes>, invalidate: string[][] = [], onSuccess?: (r: TRes) => void) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      invalidate.forEach((k) => qc.invalidateQueries({ queryKey: k }));
      onSuccess?.(r);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
}

// ---------- Toasts ----------
export type ToastFn = (msg: string, kind?: 'info' | 'error' | 'success') => void;
export const ToastContext = createContext<ToastFn>(() => {});
export const useToast = () => useContext(ToastContext);
