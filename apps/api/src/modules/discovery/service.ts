import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { ConflictError, NotFoundError, ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { encryptSecret, isEncrypted } from '@/lib/crypto';
import { orderBy, limitOffset } from '@/core/query';
import { enqueue } from '@/jobs/queues';
import { q as rawRows, one as rawOne, num, asDate } from '@/modules/dashboards/common';
import { getProvider, listProviders } from './providers';
import type { DiscoveredInterface, DiscoveredNeighbor } from './providers/types';
import { decryptConfig } from './runner';
import { applyFinding, diffAgainstCi, ignoreFindingTx, pendingFindingsSql } from './apply';
import { sourceConfigSchema, type FindingsQuery, type FindingStatsQuery, type RunsListQuery, type SourceCreateInput, type SourcePatchInput } from './schemas';

const { discoverySources, discoveryRuns, discoveryFindings, customers, sites, cis, ciTypes, users } = schema;
const MASK = '********';

// ---------------------------------------------------------------- secrets

type Cfg = Record<string, unknown> & { snmp?: { communities?: string[]; v3?: Record<string, string | undefined> } };

function encryptConfig(input: Cfg, existing?: Cfg): Cfg {
  const out: Cfg = { ...input };
  const snmp = { ...(input.snmp ?? {}) } as NonNullable<Cfg['snmp']>;
  const prevCommunities = existing?.snmp?.communities ?? [];
  if (snmp.communities) {
    snmp.communities = snmp.communities.map((c, i) => {
      if (c === MASK) return prevCommunities[i] ?? prevCommunities[0] ?? '';
      return isEncrypted(c) ? c : encryptSecret(c);
    }).filter(Boolean);
  }
  if (snmp.v3) {
    const prev = existing?.snmp?.v3 ?? {};
    const v3 = { ...snmp.v3 };
    for (const k of ['authKey', 'privKey'] as const) {
      const v = v3[k];
      if (v === MASK) v3[k] = prev[k];
      else if (v) v3[k] = isEncrypted(v) ? v : encryptSecret(v);
      else if (v === '') delete v3[k];
    }
    snmp.v3 = v3;
  }
  out.snmp = snmp;
  return out;
}

/** Masks secrets for API responses. */
export function maskConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(config ?? {})) as Cfg;
  if (out.snmp?.communities) out.snmp.communities = out.snmp.communities.map(() => MASK);
  if (out.snmp?.v3) {
    if (out.snmp.v3.authKey) out.snmp.v3.authKey = MASK;
    if (out.snmp.v3.privKey) out.snmp.v3.privKey = MASK;
  }
  return out;
}

// ---------------------------------------------------------------- sources

async function loadSource(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(discoverySources).where(eq(discoverySources.id, id)).limit(1);
  if (!row) throw new NotFoundError('Discovery source');
  ctx.requireCustomer(row.customerId);
  return row;
}

const sourceView = <T extends { config: Record<string, unknown> }>(s: T) => ({ ...s, config: maskConfig(s.config) });

export function providers() {
  return listProviders();
}

