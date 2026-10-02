import { eq, and, inArray, asc, desc, or, ilike, ne } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ForbiddenError, NotFoundError, ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { markResponded } from '@/modules/sla/engine';
import { type TicketRow, addActivity, actorOf, isCustomerUser, loadTicket, loadTicketByNumber, reloadTicket, requireAction, requireRead, userIdOf, optionMap, toLabel } from './common';
import { notifyTicketEvent } from './notify';

// ---------------------------------------------------------------- comments

export interface CommentInput {
  kind: 'comment' | 'work_note' | 'resolution';
  body: string;
  minutesSpent?: number | null;
  workType?: string;
  billable?: boolean;
}

export async function addComment(ctx: Ctx, ticketId: string, input: CommentInput) {
  const t = await loadTicket(ctx, ticketId);
  const customer = isCustomerUser(ctx);
  const kind = customer ? 'comment' : input.kind;
  if (kind === 'work_note') requireAction(ctx, t, 'tickets:work_notes');
  else requireAction(ctx, t, 'tickets:comment', 'portal:tickets');
  if (!customer && input.minutesSpent) ctx.require('tickets:time', t.customerId);
  const now = new Date();
  const [comment] = await ctx.tx
    .insert(schema.ticketComments)
    .values({ ticketId: t.id, customerId: t.customerId, authorId: userIdOf(ctx), authorName: ctx.user.name, kind, isInternal: kind === 'work_note', body: input.body, source: ctx.source, minutesSpent: customer ? null : (input.minutesSpent ?? null), createdAt: now })
    .returning();
  const patch: Partial<typeof schema.tickets.$inferInsert> = { lastActivityAt: now, updatedAt: now };
  let responded = false;
  if (!customer && kind !== 'work_note' && !t.firstResponseAt) {
    patch.firstResponseAt = now;
    if (!t.acknowledgedAt) patch.acknowledgedAt = now;
    responded = true;
  }
  await ctx.tx.update(schema.tickets).set(patch).where(eq(schema.tickets.id, t.id));
  const updated = await reloadTicket(ctx.tx, t.id);
  if (responded) {
    await markResponded(ctx.tx, updated, actorOf(ctx), now);
    await addActivity(ctx, t, { type: 'sla', summary: 'First response recorded', data: { commentId: comment.id }, customerVisible: false });
  }
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: kind === 'work_note' ? 'ticket.work_note' : 'ticket.comment', customerId: t.customerId, metadata: { commentId: comment.id, kind, minutesSpent: comment.minutesSpent } });
  if (!customer && input.minutesSpent) await addTimeEntry(ctx, t.id, { minutes: input.minutesSpent, description: input.body.slice(0, 200), workType: (input.workType as 'remote' | 'onsite' | 'travel' | 'other') ?? 'remote', billable: input.billable ?? false }, { silent: true });
  if (kind !== 'work_note') await notifyTicketEvent(ctx, customer ? 'ticket.customer_comment' : 'ticket.engineer_comment', updated, { comment: input.body });
  return comment;
}

export async function editComment(ctx: Ctx, ticketId: string, commentId: string, body: string) {
  const t = await loadTicket(ctx, ticketId);
  const [c] = await ctx.tx.select().from(schema.ticketComments).where(and(eq(schema.ticketComments.id, commentId), eq(schema.ticketComments.ticketId, t.id))).limit(1);
  if (!c) throw new NotFoundError('Comment');
  if (c.authorId !== ctx.user.id) throw new ForbiddenError('Only the author can edit a comment');
  if (c.isInternal && isCustomerUser(ctx)) throw new ForbiddenError();
  const [updated] = await ctx.tx.update(schema.ticketComments).set({ body, editedAt: new Date() }).where(eq(schema.ticketComments.id, c.id)).returning();
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'ticket.comment_edit', customerId: t.customerId, metadata: { commentId: c.id }, changes: { body: { old: c.body, new: body } } });
  return updated;
}

export async function listComments(ctx: Ctx, ticketId: string) {
  const t = await loadTicket(ctx, ticketId);
  const conds = [eq(schema.ticketComments.ticketId, t.id)];
  if (isCustomerUser(ctx)) conds.push(eq(schema.ticketComments.isInternal, false));
  return ctx.tx.select().from(schema.ticketComments).where(and(...conds)).orderBy(asc(schema.ticketComments.createdAt));
}

