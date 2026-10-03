import { eq, and, asc } from 'drizzle-orm';
import type { SlaMetric } from '@itsm/shared';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { applySlas, metricLabel } from '@/modules/sla/engine';
import { type TicketRow, addActivity, actorOf, optionById, optionByKey, reloadTicket, userIdOf } from './common';
import { notifyTicketEvent, escalationRecipients } from './notify';
import { startPaging } from '@/modules/oncall/paging';
import { ValidationError } from '@/core/errors';
import { logger } from '@/core/logger';

export interface EscalationTrigger {
  kind: 'breach' | 'warning';
  metric: SlaMetric;
  pct: number;
  slaId?: string;
  dueAt?: Date | null;
}

interface RuleConditions {
  metric?: string;
  onBreach?: boolean;
  thresholdPct?: number;
  priorityKeys?: string[];
  priorityIds?: string[];
  ticketTypes?: string[];
  customerIds?: string[];
  teamIds?: string[];
  domains?: string[];
}

interface RuleActions {
  notifyAssignee?: boolean;
  notifyTeam?: boolean;
  notifyManager?: boolean;
  notifyRoles?: string[];
  notifyUserIds?: string[];
  notifyTeamIds?: string[];
  emails?: string[];
  raiseEscalationLevel?: boolean;
  reassignTeamId?: string | null;
  raisePriorityKey?: string | null;
  raisePriority?: boolean;
  /** Notify whoever the assigned team's rotas put on call. */
  notifyOnCall?: boolean;
  /** Page through this escalation policy ... */
  pagePolicyId?: string | null;
  /** ... or through the assigned team's default policy. */
  pageTeam?: boolean;
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);

function ruleMatches(c: RuleConditions, ticket: TicketRow, priorityKey: string | null, trigger: EscalationTrigger): boolean {
  if (c.onBreach && trigger.kind !== 'breach') return false;
  if (!c.onBreach) {
    if (trigger.kind !== 'warning') return false;
    if (typeof c.thresholdPct === 'number' && trigger.pct < c.thresholdPct) return false;
  }
  if (c.metric && c.metric !== 'any' && c.metric !== trigger.metric) return false;
  const types = asList(c.ticketTypes);
  if (types.length && !types.includes(ticket.type)) return false;
  const pk = asList(c.priorityKeys);
  if (pk.length && (!priorityKey || !pk.includes(priorityKey))) return false;
  const pi = asList(c.priorityIds);
  if (pi.length && (!ticket.priorityId || !pi.includes(ticket.priorityId))) return false;
  const custs = asList(c.customerIds);
  if (custs.length && !custs.includes(ticket.customerId)) return false;
  const teams = asList(c.teamIds);
  if (teams.length && (!ticket.assignedTeamId || !teams.includes(ticket.assignedTeamId))) return false;
  const domains = asList(c.domains);
  if (domains.length && !domains.includes(ticket.domain)) return false;
  return true;
}

/**
 * Evaluates escalation rules for an SLA breach or warning and executes the
 * matching actions (notify, raise level, reassign, raise priority). Returns
 * the updated ticket.
 */
