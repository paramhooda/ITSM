import { eq, and, inArray, desc, lt, sql } from 'drizzle-orm';
import { schema, withSystem, type Tx } from '@/db/client';
import type { Ctx } from '@/core/context';
import { config } from '@/config';
import { NotFoundError, ValidationError } from '@/core/errors';
import { logger } from '@/core/logger';
import { enqueue } from '@/jobs/queues';
import { sha256, randomToken } from '@/lib/crypto';
import { queueNotification, type NotificationChannel, type Recipient } from '@/modules/notifications/dispatch';
import { addActivity, loadTicket, reloadTicket, requireAction, requireRead, systemCtx, userIdOf, optionById, isSystemCtx, type TicketRow } from '@/modules/tickets/common';
import { ticketLink } from '@/modules/tickets/notify';
import type { EscalationStep } from '@/db/schema/oncall';
import { pageTarget, usersLite, userMap, type UserLite } from './service';

/**
 * Paging: a ticket pages a person through an escalation policy. Each step is
 * one row; when its timeout passes without an acknowledgement the step is
 * marked escalated and the next row is created, until the policy is exhausted
 * (expired) or someone acknowledges (acked). The timeout is enforced twice:
 * a delayed job on the `paging` queue for speed and a one-minute sweep over
 * `expires_at` so a lost Redis never loses a page.
 */

export type PageRow = typeof schema.pages.$inferSelect;
export type PageSource = 'rule' | 'manual' | 'ai';

export const PAGE_EVENTS = { sent: 'page.sent', acknowledged: 'page.acknowledged', expired: 'page.expired' } as const;
/** Who hears that nobody acknowledged a page. */
const EXPIRED_ROLES = ['noc_manager', 'soc_manager', 'service_manager'];
const CLOSED = new Set(['resolved', 'closed', 'cancelled']);
const PAGE_STATUSES = ['pending', 'acked', 'escalated', 'expired', 'cancelled'] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

export const ackUrl = (token: string) => `${config.APP_URL.replace(/\/$/, '')}/api/oncall/ack/${token}`;
const jobId = (pageId: string) => `page-timeout-${pageId}`;

export interface StartPagingInput {
  policyId?: string | null;
  reason?: string | null;
  source?: PageSource;
}

async function loadPolicy(tx: Tx, id: string | null | undefined) {
  if (!id) return null;
  const [p] = await tx.select().from(schema.escalationPolicies).where(eq(schema.escalationPolicies.id, id)).limit(1);
  return p ?? null;
}

async function teamPolicyId(tx: Tx, teamId: string | null) {
  if (!teamId) return null;
  const [t] = await tx.select({ escalationPolicyId: schema.teams.escalationPolicyId }).from(schema.teams).where(eq(schema.teams.id, teamId)).limit(1);
  return t?.escalationPolicyId ?? null;
}

async function teamName(tx: Tx, id: string | null) {
  if (!id) return null;
  const [t] = await tx.select({ name: schema.teams.name }).from(schema.teams).where(eq(schema.teams.id, id)).limit(1);
  return t?.name ?? null;
}

async function pendingFor(tx: Tx, ticketId: string): Promise<PageRow | null> {
  const [row] = await tx.select().from(schema.pages).where(and(eq(schema.pages.ticketId, ticketId), eq(schema.pages.status, 'pending'))).orderBy(desc(schema.pages.createdAt)).limit(1);
  return row ?? null;
}

interface StepTargets {
  users: UserLite[];
  teamId: string | null;
  /** Human line for the activity: "Priya Nair (on call for NOC)". */
  label: string;
}