// ---------------------------------------------------------------- timeline

export interface TimelineItem {
  id: string;
  kind: 'comment' | 'activity';
  createdAt: Date;
  actorId: string | null;
  actorName: string | null;
  /** comments: comment | work_note | resolution; activities: activity type */
  type: string;
  body?: string;
  summary?: string;
  data?: Record<string, unknown>;
  isInternal: boolean;
  customerVisible: boolean;
  minutesSpent?: number | null;
  editedAt?: Date | null;
  source?: string;
}

export async function timeline(ctx: Ctx, ticketId: string): Promise<{ items: TimelineItem[] }> {
  const t = await loadTicket(ctx, ticketId);
  const customer = isCustomerUser(ctx);
  const comments = await ctx.tx.select().from(schema.ticketComments).where(customer ? and(eq(schema.ticketComments.ticketId, t.id), eq(schema.ticketComments.isInternal, false)) : eq(schema.ticketComments.ticketId, t.id));
  const activities = await ctx.tx.select().from(schema.ticketActivities).where(customer ? and(eq(schema.ticketActivities.ticketId, t.id), eq(schema.ticketActivities.customerVisible, true)) : eq(schema.ticketActivities.ticketId, t.id));
  const items: TimelineItem[] = [
    ...comments.map((c): TimelineItem => ({ id: c.id, kind: 'comment', createdAt: c.createdAt, actorId: c.authorId, actorName: c.authorName, type: c.kind, body: c.body, isInternal: c.isInternal, customerVisible: !c.isInternal, minutesSpent: c.minutesSpent, editedAt: c.editedAt, source: c.source })),
    ...activities.map((a): TimelineItem => ({ id: a.id, kind: 'activity', createdAt: a.createdAt, actorId: a.actorId, actorName: a.actorName, type: a.activityType, summary: a.summary, data: a.data, isInternal: !a.customerVisible, customerVisible: a.customerVisible })),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.kind === 'activity' ? -1 : 1));
  return { items };
}

// ---------------------------------------------------------------- links

export async function addLink(ctx: Ctx, ticketId: string, input: { targetTicketId?: string; targetNumber?: string; linkType: string }) {
  const t = await loadTicket(ctx, ticketId);
  requireAction(ctx, t, 'tickets:update');
  const target = input.targetTicketId ? await loadTicket(ctx, input.targetTicketId) : await loadTicketByNumber(ctx, input.targetNumber!);
  if (target.id === t.id) throw new ValidationError('A ticket cannot be linked to itself');
  if (target.customerId !== t.customerId) throw new ValidationError('Linked tickets must belong to the same customer');
  if (input.linkType === 'problem_of' && target.type !== 'problem') throw new ValidationError('"problem_of" links must point to a problem record');
  if (input.linkType === 'change_for' && t.type !== 'change') throw new ValidationError('"change_for" links can only be created from a change');
  const [link] = await ctx.tx.insert(schema.ticketLinks).values({ sourceTicketId: t.id, targetTicketId: target.id, customerId: t.customerId, linkType: input.linkType, createdBy: userIdOf(ctx) }).onConflictDoNothing().returning();
  if (!link) throw new ValidationError('This link already exists');
  await addActivity(ctx, t, { type: 'link', summary: `Linked to ${target.number} (${input.linkType.replace(/_/g, ' ')})`, data: { linkId: link.id, targetTicketId: target.id, targetNumber: target.number, linkType: input.linkType }, customerVisible: false });
  await addActivity(ctx, target, { type: 'link', summary: `Linked from ${t.number} (${input.linkType.replace(/_/g, ' ')})`, data: { linkId: link.id, sourceTicketId: t.id, sourceNumber: t.number, linkType: input.linkType }, customerVisible: false });
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'ticket.link', customerId: t.customerId, metadata: { targetTicketId: target.id, targetNumber: target.number, linkType: input.linkType } });
  return link;
}

