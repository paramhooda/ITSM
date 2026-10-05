import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DateTime } from 'luxon';
import { TICKET_TYPES, type TicketType } from '@itsm/shared';
import { schema, withSystem, type Tx } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ForbiddenError, NotFoundError, ValidationError } from '@/core/errors';
import { listTickets, visibilityConds, buildWhere } from '@/modules/tickets/list';
import { listQuerySchema } from '@/modules/tickets/schemas';
import { isCustomerUser, optionsOfType, statusApplies, type OptionRow } from '@/modules/tickets/common';
import { updateTask } from '@/modules/tickets/activity';
import { slaSummariesFor, worstSla, slaStateFilterSql, type SlaCompact } from '@/modules/sla/engine';
import type { RiskLevel } from '@/modules/sla/risk';
import * as handover from '@/modules/handover/service';
import { like } from '@/modules/ai/helpers';
import type { BoardKind } from '@/db/schema/boards';
import type { TicketBoardQuery, TaskBoardQuery, ReorderItem, NoteListQuery, NoteInput, NotePatch } from './schemas';

/**
 * Task boards: kanban views over tickets and ticket tasks for the signed-in
 * person, a team or one engineer, with lanes by status or by assignee. The
 * boards read through the same list predicates as the ticket list (customer
 * scope, the SOC fence, row-level security), every move goes through the
 * ticket routes the record page uses, and customer users are refused
 * everywhere. Sticky notes belong to their author; the shift handover panel
 * composes the handover module's own reads.
 */

const T = schema.tickets;
const K = schema.ticketTasks;
const st = alias(schema.configOptions, 'st');
const pr = alias(schema.configOptions, 'pr');
const assignee = alias(schema.users, 'assignee');

const OPEN_CATEGORIES = new Set(['new', 'open', 'pending']);
const TASK_OPEN = new Set(['open', 'in_progress']);
const TASK_LANES: { key: TaskStatus; label: string }[] = [{ key: 'open', label: 'Open' }, { key: 'in_progress', label: 'In progress' }, { key: 'done', label: 'Done' }, { key: 'cancelled', label: 'Cancelled' }];
const UNASSIGNED = 'unassigned';
const DONE_WINDOW_DAYS = 7;
const DUE_SOON_MS = 4 * 3_600_000;

export type TaskStatus = 'open' | 'in_progress' | 'done' | 'cancelled';

/** The caller's clock in their own time zone (UTC when the zone is unknown or invalid), for calendar-day questions such as "due today". */
function localClock(now: Date, zone: string | undefined): DateTime {
  const dt = DateTime.fromJSDate(now, { zone: zone || 'UTC' });
  return dt.isValid ? dt : DateTime.fromJSDate(now, { zone: 'UTC' });
}
/** The start of the caller's day plus `days`, as an instant. */
const localDayEnd = (now: Date, zone: string | undefined, days: number): Date => localClock(now, zone).startOf('day').plus({ days }).toJSDate();
/** The caller's calendar day as YYYY-MM-DD. */
const localDay = (now: Date, zone: string | undefined): string => localClock(now, zone).toISODate()!;
/** A due date that falls inside the next four hours. */
const isDueSoon = (due: Date | null | undefined, now: Date): boolean => !!due && due.getTime() > now.getTime() && due.getTime() - now.getTime() <= DUE_SOON_MS;

// ---------------------------------------------------------------- settings