/** Resolves a step to the people it reaches. */
async function resolveStep(tx: Tx, ticket: TicketRow, step: EscalationStep): Promise<StepTargets> {
  const teamId = step.teamId ?? ticket.assignedTeamId ?? null;
  const tName = await teamName(tx, teamId);
  if (step.target === 'user') {
    const users = await usersLite(tx, [step.userId]);
    return { users, teamId, label: users[0]?.name ?? 'a person who is no longer active' };
  }
  if (step.target === 'team') {
    if (!teamId) return { users: [], teamId, label: 'the team (none assigned)' };
    const rows = await tx.select({ userId: schema.teamMembers.userId }).from(schema.teamMembers).where(eq(schema.teamMembers.teamId, teamId));
    const users = await usersLite(tx, rows.map((r) => r.userId));
    return { users, teamId, label: `every member of ${tName}` };
  }
  if (step.target === 'manager') {
    if (!teamId) return { users: [], teamId, label: 'the team manager (no team assigned)' };
    const [t] = await tx.select({ managerUserId: schema.teams.managerUserId }).from(schema.teams).where(eq(schema.teams.id, teamId)).limit(1);
    const users = await usersLite(tx, [t?.managerUserId]);
    return { users, teamId, label: users[0] ? `${users[0].name} (manager of ${tName})` : `the manager of ${tName} (none set)` };
  }
  // oncall
  if (!teamId) return { users: [], teamId, label: 'whoever is on call (no team assigned)' };
  const target = await pageTarget(tx, teamId);
  if (!target) return { users: [], teamId, label: `whoever is on call for ${tName} (nobody, and no manager)` };
  const users = await usersLite(tx, [target.userId]);
  return { users, teamId, label: target.via === 'rota' ? `${users[0]?.name} (on call for ${tName}, ${target.rotaName})` : `${users[0]?.name} (manager of ${tName}, nobody on call)` };
}

async function ticketFacts(tx: Tx, ticket: TicketRow) {
  const priority = await optionById(tx, ticket.priorityId);
  const [customer] = await tx.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, ticket.customerId)).limit(1);
  return { id: ticket.id, number: ticket.number, title: ticket.title, type: ticket.type, priority: priority?.label ?? '', customerName: customer?.name ?? '', link: ticketLink(ticket.id), isMajor: ticket.isMajor };
}

const recipientsOf = (users: UserLite[]): Recipient[] => users.map((u) => ({ userId: u.id, email: u.email, name: u.name, phone: u.phone, whatsappOptIn: u.whatsappOptIn }));

interface ChainPos {
  rootId: string | null;
  step: number;
  cycle: number;
  reason: string | null;
  source: PageSource;
  createdBy: string | null;
}

/**
 * Creates the next page row from `pos` onwards: steps nobody can be paged for are
 * recorded and skipped; when the policy (and its repeats) is exhausted the last
 * row is marked expired and the managers are told.
 */