export async function removeLink(ctx: Ctx, ticketId: string, linkId: string) {
  const t = await loadTicket(ctx, ticketId);
  requireAction(ctx, t, 'tickets:update');
  const [link] = await ctx.tx.select().from(schema.ticketLinks).where(and(eq(schema.ticketLinks.id, linkId), or(eq(schema.ticketLinks.sourceTicketId, t.id), eq(schema.ticketLinks.targetTicketId, t.id)))).limit(1);
  if (!link) throw new NotFoundError('Link');
  await ctx.tx.delete(schema.ticketLinks).where(eq(schema.ticketLinks.id, link.id));
  const otherId = link.sourceTicketId === t.id ? link.targetTicketId : link.sourceTicketId;
  const [other] = await ctx.tx.select({ number: schema.tickets.number }).from(schema.tickets).where(eq(schema.tickets.id, otherId)).limit(1);
  await addActivity(ctx, t, { type: 'link', summary: `Link to ${other?.number ?? 'ticket'} removed`, data: { linkId: link.id, linkType: link.linkType }, customerVisible: false });
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'ticket.unlink', customerId: t.customerId, metadata: { linkId: link.id, otherTicketId: otherId } });
  return { ok: true };
}

// ---------------------------------------------------------------- affected CIs / assets

export async function setCis(ctx: Ctx, ticketId: string, ciIds: string[]) {
  const t = await loadTicket(ctx, ticketId);
  requireAction(ctx, t, 'tickets:update');
  const ids = [...new Set(ciIds)];
  if (ids.length) {
    const rows = await ctx.tx.select({ id: schema.cis.id, customerId: schema.cis.customerId }).from(schema.cis).where(inArray(schema.cis.id, ids));
    if (rows.length !== ids.length || rows.some((r) => r.customerId !== t.customerId)) throw new ValidationError('One or more configuration items do not belong to the customer');
  }
  const before = await ctx.tx.select({ ciId: schema.ticketCis.ciId }).from(schema.ticketCis).where(eq(schema.ticketCis.ticketId, t.id));
  await ctx.tx.delete(schema.ticketCis).where(eq(schema.ticketCis.ticketId, t.id));
  if (ids.length) await ctx.tx.insert(schema.ticketCis).values(ids.map((ciId) => ({ ticketId: t.id, ciId, customerId: t.customerId, role: ciId === t.primaryCiId ? 'primary' : 'affected' })));
  if (t.primaryCiId && !ids.includes(t.primaryCiId)) await ctx.tx.update(schema.tickets).set({ primaryCiId: ids[0] ?? null }).where(eq(schema.tickets.id, t.id));
  const names = ids.length ? await ctx.tx.select({ id: schema.cis.id, name: schema.cis.name }).from(schema.cis).where(inArray(schema.cis.id, ids)) : [];
  await addActivity(ctx, t, { type: 'ci', summary: ids.length ? `Affected CIs set: ${names.map((n) => n.name).join(', ')}` : 'Affected CIs cleared', data: { ciIds: ids, previous: before.map((b) => b.ciId) }, customerVisible: false });
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'ticket.cis', customerId: t.customerId, changes: { ciIds: { old: before.map((b) => b.ciId), new: ids } } });
  return names;
}

export async function setAssets(ctx: Ctx, ticketId: string, assetIds: string[]) {
  const t = await loadTicket(ctx, ticketId);
  requireAction(ctx, t, 'tickets:update');
  const ids = [...new Set(assetIds)];
  if (ids.length) {
    const rows = await ctx.tx.select({ id: schema.assets.id, customerId: schema.assets.customerId }).from(schema.assets).where(inArray(schema.assets.id, ids));
    if (rows.length !== ids.length || rows.some((r) => r.customerId !== t.customerId)) throw new ValidationError('One or more assets do not belong to the customer');
  }
  const before = await ctx.tx.select({ assetId: schema.ticketAssets.assetId }).from(schema.ticketAssets).where(eq(schema.ticketAssets.ticketId, t.id));
  await ctx.tx.delete(schema.ticketAssets).where(eq(schema.ticketAssets.ticketId, t.id));
  if (ids.length) await ctx.tx.insert(schema.ticketAssets).values(ids.map((assetId) => ({ ticketId: t.id, assetId, customerId: t.customerId })));
  if (t.primaryAssetId && !ids.includes(t.primaryAssetId)) await ctx.tx.update(schema.tickets).set({ primaryAssetId: ids[0] ?? null }).where(eq(schema.tickets.id, t.id));
  const names = ids.length ? await ctx.tx.select({ id: schema.assets.id, tag: schema.assets.tag, name: schema.assets.name }).from(schema.assets).where(inArray(schema.assets.id, ids)) : [];
  await addActivity(ctx, t, { type: 'ci', summary: ids.length ? `Affected assets set: ${names.map((n) => n.tag).join(', ')}` : 'Affected assets cleared', data: { assetIds: ids, previous: before.map((b) => b.assetId) }, customerVisible: false });
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'ticket.assets', customerId: t.customerId, changes: { assetIds: { old: before.map((b) => b.assetId), new: ids } } });
  return names;
}