export interface BoardSettings {
  wipDefaultLimit: number;
  cardLimit: number;
  noteRetentionDays: number;
}
export const DEFAULT_BOARD_SETTINGS: BoardSettings = { wipDefaultLimit: 8, cardLimit: 300, noteRetentionDays: 30 };
const clampNum = (v: unknown, fallback: number, min: number, max: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/** `boards.wip_default_limit`, `boards.card_limit` and `boards.note_retention_days`, clamped to their ranges. */
export async function loadBoardSettings(tx: Tx): Promise<BoardSettings> {
  const rows = await tx.select({ key: schema.systemSettings.key, value: schema.systemSettings.value }).from(schema.systemSettings).where(inArray(schema.systemSettings.key, ['boards.wip_default_limit', 'boards.card_limit', 'boards.note_retention_days']));
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return {
    wipDefaultLimit: clampNum(get('boards.wip_default_limit'), DEFAULT_BOARD_SETTINGS.wipDefaultLimit, 0, 100),
    cardLimit: clampNum(get('boards.card_limit'), DEFAULT_BOARD_SETTINGS.cardLimit, 50, 500),
    noteRetentionDays: clampNum(get('boards.note_retention_days'), DEFAULT_BOARD_SETTINGS.noteRetentionDays, 1, 365),
  };
}

// ---------------------------------------------------------------- guards and scope

/** Customer users never reach boards, handover panels or notes. */
function staffOnly(ctx: Ctx): void {
  if (isCustomerUser(ctx)) throw new ForbiddenError('Task boards are internal to the service provider');
}

interface Scope {
  mine: boolean;
  teamId: string | null;
  assigneeId: string | null;
}

function resolveScope(ctx: Ctx, q: { scope: TicketBoardQuery['scope']; teamId?: string; assigneeId?: string }): Scope {
  if (q.scope === 'mine') return { mine: true, teamId: null, assigneeId: null };
  if (q.scope === 'team') {
    const teamId = q.teamId ?? ctx.user.teams[0]?.id ?? null;
    if (!teamId) throw new ValidationError('Pick a team for the team board');
    return { mine: false, teamId, assigneeId: null };
  }
  if (q.scope === 'assignee') {
    if (!q.assigneeId) throw new ValidationError('Pick an engineer for the engineer board');
    return { mine: false, teamId: null, assigneeId: q.assigneeId };
  }
  return { mine: false, teamId: null, assigneeId: null };
}

const minutesSince = (d: Date, now: Date) => Math.max(0, Math.round((now.getTime() - d.getTime()) / 60_000));

// ---------------------------------------------------------------- lanes

export interface BoardLane {
  /** Status option id, user id, task status key, or `unassigned`. */
  key: string;
  label: string;
  kind: 'status' | 'assignee';
  /** Option colour for status lanes, null for people. */
  color: string | null;
  /** status_category for ticket status lanes. */
  category: string | null;
  /** The option key (`in_progress`, ...) for status lanes. */
  statusKey: string | null;
  /** Cards in the lane. */
  count: number;
  /** Cards in the new/open/pending categories (open or in-progress tasks). */
  open: number;
  /** Cards whose SLA is breached. */
  breached: number;
  /** Assignee lanes: the platform WIP limit (null when 0). */
  limit: number | null;
  /** open > limit */
  over: boolean;
}

/** One counted group: the exact figures come from a grouped query when the cards are capped, from the cards themselves otherwise. */
interface Figure {
  statusKey: string;
  assigneeId: string | null;
  open: boolean;
  n: number;
  breached: number;
  /** Due within the next four hours (an open SLA metric, or the record's own due date). */
  dueSoon: number;
  /** Tasks past their due date while still open or in progress. */
  overdue: number;
}

const sumBy = (figures: Figure[], pick: (f: Figure) => boolean) => figures.filter(pick).reduce((acc, f) => ({ count: acc.count + f.n, open: acc.open + (f.open ? f.n : 0), breached: acc.breached + f.breached }), { count: 0, open: 0, breached: 0 });
const total = (figures: Figure[], pick: (f: Figure) => number) => figures.reduce((s, f) => s + pick(f), 0);

/** SQL twin of the card rule for tickets: an open SLA metric due within four hours, or, for a ticket without open metrics, its own due date. */
const ticketDueSoonSql = sql`(EXISTS (SELECT 1 FROM ticket_slas s WHERE s.ticket_id = tickets.id AND s.state IN ('running', 'paused') AND s.due_at > now() AND s.due_at <= now() + interval '4 hours') OR (NOT EXISTS (SELECT 1 FROM ticket_slas s WHERE s.ticket_id = tickets.id AND s.completed_at IS NULL) AND tickets.due_at > now() AND tickets.due_at <= now() + interval '4 hours'))`;

async function teamMembers(tx: Tx, teamId: string): Promise<{ id: string; name: string }[]> {
  return tx
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.teamMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.teamMembers.userId))
    .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.users.userType, 'msp'), eq(schema.users.status, 'active')))
    .orderBy(asc(schema.users.name));
}

/**
 * Unassigned first, then the team's members (team scope), then anyone else who holds a card, by name.
 * One person's board (my board, one engineer) holds nothing unassigned by definition, so that lane is left out.
 */