async function runFrom(ctx: Ctx, ticket: TicketRow, policy: typeof schema.escalationPolicies.$inferSelect, pos: ChainPos): Promise<PageRow> {
  const tx = ctx.tx;
  const steps = policy.steps;
  const maxAttempts = steps.length * (policy.repeatCount + 1) + 1;
  let step = pos.step;
  let cycle = pos.cycle;
  let rootId = pos.rootId;
  let last: PageRow | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (step >= steps.length) {
      if (cycle < policy.repeatCount) {
        cycle++;
        step = 0;
      } else break;
    }
    const def = steps[step]!;
    const targets = await resolveStep(tx, ticket, def);
    const now = new Date();
    if (!targets.users.length) {
      const [row] = await tx
        .insert(schema.pages)
        .values({ ticketId: ticket.id, customerId: ticket.customerId, policyId: policy.id, rootPageId: rootId, step, cycle, targetKind: def.target, targetTeamId: targets.teamId, channels: def.channels, status: 'escalated', source: pos.source, reason: pos.reason, closedAt: now, createdBy: pos.createdBy })
        .returning();
      rootId = rootId ?? row!.id;
      last = row!;
      await addActivity(ctx, ticket, { type: 'page', summary: `Page step ${step + 1} of ${steps.length} (${policy.name}) skipped: nobody to reach for ${targets.label}`, data: { pageId: row!.id, step, cycle, skipped: true }, customerVisible: false });
      step++;
      continue;
    }
    const token = randomToken(24);
    const expiresAt = new Date(now.getTime() + def.timeoutMinutes * 60_000);
    const [row] = await tx
      .insert(schema.pages)
      .values({
        ticketId: ticket.id,
        customerId: ticket.customerId,
        policyId: policy.id,
        rootPageId: rootId,
        step,
        cycle,
        targetKind: def.target,
        targetUserId: targets.users.length === 1 ? targets.users[0]!.id : null,
        targetTeamId: targets.teamId,
        channels: def.channels,
        status: 'pending',
        source: pos.source,
        reason: pos.reason,
        ackTokenHash: sha256(token),
        expiresAt,
        createdBy: pos.createdBy,
      })
      .returning();
    rootId = rootId ?? row!.id;
    const facts = await ticketFacts(tx, ticket);
    const stepLine = `step ${step + 1} of ${steps.length}${cycle ? `, round ${cycle + 1}` : ''}`;
    const reasonLine = pos.reason ? pos.reason : `${facts.priority ? `${facts.priority} ` : ''}${facts.type} for ${facts.customerName}`;
    await queueNotification(tx, {
      event: PAGE_EVENTS.sent,
      recipients: recipientsOf(targets.users),
      data: { ticket: facts, step: step + 1, steps: steps.length, cycle: cycle + 1, reason: reasonLine, policy: policy.name, ackLink: ackUrl(token), timeoutMinutes: def.timeoutMinutes, target: targets.label, pagedBy: ctx.user.name },
      customerId: ticket.customerId,
      channels: def.channels as NotificationChannel[],
      entityType: 'ticket',
      entityId: ticket.id,
      link: `/tickets/${ticket.id}`,
      whatsappLink: ackUrl(token),
      title: `PAGE ${facts.number}: ${facts.title}`,
      body: `${reasonLine}. Acknowledge within ${def.timeoutMinutes} min: ${ackUrl(token)}`,
    });
    await enqueue('paging', 'page-timeout', { pageId: row!.id }, { delay: def.timeoutMinutes * 60_000, jobId: jobId(row!.id), attempts: 1 });
    await addActivity(ctx, ticket, { type: 'page', summary: `Paged ${targets.label}: ${stepLine} of "${policy.name}", ${def.channels.join(', ')}, acknowledge within ${def.timeoutMinutes} min`, data: { pageId: row!.id, step, cycle, channels: def.channels, expiresAt }, customerVisible: false });
    await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: 'ticket.page', customerId: ticket.customerId, metadata: { pageId: row!.id, policyId: policy.id, step, cycle, source: pos.source, targets: targets.users.map((u) => u.id) } });
    return row!;
  }
  // Exhausted: nobody acknowledged (or nobody could be paged at all).
  return expireChain(ctx, ticket, policy, rootId, last);
}

async function expireChain(ctx: Ctx, ticket: TicketRow, policy: typeof schema.escalationPolicies.$inferSelect, rootId: string | null, last: PageRow | null): Promise<PageRow> {
  const tx = ctx.tx;
  const now = new Date();
  let row = last;
  if (row) {
    [row] = await tx.update(schema.pages).set({ status: 'expired', closedAt: now, updatedAt: now }).where(eq(schema.pages.id, row.id)).returning();
  } else {
    [row] = await tx.insert(schema.pages).values({ ticketId: ticket.id, customerId: ticket.customerId, policyId: policy.id, rootPageId: rootId, step: 0, cycle: 0, targetKind: 'oncall', channels: [], status: 'expired', source: 'manual', closedAt: now }).returning();
  }
  const facts = await ticketFacts(tx, ticket);
  const { escalationRecipients } = await import('@/modules/tickets/notify');
  const recipients = await escalationRecipients(tx, ticket, { manager: true, roles: EXPIRED_ROLES });
  if (recipients.length) {
    await queueNotification(tx, {
      event: PAGE_EVENTS.expired,
      recipients,
      data: { ticket: facts, policy: policy.name, steps: policy.steps.length },
      customerId: ticket.customerId,
      channels: ['email', 'in_app', 'whatsapp'],
      entityType: 'ticket',
      entityId: ticket.id,
      link: `/tickets/${ticket.id}`,
      title: `Nobody acknowledged the page for ${facts.number}`,
      body: `Every step of "${policy.name}" timed out without an acknowledgement for ${facts.number} "${facts.title}".`,
    });
  }
  await addActivity(ctx, ticket, { type: 'page', summary: `Page expired: nobody acknowledged after every step of "${policy.name}"`, data: { pageId: row!.id, expired: true }, customerVisible: false });
  await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: 'ticket.page_expired', customerId: ticket.customerId, metadata: { pageId: row!.id, policyId: policy.id } });
  return row!;
}