// ---------------------------------------------------------------- tasks

export interface TaskInput {
  title: string;
  description?: string | null;
  status?: 'open' | 'in_progress' | 'done' | 'cancelled';
  assigneeId?: string | null;
  teamId?: string | null;
  dueAt?: Date | null;
  sortOrder?: number;
}

export async function listTasks(ctx: Ctx, ticketId: string) {
  const t = await loadTicket(ctx, ticketId);
  if (isCustomerUser(ctx)) return [];
  return ctx.tx.select().from(schema.ticketTasks).where(eq(schema.ticketTasks.ticketId, t.id)).orderBy(asc(schema.ticketTasks.sortOrder), asc(schema.ticketTasks.createdAt));
}

export async function createTask(ctx: Ctx, ticketId: string, input: TaskInput) {
  const t = await loadTicket(ctx, ticketId);
  requireAction(ctx, t, 'tickets:update');
  const [task] = await ctx.tx.insert(schema.ticketTasks).values({ ticketId: t.id, customerId: t.customerId, title: input.title, description: input.description ?? null, status: input.status ?? 'open', assigneeId: input.assigneeId ?? null, teamId: input.teamId ?? null, dueAt: input.dueAt ?? null, sortOrder: input.sortOrder ?? 0 }).returning();
  await addActivity(ctx, t, { type: 'task', summary: `Task added: ${task.title}`, data: { taskId: task.id }, customerVisible: false });
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'task.create', customerId: t.customerId, metadata: { taskId: task.id, title: task.title } });
  return task;
}

export async function updateTask(ctx: Ctx, ticketId: string, taskId: string, patch: Partial<TaskInput>) {
  const t = await loadTicket(ctx, ticketId);
  requireAction(ctx, t, 'tickets:update');
  const [before] = await ctx.tx.select().from(schema.ticketTasks).where(and(eq(schema.ticketTasks.id, taskId), eq(schema.ticketTasks.ticketId, t.id))).limit(1);
  if (!before) throw new NotFoundError('Task');
  const values: Partial<typeof schema.ticketTasks.$inferInsert> = { updatedAt: new Date() };
  for (const k of ['title', 'description', 'status', 'assigneeId', 'teamId', 'dueAt', 'sortOrder'] as const) if (patch[k] !== undefined) (values as Record<string, unknown>)[k] = patch[k];
  if (patch.status === 'done' && before.status !== 'done') values.completedAt = new Date();
  if (patch.status && patch.status !== 'done') values.completedAt = null;
  const [task] = await ctx.tx.update(schema.ticketTasks).set(values).where(eq(schema.ticketTasks.id, before.id)).returning();
  const changes = diffChanges(before as unknown as Record<string, unknown>, values as Record<string, unknown>, ['updatedAt', 'completedAt']);
  if (patch.status && patch.status !== before.status) await addActivity(ctx, t, { type: 'task', summary: `Task "${task.title}" ${patch.status.replace(/_/g, ' ')}`, data: { taskId: task.id, status: patch.status }, customerVisible: false });
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'task.update', customerId: t.customerId, metadata: { taskId: task.id }, changes });
  return task;
}