async function assigneeLanes(tx: Tx, scope: Scope, figures: Figure[], people: Map<string, string>, wip: number): Promise<BoardLane[]> {
  const ordered: { id: string | null; name: string }[] = scope.mine || scope.assigneeId ? [] : [{ id: null, name: 'Unassigned' }];
  const seen = new Set<string>();
  if (scope.teamId) for (const m of await teamMembers(tx, scope.teamId)) if (!seen.has(m.id)) { seen.add(m.id); ordered.push({ id: m.id, name: m.name }); }
  const extras = [...people.entries()].filter(([id]) => !seen.has(id)).sort((a, b) => a[1].localeCompare(b[1]));
  for (const [id, name] of extras) ordered.push({ id, name });
  const limit = wip > 0 ? wip : null;
  return ordered.map(({ id, name }) => {
    const s = sumBy(figures, (f) => (f.assigneeId ?? null) === id);
    return { key: id ?? UNASSIGNED, label: name, kind: 'assignee', color: null, category: null, statusKey: null, count: s.count, open: s.open, breached: s.breached, limit: id ? limit : null, over: !!id && limit !== null && s.open > limit };
  });
}

// ---------------------------------------------------------------- ticket board

export interface TicketCard {
  id: string;
  number: string;
  type: TicketType;
  title: string;
  customerId: string;
  customerName: string | null;
  status: { id: string; key: string | null; label: string | null; color: string | null; category: string | null };
  priority: { id: string; key: string | null; label: string | null; color: string | null; level: number | null } | null;
  assigneeId: string | null;
  assigneeName: string | null;
  assignedTeamId: string | null;
  teamName: string | null;
  isMajor: boolean;
  escalationLevel: number;
  dueAt: Date | null;
  createdAt: Date;
  lastActivityAt: Date;
  ageMinutes: number;
  sla: SlaCompact | null;
  breachRisk: { level: RiskLevel; score: number; reason: string } | null;
  /** The status option's own pauses_sla flag (a hint; the SLA indicator is the truth). */
  pausesSla: boolean;
  tasks: { total: number; done: number } | null;
  /** The lane key this card sits in for the requested lanes mode. */
  lane: string;
  can: { update: boolean; assign: boolean; resolve: boolean };
}

export interface TicketBoard {
  generatedAt: Date;
  board: 'tickets';
  scope: TicketBoardQuery['scope'];
  lanesBy: TicketBoardQuery['lanes'];
  lanes: BoardLane[];
  cards: TicketCard[];
  total: number;
  truncated: boolean;
  /** Open tickets due within the next four hours (an open SLA metric or the ticket's own due date); exact even when the cards are capped. */
  dueSoon: number;
  /** Status option ids that apply per ticket type, so the web can grey lanes while dragging. */
  statusesByType: Record<TicketType, string[]>;
  settings: { wipDefaultLimit: number; cardLimit: number };
}

