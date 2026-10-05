import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { Principal } from '@itsm/shared';
import { patch } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import type { BoardKind, BoardScope, LanesBy, PanelMode } from './api';

/**
 * Board layout per person: kept in `users.preferences.boards` through PATCH /auth/me
 * (a shallow merge of `preferences`, so the briefing and notification keys stay intact),
 * saved 800 ms after the last change and restored on the next visit.
 */
export interface BoardPrefs {
  board: BoardKind;
  scope: BoardScope;
  teamId?: string;
  assigneeId?: string;
  lanes: LanesBy;
  includeClosed: boolean;
  includeDone: boolean;
  showEmptyLanes: boolean;
  panel: PanelMode;
  handoverTeamId?: string;
  filters: { type?: string; customerId?: string; priorityId?: string; due?: string };
  /** `${board}:${lanes}` → lane keys in display order (unknown keys are appended at the end). */
  laneOrder: Record<string, string[]>;
  hiddenLanes: Record<string, string[]>;
  collapsedLanes: Record<string, string[]>;
  /** Lane key → limit, 0 = none. */
  wipLimits: Record<string, number>;
}

export const DEFAULT_PREFS: BoardPrefs = {
  board: 'tickets',
  scope: 'mine',
  lanes: 'status',
  includeClosed: false,
  includeDone: false,
  showEmptyLanes: false,
  panel: 'both',
  filters: {},
  laneOrder: {},
  hiddenLanes: {},
  collapsedLanes: {},
  wipLimits: {},
};

const BOARDS: BoardKind[] = ['tickets', 'tasks'];
const SCOPES: BoardScope[] = ['mine', 'team', 'assignee', 'all'];
const LANES: LanesBy[] = ['status', 'assignee'];
const PANELS: PanelMode[] = ['handover', 'notes', 'both', 'hidden'];
const pick = <T extends string>(v: unknown, allowed: T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const strMap = (v: unknown): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  if (v && typeof v === 'object') for (const [k, arr] of Object.entries(v as Record<string, unknown>)) if (Array.isArray(arr)) out[k] = arr.filter((x): x is string => typeof x === 'string');
  return out;
};
const numMap = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (v && typeof v === 'object') for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (typeof n === 'number' && Number.isFinite(n)) out[k] = Math.max(0, Math.round(n));
  return out;
};

/** Merges whatever is stored over the defaults, dropping anything that is not a known value. */
export function readPrefs(raw: unknown): BoardPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const f = (r.filters && typeof r.filters === 'object' ? r.filters : {}) as Record<string, unknown>;
  return {
    board: pick(r.board, BOARDS, DEFAULT_PREFS.board),
    scope: pick(r.scope, SCOPES, DEFAULT_PREFS.scope),
    teamId: str(r.teamId),
    assigneeId: str(r.assigneeId),
    lanes: pick(r.lanes, LANES, DEFAULT_PREFS.lanes),
    includeClosed: r.includeClosed === true,
    includeDone: r.includeDone === true,
    showEmptyLanes: r.showEmptyLanes === true,
    panel: pick(r.panel, PANELS, DEFAULT_PREFS.panel),
    handoverTeamId: str(r.handoverTeamId),
    filters: { type: str(f.type), customerId: str(f.customerId), priorityId: str(f.priorityId), due: str(f.due) },
    laneOrder: strMap(r.laneOrder),
    hiddenLanes: strMap(r.hiddenLanes),
    collapsedLanes: strMap(r.collapsedLanes),
    wipLimits: numMap(r.wipLimits),
  };
}

export function useBoardPrefs(): { prefs: BoardPrefs; update: (patch: Partial<BoardPrefs>) => void } {
  const stored = useAuthStore((s) => s.user?.preferences.boards);
  const saved = useMemo(() => readPrefs(stored), [stored]);
  const [prefs, setPrefs] = useState<BoardPrefs>(saved);
  const lastSaved = useRef(JSON.stringify(saved));
  const pending = useRef<BoardPrefs | null>(null);
  const timer = useRef<number | null>(null);

  const send = useCallback((next: BoardPrefs, keepalive: boolean) => {
    const json = JSON.stringify(next);
    if (json === lastSaved.current) return;
    const { user, accessToken } = useAuthStore.getState();
    if (!user) return;
    const body = { preferences: { ...user.preferences, boards: next } };
    if (keepalive) {
      // The page is going away (reload, navigation, closing the tab): a keepalive request outlives it.
      lastSaved.current = json;
      void fetch('/api/auth/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) }, body: JSON.stringify(body), credentials: 'include', keepalive: true });
      return;
    }
    // Only a save that reached the server counts as saved: a failed one is sent again with the next flush.
    patch<{ user: Principal }>('/auth/me', body)
      .then((res) => {
        lastSaved.current = json;
        useAuthStore.getState().setUser(res.user);
      })
      .catch(() => {
        if (!pending.current) pending.current = next;
        toast.error('Could not save the board layout');
      });
  }, []);

  const flush = useCallback(
    (keepalive = false) => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = null;
      const next = pending.current;
      pending.current = null;
      if (next) send(next, keepalive);
    },
    [send],
  );

  const update = useCallback(
    (patchPrefs: Partial<BoardPrefs>) => {
      setPrefs((prev) => {
        const next = { ...prev, ...patchPrefs };
        pending.current = next;
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => flush(false), 800);
        return next;
      });
    },
    [flush],
  );

  // A layout change made just before leaving the page is not lost: on a hard navigation the document goes away
  // without unmounting (pagehide, keepalive), on a route change the cleanup runs.
  useEffect(() => {
    const onHide = () => flush(true);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      flush(false);
    };
  }, [flush]);

  return { prefs, update };
}