/** Starts paging a ticket through a policy (the given one, else the assigned team's). One chain per ticket at a time. */
export async function startPaging(ctx: Ctx, ticket: TicketRow, input: StartPagingInput = {}): Promise<PageRow> {
  if (!isSystemCtx(ctx)) requireAction(ctx, ticket, 'tickets:escalate');
  const policyId = input.policyId ?? (await teamPolicyId(ctx.tx, ticket.assignedTeamId));
  const policy = await loadPolicy(ctx.tx, policyId);
  if (!policy) throw new ValidationError(input.policyId ? 'That escalation policy does not exist' : 'No escalation policy: pick one, or set a default policy on the assigned team');
  if (!policy.isActive) throw new ValidationError(`The policy "${policy.name}" is switched off`);
  if (!policy.steps.length) throw new ValidationError(`The policy "${policy.name}" has no steps`);
  const pending = await pendingFor(ctx.tx, ticket.id);
  if (pending) {
    const names = await userMap(ctx.tx, [pending.targetUserId]);
    throw new ValidationError(`A page is already in progress (step ${pending.step + 1}, waiting for ${names.get(pending.targetUserId ?? '')?.name ?? 'the team'})`);
  }
  return runFrom(ctx, ticket, policy, { rootId: null, step: 0, cycle: 0, reason: input.reason?.trim() || null, source: input.source ?? 'manual', createdBy: userIdOf(ctx) });
}

/** Route entry: page by ticket id. */
export async function pageTicket(ctx: Ctx, ticketId: string, input: StartPagingInput) {
  const t = await loadTicket(ctx, ticketId);
  const row = await startPaging(ctx, t, input);
  return describe(ctx.tx, row);
}

async function chainRows(tx: Tx, page: PageRow) {
  const rootId = page.rootPageId ?? page.id;
  return tx.select().from(schema.pages).where(sql`${schema.pages.id} = ${rootId} OR ${schema.pages.rootPageId} = ${rootId}`).orderBy(desc(schema.pages.createdAt));
}

/** Marks every pending row of the chain acknowledged, assigns the ticket when the policy says so and tells whoever paged. */
async function ackChain(ctx: Ctx, page: PageRow, byUserId: string | null, note?: string | null) {
  const tx = ctx.tx;
  const now = new Date();
  const rootId = page.rootPageId ?? page.id;
  const updated = await tx
    .update(schema.pages)
    .set({ status: 'acked', ackedBy: byUserId, ackedAt: now, closedAt: now, updatedAt: now })
    .where(and(sql`(${schema.pages.id} = ${rootId} OR ${schema.pages.rootPageId} = ${rootId})`, eq(schema.pages.status, 'pending')))
    .returning();
  if (!updated.length) return { acked: false as const, page };
  const ticket = await reloadTicket(tx, page.ticketId);
  const by = byUserId ? (await userMap(tx, [byUserId])).get(byUserId) : null;
  const who = by?.name ?? ctx.user.name;
  await addActivity(ctx, ticket, { type: 'page', summary: `Page acknowledged by ${who}${note ? `: ${note}` : ''}`, data: { pageId: updated[0]!.id, ackedBy: byUserId, note: note ?? null }, customerVisible: false });
  await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: 'ticket.page_ack', customerId: ticket.customerId, metadata: { pageId: updated[0]!.id, ackedBy: byUserId } });
  const policy = await loadPolicy(tx, page.policyId);
  let assigned = false;
  if (policy?.assignOnAck && byUserId && !ticket.assigneeId && (isSystemCtx(ctx) || ctx.can('tickets:assign', ticket.customerId))) {
    const { assignTicket } = await import('@/modules/tickets/service');
    await assignTicket(ctx, ticket.id, { assigneeId: byUserId, teamId: ticket.assignedTeamId ?? undefined, autoProgress: true });
    assigned = true;
  }
  const pagedBy = page.createdBy && page.createdBy !== byUserId ? await usersLite(tx, [page.createdBy]) : [];
  if (pagedBy.length) {
    const facts = await ticketFacts(tx, ticket);
    await queueNotification(tx, {
      event: PAGE_EVENTS.acknowledged,
      recipients: recipientsOf(pagedBy),
      data: { ticket: facts, ackedBy: who, note: note ?? '', assigned },
      customerId: ticket.customerId,
      channels: ['in_app', 'email'],
      entityType: 'ticket',
      entityId: ticket.id,
      link: `/tickets/${ticket.id}`,
      title: `${who} acknowledged the page for ${facts.number}`,
      body: `${who} acknowledged the page for ${facts.number} "${facts.title}"${assigned ? ' and now owns it' : ''}.`,
    });
  }
  return { acked: true as const, page: updated[0]!, assigned };
}