export async function ticketBoard(ctx: Ctx, q: TicketBoardQuery): Promise<TicketBoard> {
  staffOnly(ctx);
  ctx.require('tickets:read');
  const now = new Date();
  const settings = await loadBoardSettings(ctx.tx);
  const scope = resolveScope(ctx, q);
  const list = listQuerySchema.parse({
    page: 1,
    pageSize: settings.cardLimit,
    sort: 'lastActivityAt',
    order: 'desc',
    type: q.type,
    customerId: q.customerId,
    priorityId: q.priorityId,
    q: q.q,
    statusCategory: q.includeClosed ? undefined : 'new,open,pending,resolved',
    mine: scope.mine ? 'true' : undefined,
    teamId: scope.teamId ?? undefined,
    assigneeId: scope.assigneeId ?? undefined,
  });
  const res = await listTickets(ctx, list);
  const truncated = res.total > res.items.length;

  const options = (await optionsOfType(ctx.tx, 'ticket_status')).filter((o) => o.isActive);
  const optionById = new Map(options.map((o) => [o.id, o]));
  const statusesByType = Object.fromEntries(TICKET_TYPES.map((t) => [t, options.filter((o) => statusApplies(o, t)).map((o) => o.id)])) as Record<TicketType, string[]>;

  // Task progress per card, one grouped query.
  const ids = res.items.map((r) => r.id);
  const taskRows = ids.length
    ? await ctx.tx
        .select({ ticketId: K.ticketId, total: sql<number>`count(*) FILTER (WHERE ${K.status} <> 'cancelled')::int`, done: sql<number>`count(*) FILTER (WHERE ${K.status} = 'done')::int` })
        .from(K)
        .where(inArray(K.ticketId, ids))
        .groupBy(K.ticketId)
    : [];
  const tasksOf = new Map(taskRows.map((r) => [r.ticketId, { total: r.total, done: r.done }]));

  const cards: TicketCard[] = res.items.map((r) => ({
    id: r.id,
    number: r.number,
    type: r.type,
    title: r.title,
    customerId: r.customerId,
    customerName: r.customerName,
    status: r.status,
    priority: r.priority,
    assigneeId: r.assigneeId,
    assigneeName: r.assigneeName,
    assignedTeamId: r.assignedTeamId,
    teamName: r.teamName,
    isMajor: r.isMajor,
    escalationLevel: r.escalationLevel,
    dueAt: r.dueAt,
    createdAt: r.createdAt,
    lastActivityAt: r.lastActivityAt,
    ageMinutes: minutesSince(r.createdAt, now),
    sla: r.sla,
    breachRisk: r.breachRisk,
    pausesSla: optionById.get(r.status.id)?.pausesSla ?? false,
    tasks: tasksOf.get(r.id) ?? null,
    lane: q.lanes === 'status' ? r.status.id : r.assigneeId ?? UNASSIGNED,
    can: { update: ctx.can('tickets:update', r.customerId), assign: ctx.can('tickets:assign', r.customerId), resolve: ctx.can('tickets:resolve', r.customerId) },
  }));

  // Exact lane figures: the cards are capped at the card limit, so a busy board counts from a grouped query over the same predicates.
  let figures: Figure[];
  if (truncated) {
    const where = buildWhere(ctx, list);
    const rows = await ctx.tx
      .select({ statusId: T.statusId, assigneeId: T.assigneeId, n: sql<number>`count(*)::int`, breached: sql<number>`count(*) FILTER (WHERE ${slaStateFilterSql.breached})::int`, dueSoon: sql<number>`count(*) FILTER (WHERE ${ticketDueSoonSql})::int` })
      .from(T)
      .where(where)
      .groupBy(T.statusId, T.assigneeId);
    figures = rows.map((r) => {
      const open = OPEN_CATEGORIES.has(optionById.get(r.statusId)?.statusCategory ?? '');
      return { statusKey: r.statusId, assigneeId: r.assigneeId, open, n: r.n, breached: r.breached, dueSoon: open ? r.dueSoon : 0, overdue: 0 };
    });
  } else {
    figures = cards.map((c) => {
      const open = OPEN_CATEGORIES.has(c.status.category ?? '');
      return { statusKey: c.status.id, assigneeId: c.assigneeId, open, n: 1, breached: c.sla?.breached ? 1 : 0, dueSoon: open && isDueSoon(c.sla?.dueAt ?? c.dueAt, now) ? 1 : 0, overdue: 0 };
    });
  }

  let lanes: BoardLane[];
  if (q.lanes === 'status') {
    const types: TicketType[] = q.type ? [q.type] : [...TICKET_TYPES];
    const laneOptions = options.filter((o) => types.some((t) => statusApplies(o, t)) && (q.includeClosed || !['closed', 'cancelled'].includes(o.statusCategory ?? '')));
    lanes = laneOptions.map((o) => statusLane(o, sumBy(figures, (f) => f.statusKey === o.id)));
  } else {
    const people = new Map<string, string>();
    for (const c of cards) if (c.assigneeId && c.assigneeName) people.set(c.assigneeId, c.assigneeName);
    if (truncated) for (const [id, name] of await namesOf(ctx.tx, figures.map((f) => f.assigneeId).filter((x): x is string => !!x && !people.has(x)))) people.set(id, name);
    lanes = await assigneeLanes(ctx.tx, scope, figures, people, settings.wipDefaultLimit);
  }

  return { generatedAt: now, board: 'tickets', scope: q.scope, lanesBy: q.lanes, lanes, cards, total: res.total, truncated, dueSoon: total(figures, (f) => f.dueSoon), statusesByType, settings: { wipDefaultLimit: settings.wipDefaultLimit, cardLimit: settings.cardLimit } };
}

const statusLane = (o: OptionRow, s: { count: number; open: number; breached: number }): BoardLane => ({ key: o.id, label: o.label, kind: 'status', color: o.color ?? null, category: o.statusCategory ?? null, statusKey: o.key, count: s.count, open: OPEN_CATEGORIES.has(o.statusCategory ?? '') ? s.count : 0, breached: s.breached, limit: null, over: false });

