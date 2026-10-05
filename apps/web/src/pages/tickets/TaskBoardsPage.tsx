import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Kanban, Columns3, ExternalLink, UserPlus, MoveRight, CheckCircle2, ListPlus, Eye, RotateCcw, Trash2, CheckCheck, List } from 'lucide-react';
import { TICKET_TYPES } from '@itsm/shared';
import { PageHeader, ListShell, FilterGroup, FilterOptions, FilterSelect, FilterToggle, Button, Select, EmptyState, LoadingBlock, ErrorBlock, Dialog, Field, Input, Checkbox, ConfirmDialog, type AppliedFilter } from '@/components/ui';
import { Segmented } from '@/components/dashboards/Panel';
import type { MenuItem } from '@/components/Menu';
import { useListState } from '@/hooks/useListState';
import { useLookups, useEngineers, useCustomersLookup } from '@/hooks/useLookups';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useAuthStore } from '@/stores/auth';
import { fmtNumber } from '@/lib/format';
import { cn, dotClass } from '@/lib/utils';
import { PRIORITY_LEVEL_COLORS } from '@/lib/statusColors';
import { ticketsApi } from '@/components/tickets/api';
import { TYPE_LABELS, type TicketType } from '@/components/tickets/types';
import { boardKeys, boardsApi, TERMINAL_CATEGORIES, type BoardKind, type BoardLane, type BoardScope, type LanesBy, type PanelMode, type ReorderItem, type TaskBoard, type TaskCard, type TaskStatus, type TicketBoard, type TicketCard } from '@/components/boards/api';
import { useBoardPrefs } from '@/components/boards/useBoardPrefs';
import { useDragDrop, ticketRefusals, taskRefusals, type Refusals } from '@/components/boards/useDragDrop';
import { Lane } from '@/components/boards/BoardLane';
import { TicketCardView } from '@/components/boards/TicketCard';
import { TaskCardView } from '@/components/boards/TaskCard';
import { LanesDialog } from '@/components/boards/LanesPopover';
import { MoveDialog, TerminalDropDialog, terminalKindOf, type PendingTerminal } from '@/components/boards/MoveDialog';
import { HandoverPanel } from '@/components/boards/HandoverPanel';
import { StickyNotes } from '@/components/boards/StickyNotes';

const SCOPES: BoardScope[] = ['mine', 'team', 'assignee', 'all'];
const PANELS: PanelMode[] = ['handover', 'notes', 'both', 'hidden'];
const URL_KEYS = ['board', 'scope', 'teamId', 'assigneeId', 'lanes', 'type', 'customerId', 'priorityId', 'due', 'q', 'panel'];
const DUE_OPTIONS = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
];
const OPEN_CATEGORIES = new Set(['new', 'open', 'pending']);
const isTask = (c: TicketCard | TaskCard): c is TaskCard => 'ticketId' in c;
const toggleIn = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
const omit = <T,>(map: Record<string, T>, key: string) => Object.fromEntries(Object.entries(map).filter(([k]) => k !== key));
/** Scrolls the lane strip sideways while a card is dragged near its left or right edge, so far lanes can be reached. */
const autoScrollStrip = (e: { currentTarget: HTMLElement; clientX: number }) => {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const edge = 56;
  if (e.clientX < r.left + edge) el.scrollLeft -= 18;
  else if (e.clientX > r.right - edge) el.scrollLeft += 18;
};

// ---------------------------------------------------------------- optimistic moves

/** The card in its new lane (status or owner) with the lane figures adjusted, before the server answers. */
function moveTicketCard(prev: TicketBoard, cardId: string, lane: BoardLane): TicketBoard {
  const card = prev.cards.find((c) => c.id === cardId);
  if (!card || card.lane === lane.key) return prev;
  const wasOpen = OPEN_CATEGORIES.has(card.status.category ?? '');
  const nowOpen = lane.kind === 'status' ? OPEN_CATEGORIES.has(lane.category ?? '') : wasOpen;
  const breached = card.sla?.breached ? 1 : 0;
  const moved: TicketCard =
    lane.kind === 'status'
      ? { ...card, lane: lane.key, status: { id: lane.key, key: lane.statusKey, label: lane.label, color: lane.color, category: lane.category } }
      : { ...card, lane: lane.key, assigneeId: lane.key === 'unassigned' ? null : lane.key, assigneeName: lane.key === 'unassigned' ? null : lane.label };
  const lanes = prev.lanes
    .map((l) => (l.key === card.lane ? { ...l, count: l.count - 1, open: l.open - (wasOpen ? 1 : 0), breached: l.breached - breached } : l.key === lane.key ? { ...l, count: l.count + 1, open: l.open + (nowOpen ? 1 : 0), breached: l.breached + breached } : l))
    .map((l) => ({ ...l, over: l.kind === 'assignee' && l.limit !== null && l.open > l.limit }));
  return { ...prev, lanes, cards: prev.cards.map((c) => (c.id === cardId ? moved : c)) };
}