/** Acknowledge from inside the application (anyone who can read the ticket may take it). */
export async function acknowledgePage(ctx: Ctx, pageId: string, note?: string | null) {
  const [page] = await ctx.tx.select().from(schema.pages).where(eq(schema.pages.id, pageId)).limit(1);
  if (!page) throw new NotFoundError('Page');
  const ticket = await loadTicket(ctx, page.ticketId);
  requireRead(ctx, ticket);
  if (page.status !== 'pending') {
    const pending = (await chainRows(ctx.tx, page)).find((r) => r.status === 'pending');
    if (!pending) throw new ValidationError(page.status === 'acked' ? 'This page was already acknowledged' : 'This page is no longer waiting for an acknowledgement');
    const res = await ackChain(ctx, pending, userIdOf(ctx), note);
    return describe(ctx.tx, res.page);
  }
  const res = await ackChain(ctx, page, userIdOf(ctx), note);
  return describe(ctx.tx, res.page);
}

/** What the acknowledgement link shows before the button is pressed (number and title only). */
export async function pageByToken(token: string) {
  return withSystem(async (tx) => {
    const [page] = await tx.select().from(schema.pages).where(eq(schema.pages.ackTokenHash, sha256(token))).limit(1);
    if (!page) return null;
    const chain = await chainRows(tx, page);
    const pending = chain.find((r) => r.status === 'pending');
    const [t] = await tx.select({ number: schema.tickets.number, title: schema.tickets.title }).from(schema.tickets).where(eq(schema.tickets.id, page.ticketId)).limit(1);
    const names = await userMap(tx, [page.targetUserId, ...chain.map((r) => r.ackedBy)]);
    const acked = chain.find((r) => r.status === 'acked');
    return {
      ticket: { id: page.ticketId, number: t?.number ?? '', title: t?.title ?? '', link: ticketLink(page.ticketId) },
      target: names.get(page.targetUserId ?? '')?.name ?? null,
      status: pending ? 'pending' : acked ? 'acked' : (chain[0]?.status ?? page.status),
      ackedBy: acked ? (names.get(acked.ackedBy ?? '')?.name ?? null) : null,
      expiresAt: pending?.expiresAt ?? null,
    };
  });
}

/** Acknowledge through the link in the message: the token names the person; whichever step is pending is closed. */
export async function acknowledgeByToken(token: string) {
  return withSystem(async (tx) => {
    const [page] = await tx.select().from(schema.pages).where(eq(schema.pages.ackTokenHash, sha256(token))).limit(1);
    if (!page) throw new NotFoundError('Acknowledgement link');
    const chain = await chainRows(tx, page);
    const pending = chain.find((r) => r.status === 'pending');
    const [t] = await tx.select({ number: schema.tickets.number, title: schema.tickets.title }).from(schema.tickets).where(eq(schema.tickets.id, page.ticketId)).limit(1);
    const ticket = { id: page.ticketId, number: t?.number ?? '', title: t?.title ?? '', link: ticketLink(page.ticketId) };
    if (!pending) {
      const acked = chain.find((r) => r.status === 'acked');
      const names = await userMap(tx, [acked?.ackedBy]);
      return { status: acked ? ('acked' as const) : ('closed' as const), ackedBy: acked ? (names.get(acked.ackedBy ?? '')?.name ?? null) : null, ticket };
    }
    const ctx = systemCtx(tx, 'page-ack');
    const res = await ackChain(ctx, pending, page.targetUserId, null);
    return { status: 'acked' as const, ackedBy: (await userMap(tx, [page.targetUserId])).get(page.targetUserId ?? '')?.name ?? null, ticket, assigned: res.acked ? res.assigned : false };
  });
}

