import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/** Keeps list filters, page and sort in the URL so views are shareable and survive refresh. */
export function useListState(defaults: Record<string, string> = {}) {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => {
    const obj: Record<string, string> = { ...defaults };
    params.forEach((v, k) => (obj[k] = v));
    return obj;
  }, [params, defaults]);
  const set = useCallback(
    (patch: Record<string, string | number | undefined | null>, resetPage = true) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === null || v === '') next.delete(k);
        else next.set(k, String(v));
      }
      if (resetPage && !('page' in patch)) next.delete('page');
      setParams(next, { replace: true });
    },
    [params, setParams],
  );
  const page = Number(state.page ?? 1) || 1;
  const pageSize = Number(state.pageSize ?? 50) || 50;
  return { state, set, page, pageSize, setPage: (p: number) => set({ page: p }, false) };
}