export async function deleteTask(ctx: Ctx, ticketId: string, taskId: string) {
  const t = await loadTicket(ctx, ticketId);
  requireAction(ctx, t, 'tickets:update');
  const [task] = await ctx.tx.delete(schema.ticketTasks).where(and(eq(schema.ticketTasks.id, taskId), eq(schema.ticketTasks.ticketId, t.id))).returning();
  if (!task) throw new NotFoundError('Task');
  await addActivity(ctx, t, { type: 'task', summary: `Task removed: ${task.title}`, data: { taskId: task.id }, customerVisible: false });
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'task.delete', customerId: t.customerId, metadata: { taskId: task.id, title: task.title } });
  return { ok: true };
}

// ---------------------------------------------------------------- time entries

export interface TimeEntryInput {
  minutes: number;
  description?: string | null;
  workType: 'remote' | 'onsite' | 'travel' | 'other';
  billable?: boolean;
  startedAt?: Date | null;
  entitlementId?: string | null;
  userId?: string | null;
}

export async function listTimeEntries(ctx: Ctx, ticketId: string) {
  const t = await loadTicket(ctx, ticketId);
  if (isCustomerUser(ctx)) throw new ForbiddenError();
  requireRead(ctx, t);
  const rows = await ctx.tx
    .select({ entry: schema.timeEntries, userName: schema.users.name })
    .from(schema.timeEntries)
    .leftJoin(schema.users, eq(schema.users.id, schema.timeEntries.userId))
    .where(eq(schema.timeEntries.ticketId, t.id))
    .orderBy(desc(schema.timeEntries.createdAt));
  const items = rows.map((r) => ({ ...r.entry, userName: r.userName }));
  return { items, totalMinutes: items.reduce((s, e) => s + e.minutes, 0), billableMinutes: items.filter((e) => e.billable).reduce((s, e) => s + e.minutes, 0) };
}

export async function addTimeEntry(ctx: Ctx, ticketId: string, input: TimeEntryInput, opts: { silent?: boolean } = {}) {
  const t = await loadTicket(ctx, ticketId);
  requireAction(ctx, t, 'tickets:time');
  const userId = input.userId && input.userId !== ctx.user.id ? input.userId : userIdOf(ctx);
  if (!userId) throw new ValidationError('A user is required for time entries');
  if (input.userId && input.userId !== ctx.user.id) ctx.require('tickets:assign', t.customerId);
  const [entry] = await ctx.tx
    .insert(schema.timeEntries)
    .values({ ticketId: t.id, customerId: t.customerId, userId, minutes: input.minutes, startedAt: input.startedAt ?? null, description: input.description ?? null, workType: input.workType ?? 'remote', billable: input.billable ?? false, entitlementId: input.entitlementId ?? null })
    .returning();
  let consumptionId: string | null = null;
  if (input.entitlementId) {
    const [ent] = await ctx.tx.select().from(schema.contractEntitlements).where(eq(schema.contractEntitlements.id, input.entitlementId)).limit(1);
    if (!ent || ent.customerId !== t.customerId) throw new ValidationError('Entitlement does not belong to the customer');
    const quantity = ent.unit === 'hours' ? Math.round((input.minutes / 60) * 100) / 100 : 1;
    const [cons] = await ctx.tx
      .insert(schema.entitlementConsumptions)
      .values({ entitlementId: ent.id, customerId: t.customerId, quantity: String(quantity), sourceType: 'time_entry', sourceId: entry.id, ticketId: t.id, notes: input.description ?? `${t.number}: ${input.minutes} minutes`, createdBy: userIdOf(ctx) })
      .returning();
    consumptionId = cons.id;
    await ctx.tx.update(schema.timeEntries).set({ consumptionId }).where(eq(schema.timeEntries.id, entry.id));
  }
  if (!opts.silent) await addActivity(ctx, t, { type: 'time', summary: `${input.minutes} min ${input.workType ?? 'remote'} work logged${input.description ? `: ${input.description}` : ''}`, data: { timeEntryId: entry.id, minutes: input.minutes, billable: input.billable ?? false, entitlementId: input.entitlementId ?? null }, customerVisible: false });
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'time.add', customerId: t.customerId, metadata: { timeEntryId: entry.id, minutes: input.minutes, entitlementId: input.entitlementId ?? null, consumptionId } });
  await ctx.tx.update(schema.tickets).set({ lastActivityAt: new Date() }).where(eq(schema.tickets.id, t.id));
  return { ...entry, consumptionId };
}

