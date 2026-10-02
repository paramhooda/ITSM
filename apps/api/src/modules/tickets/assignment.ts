import { eq, and, asc } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';

export interface AssignmentInput {
  ticketType: string;
  categoryId?: string | null;
  serviceId?: string | null;
  customerId: string;
  priorityId?: string | null;
  domain?: string | null;
  sourceId?: string | null;
  /** Team suggested by the contract service (fallback after service default). */
  contractTeamId?: string | null;
}

export interface AssignmentResult {
  teamId: string | null;
  userId: string | null;
  ruleId: string | null;
  ruleName: string | null;
  source: 'rule' | 'service' | 'contract' | 'none';
}

interface RuleConditions {
  ticketTypes?: string[];
  ticketType?: string;
  categoryIds?: string[];
  serviceIds?: string[];
  customerIds?: string[];
  priorityIds?: string[];
  domains?: string[];
  domain?: string;
  sourceIds?: string[];
  source?: string;
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);

function matches(c: RuleConditions, input: AssignmentInput): boolean {
  const types = [...asList(c.ticketTypes), ...asList(c.ticketType)];
  if (types.length && !types.includes(input.ticketType)) return false;
  const cats = asList(c.categoryIds);
  if (cats.length && (!input.categoryId || !cats.includes(input.categoryId))) return false;
  const svcs = asList(c.serviceIds);
  if (svcs.length && (!input.serviceId || !svcs.includes(input.serviceId))) return false;
  const custs = asList(c.customerIds);
  if (custs.length && !custs.includes(input.customerId)) return false;
  const prios = asList(c.priorityIds);
  if (prios.length && (!input.priorityId || !prios.includes(input.priorityId))) return false;
  const domains = [...asList(c.domains), ...asList(c.domain)];
  if (domains.length && (!input.domain || !domains.includes(input.domain))) return false;
  const sources = [...asList(c.sourceIds), ...asList(c.source)];
  if (sources.length && (!input.sourceId || !sources.includes(input.sourceId))) return false;
  return true;
}

/**
 * Picks the team / engineer for a new ticket: the first matching active
 * assignment rule (by sort order), else the service's default team, else the
 * team on the contract service.
 */
export async function evaluateAssignment(tx: Tx, input: AssignmentInput): Promise<AssignmentResult> {
  const rules = await tx.select().from(schema.assignmentRules).where(eq(schema.assignmentRules.isActive, true)).orderBy(asc(schema.assignmentRules.sortOrder), asc(schema.assignmentRules.createdAt));
  for (const rule of rules) {
    if (!matches((rule.conditions ?? {}) as RuleConditions, input)) continue;
    if (!rule.teamId && !rule.userId) continue;
    let userId = rule.userId ?? null;
    let teamId = rule.teamId ?? null;
    if (rule.strategy === 'round_robin' && teamId && !userId) userId = await roundRobin(tx, teamId);
    if (rule.strategy === 'least_loaded' && teamId && !userId) userId = await leastLoaded(tx, teamId);
    if (userId && !teamId) teamId = await teamOfUser(tx, userId);
    return { teamId, userId, ruleId: rule.id, ruleName: rule.name, source: 'rule' };
  }
  if (input.serviceId) {
    const [svc] = await tx.select({ defaultTeamId: schema.services.defaultTeamId }).from(schema.services).where(eq(schema.services.id, input.serviceId)).limit(1);
    if (svc?.defaultTeamId) return { teamId: svc.defaultTeamId, userId: null, ruleId: null, ruleName: null, source: 'service' };
  }
  if (input.contractTeamId) return { teamId: input.contractTeamId, userId: null, ruleId: null, ruleName: null, source: 'contract' };
  return { teamId: null, userId: null, ruleId: null, ruleName: null, source: 'none' };
}

async function teamMembers(tx: Tx, teamId: string) {
  return tx
    .select({ userId: schema.teamMembers.userId })
    .from(schema.teamMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.teamMembers.userId))
    .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.users.status, 'active')))
    .orderBy(asc(schema.teamMembers.createdAt));
}

/** Member after the most recently assigned ticket of the team. */
async function roundRobin(tx: Tx, teamId: string): Promise<string | null> {
  const members = await teamMembers(tx, teamId);
  if (!members.length) return null;
  const [last] = await tx
    .select({ assigneeId: schema.tickets.assigneeId })
    .from(schema.tickets)
    .where(eq(schema.tickets.assignedTeamId, teamId))
    .orderBy(asc(schema.tickets.createdAt))
    .limit(1)
    .offset(0);
  const idx = last?.assigneeId ? members.findIndex((m) => m.userId === last.assigneeId) : -1;
  return members[(idx + 1) % members.length]!.userId;
}

/** Member with the fewest open tickets. */
async function leastLoaded(tx: Tx, teamId: string): Promise<string | null> {
  const members = await teamMembers(tx, teamId);
  if (!members.length) return null;
  const openStatuses = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'ticket_status')));
  const openIds = new Set(openStatuses.map((s) => s.id));
  const counts = new Map<string, number>(members.map((m) => [m.userId, 0]));
  const rows = await tx.select({ assigneeId: schema.tickets.assigneeId, statusId: schema.tickets.statusId }).from(schema.tickets).where(eq(schema.tickets.assignedTeamId, teamId));
  for (const r of rows) if (r.assigneeId && counts.has(r.assigneeId) && openIds.has(r.statusId)) counts.set(r.assigneeId, (counts.get(r.assigneeId) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[1] - b[1])[0]![0];
}

async function teamOfUser(tx: Tx, userId: string): Promise<string | null> {
  const [m] = await tx.select({ teamId: schema.teamMembers.teamId }).from(schema.teamMembers).where(eq(schema.teamMembers.userId, userId)).limit(1);
  return m?.teamId ?? null;
}
