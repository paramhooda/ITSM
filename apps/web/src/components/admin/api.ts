import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { get, post, patch, del, ApiError } from '@/api/client';
import { moveBeside } from '@/lib/configFilter';

/** Friendly message for any thrown error (API errors carry the server message). */
export function errorMessage(err: unknown, fallback = 'Something went wrong') {
  if (err instanceof ApiError) {
    if (err.status === 400 && Array.isArray(err.details) && err.details.length) {
      const first = err.details[0] as { path?: (string | number)[]; message?: string };
      return `${first.path?.length ? first.path.join('.') + ': ' : ''}${first.message ?? err.message}`;
    }
    return err.message || fallback;
  }
  return (err as { message?: string })?.message ?? fallback;
}

export const isNotFound = (err: unknown) => err instanceof ApiError && err.status === 404;

/** Generic config list (`GET /config/:kind`). */
export function useConfigKind<T = Record<string, unknown>>(kind: string, enabled = true) {
  return useQuery({ queryKey: ['config', kind], queryFn: () => get<T[]>(`/config/${kind}`), enabled });
}

export interface MutationOpts {
  /** Query keys to invalidate after a successful write. */
  invalidate?: QueryKey[];
  /** Also refresh the shared lookups cache (option lists, teams, CI types...). */
  lookups?: boolean;
  success?: string;
}

/** Mutation wrapper with toast + invalidation. */
export function useAdminMutation<TVars, TResult = unknown>(fn: (vars: TVars) => Promise<TResult>, opts: MutationOpts & { onSuccess?: (result: TResult, vars: TVars) => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result, vars) => {
      for (const key of opts.invalidate ?? []) void qc.invalidateQueries({ queryKey: key });
      if (opts.lookups) void qc.invalidateQueries({ queryKey: ['lookups'] });
      if (opts.success) toast.success(opts.success);
      opts.onSuccess?.(result, vars);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}

/** CRUD mutations for a generic config kind. */
export function useConfigMutations(kind: string, opts: { lookups?: boolean; label?: string } = {}) {
  const invalidate: QueryKey[] = [['config', kind]];
  const label = opts.label ?? 'Entry';
  const create = useAdminMutation((body: Record<string, unknown>) => post<Record<string, unknown>>(`/config/${kind}`, body), { invalidate, lookups: opts.lookups, success: `${label} created` });
  const update = useAdminMutation(({ id, ...body }: Record<string, unknown> & { id: string }) => patch<Record<string, unknown>>(`/config/${kind}/${id}`, body), { invalidate, lookups: opts.lookups, success: `${label} updated` });
  const remove = useAdminMutation((id: string) => del(`/config/${kind}/${id}`), { invalidate, lookups: opts.lookups, success: `${label} deleted` });
  return { create, update, remove };
}

/**
 * The sortOrder of every row after `id` moves past `neighbourId` (the row shown next to it;
 * `dir` -1 puts it before, 1 after), used by the up and down actions on ordered
 * configuration lists. Rows hidden from the view keep their place (`moveBeside`); the
 * result is empty when the order does not change.
 */
export function moveNextTo<T extends { id: string; sortOrder?: number }>(rows: T[], id: string, neighbourId: string, dir: -1 | 1): { id: string; sortOrder: number }[] {
  const sorted = [...rows].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((r) => r.id);
  const order = moveBeside(sorted, id, neighbourId, dir);
  if (order.every((x, i) => x === sorted[i])) return [];
  return order.map((rowId, idx) => ({ id: rowId, sortOrder: (idx + 1) * 10 }));
}

export const slugify = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);

export const camelKey = (s: string) => {
  const parts = s.trim().replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const out = parts.map((p, i) => (i === 0 ? p.toLowerCase() : p[0].toUpperCase() + p.slice(1).toLowerCase())).join('');
  return /^[a-zA-Z]/.test(out) ? out.slice(0, 64) : `f${out}`.slice(0, 64);
};