/** The destination lane's cards with `card` placed at `index` (an index among the cards shown, the card itself included). */
function placeInLane(cards: TaskCard[], card: TaskCard, laneKey: string, index: number): TaskCard[] {
  const laneCards = cards.filter((c) => c.lane === laneKey).sort((a, b) => a.sortOrder - b.sortOrder);
  const current = laneCards.findIndex((c) => c.id === card.id);
  const rest = laneCards.filter((c) => c.id !== card.id);
  const at = Math.min(current >= 0 && current < index ? index - 1 : index, rest.length);
  rest.splice(Math.max(0, at), 0, card);
  return rest;
}

function moveTaskCard(prev: TaskBoard, cardId: string, lane: BoardLane, index: number): TaskBoard {
  const card = prev.cards.find((c) => c.id === cardId);
  if (!card) return prev;
  const toStatus = lane.kind === 'status';
  const moved: TaskCard = toStatus
    ? { ...card, lane: lane.key, status: lane.key as TaskStatus, completedAt: lane.key === 'done' ? (card.completedAt ?? new Date().toISOString()) : null, overdue: lane.key === 'done' || lane.key === 'cancelled' ? false : card.overdue }
    : { ...card, lane: lane.key, assigneeId: lane.key === 'unassigned' ? null : lane.key, assigneeName: lane.key === 'unassigned' ? null : lane.label };
  const dest = placeInLane(prev.cards, moved, lane.key, index).map((c, i) => ({ ...c, sortOrder: i }));
  const others = prev.cards.filter((c) => c.lane !== lane.key && c.id !== cardId);
  const wasOpen = card.status === 'open' || card.status === 'in_progress';
  const nowOpen = toStatus ? lane.key === 'open' || lane.key === 'in_progress' : wasOpen;
  const lanes =
    card.lane === lane.key
      ? prev.lanes
      : prev.lanes.map((l) => (l.key === card.lane ? { ...l, count: l.count - 1, open: l.open - (wasOpen ? 1 : 0) } : l.key === lane.key ? { ...l, count: l.count + 1, open: l.open + (nowOpen ? 1 : 0) } : l)).map((l) => ({ ...l, over: l.kind === 'assignee' && l.limit !== null && l.open > l.limit }));
  return { ...prev, lanes, cards: [...others, ...dest] };
}

const MAX_SORT = 100000;
/** The gap left between sort orders when a lane is renumbered, so the next drops fit between their neighbours with one item. */
const SORT_SPACING = 100;
/** The most items one reorder request carries (the route's cap); a longer list goes in several requests, the moved card first. */
const REORDER_CHUNK = 200;

/**
 * The reorder items a task drop needs. The moved card (with its new status) takes a sort
 * order between its new neighbours, so a drop is usually one item; only when the neighbours
 * leave no room (tasks start at 0) are the cards after it spaced out, and only the ones the
 * person may update are sent. The server is the authority on the cards it refuses.
 */
function buildReorder(board: TaskBoard, card: TaskCard, lane: BoardLane, index: number): ReorderItem[] {
  const status = lane.key as TaskStatus;
  const placed = placeInLane(board.cards, { ...card, lane: lane.key }, lane.key, index);
  const at = placed.findIndex((c) => c.id === card.id);
  const before = placed.slice(0, at);
  const after = placed.slice(at + 1);
  const maxBefore = before.length ? Math.max(...before.map((c) => c.sortOrder)) : -1;
  const minAfter = after.length ? Math.min(...after.map((c) => c.sortOrder)) : MAX_SORT + 1;
  const own = (sortOrder: number): ReorderItem => ({ taskId: card.id, ticketId: card.ticketId, status, sortOrder });
  if (minAfter - maxBefore >= 2) {
    const slot = after.length ? Math.floor((maxBefore + minAfter) / 2) : Math.min(MAX_SORT, maxBefore + SORT_SPACING);
    if (slot > maxBefore && slot < minAfter) return [own(slot)];
  }
  const base = maxBefore + 1;
  if (base + SORT_SPACING * after.length > MAX_SORT) {
    // The lane has run out of room at the top of the range: renumber it from the start.
    return [own(Math.min(MAX_SORT, at * SORT_SPACING)), ...placed.filter((c) => c.id !== card.id && c.can.update).map((c) => ({ taskId: c.id, ticketId: c.ticketId, sortOrder: Math.min(MAX_SORT, placed.indexOf(c) * SORT_SPACING) }))];
  }
  const items: ReorderItem[] = [own(base)];
  after.forEach((c, i) => {
    const next = base + SORT_SPACING * (i + 1);
    if (c.can.update && c.sortOrder !== next) items.push({ taskId: c.id, ticketId: c.ticketId, sortOrder: next });
  });
  return items;
}

// ---------------------------------------------------------------- small dialogs

function AddTaskDialog({ ticket, onClose, onDone }: { ticket: TicketCard | null; onClose: () => void; onDone: () => void }) {
  const user = useAuthStore((s) => s.user);
  const [title, setTitle] = useState('');
  const [mine, setMine] = useState(true);
  useEffect(() => {
    if (ticket) {
      setTitle('');
      setMine(true);
    }
  }, [ticket]);
  const add = useMutation({
    mutationFn: () => ticketsApi.addTask(ticket!.id, { title: title.trim(), assigneeId: mine && user ? user.id : null }),
    onSuccess: () => {
      toast.success(`Task added to ${ticket!.number}`);
      onDone();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog
      open={!!ticket}
      onClose={onClose}
      title={ticket ? `Add a task to ${ticket.number}` : ''}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => add.mutate()} disabled={!title.trim()} loading={add.isPending}>
            Add task
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Task" required>
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing"
            maxLength={300}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && title.trim() && !add.isPending) add.mutate();
            }}
          />
        </Field>
        <Checkbox checked={mine} onChange={(e) => setMine(e.target.checked)} label="Assign it to me" />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- page

