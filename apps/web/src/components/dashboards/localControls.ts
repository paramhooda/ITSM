import { useCallback } from 'react';
import { useListState } from '@/hooks/useListState';

/**
 * A panel's local control (the Segmented or Select in its header) keeps its
 * state in the URL under its own key (`flow=`, `age=`, `heat=`, `by=`, …), so a
 * view can be bookmarked and shared and the back button restores it. The
 * default value is left out of the URL, a value outside `allowed` falls back
 * to the default, and writing never touches `page`, the hero's interactive
 * filters or any other panel's key: a local control changes its panel alone.
 */
export function useLocalControl<T extends string>(key: string, fallback: T, allowed?: readonly T[]): [T, (v: T) => void] {
  const { state, set } = useListState();
  const raw = state[key];
  const value = (raw && (!allowed || (allowed as readonly string[]).includes(raw)) ? raw : fallback) as T;
  const setValue = useCallback((v: T) => set({ [key]: v === fallback ? undefined : v }, false), [set, key, fallback]);
  return [value, setValue];
}