async function namesOf(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  const clean = [...new Set(ids)];
  if (!clean.length) return new Map();
  const rows = await tx.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, clean));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ---------------------------------------------------------------- task board

export interface TaskCard {
  id: string;
  ticketId: string;
  ticketNumber: string;
  ticketType: TicketType;
  ticketTitle: string;
  customerId: string;
  customerName: string | null;
  title: string;
  /** Truncated to 200 characters. */
  description: string | null;
  status: TaskStatus;
  assigneeId: string | null;
  assigneeName: string | null;
  teamId: string | null;
  teamName: string | null;
  dueAt: Date | null;
  completedAt: Date | null;
  sortOrder: number;
  createdAt: Date;
  ageMinutes: number;
  /** dueAt in the past while the task is still open or in progress. */
  overdue: boolean;
  ticketPriority: TicketCard['priority'];
  ticketStatus: TicketCard['status'];
  ticketSla: SlaCompact | null;
  lane: string;
  can: { update: boolean };
}

export interface TaskBoard {
  generatedAt: Date;
  board: 'tasks';
  scope: TaskBoardQuery['scope'];
  lanesBy: TaskBoardQuery['lanes'];
  lanes: BoardLane[];
  cards: TaskCard[];
  total: number;
  truncated: boolean;
  /** Open or in-progress tasks past their due date; exact even when the cards are capped. */
  overdue: number;
  /** Open or in-progress tasks due within the next four hours; exact even when the cards are capped. */
  dueSoon: number;
  settings: { wipDefaultLimit: number; cardLimit: number };
}

/** "Today" and "this week" are the caller's calendar days, in their own time zone. */
function taskWhere(ctx: Ctx, q: TaskBoardQuery, scope: Scope, now: Date): SQL | undefined {
  const conds: SQL[] = visibilityConds(ctx);
  if (scope.mine) conds.push(eq(K.assigneeId, ctx.user.id));
  if (scope.teamId) conds.push(or(eq(K.teamId, scope.teamId), and(isNull(K.teamId), eq(T.assignedTeamId, scope.teamId)))!);
  if (scope.assigneeId) conds.push(eq(K.assigneeId, scope.assigneeId));
  if (q.customerId) {
    ctx.requireCustomer(q.customerId);
    conds.push(eq(T.customerId, q.customerId));
  }
  if (q.q?.trim()) {
    const pattern = like(q.q);
    conds.push(or(ilike(K.title, pattern), ilike(T.number, pattern), ilike(T.title, pattern))!);
  }
  if (q.due === 'overdue') conds.push(lt(K.dueAt, now), inArray(K.status, ['open', 'in_progress']));
  else if (q.due === 'today') conds.push(lt(K.dueAt, localDayEnd(now, ctx.user.timezone, 1)));
  else if (q.due === 'week') conds.push(lt(K.dueAt, localDayEnd(now, ctx.user.timezone, 7)));
  if (!q.includeDone) conds.push(or(inArray(K.status, ['open', 'in_progress']), and(eq(K.status, 'done'), gte(K.completedAt, new Date(now.getTime() - DONE_WINDOW_DAYS * 86_400_000))))!);
  return conds.length ? and(...conds) : undefined;
}

const TASK_RANK: Record<string, number> = { open: 0, in_progress: 1, done: 2, cancelled: 3 };
/** Lane order: status, the person's sort order, the earliest due date (none last), then age. */
const taskOrder = (a: { status: string; sortOrder: number; dueAt: Date | null; createdAt: Date }, b: { status: string; sortOrder: number; dueAt: Date | null; createdAt: Date }): number =>
  (TASK_RANK[a.status] ?? 3) - (TASK_RANK[b.status] ?? 3) || a.sortOrder - b.sortOrder || (a.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) || a.createdAt.getTime() - b.createdAt.getTime();
const taskOverdueSql = sql`${K.dueAt} < now() AND ${K.status} IN ('open', 'in_progress')`;
const taskDueSoonSql = sql`${K.dueAt} > now() AND ${K.dueAt} <= now() + interval '4 hours' AND ${K.status} IN ('open', 'in_progress')`;