/**
 * Tickets → Task boards: two kanban boards (tickets, ticket tasks) with lanes by status or
 * by engineer for my work, a team, one engineer or everything in sight. A drop performs the
 * record's own status, assignment or task transition; a refused one snaps back with the
 * server's message. The right column holds the team's shift handover and sticky notes.
 */
export default function TaskBoardsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const can = useAuthStore((s) => s.can);
  const { prefs, update } = useBoardPrefs();
  const { state, set } = useListState();
  const [ready, setReady] = useState(false);
  const { options, lookups } = useLookups();
  const engineers = useEngineers();
  const customers = useCustomersLookup();
  const desktop = useMediaQuery('(min-width: 768px)');
  const [lanesOpen, setLanesOpen] = useState(false);
  const [picker, setPicker] = useState<{ kind: 'ticket'; card: TicketCard } | { kind: 'task'; card: TaskCard } | null>(null);
  const [pending, setPending] = useState<PendingTerminal | null>(null);
  const [addTaskFor, setAddTaskFor] = useState<TicketCard | null>(null);
  const [deleteTask, setDeleteTask] = useState<TaskCard | null>(null);
  const [mobileLane, setMobileLane] = useState<string | null>(null);

  // First visit: the saved layout fills the URL, unless a link already carries board parameters (they win).
  useEffect(() => {
    if (!URL_KEYS.some((k) => state[k] !== undefined)) {
      const p = prefs;
      const fill: Record<string, string | undefined> = {};
      if (p.board !== 'tickets') fill.board = p.board;
      if (p.scope !== 'mine') fill.scope = p.scope;
      if (p.teamId) fill.teamId = p.teamId;
      if (p.assigneeId) fill.assigneeId = p.assigneeId;
      if (p.lanes !== 'status') fill.lanes = p.lanes;
      if (p.panel !== 'both') fill.panel = p.panel;
      for (const k of ['type', 'customerId', 'priorityId', 'due'] as const) if (p.filters[k]) fill[k] = p.filters[k];
      if (Object.keys(fill).length) set(fill, false);
    }
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const board: BoardKind = state.board === 'tasks' ? 'tasks' : 'tickets';
  const scope: BoardScope = SCOPES.includes(state.scope as BoardScope) ? (state.scope as BoardScope) : 'mine';
  const lanesBy: LanesBy = state.lanes === 'assignee' ? 'assignee' : 'status';
  const panel: PanelMode = PANELS.includes(state.panel as PanelMode) ? (state.panel as PanelMode) : 'both';
  const typeFilter = (TICKET_TYPES as readonly string[]).includes(state.type ?? '') ? (state.type as TicketType) : undefined;
  const myTeams = user?.teams ?? [];
  const everyTeam = can('oncall:manage', 'tenant:all');
  const teamOptions = useMemo(() => {
    const seen = new Map<string, { id: string; name: string }>();
    for (const t of myTeams) seen.set(t.id, { id: t.id, name: t.name });
    if (everyTeam) for (const t of lookups?.teams ?? []) if (!seen.has(t.id)) seen.set(t.id, { id: t.id, name: t.name });
    return [...seen.values()];
  }, [myTeams, everyTeam, lookups?.teams]);
  const teamId = state.teamId || myTeams[0]?.id || teamOptions[0]?.id;
  const assigneeId = state.assigneeId || user?.id;
  const scopeReady = scope === 'team' ? !!teamId : scope === 'assignee' ? !!assigneeId : true;
  // A saved panel team counts only while the person may still pick it (a team they left or that was retired falls through).
  const savedHandoverTeam = prefs.handoverTeamId && teamOptions.some((t) => t.id === prefs.handoverTeamId) ? prefs.handoverTeamId : undefined;
  const handoverTeamId = savedHandoverTeam ?? (scope === 'team' ? teamId : undefined) ?? myTeams[0]?.id ?? teamOptions[0]?.id;

  const ticketParams = useMemo(
    () => ({ scope, teamId: scope === 'team' ? teamId : undefined, assigneeId: scope === 'assignee' ? assigneeId : undefined, lanes: lanesBy, type: typeFilter, customerId: state.customerId || undefined, priorityId: state.priorityId || undefined, q: state.q || undefined, includeClosed: prefs.includeClosed ? 'true' : undefined }),
    [scope, teamId, assigneeId, lanesBy, typeFilter, state.customerId, state.priorityId, state.q, prefs.includeClosed],
  );
  const taskParams = useMemo(
    () => ({ scope, teamId: scope === 'team' ? teamId : undefined, assigneeId: scope === 'assignee' ? assigneeId : undefined, lanes: lanesBy, customerId: state.customerId || undefined, due: state.due || undefined, q: state.q || undefined, includeDone: prefs.includeDone ? 'true' : undefined }),
    [scope, teamId, assigneeId, lanesBy, state.customerId, state.due, state.q, prefs.includeDone],
  );
  const ticketKey = boardKeys.tickets(ticketParams);
  const taskKey = boardKeys.tasks(taskParams);
  const ticketQ = useQuery({ queryKey: ticketKey, queryFn: () => boardsApi.tickets(ticketParams), enabled: ready && scopeReady && board === 'tickets', refetchInterval: 60_000, placeholderData: (p) => p });
  const taskQ = useQuery({ queryKey: taskKey, queryFn: () => boardsApi.tasks(taskParams), enabled: ready && scopeReady && board === 'tasks', refetchInterval: 60_000, placeholderData: (p) => p });
  const data: TicketBoard | TaskBoard | undefined = board === 'tickets' ? ticketQ.data : taskQ.data;
  const loading = board === 'tickets' ? ticketQ.isLoading : taskQ.isLoading;
  const error = board === 'tickets' ? ticketQ.error : taskQ.error;
  const refetch = board === 'tickets' ? ticketQ.refetch : taskQ.refetch;

  // The URL is the state of the visit; the saved layout follows it.
  useEffect(() => {
    if (!ready) return;
    update({ board, scope, teamId: state.teamId || undefined, assigneeId: state.assigneeId || undefined, lanes: lanesBy, panel, filters: { type: typeFilter, customerId: state.customerId || undefined, priorityId: state.priorityId || undefined, due: state.due || undefined } });
  }, [ready, board, scope, state.teamId, state.assigneeId, lanesBy, panel, typeFilter, state.customerId, state.priorityId, state.due, update]);

  // ---- lanes as the person laid them out
  const layoutKey = `${board}:${lanesBy}`;
  const hidden = useMemo(() => new Set(prefs.hiddenLanes[layoutKey] ?? []), [prefs.hiddenLanes, layoutKey]);
  const collapsed = useMemo(() => new Set(prefs.collapsedLanes[layoutKey] ?? []), [prefs.collapsedLanes, layoutKey]);
  const orderedLanes = useMemo(() => {
    const lanes = data?.lanes ?? [];
    const order = prefs.laneOrder[layoutKey] ?? [];
    const idx = new Map(order.map((k, i) => [k, i]));
    return lanes
      .map((l, i) => ({ l, rank: idx.get(l.key) ?? order.length + i }))
      .sort((a, b) => a.rank - b.rank)
      .map((x) => x.l);
  }, [data, prefs.laneOrder, layoutKey]);
  const statusesByType = data && 'statusesByType' in data ? data.statusesByType : undefined;
  const typesInView: TicketType[] = typeFilter ? [typeFilter] : [...TICKET_TYPES];
  const isSharedLane = (lane: BoardLane) => board !== 'tickets' || lane.kind !== 'status' || !statusesByType || typesInView.every((t) => (statusesByType[t] ?? []).includes(lane.key));
  const pickerLanes = orderedLanes.filter((l) => !hidden.has(l.key));
  const visibleLanes = pickerLanes.filter((l) => prefs.showEmptyLanes || l.count > 0 || isSharedLane(l));
  const limitFor = (lane: BoardLane) => {
    const own = prefs.wipLimits[lane.key];
    return own && own > 0 ? own : lane.limit;
  };
  const cardsByLane = useMemo(() => {
    const m = new Map<string, (TicketCard | TaskCard)[]>();
    for (const c of data?.cards ?? []) {
      const arr = m.get(c.lane) ?? [];
      arr.push(c);
      m.set(c.lane, arr);
    }
    if (board === 'tasks') for (const arr of m.values()) arr.sort((a, b) => (a as TaskCard).sortOrder - (b as TaskCard).sortOrder);
    return m;
  }, [data, board]);
  const refusalsFor = (card: TicketCard | TaskCard): Refusals => (isTask(card) ? taskRefusals(card, orderedLanes) : ticketRefusals(card, orderedLanes, lanesBy, statusesByType ?? ({} as Record<TicketType, string[]>)));
  const canDrag = (card: TicketCard | TaskCard) => desktop && (isTask(card) ? card.can.update : lanesBy === 'assignee' ? card.can.assign : card.can.update || card.can.resolve);

  // ---- moves: optimistic, snapped back with the server's message when refused
  const invalidateBoards = () => {
    void qc.invalidateQueries({ queryKey: ['tickets'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const moveTicket = useMutation({
    mutationFn: ({ card, lane }: { card: TicketCard; lane: BoardLane }) => (lane.kind === 'assignee' ? ticketsApi.assign(card.id, { assigneeId: lane.key === 'unassigned' ? null : lane.key }) : ticketsApi.status(card.id, { statusId: lane.key })),
    onMutate: async ({ card, lane }) => {
      await qc.cancelQueries({ queryKey: ticketKey });
      const prev = qc.getQueryData<TicketBoard>(ticketKey);
      if (prev) qc.setQueryData(ticketKey, moveTicketCard(prev, card.id, lane));
      return { prev };
    },
    onError: (e: Error, _v, c) => {
      if (c?.prev) qc.setQueryData(ticketKey, c.prev);
      toast.error(e.message || 'The move was refused');
    },
    onSuccess: (_d, { card, lane }) => toast.success(lane.kind === 'assignee' ? (lane.key === 'unassigned' ? `${card.number} unassigned` : `${card.number} assigned to ${lane.label}`) : `${card.number} moved to ${lane.label}`),
    onSettled: invalidateBoards,
  });
  const moveTask = useMutation({
    mutationFn: async ({ card, lane, items }: { card: TaskCard; lane: BoardLane; index: number; items: ReorderItem[] }) => {
      if (lane.kind === 'assignee') {
        await ticketsApi.updateTask(card.ticketId, card.id, { assigneeId: lane.key === 'unassigned' ? null : lane.key });
        return;
      }
      const failed: { taskId: string; error: string }[] = [];
      for (let i = 0; i < items.length; i += REORDER_CHUNK) {
        const res = await boardsApi.reorder(items.slice(i, i + REORDER_CHUNK));
        const own = res.failed.find((f) => f.taskId === card.id);
        if (own) throw new Error(own.error);
        failed.push(...res.failed);
      }
      if (failed.length) toast.error(`${failed.length} other task${failed.length === 1 ? '' : 's'} could not be reordered: ${failed[0]!.error}`);
    },
    onMutate: async ({ card, lane, index }) => {
      await qc.cancelQueries({ queryKey: taskKey });
      const prev = qc.getQueryData<TaskBoard>(taskKey);
      if (prev) qc.setQueryData(taskKey, moveTaskCard(prev, card.id, lane, index));
      return { prev };
    },
    onError: (e: Error, _v, c) => {
      if (c?.prev) qc.setQueryData(taskKey, c.prev);
      toast.error(e.message || 'The move was refused');
    },
    onSuccess: (_d, { card, lane }) => toast.success(lane.kind === 'assignee' ? (lane.key === 'unassigned' ? 'Task unassigned' : `Task assigned to ${lane.label}`) : lane.key === 'done' ? 'Task marked done' : card.lane === lane.key ? 'Task order saved' : `Task moved to ${lane.label}`),
    onSettled: invalidateBoards,
  });
  const handleMove = useCallback(
    (cardId: string, laneKey: string, index: number) => {
      const lane = orderedLanes.find((l) => l.key === laneKey);
      if (!lane || !data) return;
      if (board === 'tickets') {
        const card = (data as TicketBoard).cards.find((c) => c.id === cardId);
        if (!card || card.lane === laneKey) return;
        const kind = lane.kind === 'status' ? terminalKindOf(lane.category) : null;
        if (kind) {
          setPending({ ticketId: card.id, number: card.number, kind, statusId: lane.key, laneLabel: lane.label });
          return;
        }
        moveTicket.mutate({ card, lane });
      } else {
        const tasks = data as TaskBoard;
        const card = tasks.cards.find((c) => c.id === cardId);
        if (!card || (lane.kind === 'assignee' && card.lane === laneKey)) return;
        moveTask.mutate({ card, lane, index, items: lane.kind === 'status' ? buildReorder(tasks, card, lane, index) : [] });
      }
    },
    [orderedLanes, data, board, moveTicket, moveTask],
  );
  const refuse = useCallback((reason: string) => toast.error(reason), []);
  const dnd = useDragDrop(handleMove, refuse);

  // ---- quick actions from the card menus
  const quick = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onError: (e: Error) => toast.error(e.message), onSettled: invalidateBoards });
  const act = (fn: () => Promise<unknown>, message: string) => quick.mutate(fn, { onSuccess: () => toast.success(message) });
  const ticketMenu = (card: TicketCard): MenuItem[] => {
    const items: MenuItem[] = [{ label: 'Open', icon: <ExternalLink className="h-3.5 w-3.5" />, onClick: () => navigate(`/tickets/${card.id}`) }];
    if (card.can.assign && user && card.assigneeId !== user.id) items.push({ label: 'Assign to me', icon: <UserPlus className="h-3.5 w-3.5" />, onClick: () => act(() => ticketsApi.assign(card.id, { assigneeId: user.id, autoProgress: true }), `${card.number} assigned to you`) });
    const refusals = refusalsFor(card);
    if (pickerLanes.some((l) => l.key !== card.lane && refusals[l.key] === null)) items.push({ label: 'Move to…', icon: <MoveRight className="h-3.5 w-3.5" />, onClick: () => setPicker({ kind: 'ticket', card }) });
    if (card.can.resolve && !TERMINAL_CATEGORIES.has(card.status.category ?? '')) items.push({ label: 'Resolve…', icon: <CheckCircle2 className="h-3.5 w-3.5" />, onClick: () => setPending({ ticketId: card.id, number: card.number, kind: 'resolve' }) });
    if (card.can.update) items.push({ label: 'Add task…', icon: <ListPlus className="h-3.5 w-3.5" />, onClick: () => setAddTaskFor(card) });
    items.push({ label: 'Watch', icon: <Eye className="h-3.5 w-3.5" />, onClick: () => act(() => ticketsApi.watch(card.id), `Watching ${card.number}`) });
    return items;
  };
  const taskMenu = (card: TaskCard): MenuItem[] => {
    const items: MenuItem[] = [{ label: 'Open ticket', icon: <ExternalLink className="h-3.5 w-3.5" />, onClick: () => navigate(`/tickets/${card.ticketId}`) }];
    if (!card.can.update) return items;
    if (card.status !== 'done') items.push({ label: 'Mark done', icon: <CheckCheck className="h-3.5 w-3.5" />, onClick: () => act(() => ticketsApi.updateTask(card.ticketId, card.id, { status: 'done' }), 'Task marked done') });
    if (card.status === 'done' || card.status === 'cancelled') items.push({ label: 'Reopen', icon: <RotateCcw className="h-3.5 w-3.5" />, onClick: () => act(() => ticketsApi.updateTask(card.ticketId, card.id, { status: 'open' }), 'Task reopened') });
    if (user && card.assigneeId !== user.id) items.push({ label: 'Assign to me', icon: <UserPlus className="h-3.5 w-3.5" />, onClick: () => act(() => ticketsApi.updateTask(card.ticketId, card.id, { assigneeId: user.id }), 'Task assigned to you') });
    items.push({ label: 'Move to…', icon: <MoveRight className="h-3.5 w-3.5" />, onClick: () => setPicker({ kind: 'task', card }) });
    items.push({ label: 'Delete…', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onClick: () => setDeleteTask(card) });
    return items;
  };

  // ---- filters
  const priorities = options('ticket_priority');
  const customerItems = customers.data?.items ?? [];
  const engineerItems = useMemo(() => {
    const list = (engineers.data ?? []).map((u) => ({ id: u.id, name: u.name }));
    if (user && !list.some((u) => u.id === user.id)) list.unshift({ id: user.id, name: `${user.name} (you)` });
    return list;
  }, [engineers.data, user]);
  const applied: AppliedFilter[] = [];
  const addApplied = (key: string, label: ReactNode, onRemove = () => set({ [key]: undefined })) => applied.push({ key, label, onRemove });
  if (state.q) addApplied('q', `Search: “${state.q}”`);
  if (board === 'tickets' && typeFilter) addApplied('type', `Type: ${TYPE_LABELS[typeFilter]}`);
  if (state.customerId) addApplied('customerId', `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`);
  if (board === 'tickets' && state.priorityId) addApplied('priorityId', `Priority: ${priorities.find((p) => p.id === state.priorityId)?.label ?? '…'}`);
  if (board === 'tasks' && state.due) addApplied('due', `Due: ${DUE_OPTIONS.find((o) => o.value === state.due)?.label ?? state.due}`);
  if (board === 'tickets' && prefs.includeClosed) addApplied('includeClosed', 'Closed shown', () => update({ includeClosed: false }));
  if (board === 'tasks' && prefs.includeDone) addApplied('includeDone', 'Done shown', () => update({ includeDone: false }));
  if (prefs.showEmptyLanes) addApplied('showEmptyLanes', 'Empty lanes shown', () => update({ showEmptyLanes: false }));
  const clearFilters = () => {
    set({ q: undefined, type: undefined, customerId: undefined, priorityId: undefined, due: undefined });
    update({ includeClosed: false, includeDone: false, showEmptyLanes: false });
  };
  const filters = (
    <>
      {board === 'tickets' && (
        <FilterGroup label="Type">
          <FilterOptions options={TICKET_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] }))} value={typeFilter} onChange={(v) => set({ type: v as string | undefined })} />
        </FilterGroup>
      )}
      <FilterGroup label="Customer">
        <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value || undefined })} placeholder="Any customer" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
      </FilterGroup>
      {board === 'tickets' ? (
        <FilterGroup label="Priority">
          <FilterOptions options={priorities.map((p) => ({ value: p.id, label: p.label, dot: dotClass(p.color ?? (p.level ? PRIORITY_LEVEL_COLORS[p.level] : null)) }))} value={state.priorityId} onChange={(v) => set({ priorityId: v as string | undefined })} />
        </FilterGroup>
      ) : (
        <FilterGroup label="Due">
          <FilterOptions options={DUE_OPTIONS} value={state.due} onChange={(v) => set({ due: v as string | undefined })} />
        </FilterGroup>
      )}
      <FilterGroup label="View" hint="What the board shows beyond the open work">
        {board === 'tickets' ? <FilterToggle label="Show closed" checked={prefs.includeClosed} onChange={(v) => update({ includeClosed: v })} hint="Closed and cancelled tickets get their own lanes" /> : <FilterToggle label="Show done" checked={prefs.includeDone} onChange={(v) => update({ includeDone: v })} hint="Every done task, and a Cancelled lane" />}
        <FilterToggle label="Show empty lanes" checked={prefs.showEmptyLanes} onChange={(v) => update({ showEmptyLanes: v })} hint="Statuses of one ticket type with no card in them" />
      </FilterGroup>
    </>
  );

  // ---- rendering
  const toggleCollapsed = (key: string) => update({ collapsedLanes: { ...prefs.collapsedLanes, [layoutKey]: toggleIn(prefs.collapsedLanes[layoutKey] ?? [], key) } });
  const renderCard = (c: TicketCard | TaskCard, i: number) =>
    isTask(c) ? (
      <TaskCardView key={c.id} card={c} index={i} draggable={canDrag(c)} dragging={dnd.drag?.cardId === c.id} onDragStart={(e) => dnd.start(e, c.id, c.lane, refusalsFor(c))} onDragEnd={dnd.end} menu={taskMenu(c)} />
    ) : (
      <TicketCardView key={c.id} card={c} index={i} draggable={canDrag(c)} dragging={dnd.drag?.cardId === c.id} onDragStart={(e) => dnd.start(e, c.id, c.lane, refusalsFor(c))} onDragEnd={dnd.end} menu={ticketMenu(c)} />
    );
  const activeMobileLane = visibleLanes.find((l) => l.key === mobileLane) ?? visibleLanes[0];
  const count = data ? `${fmtNumber(data.total)} ${data.total === 1 ? 'card' : 'cards'} · ${visibleLanes.length} ${visibleLanes.length === 1 ? 'lane' : 'lanes'}` : undefined;
  const noCards = !!data && data.cards.length === 0 && !prefs.showEmptyLanes;

  let body: ReactNode;
  if (!scopeReady) body = <EmptyState icon={<Kanban className="h-5 w-5" />} title={scope === 'team' ? 'Pick a team for the team board' : 'Pick an engineer for the engineer board'} description={scope === 'team' ? 'You are not in a team; choose one above.' : 'Choose an engineer above.'} />;
  else if (loading || (!data && !error)) body = <LoadingBlock label="Laying out the board…" />;
  else if (error) body = <ErrorBlock error={error} retry={() => void refetch()} />;
  else if (noCards)
    body = (
      <EmptyState
        icon={<Kanban className="h-5 w-5" />}
        title="No cards in this scope"
        description={scope === 'mine' ? 'Nothing is assigned to you here. Widen the scope or clear the filters.' : 'Widen the scope or clear the filters to see more.'}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {applied.length > 0 && (
              <Button variant="outline" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => navigate('/tickets')}>
              Open the ticket list
            </Button>
          </div>
        }
      />
    );
  else if (desktop)
    body = (
      <div className="flex gap-3 overflow-x-auto pb-2 [scrollbar-width:thin] fade-in" data-testid="board-strip" onDragOver={autoScrollStrip}>
        {visibleLanes.map((lane) => {
          const cards = cardsByLane.get(lane.key) ?? [];
          return (
            <Lane key={lane.key} lane={lane} limit={limitFor(lane)} collapsed={collapsed.has(lane.key)} onToggleCollapse={() => toggleCollapsed(lane.key)} drop={dnd.laneProps(lane.key)} empty={cards.length === 0}>
              {cards.map(renderCard)}
            </Lane>
          );
        })}
      </div>
    );
  else
    body = (
      <div className="flex flex-col gap-3" data-testid="board-mobile">
        <Select aria-label="Lane" value={activeMobileLane?.key ?? ''} onChange={(e) => setMobileLane(e.target.value)} options={visibleLanes.map((l) => ({ value: l.key, label: `${l.label} (${l.count})` }))} data-testid="mobile-lane-select" />
        {activeMobileLane && (
          <Lane lane={activeMobileLane} limit={limitFor(activeMobileLane)} mobile empty={(cardsByLane.get(activeMobileLane.key) ?? []).length === 0}>
            {(cardsByLane.get(activeMobileLane.key) ?? []).map(renderCard)}
          </Lane>
        )}
        <p className="text-[12px] text-subtle">Use a card's menu to move it between lanes on a phone.</p>
      </div>
    );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Task boards"
        subtitle="Tickets and tasks as lanes; drag a card to change its status or owner"
        actions={
          <Button variant="outline" size="sm" icon={<List className="h-3.5 w-3.5" />} onClick={() => navigate('/tickets')}>
            Open the ticket list
          </Button>
        }
      />
      <ListShell
        id="task-boards"
        search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: board === 'tickets' ? 'Search number, title…' : 'Search tasks, ticket number…' }}
        filters={filters}
        applied={applied}
        activeCount={applied.length}
        onClear={clearFilters}
        count={count}
        quick={
          <>
            <Segmented size="sm" options={[{ value: 'tickets', label: 'Tickets' }, { value: 'tasks', label: 'Tasks' }]} value={board} onChange={(v) => set({ board: v === 'tickets' ? undefined : v })} />
            <span className="hidden sm:block h-5 w-px bg-[var(--border)] mx-0.5" aria-hidden />
            <Segmented
              size="sm"
              options={[
                { value: 'mine', label: 'My board' },
                { value: 'team', label: 'Team' },
                { value: 'assignee', label: 'Engineer' },
                { value: 'all', label: 'Everything' },
              ]}
              value={scope}
              onChange={(v) => set({ scope: v === 'mine' ? undefined : v, teamId: v === 'team' ? state.teamId || teamId : undefined, assigneeId: v === 'assignee' ? state.assigneeId || user?.id : undefined })}
            />
            {scope === 'team' && (teamOptions.length > 0 ? <Select aria-label="Team" className="h-8 py-0 text-[12.5px] w-44" value={teamId ?? ''} onChange={(e) => set({ teamId: e.target.value || undefined })} options={teamOptions.map((t) => ({ value: t.id, label: t.name }))} data-testid="board-team" /> : <span className="text-[12.5px] text-subtle">You are not in a team</span>)}
            {scope === 'assignee' && <Select aria-label="Engineer" className="h-8 py-0 text-[12.5px] w-44" value={assigneeId ?? ''} onChange={(e) => set({ assigneeId: e.target.value || undefined })} placeholder="Pick an engineer" options={engineerItems.map((u) => ({ value: u.id, label: u.name }))} data-testid="board-engineer" />}
            <span className="hidden sm:block h-5 w-px bg-[var(--border)] mx-0.5" aria-hidden />
            <Segmented size="sm" options={[{ value: 'status', label: 'Status' }, { value: 'assignee', label: 'Assignee' }]} value={lanesBy} onChange={(v) => set({ lanes: v === 'status' ? undefined : v })} />
          </>
        }
        toolbar={
          <>
            <Button variant="outline" size="sm" icon={<Columns3 className="h-3.5 w-3.5" />} onClick={() => setLanesOpen(true)} disabled={!data}>
              Lanes…
            </Button>
            <Segmented
              size="sm"
              options={[
                { value: 'handover', label: 'Handover' },
                { value: 'notes', label: 'Notes' },
                { value: 'both', label: 'Both' },
                { value: 'hidden', label: 'Hidden' },
              ]}
              value={panel}
              onChange={(v) => set({ panel: v === 'both' ? undefined : v })}
            />
          </>
        }
      >
        <div className={cn('grid gap-5 items-start', panel !== 'hidden' && 'xl:grid-cols-[minmax(0,1fr)_320px]')}>
          <div className="min-w-0">
            {body}
            {data?.truncated && !noCards && <p className="text-[12.5px] text-muted mt-2">Showing the {fmtNumber(data.cards.length)} most recently active cards; narrow the scope to see the rest.</p>}
          </div>
          {panel !== 'hidden' && (
            <aside className="flex flex-col gap-4 min-w-0" data-testid="board-panel">
              {(panel === 'handover' || panel === 'both') && <HandoverPanel teamId={handoverTeamId} teams={teamOptions} onTeamChange={(id) => update({ handoverTeamId: id })} />}
              {(panel === 'notes' || panel === 'both') && <StickyNotes board={board} teamId={scope === 'team' ? teamId : undefined} />}
            </aside>
          )}
        </div>
      </ListShell>

      <LanesDialog
        open={lanesOpen}
        onClose={() => setLanesOpen(false)}
        lanes={orderedLanes}
        hidden={hidden}
        collapsed={collapsed}
        limits={prefs.wipLimits}
        onReorder={(keys) => update({ laneOrder: { ...prefs.laneOrder, [layoutKey]: keys } })}
        onToggleHidden={(k) => update({ hiddenLanes: { ...prefs.hiddenLanes, [layoutKey]: toggleIn(prefs.hiddenLanes[layoutKey] ?? [], k) } })}
        onToggleCollapsed={toggleCollapsed}
        onLimit={(k, n) => {
          const next = { ...prefs.wipLimits };
          if (n > 0) next[k] = n;
          else delete next[k];
          update({ wipLimits: next });
        }}
        onReset={() => update({ laneOrder: omit(prefs.laneOrder, layoutKey), hiddenLanes: omit(prefs.hiddenLanes, layoutKey), collapsedLanes: omit(prefs.collapsedLanes, layoutKey), wipLimits: Object.fromEntries(Object.entries(prefs.wipLimits).filter(([k]) => !orderedLanes.some((l) => l.key === k))) })}
      />
      {picker && <MoveDialog open onClose={() => setPicker(null)} title={picker.kind === 'ticket' ? `Move ${picker.card.number}` : `Move the task “${picker.card.title}”`} lanes={pickerLanes} currentLane={picker.card.lane} refusals={refusalsFor(picker.card)} onPick={(key) => handleMove(picker.card.id, key, Number.MAX_SAFE_INTEGER)} />}
      <TerminalDropDialog
        pending={pending}
        onClose={() => setPending(null)}
        onDone={(message) => {
          setPending(null);
          toast.success(message);
          invalidateBoards();
        }}
      />
      <AddTaskDialog ticket={addTaskFor} onClose={() => setAddTaskFor(null)} onDone={invalidateBoards} />
      <ConfirmDialog
        open={!!deleteTask}
        onClose={() => setDeleteTask(null)}
        title="Delete this task?"
        description={deleteTask ? `“${deleteTask.title}” on ${deleteTask.ticketNumber} is removed from the ticket.` : undefined}
        confirmLabel="Delete"
        danger
        loading={quick.isPending}
        onConfirm={() => {
          const t = deleteTask;
          if (!t) return;
          quick.mutate(() => ticketsApi.deleteTask(t.ticketId, t.id), {
            onSuccess: () => {
              toast.success('Task deleted');
              setDeleteTask(null);
            },
          });
        }}
      />
    </div>
  );
}