/** Cancels every pending page of a ticket (resolution, closure, or a person calling it off). */
export async function cancelPages(ctx: Ctx, ticket: TicketRow, reason: string) {
  const now = new Date();
  const rows = await ctx.tx.update(schema.pages).set({ status: 'cancelled', closedAt: now, updatedAt: now }).where(and(eq(schema.pages.ticketId, ticket.id), eq(schema.pages.status, 'pending'))).returning();
  if (!rows.length) return 0;
  await addActivity(ctx, ticket, { type: 'page', summary: `Page cancelled: ${reason}`, data: { pageIds: rows.map((r) => r.id) }, customerVisible: false });
  await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: 'ticket.page_cancel', customerId: ticket.customerId, metadata: { pageIds: rows.map((r) => r.id), reason } });
  return rows.length;
}

export async function cancelPage(ctx: Ctx, pageId: string, reason?: string | null) {
  const [page] = await ctx.tx.select().from(schema.pages).where(eq(schema.pages.id, pageId)).limit(1);
  if (!page) throw new NotFoundError('Page');
  const ticket = await loadTicket(ctx, page.ticketId);
  requireAction(ctx, ticket, 'tickets:escalate');
  await cancelPages(ctx, ticket, reason?.trim() || `called off by ${ctx.user.name}`);
  const [fresh] = await ctx.tx.select().from(schema.pages).where(eq(schema.pages.id, pageId)).limit(1);
  return describe(ctx.tx, fresh!);
}

/**
 * Job: a pending step whose timeout passed moves the chain on. Safe to call
 * for any page id; rows that are not pending, or not yet due, are left alone.
 */
export async function processTimeout(pageId: string, now = new Date()) {
  return withSystem(async (tx) => {
    const locked = await tx.execute(sql`SELECT id FROM pages WHERE id = ${pageId} FOR UPDATE`);
    if (!locked.rows.length) return 'missing' as const;
    const [page] = await tx.select().from(schema.pages).where(eq(schema.pages.id, pageId)).limit(1);
    if (!page || page.status !== 'pending') return 'not_pending' as const;
    if (page.expiresAt && page.expiresAt.getTime() > now.getTime() + 1000) return 'not_due' as const;
    const ctx = systemCtx(tx, 'page-timeout');
    const ticket = await reloadTicket(tx, page.ticketId);
    const status = await optionById(tx, ticket.statusId);
    if (status?.statusCategory && CLOSED.has(status.statusCategory)) {
      await cancelPages(ctx, ticket, `the ticket is ${status.label.toLowerCase()}`);
      return 'cancelled' as const;
    }
    const policy = await loadPolicy(tx, page.policyId);
    const names = await userMap(tx, [page.targetUserId]);
    const waited = page.expiresAt ? Math.round((page.expiresAt.getTime() - page.createdAt.getTime()) / 60_000) : null;
    const who = names.get(page.targetUserId ?? '')?.name ?? 'the team';
    const hasNext = !!policy && (page.step + 1 < policy.steps.length || page.cycle < policy.repeatCount);
    if (!policy || !hasNext) {
      // The last step: this row expires and the managers hear about it.
      await addActivity(ctx, ticket, { type: 'page', summary: `No acknowledgement from ${who}${waited ? ` within ${waited} min` : ''}`, data: { pageId: page.id, step: page.step, cycle: page.cycle }, customerVisible: false });
      if (!policy) {
        await tx.update(schema.pages).set({ status: 'expired', closedAt: now, updatedAt: now }).where(eq(schema.pages.id, page.id));
        return 'expired' as const;
      }
      await expireChain(ctx, ticket, policy, page.rootPageId ?? page.id, page);
      return 'expired' as const;
    }
    await tx.update(schema.pages).set({ status: 'escalated', closedAt: now, updatedAt: now }).where(eq(schema.pages.id, page.id));
    await addActivity(ctx, ticket, { type: 'page', summary: `No acknowledgement from ${who}${waited ? ` within ${waited} min` : ''}; escalating`, data: { pageId: page.id, step: page.step, cycle: page.cycle }, customerVisible: false });
    const next = await runFrom(ctx, ticket, policy, { rootId: page.rootPageId ?? page.id, step: page.step + 1, cycle: page.cycle, reason: page.reason, source: page.source as PageSource, createdBy: page.createdBy });
    return next.status === 'pending' ? ('escalated' as const) : ('expired' as const);
  });
}