export async function taskBoard(ctx: Ctx, q: TaskBoardQuery): Promise<TaskBoard> {
  staffOnly(ctx);
  ctx.require('tickets:read');
  const now = new Date();
  const settings = await loadBoardSettings(ctx.tx);
  const scope = resolveScope(ctx, q);
  const where = taskWhere(ctx, q, scope, now);
  const rows = await ctx.tx
    .select({
      id: K.id,
      ticketId: K.ticketId,
      ticketNumber: T.number,
      ticketType: T.type,
      ticketTitle: T.title,
      customerId: T.customerId,
      customerName: schema.customers.name,
      title: K.title,
      description: K.description,
      status: K.status,
      assigneeId: K.assigneeId,
      assigneeName: assignee.name,
      teamId: K.teamId,
      teamName: schema.teams.name,
      dueAt: K.dueAt,
      completedAt: K.completedAt,
      sortOrder: K.sortOrder,
      createdAt: K.createdAt,
      statusId: T.statusId,
      statusKey: st.key,
      statusLabel: st.label,
      statusColor: st.color,
      statusCategory: st.statusCategory,
      priorityId: T.priorityId,
      priorityKey: pr.key,
      priorityLabel: pr.label,
      priorityColor: pr.color,
      priorityLevel: pr.level,
    })
    .from(K)
    .innerJoin(T, eq(T.id, K.ticketId))
    .leftJoin(st, eq(st.id, T.statusId))
    .leftJoin(pr, eq(pr.id, T.priorityId))
    .leftJoin(schema.customers, eq(schema.customers.id, T.customerId))
    .leftJoin(assignee, eq(assignee.id, K.assigneeId))
    .leftJoin(schema.teams, eq(schema.teams.id, K.teamId))
    .where(where)
    // The cap keeps the most recently active tasks across every lane; the lanes then order their cards in memory.
    .orderBy(desc(K.updatedAt), desc(K.createdAt))
    .limit(settings.cardLimit + 1);
  const truncated = rows.length > settings.cardLimit;
  const kept = (truncated ? rows.slice(0, settings.cardLimit) : rows).sort(taskOrder);
  const slas = await slaSummariesFor(ctx.tx, [...new Set(kept.map((r) => r.ticketId))]);
  const cards: TaskCard[] = kept.map((r) => {
    const status = r.status as TaskStatus;
    return {
      id: r.id,
      ticketId: r.ticketId,
      ticketNumber: r.ticketNumber,
      ticketType: r.ticketType,
      ticketTitle: r.ticketTitle,
      customerId: r.customerId,
      customerName: r.customerName,
      title: r.title,
      description: r.description ? (r.description.length > 200 ? `${r.description.slice(0, 200)}…` : r.description) : null,
      status,
      assigneeId: r.assigneeId,
      assigneeName: r.assigneeName,
      teamId: r.teamId,
      teamName: r.teamName,
      dueAt: r.dueAt,
      completedAt: r.completedAt,
      sortOrder: r.sortOrder,
      createdAt: r.createdAt,
      ageMinutes: minutesSince(r.createdAt, now),
      overdue: !!r.dueAt && r.dueAt.getTime() < now.getTime() && TASK_OPEN.has(status),
      ticketPriority: r.priorityId ? { id: r.priorityId, key: r.priorityKey, label: r.priorityLabel, color: r.priorityColor, level: r.priorityLevel } : null,
      ticketStatus: { id: r.statusId, key: r.statusKey, label: r.statusLabel, color: r.statusColor, category: r.statusCategory },
      ticketSla: worstSla(slas.get(r.ticketId)),
      lane: q.lanes === 'status' ? status : r.assigneeId ?? UNASSIGNED,
      can: { update: ctx.can('tickets:update', r.customerId) },
    };
  });

  let figures: Figure[];
  if (truncated) {
    const grouped = await ctx.tx
      .select({ status: K.status, assigneeId: K.assigneeId, n: sql<number>`count(*)::int`, breached: sql<number>`count(*) FILTER (WHERE ${slaStateFilterSql.breached})::int`, dueSoon: sql<number>`count(*) FILTER (WHERE ${taskDueSoonSql})::int`, overdue: sql<number>`count(*) FILTER (WHERE ${taskOverdueSql})::int` })
      .from(K)
      .innerJoin(T, eq(T.id, K.ticketId))
      .where(where)
      .groupBy(K.status, K.assigneeId);
    figures = grouped.map((r) => ({ statusKey: r.status, assigneeId: r.assigneeId, open: TASK_OPEN.has(r.status), n: r.n, breached: r.breached, dueSoon: r.dueSoon, overdue: r.overdue }));
  } else {
    figures = cards.map((c) => ({ statusKey: c.status, assigneeId: c.assigneeId, open: TASK_OPEN.has(c.status), n: 1, breached: c.ticketSla?.breached ? 1 : 0, dueSoon: TASK_OPEN.has(c.status) && isDueSoon(c.dueAt, now) ? 1 : 0, overdue: c.overdue ? 1 : 0 }));
  }
  const totalCards = total(figures, (f) => f.n);

  let lanes: BoardLane[];
  if (q.lanes === 'status') {
    lanes = TASK_LANES.filter((l) => q.includeDone || l.key !== 'cancelled').map((l) => {
      const s = sumBy(figures, (f) => f.statusKey === l.key);
      return { key: l.key, label: l.label, kind: 'status', color: null, category: null, statusKey: l.key, count: s.count, open: TASK_OPEN.has(l.key) ? s.count : 0, breached: s.breached, limit: null, over: false };
    });
  } else {
    const people = new Map<string, string>();
    for (const c of cards) if (c.assigneeId && c.assigneeName) people.set(c.assigneeId, c.assigneeName);
    if (truncated) for (const [id, name] of await namesOf(ctx.tx, figures.map((f) => f.assigneeId).filter((x): x is string => !!x && !people.has(x)))) people.set(id, name);
    lanes = await assigneeLanes(ctx.tx, scope, figures, people, settings.wipDefaultLimit);
  }

  return { generatedAt: now, board: 'tasks', scope: q.scope, lanesBy: q.lanes, lanes, cards, total: totalCards, truncated, overdue: total(figures, (f) => f.overdue), dueSoon: total(figures, (f) => f.dueSoon), settings: { wipDefaultLimit: settings.wipDefaultLimit, cardLimit: settings.cardLimit } };
}

