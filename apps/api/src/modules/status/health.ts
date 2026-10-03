import { and, eq, gte, inArray, isNotNull, lte, ne, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { schema, withSystem, type Tx } from '@/db/client';
import { logger } from '@/core/logger';
import { buildDependencyMap } from '@/modules/cmdb/graph';
import type { HealthReason, ServiceHealth } from '@/db/schema/status';

/**
 * Health of every business service (a CI of type `business_service`), from
 * what is happening on the systems it relies on: an active major incident is
 * `down`; a maintenance window (a PM visit in progress, a change inside its
 * window, a dependency marked in maintenance) is `maintenance`; an open P1/P2
 * ticket or a critical monitoring alert in the last two hours is `degraded`.
 * The `status-health` job rewrites `service_health_snapshots` every two
 * minutes; the portal, the public status page and the CMDB read from there.
 */

const OPEN = ['new', 'open', 'pending'] as const;
const ALERT_WINDOW_MS = 2 * 3600_000;
const RANK: Record<ServiceHealth, number> = { good: 0, degraded: 1, maintenance: 2, down: 3 };
export const worstHealth = (list: ServiceHealth[]): ServiceHealth => list.reduce<ServiceHealth>((w, h) => (RANK[h] > RANK[w] ? h : w), 'good');

export interface HealthInputs {
  majors: { ticketId: string; number: string; title: string; ciIds: string[]; declaredAt: Date }[];
  critical: { id: string; number: string; title: string; ciIds: string[] }[];
  alerts: { id: string; ciId: string; source: string; message: string | null; receivedAt: Date }[];
  visits: { id: string; number: string; title: string; ciIds: string[]; endsAt: Date | null }[];
  changes: { id: string; number: string; title: string; ciIds: string[]; endsAt: Date | null }[];
  /** Dependencies flagged in maintenance in the CMDB (ci id → name). */
  inMaintenance: Map<string, string>;
}

const touches = (ciIds: string[], deps: Set<string>) => ciIds.some((id) => deps.has(id));

/** Pure: the health of one service given the ids of everything it relies on (itself included). */
export function healthOf(deps: Set<string>, input: HealthInputs): { health: ServiceHealth; reasons: HealthReason[] } {
  const reasons: HealthReason[] = [];
  for (const m of input.majors) if (touches(m.ciIds, deps)) reasons.push({ kind: 'major_incident', ref: m.ticketId, label: m.number, text: `Major incident ${m.number}: ${m.title}` });
  for (const v of input.visits) if (touches(v.ciIds, deps)) reasons.push({ kind: 'maintenance', ref: v.id, label: v.number, text: `Planned maintenance in progress: ${v.title}`, until: v.endsAt?.toISOString() ?? null });
  for (const c of input.changes) if (touches(c.ciIds, deps)) reasons.push({ kind: 'change', ref: c.id, label: c.number, text: `Change ${c.number} in its window: ${c.title}`, until: c.endsAt?.toISOString() ?? null });
  for (const [id, name] of input.inMaintenance) if (deps.has(id)) reasons.push({ kind: 'maintenance', ref: id, label: name, text: `${name} is in maintenance` });
  for (const t of input.critical) if (touches(t.ciIds, deps)) reasons.push({ kind: 'event', ref: t.id, label: t.number, text: `Incident ${t.number} on a supporting system: ${t.title}` });
  const alerts = input.alerts.filter((a) => deps.has(a.ciId));
  if (alerts.length) reasons.push({ kind: 'event', ref: alerts[0]!.id, label: alerts[0]!.source, text: `${alerts.length} critical monitoring alert${alerts.length === 1 ? '' : 's'} on a supporting system in the last two hours` });
  const health: ServiceHealth = reasons.some((r) => r.kind === 'major_incident') ? 'down' : reasons.some((r) => r.kind === 'maintenance' || r.kind === 'change') ? 'maintenance' : reasons.length ? 'degraded' : 'good';
  return { health, reasons };
}

async function ticketCiSets(tx: Tx, tickets: { id: string; primaryCiId: string | null }[]) {
  const sets = new Map<string, Set<string>>();
  for (const t of tickets) sets.set(t.id, new Set(t.primaryCiId ? [t.primaryCiId] : []));
  if (tickets.length) {
    const rows = await tx.select({ ticketId: schema.ticketCis.ticketId, ciId: schema.ticketCis.ciId }).from(schema.ticketCis).where(inArray(schema.ticketCis.ticketId, tickets.map((t) => t.id)));
    for (const r of rows) sets.get(r.ticketId)?.add(r.ciId);
  }
  return (id: string) => [...(sets.get(id) ?? [])];
}

/** Gathers everything that can affect a service, once per run. */
export async function gatherInputs(tx: Tx, now = new Date()): Promise<HealthInputs> {
  const t = schema.tickets;
  const st = alias(schema.configOptions, 'st');
  const pr = alias(schema.configOptions, 'pr');
  const majors = await tx
    .select({ ticketId: schema.majorIncidents.ticketId, number: t.number, title: t.title, declaredAt: schema.majorIncidents.declaredAt, primaryCiId: t.primaryCiId })
    .from(schema.majorIncidents)
    .innerJoin(t, eq(t.id, schema.majorIncidents.ticketId))
    .where(eq(schema.majorIncidents.status, 'active'));
  const critical = await tx
    .select({ id: t.id, number: t.number, title: t.title, primaryCiId: t.primaryCiId })
    .from(t)
    .innerJoin(st, eq(st.id, t.statusId))
    .leftJoin(pr, eq(pr.id, t.priorityId))
    .where(and(inArray(st.statusCategory, [...OPEN]), eq(t.isMajor, false), ne(t.type, 'change'), lte(pr.level, 2)));
  const changes = await tx
    .select({ id: t.id, number: t.number, title: t.title, primaryCiId: t.primaryCiId, endsAt: schema.changeDetails.scheduledEnd })
    .from(schema.changeDetails)
    .innerJoin(t, eq(t.id, schema.changeDetails.ticketId))
    .innerJoin(st, eq(st.id, t.statusId))
    .where(and(inArray(st.statusCategory, [...OPEN]), lte(schema.changeDetails.scheduledStart, now), gte(schema.changeDetails.scheduledEnd, now)));
  const ciIdsOf = await ticketCiSets(tx, [...majors.map((m) => ({ id: m.ticketId, primaryCiId: m.primaryCiId })), ...critical, ...changes]);
  const alerts = await tx
    .select({ id: schema.integrationEvents.id, ciId: schema.integrationEvents.matchedCiId, source: schema.integrationEvents.integrationType, message: schema.integrationEvents.message, receivedAt: schema.integrationEvents.receivedAt })
    .from(schema.integrationEvents)
    .where(and(eq(schema.integrationEvents.status, 'open'), inArray(schema.integrationEvents.severity, ['critical', 'high']), isNotNull(schema.integrationEvents.matchedCiId), gte(schema.integrationEvents.receivedAt, new Date(now.getTime() - ALERT_WINDOW_MS))))
    .limit(2000);
  const visits = await tx
    .select({ id: schema.fieldVisits.id, number: schema.fieldVisits.number, title: schema.fieldVisits.title, endsAt: schema.fieldVisits.scheduledEnd, ciIds: schema.pmPrograms.ciIds })
    .from(schema.pmOccurrences)
    .innerJoin(schema.fieldVisits, eq(schema.fieldVisits.id, schema.pmOccurrences.fieldVisitId))
    .innerJoin(schema.pmPrograms, eq(schema.pmPrograms.id, schema.pmOccurrences.programId))
    .where(eq(schema.fieldVisits.status, 'in_progress'));
  const maint = await tx.select({ id: schema.cis.id, name: schema.cis.name }).from(schema.cis).where(eq(schema.cis.status, 'maintenance'));
  return {
    majors: majors.map((m) => ({ ticketId: m.ticketId, number: m.number, title: m.title, declaredAt: m.declaredAt, ciIds: ciIdsOf(m.ticketId) })),
    critical: critical.map((c) => ({ id: c.id, number: c.number, title: c.title, ciIds: ciIdsOf(c.id) })),
    changes: changes.map((c) => ({ id: c.id, number: c.number, title: c.title, endsAt: c.endsAt, ciIds: ciIdsOf(c.id) })),
    alerts: alerts.map((a) => ({ id: a.id, ciId: a.ciId!, source: a.source, message: a.message, receivedAt: a.receivedAt })),
    visits: visits.map((v) => ({ id: v.id, number: v.number, title: v.title, endsAt: v.endsAt, ciIds: v.ciIds })),
    inMaintenance: new Map(maint.map((c) => [c.id, c.name])),
  };
}

export interface HealthRun {
  services: number;
  down: number;
  degraded: number;
  maintenance: number;
}

/** Job entry: recomputes and stores the health of every business service. */
export async function computeServiceHealth(now = new Date()): Promise<HealthRun> {
  const run: HealthRun = { services: 0, down: 0, degraded: 0, maintenance: 0 };
  await withSystem(async (tx) => {
    const services = await tx
      .select({ id: schema.cis.id, customerId: schema.cis.customerId, name: schema.cis.name })
      .from(schema.cis)
      .innerJoin(schema.ciTypes, eq(schema.ciTypes.id, schema.cis.typeId))
      .where(and(eq(schema.ciTypes.key, 'business_service'), ne(schema.cis.status, 'retired')));
    const input = await gatherInputs(tx, now);
    const kept: string[] = [];
    for (const s of services) {
      const map = await buildDependencyMap(tx, s.id);
      const deps = new Set<string>(map ? map.nodes.map((n) => n.id) : [s.id]);
      const { health, reasons } = healthOf(deps, input);
      await tx
        .insert(schema.serviceHealthSnapshots)
        .values({ ciId: s.id, customerId: s.customerId, health, reasons, computedAt: now })
        .onConflictDoUpdate({ target: schema.serviceHealthSnapshots.ciId, set: { customerId: s.customerId, health, reasons, computedAt: now } });
      kept.push(s.id);
      run.services++;
      if (health === 'down') run.down++;
      else if (health === 'degraded') run.degraded++;
      else if (health === 'maintenance') run.maintenance++;
    }
    // Services that were retired or deleted leave no stale row behind.
    if (kept.length) await tx.delete(schema.serviceHealthSnapshots).where(notInArray(schema.serviceHealthSnapshots.ciId, kept));
    else await tx.delete(schema.serviceHealthSnapshots).where(sql`true`);
  }).catch((err) => {
    logger.error({ err }, 'service health computation failed');
    throw err;
  });
  return run;
}