export async function listSources(ctx: Ctx, q: { customerId?: string; includeInactive?: boolean }) {
  const conds: SQL[] = [];
  if (q.customerId) {
    ctx.requireCustomer(q.customerId);
    conds.push(eq(discoverySources.customerId, q.customerId));
  }
  if (!q.includeInactive) conds.push(eq(discoverySources.isActive, true));
  const lastRun = sql<string | null>`(select r.status from ${discoveryRuns} r where r.source_id = ${discoverySources.id} order by r.created_at desc limit 1)`;
  const lastRunId = sql<string | null>`(select r.id from ${discoveryRuns} r where r.source_id = ${discoverySources.id} order by r.created_at desc limit 1)`;
  const rows = await ctx.tx
    .select({
      id: discoverySources.id,
      customerId: discoverySources.customerId,
      customerName: customers.name,
      siteId: discoverySources.siteId,
      siteName: sites.name,
      name: discoverySources.name,
      sourceType: discoverySources.sourceType,
      config: discoverySources.config,
      scheduleCron: discoverySources.scheduleCron,
      autoApply: discoverySources.autoApply,
      isActive: discoverySources.isActive,
      lastRunAt: discoverySources.lastRunAt,
      lastRunStatus: lastRun,
      lastRunId,
      pendingFindings: pendingFindingsSql(discoverySources.id),
      createdAt: discoverySources.createdAt,
      updatedAt: discoverySources.updatedAt,
    })
    .from(discoverySources)
    .leftJoin(customers, eq(customers.id, discoverySources.customerId))
    .leftJoin(sites, eq(sites.id, discoverySources.siteId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(customers.name, discoverySources.name);
  return { items: rows.map(sourceView), total: rows.length };
}

export async function getSource(ctx: Ctx, id: string) {
  const s = await loadSource(ctx, id);
  const [meta] = await ctx.tx.select({ customerName: customers.name, siteName: sites.name }).from(discoverySources).leftJoin(customers, eq(customers.id, discoverySources.customerId)).leftJoin(sites, eq(sites.id, discoverySources.siteId)).where(eq(discoverySources.id, id)).limit(1);
  return { ...sourceView(s), ...meta };
}

function validateCron(cron?: string | null) {
  if (!cron) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new ValidationError('Schedule must be a 5-field cron expression (minute hour day month weekday)');
  return parts.join(' ');
}

async function assertSite(ctx: Ctx, customerId: string, siteId?: string | null) {
  if (!siteId) return;
  const [s] = await ctx.tx.select({ id: sites.id }).from(sites).where(and(eq(sites.id, siteId), eq(sites.customerId, customerId))).limit(1);
  if (!s) throw new ValidationError('Site does not belong to this customer');
}

export async function createSource(ctx: Ctx, input: SourceCreateInput) {
  ctx.requireCustomer(input.customerId);
  ctx.require('discovery:manage', input.customerId);
  if (!getProvider(input.sourceType)) throw new ValidationError(`Unknown discovery source type "${input.sourceType}"`);
  await assertSite(ctx, input.customerId, input.siteId);
  const [row] = await ctx.tx
    .insert(discoverySources)
    .values({ customerId: input.customerId, siteId: input.siteId ?? null, name: input.name, sourceType: input.sourceType, config: encryptConfig(input.config as Cfg), scheduleCron: validateCron(input.scheduleCron), autoApply: input.autoApply ?? false, isActive: input.isActive ?? true, createdBy: ctx.user.id })
    .returning();
  await ctx.audit({ entityType: 'discovery_source', entityId: row.id, entityLabel: row.name, action: 'create', customerId: row.customerId, metadata: { sourceType: row.sourceType, subnets: input.config.subnets } });
  return getSource(ctx, row.id);
}

export async function updateSource(ctx: Ctx, id: string, patch: SourcePatchInput) {
  const before = await loadSource(ctx, id);
  ctx.require('discovery:manage', before.customerId);
  if (patch.sourceType && !getProvider(patch.sourceType)) throw new ValidationError(`Unknown discovery source type "${patch.sourceType}"`);
  if (patch.siteId !== undefined) await assertSite(ctx, before.customerId, patch.siteId);
  const set: Record<string, unknown> = { ...patch };
  if (patch.config) {
    const incoming = patch.config as Record<string, unknown> & { snmp?: Record<string, unknown> };
    const merged = sourceConfigSchema.parse({ ...(before.config as object), ...incoming, snmp: { ...((before.config as Cfg).snmp ?? {}), ...(incoming.snmp ?? {}) } });
    set.config = encryptConfig(merged as Cfg, before.config as Cfg);
  }
  if (patch.scheduleCron !== undefined) set.scheduleCron = validateCron(patch.scheduleCron);
  const [after] = await ctx.tx.update(discoverySources).set({ ...set, updatedAt: new Date() } as never).where(eq(discoverySources.id, id)).returning();
  const changes = diffChanges({ ...before, config: maskConfig(before.config) } as Record<string, unknown>, { ...set, ...(set.config ? { config: maskConfig(set.config as Record<string, unknown>) } : {}) });
  if (Object.keys(changes).length) await ctx.audit({ entityType: 'discovery_source', entityId: id, entityLabel: after.name, action: 'update', customerId: after.customerId, changes });
  return getSource(ctx, id);
}

export async function deleteSource(ctx: Ctx, id: string) {
  const s = await loadSource(ctx, id);
  ctx.require('discovery:manage', s.customerId);
  await ctx.tx.delete(discoverySources).where(eq(discoverySources.id, id));
  await ctx.audit({ entityType: 'discovery_source', entityId: id, entityLabel: s.name, action: 'delete', customerId: s.customerId });
  return { deleted: true };
}

// ---------------------------------------------------------------- runs

export async function runSource(ctx: Ctx, id: string) {
  const s = await loadSource(ctx, id);
  ctx.require('discovery:run', s.customerId);
  if (!s.isActive) throw new ValidationError('Source is inactive');
  const [busy] = await ctx.tx
    .select({ id: discoveryRuns.id })
    .from(discoveryRuns)
    .where(and(eq(discoveryRuns.sourceId, id), inArray(discoveryRuns.status, ['queued', 'running']), sql`${discoveryRuns.createdAt} > now() - interval '2 hours'`))
    .limit(1);
  if (busy) throw new ConflictError('A run for this source is already queued or running');
  const [run] = await ctx.tx.insert(discoveryRuns).values({ sourceId: id, customerId: s.customerId, status: 'queued', triggeredBy: ctx.user.id, log: `Queued by ${ctx.user.name}\n` }).returning();
  await ctx.audit({ entityType: 'discovery_source', entityId: id, entityLabel: s.name, action: 'run', customerId: s.customerId, metadata: { runId: run.id } });
  // Enqueue after the transaction commits would be ideal; BullMQ job is idempotent by id and the worker re-reads the row (which exists once committed).
  await enqueue('discovery', 'run', { runId: run.id }, { jobId: `discovery-run-${run.id}`, delay: 500 });
  return run;
}

export async function listRuns(ctx: Ctx, sourceId: string, q: { page: number; pageSize: number }) {
  await loadSource(ctx, sourceId);
  const [{ count }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(discoveryRuns).where(eq(discoveryRuns.sourceId, sourceId));
  const { limit, offset } = limitOffset(q);
  const items = await ctx.tx
    .select({ id: discoveryRuns.id, sourceId: discoveryRuns.sourceId, status: discoveryRuns.status, startedAt: discoveryRuns.startedAt, finishedAt: discoveryRuns.finishedAt, stats: discoveryRuns.stats, error: discoveryRuns.error, triggeredBy: discoveryRuns.triggeredBy, triggeredByName: users.name, createdAt: discoveryRuns.createdAt })
    .from(discoveryRuns)
    .leftJoin(users, eq(users.id, discoveryRuns.triggeredBy))
    .where(eq(discoveryRuns.sourceId, sourceId))
    .orderBy(desc(discoveryRuns.createdAt))
    .limit(limit)
    .offset(offset);
  return { items, total: count, page: q.page, pageSize: q.pageSize };
}

export async function getRun(ctx: Ctx, id: string) {
  const [run] = await ctx.tx
    .select({ id: discoveryRuns.id, sourceId: discoveryRuns.sourceId, sourceName: discoverySources.name, customerId: discoveryRuns.customerId, status: discoveryRuns.status, startedAt: discoveryRuns.startedAt, finishedAt: discoveryRuns.finishedAt, stats: discoveryRuns.stats, log: discoveryRuns.log, error: discoveryRuns.error, triggeredBy: discoveryRuns.triggeredBy, triggeredByName: users.name, createdAt: discoveryRuns.createdAt })
    .from(discoveryRuns)
    .leftJoin(discoverySources, eq(discoverySources.id, discoveryRuns.sourceId))
    .leftJoin(users, eq(users.id, discoveryRuns.triggeredBy))
    .where(eq(discoveryRuns.id, id))
    .limit(1);
  if (!run) throw new NotFoundError('Discovery run');
  ctx.requireCustomer(run.customerId);
  return run;
}

// ---------------------------------------------------------------- findings

export async function listFindings(ctx: Ctx, q: FindingsQuery) {
  const conds: SQL[] = [];
  if (q.customerId) {
    ctx.requireCustomer(q.customerId);
    conds.push(eq(discoveryFindings.customerId, q.customerId));
  }
  if (q.sourceId) conds.push(eq(discoveryFindings.sourceId, q.sourceId));
  if (q.runId) conds.push(eq(discoveryFindings.runId, q.runId));
  if (q.status) conds.push(eq(discoveryFindings.status, q.status));
  if (q.diffStatus) conds.push(eq(discoveryFindings.diffStatus, q.diffStatus));
  if (q.q) conds.push(or(ilike(discoveryFindings.ipAddress, `%${q.q}%`), ilike(discoveryFindings.hostname, `%${q.q}%`), ilike(discoveryFindings.serialNumber, `%${q.q}%`), ilike(discoveryFindings.sysDescr, `%${q.q}%`))!);
  const where = conds.length ? and(...conds) : undefined;
  const [{ count }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(discoveryFindings).where(where);
  const ipOrder = sql`inet(${discoveryFindings.ipAddress})`;
  const sortable = { ipAddress: ipOrder, hostname: discoveryFindings.hostname, createdAt: discoveryFindings.createdAt, diffStatus: discoveryFindings.diffStatus };
  const order = orderBy(sortable, q.sort, q.order ?? (q.sort ? 'asc' : 'desc'), discoveryFindings.createdAt);
  const { limit, offset } = limitOffset(q);
  const items = await ctx.tx
    .select({
      id: discoveryFindings.id,
      runId: discoveryFindings.runId,
      sourceId: discoveryFindings.sourceId,
      sourceName: discoverySources.name,
      customerId: discoveryFindings.customerId,
      siteId: discoveryFindings.siteId,
      ipAddress: discoveryFindings.ipAddress,
      hostname: discoveryFindings.hostname,
      fqdn: discoveryFindings.fqdn,
      macAddress: discoveryFindings.macAddress,
      manufacturer: discoveryFindings.manufacturer,
      model: discoveryFindings.model,
      serialNumber: discoveryFindings.serialNumber,
      sysDescr: discoveryFindings.sysDescr,
      sysObjectId: discoveryFindings.sysObjectId,
      suggestedTypeKey: discoveryFindings.suggestedTypeKey,
      openPorts: discoveryFindings.openPorts,
      interfaces: discoveryFindings.interfaces,
      neighbors: discoveryFindings.neighbors,
      raw: discoveryFindings.raw,
      matchedCiId: discoveryFindings.matchedCiId,
      matchedCiName: cis.name,
      diffStatus: discoveryFindings.diffStatus,
      status: discoveryFindings.status,
      appliedAt: discoveryFindings.appliedAt,
      createdAt: discoveryFindings.createdAt,
    })
    .from(discoveryFindings)
    .leftJoin(discoverySources, eq(discoverySources.id, discoveryFindings.sourceId))
    .leftJoin(cis, eq(cis.id, discoveryFindings.matchedCiId))
    .where(where)
    .orderBy(order)
    .limit(limit)
    .offset(offset);
  return { items, total: count, page: q.page, pageSize: q.pageSize };
}

async function loadFinding(ctx: Ctx, id: string) {
  const [f] = await ctx.tx.select().from(discoveryFindings).where(eq(discoveryFindings.id, id)).limit(1);
  if (!f) throw new NotFoundError('Finding');
  ctx.requireCustomer(f.customerId);
  ctx.require('discovery:run', f.customerId);
  return f;
}

const actorOf = (ctx: Ctx) => ({ userId: ctx.user.apiKeyId ? null : ctx.user.id, userName: ctx.user.name, source: ctx.source, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });

export async function applyFindingById(ctx: Ctx, id: string) {
  const f = await loadFinding(ctx, id);
  if (f.status === 'applied') throw new ConflictError('Finding has already been applied');
  ctx.require('cmdb:manage', f.customerId);
  const res = await applyFinding(ctx.tx, f, actorOf(ctx));
  return { findingId: id, ciId: res.ci.id, ciName: res.ci.name, created: res.created, neighborsLinked: res.neighborsLinked };
}

export async function ignoreFinding(ctx: Ctx, id: string) {
  const f = await loadFinding(ctx, id);
  if (f.status !== 'pending') throw new ConflictError(`Finding is already ${f.status}`);
  await ignoreFindingTx(ctx.tx, f, actorOf(ctx));
  return { findingId: id, status: 'ignored' };
}

export async function bulkFindings(ctx: Ctx, ids: string[], action: 'apply' | 'ignore') {
  const results: { id: string; ok: boolean; message?: string; ciId?: string }[] = [];
  for (const id of ids) {
    await ctx.tx.execute(sql`savepoint bulk_finding`);
    try {
      if (action === 'apply') {
        const r = await applyFindingById(ctx, id);
        results.push({ id, ok: true, ciId: r.ciId });
      } else {
        await ignoreFinding(ctx, id);
        results.push({ id, ok: true });
      }
      await ctx.tx.execute(sql`release savepoint bulk_finding`);
    } catch (err) {
      await ctx.tx.execute(sql`rollback to savepoint bulk_finding`);
      results.push({ id, ok: false, message: (err as Error).message });
    }
  }
  return { action, applied: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

// ---------------------------------------------------------------- test

export async function testSource(ctx: Ctx, id: string) {
  const s = await loadSource(ctx, id);
  ctx.require('discovery:run', s.customerId);
  const provider = getProvider(s.sourceType);
  if (!provider?.test) throw new ValidationError('This source type does not support connectivity tests');
  const res = await provider.test({ id: s.id, customerId: s.customerId, siteId: s.siteId, name: s.name, sourceType: s.sourceType, config: decryptConfig(s.config) });
  await ctx.audit({ entityType: 'discovery_source', entityId: id, entityLabel: s.name, action: 'test', customerId: s.customerId, metadata: { ok: res.ok, message: res.message } });
  return res;
}

// ---------------------------------------------------------------- overview

/** One-call payload for the discovery landing page: source/run/finding counters, the latest runs and a per-customer rollup. */
export async function discoveryOverview(ctx: Ctx, customerId?: string) {
  if (customerId) ctx.requireCustomer(customerId);
  const cc = (col: SQL) => (customerId ? sql`and ${col} = ${customerId}::uuid` : sql``);
  const [sources, runs, findings, lastRuns, byCustomer] = await Promise.all([
    rawOne<{ total: number; active: number; scheduled: number }>(ctx, sql`
      select count(*)::int as total, count(*) filter (where s.is_active)::int as active, count(*) filter (where s.schedule_cron is not null)::int as scheduled
      from discovery_sources s where true ${cc(sql`s.customer_id`)}`),
    rawOne<{ running: number; queued: number; completed7d: number; failed7d: number }>(ctx, sql`
      select count(*) filter (where r.status = 'running')::int as running, count(*) filter (where r.status = 'queued')::int as queued,
        count(*) filter (where r.status = 'completed' and coalesce(r.finished_at, r.created_at) > now() - interval '7 days')::int as "completed7d",
        count(*) filter (where r.status = 'failed' and coalesce(r.finished_at, r.created_at) > now() - interval '7 days')::int as "failed7d"
      from discovery_runs r where true ${cc(sql`r.customer_id`)}`),
    rawOne<{ pending: number; pendingNew: number; pendingChanged: number; pendingUnchanged: number; applied7d: number; ignored7d: number }>(ctx, sql`
      select count(*) filter (where f.status = 'pending')::int as pending,
        count(*) filter (where f.status = 'pending' and f.diff_status = 'new')::int as "pendingNew",
        count(*) filter (where f.status = 'pending' and f.diff_status = 'changed')::int as "pendingChanged",
        count(*) filter (where f.status = 'pending' and f.diff_status = 'unchanged')::int as "pendingUnchanged",
        count(*) filter (where f.status = 'applied' and f.applied_at > now() - interval '7 days')::int as "applied7d",
        count(*) filter (where f.status = 'ignored' and f.applied_at > now() - interval '7 days')::int as "ignored7d"
      from discovery_findings f where true ${cc(sql`f.customer_id`)}`),
    rawRows<{ id: string; sourceId: string; sourceName: string | null; customerId: string; customerName: string | null; status: string; triggeredBy: string | null; triggeredByName: string | null; startedAt: Date | null; finishedAt: Date | null; stats: Record<string, number>; createdAt: Date }>(ctx, sql`
      select r.id, r.source_id as "sourceId", s.name as "sourceName", r.customer_id as "customerId", cu.name as "customerName", r.status, r.triggered_by as "triggeredBy", u.name as "triggeredByName",
        r.started_at as "startedAt", r.finished_at as "finishedAt", r.stats, r.created_at as "createdAt"
      from discovery_runs r left join discovery_sources s on s.id = r.source_id left join customers cu on cu.id = r.customer_id left join users u on u.id = r.triggered_by
      where true ${cc(sql`r.customer_id`)} order by r.created_at desc limit 10`),
    rawRows<{ customerId: string; customerName: string | null; sources: number; pendingFindings: number; lastRunAt: Date | null }>(ctx, sql`
      select s.customer_id as "customerId", cu.name as "customerName", count(*)::int as sources,
        (select count(*)::int from discovery_findings f where f.customer_id = s.customer_id and f.status = 'pending') as "pendingFindings",
        (select max(coalesce(r.started_at, r.created_at)) from discovery_runs r where r.customer_id = s.customer_id) as "lastRunAt"
      from discovery_sources s left join customers cu on cu.id = s.customer_id where true ${cc(sql`s.customer_id`)}
      group by s.customer_id, cu.name order by cu.name`),
  ]);
  return {
    sources: { total: num(sources.total), active: num(sources.active), scheduled: num(sources.scheduled) },
    runs: { running: num(runs.running), queued: num(runs.queued), completed7d: num(runs.completed7d), failed7d: num(runs.failed7d) },
    findings: { pending: num(findings.pending), pendingNew: num(findings.pendingNew), pendingChanged: num(findings.pendingChanged), pendingUnchanged: num(findings.pendingUnchanged), applied7d: num(findings.applied7d), ignored7d: num(findings.ignored7d) },
    lastRuns: lastRuns.map((r) => ({ ...r, startedAt: asDate(r.startedAt), finishedAt: asDate(r.finishedAt), createdAt: asDate(r.createdAt) as Date })),
    byCustomer: byCustomer.map((r) => ({ ...r, sources: num(r.sources), pendingFindings: num(r.pendingFindings), lastRunAt: asDate(r.lastRunAt) })),
  };
}

// ---------------------------------------------------------------- runs across sources

/** Paginated runs across every source the caller can see, with source/customer names, duration and finding counts. */
export async function listAllRuns(ctx: Ctx, q: RunsListQuery) {
  const conds: SQL[] = [];
  if (q.customerId) {
    ctx.requireCustomer(q.customerId);
    conds.push(eq(discoveryRuns.customerId, q.customerId));
  }
  if (q.sourceId) conds.push(eq(discoveryRuns.sourceId, q.sourceId));
  if (q.status) conds.push(eq(discoveryRuns.status, q.status));
  const where = conds.length ? and(...conds) : undefined;
  const [{ count }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(discoveryRuns).where(where);
  const durationSec = sql<number | null>`case when ${discoveryRuns.startedAt} is null then null else extract(epoch from (coalesce(${discoveryRuns.finishedAt}, now()) - ${discoveryRuns.startedAt}))::int end`;
  const findingCount = (extra: SQL) => sql<number>`(select count(*)::int from ${discoveryFindings} f where f.run_id = ${discoveryRuns.id} ${extra})`;
  const sortable = { createdAt: discoveryRuns.createdAt, startedAt: discoveryRuns.startedAt, finishedAt: discoveryRuns.finishedAt, status: discoveryRuns.status, sourceName: discoverySources.name, customerName: customers.name, durationSec };
  const order = orderBy(sortable, q.sort, q.order ?? (q.sort ? 'asc' : 'desc'), discoveryRuns.createdAt);
  const { limit, offset } = limitOffset(q);
  const rows = await ctx.tx
    .select({
      id: discoveryRuns.id,
      sourceId: discoveryRuns.sourceId,
      sourceName: discoverySources.name,
      customerId: discoveryRuns.customerId,
      customerName: customers.name,
      status: discoveryRuns.status,
      startedAt: discoveryRuns.startedAt,
      finishedAt: discoveryRuns.finishedAt,
      durationSec,
      stats: discoveryRuns.stats,
      error: discoveryRuns.error,
      triggeredBy: discoveryRuns.triggeredBy,
      triggeredByName: users.name,
      createdAt: discoveryRuns.createdAt,
      findingsTotal: findingCount(sql``),
      findingsNew: findingCount(sql`and f.diff_status = 'new'`),
      findingsChanged: findingCount(sql`and f.diff_status = 'changed'`),
      findingsUnchanged: findingCount(sql`and f.diff_status = 'unchanged'`),
    })
    .from(discoveryRuns)
    .leftJoin(discoverySources, eq(discoverySources.id, discoveryRuns.sourceId))
    .leftJoin(customers, eq(customers.id, discoveryRuns.customerId))
    .leftJoin(users, eq(users.id, discoveryRuns.triggeredBy))
    .where(where)
    .orderBy(order)
    .limit(limit)
    .offset(offset);
  const items = rows.map(({ findingsTotal, findingsNew, findingsChanged, findingsUnchanged, ...r }) => ({ ...r, findings: { total: findingsTotal, new: findingsNew, changed: findingsChanged, unchanged: findingsUnchanged } }));
  return { items, total: count, page: q.page, pageSize: q.pageSize };
}

/** Marks a queued/running run cancelled; the worker notices on its next progress flush and stops the scan (reconciled findings are kept). */
export async function cancelRun(ctx: Ctx, id: string) {
  const [run] = await ctx.tx.select().from(discoveryRuns).where(eq(discoveryRuns.id, id)).limit(1);
  if (!run) throw new NotFoundError('Discovery run');
  ctx.requireCustomer(run.customerId);
  ctx.require('discovery:run', run.customerId);
  if (run.status !== 'queued' && run.status !== 'running') throw new ConflictError(`Run is already ${run.status}`);
  const now = new Date();
  const line = `${now.toISOString().slice(11, 19)} Cancelled by ${ctx.user.name}\n`;
  await ctx.tx.update(discoveryRuns).set({ status: 'cancelled', finishedAt: now, log: sql`coalesce(${discoveryRuns.log}, '') || ${line}` }).where(eq(discoveryRuns.id, id));
  await ctx.audit({ entityType: 'discovery_run', entityId: id, action: 'cancel', customerId: run.customerId, metadata: { sourceId: run.sourceId, previousStatus: run.status } });
  return getRun(ctx, id);
}

// ---------------------------------------------------------------- finding detail / stats

const DIFF_FIELDS = ['hostname', 'ipAddress', 'macAddress', 'serialNumber', 'model', 'manufacturer'] as const;

/** A finding with its source, run, matched CI, a field-by-field comparison and the suggested CI type. */
export async function getFinding(ctx: Ctx, id: string) {
  const [f] = await ctx.tx.select().from(discoveryFindings).where(eq(discoveryFindings.id, id)).limit(1);
  if (!f) throw new NotFoundError('Finding');
  ctx.requireCustomer(f.customerId);
  const [[source], [run], matched, [suggested]] = await Promise.all([
    ctx.tx.select({ id: discoverySources.id, name: discoverySources.name }).from(discoverySources).where(eq(discoverySources.id, f.sourceId)).limit(1),
    ctx.tx.select({ id: discoveryRuns.id, status: discoveryRuns.status, startedAt: discoveryRuns.startedAt }).from(discoveryRuns).where(eq(discoveryRuns.id, f.runId)).limit(1),
    f.matchedCiId
      ? ctx.tx
          .select({ id: cis.id, name: cis.name, typeKey: ciTypes.key, typeName: ciTypes.name, hostname: cis.hostname, ipAddress: cis.ipAddress, macAddress: cis.macAddress, serialNumber: cis.serialNumber, manufacturer: cis.manufacturer, model: cis.model, osName: cis.osName, status: cis.status, lastSeenAt: cis.lastSeenAt })
          .from(cis)
          .innerJoin(ciTypes, eq(ciTypes.id, cis.typeId))
          .where(eq(cis.id, f.matchedCiId))
          .limit(1)
      : Promise.resolve([]),
    f.suggestedTypeKey ? ctx.tx.select({ key: ciTypes.key, name: ciTypes.name, color: ciTypes.color, icon: ciTypes.icon }).from(ciTypes).where(eq(ciTypes.key, f.suggestedTypeKey)).limit(1) : Promise.resolve([]),
  ]);
  const matchedCi = matched[0] ?? null;
  const diff = diffAgainstCi(f, matchedCi);
  const changes = DIFF_FIELDS.map((field) => ({ field, current: matchedCi?.[field] ?? null, discovered: f[field] ?? null, changed: diff.changed.includes(field) }));
  return {
    ...f,
    source: source ? { id: source.id, name: source.name } : null,
    sourceName: source?.name ?? null,
    run: run ?? null,
    matchedCi,
    matchedCiName: matchedCi?.name ?? null,
    changes,
    interfaces: (f.interfaces ?? []) as unknown as DiscoveredInterface[],
    neighbors: (f.neighbors ?? []) as unknown as DiscoveredNeighbor[],
    suggestedType: suggested ?? null,
  };
}

/** Finding counts by review status, diff status and suggested CI type for a customer / source / run. */
export async function findingStats(ctx: Ctx, q: FindingStatsQuery) {
  const conds: SQL[] = [];
  if (q.customerId) {
    ctx.requireCustomer(q.customerId);
    conds.push(eq(discoveryFindings.customerId, q.customerId));
  }
  if (q.sourceId) conds.push(eq(discoveryFindings.sourceId, q.sourceId));
  if (q.runId) conds.push(eq(discoveryFindings.runId, q.runId));
  const where = conds.length ? and(...conds) : undefined;
  const count = sql<number>`count(*)::int`;
  const [byStatus, byDiff, byType, [tot]] = await Promise.all([
    ctx.tx.select({ key: discoveryFindings.status, count }).from(discoveryFindings).where(where).groupBy(discoveryFindings.status),
    ctx.tx.select({ key: discoveryFindings.diffStatus, count }).from(discoveryFindings).where(where).groupBy(discoveryFindings.diffStatus),
    ctx.tx.select({ key: discoveryFindings.suggestedTypeKey, name: ciTypes.name, count }).from(discoveryFindings).leftJoin(ciTypes, eq(ciTypes.key, discoveryFindings.suggestedTypeKey)).where(where).groupBy(discoveryFindings.suggestedTypeKey, ciTypes.name).orderBy(desc(sql`count(*)`)),
    ctx.tx.select({ count }).from(discoveryFindings).where(where),
  ]);
  return {
    byStatus: Object.fromEntries(byStatus.map((r) => [r.key, r.count])) as Record<string, number>,
    byDiff: Object.fromEntries(byDiff.map((r) => [r.key, r.count])) as Record<string, number>,
    bySuggestedType: byType.map((r) => ({ key: r.key ?? 'other', name: r.name ?? r.key ?? 'Other', count: r.count })),
    total: tot?.count ?? 0,
  };
}