// ---------------------------------------------------------------- reorder

/** Moves and reorders tasks in one request: each item under its own savepoint, so one refusal never undoes the others. */
export async function reorderTasks(ctx: Ctx, items: ReorderItem[]): Promise<{ ok: true; updated: number; failed: { taskId: string; error: string }[] }> {
  staffOnly(ctx);
  ctx.require('tickets:update');
  const failed: { taskId: string; error: string }[] = [];
  let updated = 0;
  for (const [i, item] of items.entries()) {
    const sp = sql.raw(`board_reorder_${i}`);
    await ctx.tx.execute(sql`SAVEPOINT ${sp}`);
    try {
      await updateTask(ctx, item.ticketId, item.taskId, { status: item.status, sortOrder: item.sortOrder });
      await ctx.tx.execute(sql`RELEASE SAVEPOINT ${sp}`);
      updated++;
    } catch (err) {
      await ctx.tx.execute(sql`ROLLBACK TO SAVEPOINT ${sp}`);
      failed.push({ taskId: item.taskId, error: (err as Error).message });
    }
  }
  return { ok: true, updated, failed };
}

// ---------------------------------------------------------------- sticky notes

export type NoteRow = typeof schema.boardNotes.$inferSelect;
const N = schema.boardNotes;

function notesGuard(ctx: Ctx) {
  staffOnly(ctx);
  ctx.require('tickets:read');
}

export async function listNotes(ctx: Ctx, q: NoteListQuery): Promise<{ items: NoteRow[] }> {
  notesGuard(ctx);
  const conds: SQL[] = [eq(N.userId, ctx.user.id), eq(N.board, q.board)];
  conds.push(q.teamId ? eq(N.teamId, q.teamId) : isNull(N.teamId));
  if (!q.includeDone) conds.push(eq(N.done, false));
  const items = await ctx.tx.select().from(N).where(and(...conds)).orderBy(desc(N.pinned), asc(N.done), asc(N.sortOrder), desc(N.createdAt));
  return { items };
}

async function loadNote(ctx: Ctx, id: string): Promise<NoteRow> {
  const [row] = await ctx.tx.select().from(N).where(and(eq(N.id, id), eq(N.userId, ctx.user.id))).limit(1);
  if (!row) throw new NotFoundError('Note');
  return row;
}

