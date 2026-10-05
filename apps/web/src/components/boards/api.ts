import { get, post, patch, del } from '@/api/client';
import type { BreachRisk, SlaCompact, TicketType } from '@/components/tickets/types';

/**
 * Task boards: the ticket board, the task board, the shift handover panel and the
 * person's sticky notes. Moves go through the ticket routes (`ticketsApi`), so the
 * permission each move needs is the one the record page already checks.
 */

export type BoardKind = 'tickets' | 'tasks';
export type BoardScope = 'mine' | 'team' | 'assignee' | 'all';
export type LanesBy = 'status' | 'assignee';
export type TaskStatus = 'open' | 'in_progress' | 'done' | 'cancelled';
export type NoteColor = 'amber' | 'blue' | 'green' | 'rose' | 'slate';
export type PanelMode = 'handover' | 'notes' | 'both' | 'hidden';

export interface BoardLane {
  /** Status option id, user id, task status key, or `unassigned`. */
  key: string;
  label: string;
  kind: LanesBy;
  /** Option colour for status lanes, null for people. */
  color: string | null;
  /** status_category for ticket status lanes. */
  category: string | null;
  /** The option key (`in_progress`, …) for status lanes. */
  statusKey: string | null;
  count: number;
  /** Cards in the new/open/pending categories (open or in-progress tasks). */
  open: number;
  breached: number;
  /** Assignee lanes: the platform WIP limit (null when 0). */
  limit: number | null;
  over: boolean;
}

export interface CardStatus {
  id: string;
  key: string | null;
  label: string | null;
  color: string | null;
  category: string | null;
}
export interface CardPriority {
  id: string;
  key: string | null;
  label: string | null;
  color: string | null;
  level: number | null;
}

export interface TicketCard {
  id: string;
  number: string;
  type: TicketType;
  title: string;
  customerId: string;
  customerName: string | null;
  status: CardStatus;
  priority: CardPriority | null;
  assigneeId: string | null;
  assigneeName: string | null;
  assignedTeamId: string | null;
  teamName: string | null;
  isMajor: boolean;
  escalationLevel: number;
  dueAt: string | null;
  createdAt: string;
  lastActivityAt: string;
  ageMinutes: number;
  sla: SlaCompact | null;
  breachRisk: BreachRisk | null;
  /** The status option's own pauses_sla flag (a hint; the SLA indicator is the truth). */
  pausesSla: boolean;
  tasks: { total: number; done: number } | null;
  /** The lane key this card sits in for the requested lanes mode. */
  lane: string;
  can: { update: boolean; assign: boolean; resolve: boolean };
}

export interface TicketBoard {
  generatedAt: string;
  board: 'tickets';
  scope: BoardScope;
  lanesBy: LanesBy;
  lanes: BoardLane[];
  cards: TicketCard[];
  total: number;
  truncated: boolean;
  /** Open tickets due within the next four hours; exact even when the cards are capped. */
  dueSoon: number;
  /** Status option ids that apply per ticket type, so lanes can be greyed while dragging. */
  statusesByType: Record<TicketType, string[]>;
  settings: { wipDefaultLimit: number; cardLimit: number };
}

export interface TaskCard {
  id: string;
  ticketId: string;
  ticketNumber: string;
  ticketType: TicketType;
  ticketTitle: string;
  customerId: string;
  customerName: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  assigneeId: string | null;
  assigneeName: string | null;
  teamId: string | null;
  teamName: string | null;
  dueAt: string | null;
  completedAt: string | null;
  sortOrder: number;
  createdAt: string;
  ageMinutes: number;
  /** dueAt in the past while the task is still open or in progress. */
  overdue: boolean;
  ticketPriority: CardPriority | null;
  ticketStatus: CardStatus;
  ticketSla: SlaCompact | null;
  lane: string;
  can: { update: boolean };
}

export interface TaskBoard {
  generatedAt: string;
  board: 'tasks';
  scope: BoardScope;
  lanesBy: LanesBy;
  lanes: BoardLane[];
  cards: TaskCard[];
  total: number;
  truncated: boolean;
  /** Open or in-progress tasks past their due date, and those due within four hours; exact even when the cards are capped. */
  overdue: number;
  dueSoon: number;
  settings: { wipDefaultLimit: number; cardLimit: number };
}

export interface ReorderItem {
  taskId: string;
  ticketId: string;
  status?: TaskStatus;
  sortOrder: number;
}

export interface HandoverPanel {
  team: { id: string; name: string };
  current: { id: string; name: string; endsAt: string } | null;
  next: { id: string; name: string; startsAt: string } | null;
  unacknowledged: number;
  canWrite: boolean;
  canAcknowledge: boolean;
  latest: {
    id: string;
    status: 'draft' | 'final' | 'acknowledged';
    shiftDate: string;
    shiftName: string | null;
    authorId: string | null;
    authorName: string | null;
    publishedAt: string | null;
    acknowledgedByName: string | null;
    acknowledgedAt: string | null;
    acknowledgementNote: string | null;
    /** The "Watch first" section of the note (the whole note when it has none), up to 600 characters. */
    watchFirst: string;
    body: string;
  } | null;
}

export interface BoardNote {
  id: string;
  userId: string;
  teamId: string | null;
  board: BoardKind;
  body: string;
  color: NoteColor;
  pinned: boolean;
  done: boolean;
  doneAt: string | null;
  shiftDate: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export const boardKeys = {
  /** Under 'tickets' so the assistant's tickets invalidation and the ticket page's refresh reach the boards. */
  tickets: (params: Record<string, unknown>) => ['tickets', 'board', 'tickets', params] as const,
  tasks: (params: Record<string, unknown>) => ['tickets', 'board', 'tasks', params] as const,
  handover: (teamId: string) => ['handover', 'panel', teamId] as const,
  notes: (params: Record<string, unknown>) => ['boards', 'notes', params] as const,
};

export const boardsApi = {
  tickets: (params: Record<string, unknown>) => get<TicketBoard>('/boards/tickets', params),
  tasks: (params: Record<string, unknown>) => get<TaskBoard>('/boards/tasks', params),
  reorder: (items: ReorderItem[]) => post<{ ok: true; updated: number; failed: { taskId: string; error: string }[] }>('/boards/tasks/reorder', { items }),
  handover: (teamId: string) => get<HandoverPanel>('/boards/handover', { teamId }),
  notes: (params: { board: BoardKind; teamId?: string; includeDone?: 'true' }) => get<{ items: BoardNote[] }>('/boards/notes', params),
  addNote: (body: { board: BoardKind; teamId?: string | null; body: string; color?: NoteColor; pinned?: boolean }) => post<BoardNote>('/boards/notes', body),
  updateNote: (id: string, body: { body?: string; color?: NoteColor; pinned?: boolean; done?: boolean; sortOrder?: number }) => patch<BoardNote>(`/boards/notes/${id}`, body),
  deleteNote: (id: string) => del<{ ok: true }>(`/boards/notes/${id}`),
};

export const TERMINAL_CATEGORIES = new Set(['resolved', 'closed', 'cancelled']);
