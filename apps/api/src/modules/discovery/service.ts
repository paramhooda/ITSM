import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { ConflictError, NotFoundError, ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { encryptSecret, isEncrypted } from '@/lib/crypto';
import { orderBy, limitOffset } from '@/core/query';
import { enqueue } from '@/jobs/queues';
import { getProvider, listProviders } from './providers';
import { decryptConfig } from './runner';
import { applyFinding, ignoreFindingTx, pendingFindingsSql } from './apply';
import { sourceConfigSchema, type FindingsQuery, type SourceCreateInput, type SourcePatchInput } from './schemas';

const { discoverySources, discoveryRuns, discoveryFindings, customers, sites, cis, users } = schema;
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