export async function createNote(ctx: Ctx, input: NoteInput): Promise<NoteRow> {
  notesGuard(ctx);
  const teamId = input.teamId ?? null;
  if (teamId) {
    const [team] = await ctx.tx.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.id, teamId)).limit(1);
    if (!team) throw new ValidationError('Unknown team');
  }
  const [row] = await ctx.tx
    .insert(N)
    .values({ userId: ctx.user.id, teamId, board: input.board as BoardKind, body: input.body, color: input.color, pinned: input.pinned, shiftDate: localDay(new Date(), ctx.user.timezone) })
    .returning();
  await ctx.audit({ entityType: 'board_note', entityId: row!.id, action: 'create', metadata: { board: input.board, teamId } });
  return row!;
}

export async function updateNote(ctx: Ctx, id: string, patch: NotePatch): Promise<NoteRow> {
  notesGuard(ctx);
  const before = await loadNote(ctx, id);
  const values: Partial<typeof N.$inferInsert> = { updatedAt: new Date() };
  if (patch.body !== undefined) values.body = patch.body;
  if (patch.color !== undefined) values.color = patch.color;
  if (patch.pinned !== undefined) values.pinned = patch.pinned;
  if (patch.done !== undefined && patch.done !== before.done) {
    values.done = patch.done;
    values.doneAt = patch.done ? new Date() : null;
  }
  if (patch.sortOrder !== undefined) values.sortOrder = patch.sortOrder;
  const [row] = await ctx.tx.update(N).set(values).where(eq(N.id, before.id)).returning();
  return row!;
}

export async function deleteNote(ctx: Ctx, id: string): Promise<{ ok: true }> {
  notesGuard(ctx);
  const row = await loadNote(ctx, id);
  await ctx.tx.delete(N).where(eq(N.id, row.id));
  await ctx.audit({ entityType: 'board_note', entityId: row.id, action: 'delete', metadata: { board: row.board, teamId: row.teamId } });
  return { ok: true };
}

/** Nightly: removes notes marked done more than `boards.note_retention_days` ago (counted from when they were marked done). Runs under the system context. */
export async function purgeDoneNotes(now = new Date()): Promise<{ deleted: number }> {
  return withSystem(async (tx) => {
    const settings = await loadBoardSettings(tx);
    const cutoff = new Date(now.getTime() - settings.noteRetentionDays * 86_400_000);
    const rows = await tx.delete(N).where(and(eq(N.done, true), sql`coalesce(${N.doneAt}, ${N.updatedAt}) < ${cutoff}`)).returning({ id: N.id });
    return { deleted: rows.length };
  });
}

// ---------------------------------------------------------------- handover panel

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
    publishedAt: Date | null;
    acknowledgedByName: string | null;
    acknowledgedAt: Date | null;
    acknowledgementNote: string | null;
    /** The "Watch first" section of the note (the whole note when it has none), up to 600 characters. */
    watchFirst: string;
    body: string;
  } | null;
}

/** The handover picture for one team as the board panel and the Grady tools show it: composed from the handover module's own reads. */
export async function handoverPanel(ctx: Ctx, teamId: string): Promise<HandoverPanel> {
  staffOnly(ctx);
  ctx.require('tickets:read');
  const teams = await handover.listTeams(ctx);
  const team = teams.items.find((t) => t.id === teamId);
  if (!team) throw new NotFoundError('Team');
  const latest = team.latest ? await handover.get(ctx, team.latest.id) : null;
  const isMember = ctx.user.teams.some((t) => t.id === teamId);
  const canAcknowledge = !!latest && ctx.can('handover:write') && latest.status === 'final' && latest.authorId !== ctx.user.id && (isMember || ctx.can('oncall:manage'));
  return {
    team: { id: team.id, name: team.name },
    current: team.current ? { id: team.current.id, name: team.current.name, endsAt: team.current.endsAt.toISOString() } : null,
    next: team.next ? { id: team.next.id, name: team.next.name, startsAt: team.next.startsAt.toISOString() } : null,
    unacknowledged: team.unacknowledged,
    canWrite: team.canWrite,
    canAcknowledge,
    latest: latest
      ? {
          id: latest.id,
          status: latest.status as 'draft' | 'final' | 'acknowledged',
          shiftDate: latest.shiftDate,
          shiftName: latest.shiftName ?? null,
          authorId: latest.authorId,
          authorName: latest.authorName,
          publishedAt: latest.publishedAt,
          acknowledgedByName: latest.acknowledgedByName,
          acknowledgedAt: latest.acknowledgedAt,
          acknowledgementNote: latest.acknowledgementNote,
          watchFirst: handover.excerpt(latest.body),
          body: latest.body,
        }
      : null,
  };
}