export async function applyEscalationRules(ctx: Ctx, ticket: TicketRow, trigger: EscalationTrigger): Promise<{ ticket: TicketRow; applied: string[] }> {
  const rules = await ctx.tx.select().from(schema.escalationRules).where(eq(schema.escalationRules.isActive, true)).orderBy(asc(schema.escalationRules.sortOrder), asc(schema.escalationRules.createdAt));
  const priority = await optionById(ctx.tx, ticket.priorityId);
  const applied: string[] = [];
  let current = ticket;
  for (const rule of rules) {
    if (!ruleMatches((rule.conditions ?? {}) as RuleConditions, current, priority?.key ?? null, trigger)) continue;
    const a = (rule.actions ?? {}) as RuleActions;
    const patch: Partial<typeof schema.tickets.$inferInsert> = {};
    const summary: string[] = [];
    let level = current.escalationLevel;
    if (a.raiseEscalationLevel) {
      level = current.escalationLevel + 1;
      patch.escalationLevel = level;
      summary.push(`level ${level}`);
    }
    if (a.reassignTeamId && a.reassignTeamId !== current.assignedTeamId) {
      patch.assignedTeamId = a.reassignTeamId;
      patch.assigneeId = null;
      summary.push('reassigned team');
    }
    let priorityChanged = false;
    if (a.raisePriorityKey) {
      const target = await optionByKey(ctx.tx, 'ticket_priority', a.raisePriorityKey);
      if (target && target.id !== current.priorityId && (priority?.level == null || target.level == null || target.level < priority.level)) {
        patch.priorityId = target.id;
        priorityChanged = true;
        summary.push(`priority → ${target.label}`);
      }
    }
    if (Object.keys(patch).length) {
      await ctx.tx.update(schema.tickets).set({ ...patch, updatedAt: new Date(), lastActivityAt: new Date() }).where(eq(schema.tickets.id, current.id));
      current = await reloadTicket(ctx.tx, current.id);
      if (priorityChanged) await applySlas(ctx.tx, current, actorOf(ctx), { reason: 'recalculated' });
    }
    const reason = `${trigger.kind === 'breach' ? 'SLA breach' : 'SLA warning'}: ${metricLabel(trigger.metric)} at ${Math.round(trigger.pct)}% (${rule.name})`;
    await ctx.tx.insert(schema.escalationLog).values({ ticketId: current.id, customerId: current.customerId, ruleId: rule.id, level, reason, actions: a as Record<string, unknown>, triggeredBy: userIdOf(ctx) });
    await addActivity(ctx, current, { type: 'escalation', summary: `Escalation rule "${rule.name}" applied${summary.length ? `: ${summary.join(', ')}` : ''}`, data: { ruleId: rule.id, trigger, actions: a, level }, customerVisible: false });
    await ctx.audit({ entityType: 'ticket', entityId: current.id, entityLabel: current.number, action: 'escalate.auto', customerId: current.customerId, metadata: { ruleId: rule.id, ruleName: rule.name, trigger, actions: a } });

    const wantsNotify = a.notifyAssignee || a.notifyTeam || a.notifyManager || a.notifyOnCall || a.notifyRoles?.length || a.notifyUserIds?.length || a.notifyTeamIds?.length || a.emails?.length;
    if (wantsNotify) {
      const extraRecipients = a.notifyTeamIds?.length ? await escalationRecipients(ctx.tx, { ...current, assignedTeamId: a.notifyTeamIds[0]! }, { team: true }) : [];
      await notifyTicketEvent(ctx, 'ticket.escalated', current, {
        level,
        reason,
        sla: { metric: trigger.metric, dueAt: trigger.dueAt ?? null, pct: trigger.pct },
        recipientOverride: { assignee: a.notifyAssignee, team: a.notifyTeam, manager: a.notifyManager, onCall: a.notifyOnCall, roles: a.notifyRoles, users: a.notifyUserIds, emails: a.emails },
        extraRecipients,
      });
    }
    if (a.pagePolicyId || a.pageTeam) {
      // A page that cannot start (no policy, one already running) must not undo the rule's other actions.
      try {
        await startPaging(ctx, current, { policyId: a.pagePolicyId ?? null, reason, source: 'rule' });
      } catch (err) {
        if (err instanceof ValidationError) logger.warn({ ticketId: current.id, rule: rule.name, err: err.message }, 'escalation rule could not page');
        else throw err;
      }
    }
    applied.push(rule.name);
  }
  return { ticket: current, applied };
}

/** Manual escalation by an engineer/manager: level++, log, notify team manager + NOC/service managers. */
export async function escalateManually(ctx: Ctx, ticket: TicketRow, reason: string, notifyRoles: string[] = ['noc_manager', 'service_manager']): Promise<TicketRow> {
  const level = ticket.escalationLevel + 1;
  await ctx.tx.update(schema.tickets).set({ escalationLevel: level, updatedAt: new Date(), lastActivityAt: new Date() }).where(eq(schema.tickets.id, ticket.id));
  const updated = await reloadTicket(ctx.tx, ticket.id);
  await ctx.tx.insert(schema.escalationLog).values({ ticketId: ticket.id, customerId: ticket.customerId, ruleId: null, level, reason, actions: { manual: true, notifyRoles }, triggeredBy: userIdOf(ctx) });
  await addActivity(ctx, ticket, { type: 'escalation', summary: `Escalated to level ${level}: ${reason}`, data: { level, reason, manual: true }, customerVisible: false });
  await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, action: 'escalate', customerId: ticket.customerId, changes: { escalationLevel: { old: ticket.escalationLevel, new: level } }, metadata: { reason } });
  const extraRecipients = await escalationRecipients(ctx.tx, updated, { manager: true, roles: notifyRoles });
  await notifyTicketEvent(ctx, 'ticket.escalated', updated, { level, reason, extraRecipients });
  return updated;
}

export async function escalationHistory(ctx: Ctx, ticketId: string) {
  return ctx.tx.select().from(schema.escalationLog).where(and(eq(schema.escalationLog.ticketId, ticketId))).orderBy(asc(schema.escalationLog.occurredAt));
}