/** Safety net (every minute): every pending page past its timeout, whatever happened to the delayed job. */
export async function sweepTimeouts(now = new Date(), limit = 100) {
  const due = await withSystem((tx) => tx.select({ id: schema.pages.id }).from(schema.pages).where(and(eq(schema.pages.status, 'pending'), lt(schema.pages.expiresAt, now))).orderBy(schema.pages.expiresAt).limit(limit));
  let processed = 0;
  for (const { id } of due) {
    try {
      const r = await processTimeout(id, now);
      if (r === 'escalated' || r === 'expired' || r === 'cancelled') processed++;
    } catch (err) {
      logger.error({ err, pageId: id }, 'page timeout failed');
    }
  }
  return processed;
}

async function describe(tx: Tx, row: PageRow) {
  const [full] = await describeMany(tx, [row]);
  return full!;
}

async function describeMany(tx: Tx, rows: PageRow[]) {
  if (!rows.length) return [];
  const names = await userMap(tx, rows.flatMap((r) => [r.targetUserId, r.ackedBy, r.createdBy]));
  const policyIds = [...new Set(rows.map((r) => r.policyId).filter((x): x is string => !!x))];
  const policies = policyIds.length ? new Map((await tx.select({ id: schema.escalationPolicies.id, name: schema.escalationPolicies.name, steps: schema.escalationPolicies.steps }).from(schema.escalationPolicies).where(inArray(schema.escalationPolicies.id, policyIds))).map((p) => [p.id, p])) : new Map<string, { id: string; name: string; steps: EscalationStep[] }>();
  const teamIds = [...new Set(rows.map((r) => r.targetTeamId).filter((x): x is string => !!x))];
  const teams = teamIds.length ? new Map((await tx.select({ id: schema.teams.id, name: schema.teams.name }).from(schema.teams).where(inArray(schema.teams.id, teamIds))).map((t) => [t.id, t.name])) : new Map<string, string>();
  const ticketIds = [...new Set(rows.map((r) => r.ticketId))];
  const tickets = new Map((await tx.select({ id: schema.tickets.id, number: schema.tickets.number, title: schema.tickets.title }).from(schema.tickets).where(inArray(schema.tickets.id, ticketIds))).map((t) => [t.id, t]));
  return rows.map((r) => {
    const { ackTokenHash: _h, ...rest } = r;
    const p = r.policyId ? policies.get(r.policyId) : undefined;
    return {
      ...rest,
      policyName: p?.name ?? null,
      steps: p?.steps.length ?? null,
      targetName: names.get(r.targetUserId ?? '')?.name ?? null,
      targetTeamName: teams.get(r.targetTeamId ?? '') ?? null,
      ackedByName: names.get(r.ackedBy ?? '')?.name ?? null,
      createdByName: names.get(r.createdBy ?? '')?.name ?? null,
      ticket: tickets.get(r.ticketId) ?? null,
    };
  });
}

export type PageView = Awaited<ReturnType<typeof describe>>;

/** Pages, newest first (RLS limits them to tickets the caller can see). */
export async function listPages(ctx: Ctx, q: { ticketId?: string | null; status?: PageStatus | 'open' | null; limit?: number } = {}) {
  ctx.require('tickets:read');
  const conds = [];
  if (q.ticketId) conds.push(eq(schema.pages.ticketId, q.ticketId));
  if (q.status === 'open') conds.push(eq(schema.pages.status, 'pending'));
  else if (q.status) conds.push(eq(schema.pages.status, q.status));
  const rows = await ctx.tx
    .select()
    .from(schema.pages)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.pages.createdAt))
    .limit(Math.min(200, Math.max(1, q.limit ?? 50)));
  return { items: await describeMany(ctx.tx, rows) };
}

export { PAGE_STATUSES };