export async function deleteTimeEntry(ctx: Ctx, ticketId: string, entryId: string) {
  const t = await loadTicket(ctx, ticketId);
  requireAction(ctx, t, 'tickets:time');
  const [entry] = await ctx.tx.select().from(schema.timeEntries).where(and(eq(schema.timeEntries.id, entryId), eq(schema.timeEntries.ticketId, t.id))).limit(1);
  if (!entry) throw new NotFoundError('Time entry');
  if (entry.userId !== ctx.user.id) ctx.require('tickets:assign', t.customerId);
  if (entry.consumptionId) await ctx.tx.delete(schema.entitlementConsumptions).where(eq(schema.entitlementConsumptions.id, entry.consumptionId));
  await ctx.tx.delete(schema.timeEntries).where(eq(schema.timeEntries.id, entry.id));
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'time.delete', customerId: t.customerId, metadata: { timeEntryId: entry.id, minutes: entry.minutes } });
  return { ok: true };
}

// ---------------------------------------------------------------- watchers

export async function addWatcher(ctx: Ctx, ticketId: string, userId?: string) {
  const t = await loadTicket(ctx, ticketId);
  const target = userId ?? ctx.user.id;
  if (target !== ctx.user.id) requireAction(ctx, t, 'tickets:update');
  else requireAction(ctx, t, 'tickets:read', 'portal:tickets');
  const [u] = await ctx.tx.select({ id: schema.users.id, name: schema.users.name, userType: schema.users.userType, customerId: schema.users.customerId }).from(schema.users).where(eq(schema.users.id, target)).limit(1);
  if (!u) throw new NotFoundError('User');
  if (u.userType === 'customer' && u.customerId !== t.customerId) throw new ValidationError('Customer users can only watch their own tickets');
  await ctx.tx.insert(schema.ticketWatchers).values({ ticketId: t.id, userId: target, customerId: t.customerId }).onConflictDoNothing();
  await addActivity(ctx, t, { type: 'watcher', summary: `${u.name} is now watching`, data: { userId: target }, customerVisible: false });
  return listWatchers(ctx, t);
}

export async function removeWatcher(ctx: Ctx, ticketId: string, userId?: string) {
  const t = await loadTicket(ctx, ticketId);
  const target = userId ?? ctx.user.id;
  if (target !== ctx.user.id) requireAction(ctx, t, 'tickets:update');
  await ctx.tx.delete(schema.ticketWatchers).where(and(eq(schema.ticketWatchers.ticketId, t.id), eq(schema.ticketWatchers.userId, target)));
  return listWatchers(ctx, t);
}

async function listWatchers(ctx: Ctx, t: TicketRow) {
  const rows = await ctx.tx.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.ticketWatchers).innerJoin(schema.users, eq(schema.users.id, schema.ticketWatchers.userId)).where(eq(schema.ticketWatchers.ticketId, t.id));
  return { items: rows, isWatching: rows.some((r) => r.id === ctx.user.id) };
}

// ---------------------------------------------------------------- picker (link by number)

export async function lookupTickets(ctx: Ctx, q: string, customerId?: string | null, excludeId?: string | null) {
  const term = q.trim();
  if (term.length < 2) return { items: [] };
  const pattern = `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const where = [or(ilike(schema.tickets.number, pattern), ilike(schema.tickets.title, pattern))!];
  if (customerId) where.push(eq(schema.tickets.customerId, customerId));
  if (!isCustomerUser(ctx) && !ctx.can('soc:read')) where.push(ne(schema.tickets.domain, 'soc'));
  if (excludeId) where.push(ne(schema.tickets.id, excludeId));
  const rows = await ctx.tx
    .select({ id: schema.tickets.id, number: schema.tickets.number, title: schema.tickets.title, type: schema.tickets.type, statusId: schema.tickets.statusId, customerId: schema.tickets.customerId, domain: schema.tickets.domain })
    .from(schema.tickets)
    .where(and(...where))
    .orderBy(desc(schema.tickets.createdAt))
    .limit(10);
  const opts = await optionMap(ctx.tx, rows.map((r) => r.statusId));
  return { items: rows.map((r) => ({ id: r.id, number: r.number, title: r.title, type: r.type, status: toLabel(opts.get(r.statusId)) })) };
}
