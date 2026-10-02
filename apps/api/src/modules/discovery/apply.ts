/**
 * Reconciliation of raw findings with the CMDB and application of findings to
 * CIs. Transaction-level functions used both by the API (review workflow) and
 * by the worker (auto-apply), so they take a `Tx` and an audit actor rather
 * than a request `Ctx`.
 */
import { and, eq, or, sql } from 'drizzle-orm';
import { schema, type Tx } from '@/db/client';
import { writeAudit, type AuditActor } from '@/core/audit';
import { findCiByReference, normaliseMac } from '@/modules/cmdb/match';
import { ensureRelationship, replaceInterfaces, typeByKey } from '@/modules/cmdb/service';
import type { RawFinding } from './providers/types';

const { cis, discoveryFindings, ciRelationshipTypes } = schema;

export type FindingRow = typeof discoveryFindings.$inferSelect;
export type DiffStatus = 'new' | 'changed' | 'unchanged';

const norm = (v?: string | null) => (v ?? '').trim().toLowerCase();

/** Fields compared to decide whether a finding changes an existing CI. */
export function diffAgainstCi(f: Pick<RawFinding, 'hostname' | 'ipAddress' | 'macAddress' | 'serialNumber' | 'model' | 'manufacturer'>, ci: Pick<typeof cis.$inferSelect, 'hostname' | 'ipAddress' | 'macAddress' | 'serialNumber' | 'model' | 'manufacturer'> | null): { status: DiffStatus; changed: string[] } {
  if (!ci) return { status: 'new', changed: [] };
  const changed: string[] = [];
  if (f.hostname && norm(f.hostname) !== norm(ci.hostname)) changed.push('hostname');
  if (f.ipAddress && norm(f.ipAddress) !== norm(ci.ipAddress)) changed.push('ipAddress');
  if (f.macAddress && normaliseMac(f.macAddress) !== normaliseMac(ci.macAddress)) changed.push('macAddress');
  if (f.serialNumber && norm(f.serialNumber) !== norm(ci.serialNumber)) changed.push('serialNumber');
  if (f.model && norm(f.model) !== norm(ci.model)) changed.push('model');
  if (f.manufacturer && norm(f.manufacturer) !== norm(ci.manufacturer)) changed.push('manufacturer');
  return { status: changed.length ? 'changed' : 'unchanged', changed };
}

export interface ReconcileTarget { sourceId: string; runId: string; customerId: string; siteId: string | null }

/**
 * Matches a raw finding to an existing CI (ip → serial → mac → hostname within
 * the customer), computes the diff status, stores the finding and refreshes
 * `lastSeenAt` on the matched CI.
 */
export async function reconcileFinding(tx: Tx, target: ReconcileTarget, raw: RawFinding): Promise<{ finding: FindingRow; changed: string[] }> {
  const matched = await findCiByReference(tx, { customerId: target.customerId, ipAddress: raw.ipAddress, serialNumber: raw.serialNumber, macAddress: raw.macAddress, hostname: raw.hostname ?? raw.fqdn });
  const diff = diffAgainstCi(raw, matched);
  const [finding] = await tx
    .insert(discoveryFindings)
    .values({
      runId: target.runId,
      sourceId: target.sourceId,
      customerId: target.customerId,
      siteId: target.siteId,
      ipAddress: raw.ipAddress,
      hostname: raw.hostname ?? null,
      fqdn: raw.fqdn ?? null,
      macAddress: normaliseMac(raw.macAddress),
      manufacturer: raw.manufacturer ?? null,
      model: raw.model ?? null,
      serialNumber: raw.serialNumber ?? null,
      sysDescr: raw.sysDescr?.slice(0, 2000) ?? null,
      sysObjectId: raw.sysObjectId ?? null,
      suggestedTypeKey: raw.suggestedTypeKey ?? 'other',
      openPorts: raw.openPorts ?? [],
      interfaces: (raw.interfaces ?? []) as unknown as Record<string, unknown>[],
      neighbors: (raw.neighbors ?? []) as unknown as Record<string, unknown>[],
      raw: { ...(raw.raw ?? {}), osName: raw.osName ?? null, osVersion: raw.osVersion ?? null, sysName: raw.sysName ?? null, sysLocation: raw.sysLocation ?? null, sysContact: raw.sysContact ?? null, matchedBy: matched?.matchedBy ?? null, changedFields: diff.changed },
      matchedCiId: matched?.id ?? null,
      diffStatus: diff.status,
      status: 'pending',
    })
    .returning();
  if (matched) await tx.update(cis).set({ lastSeenAt: new Date() }).where(eq(cis.id, matched.id));
  return { finding, changed: diff.changed };
}

/**
 * Applies a finding: creates or updates the CI, replaces interfaces, links
 * LLDP/CDP neighbours with `connected_to` relationships and marks the finding
 * applied. Audit entries are written with the supplied actor.
 */
export async function applyFinding(tx: Tx, finding: FindingRow, actor: AuditActor & { userId: string | null }): Promise<{ ci: typeof cis.$inferSelect; created: boolean; neighborsLinked: number }> {
  const raw = (finding.raw ?? {}) as Record<string, unknown>;
  let existing = finding.matchedCiId ? (await tx.select().from(cis).where(and(eq(cis.id, finding.matchedCiId), eq(cis.customerId, finding.customerId))).limit(1))[0] ?? null : null;
  if (!existing) existing = await findCiByReference(tx, { customerId: finding.customerId, ipAddress: finding.ipAddress, serialNumber: finding.serialNumber, macAddress: finding.macAddress, hostname: finding.hostname ?? finding.fqdn });

  const snmpAttrs = { sysObjectId: finding.sysObjectId ?? null, sysDescr: finding.sysDescr ?? null, sysLocation: (raw.sysLocation as string | null) ?? null, sysContact: (raw.sysContact as string | null) ?? null, sysName: (raw.sysName as string | null) ?? null };
  const now = new Date();
  const fill = {
    ...(finding.hostname ? { hostname: finding.hostname.toLowerCase() } : {}),
    ...(finding.fqdn ? { fqdn: finding.fqdn.toLowerCase() } : {}),
    ipAddress: finding.ipAddress,
    ...(finding.macAddress ? { macAddress: normaliseMac(finding.macAddress) } : {}),
    ...(finding.serialNumber ? { serialNumber: finding.serialNumber } : {}),
    ...(finding.manufacturer ? { manufacturer: finding.manufacturer } : {}),
    ...(finding.model ? { model: finding.model } : {}),
    ...(raw.osName ? { osName: String(raw.osName) } : {}),
    ...(raw.osVersion ? { osVersion: String(raw.osVersion) } : {}),
    discoverySource: 'network_scan',
    lastSeenAt: now,
  };

  let ci: typeof cis.$inferSelect;
  let created = false;
  if (existing) {
    const attributes = { ...(existing.attributes ?? {}), ...(finding.sysDescr || finding.sysObjectId ? { snmp: snmpAttrs } : {}), discovery: { openPorts: finding.openPorts, lastFindingId: finding.id, lastRunId: finding.runId } };
    [ci] = await tx
      .update(cis)
      .set({ ...fill, attributes, discoveredAt: existing.discoveredAt ?? now, updatedAt: now })
      .where(eq(cis.id, existing.id))
      .returning();
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    for (const k of ['hostname', 'fqdn', 'ipAddress', 'macAddress', 'serialNumber', 'manufacturer', 'model', 'osName', 'osVersion'] as const) {
      if (fill[k as keyof typeof fill] !== undefined && (existing[k] ?? null) !== (ci[k] ?? null)) changes[k] = { old: existing[k] ?? null, new: ci[k] ?? null };
    }
    await writeAudit(tx, actor, { entityType: 'ci', entityId: ci.id, entityLabel: ci.name, action: 'discovery.update', customerId: ci.customerId, changes, metadata: { findingId: finding.id, runId: finding.runId } });
  } else {
    const type = (await typeByKey(tx, finding.suggestedTypeKey ?? 'other')) ?? (await typeByKey(tx, 'other'));
    if (!type) throw new Error('CI type "other" is missing; seed CI types first');
    [ci] = await tx
      .insert(cis)
      .values({
        customerId: finding.customerId,
        siteId: finding.siteId,
        typeId: type.id,
        name: finding.hostname ?? finding.ipAddress,
        ...fill,
        status: 'active',
        attributes: { ...(finding.sysDescr || finding.sysObjectId ? { snmp: snmpAttrs } : {}), discovery: { openPorts: finding.openPorts, lastFindingId: finding.id, lastRunId: finding.runId } },
        discoveredAt: now,
      })
      .returning();
    created = true;
    await writeAudit(tx, actor, { entityType: 'ci', entityId: ci.id, entityLabel: ci.name, action: 'discovery.create', customerId: ci.customerId, metadata: { findingId: finding.id, runId: finding.runId, typeKey: type.key } });
  }

  const interfaces = (finding.interfaces ?? []) as { name?: string; ifIndex?: number | null; description?: string | null; macAddress?: string | null; ipAddress?: string | null; speedMbps?: number | null; adminStatus?: string | null; operStatus?: string | null }[];
  if (interfaces.length) await replaceInterfaces(tx, ci, interfaces.filter((i) => i.name).map((i) => ({ ...i, name: String(i.name) })));

  // LLDP / CDP neighbours → connected_to relationships (only to CIs we already know in this customer)
  let neighborsLinked = 0;
  const neighbors = (finding.neighbors ?? []) as { remoteSysName?: string | null; remoteIp?: string | null; remotePort?: string | null; localPort?: string | null; protocol?: string }[];
  if (neighbors.length) {
    const [relType] = await tx.select().from(ciRelationshipTypes).where(eq(ciRelationshipTypes.key, 'connected_to')).limit(1);
    if (relType) {
      const seen = new Set<string>();
      for (const n of neighbors.slice(0, 64)) {
        const key = `${n.remoteSysName ?? ''}|${n.remoteIp ?? ''}`;
        if (seen.has(key) || (!n.remoteSysName && !n.remoteIp)) continue;
        seen.add(key);
        const other = await findCiByReference(tx, { customerId: finding.customerId, hostname: n.remoteSysName, ipAddress: n.remoteIp });
        if (!other || other.id === ci.id) continue;
        const row = await ensureRelationship(tx, { customerId: ci.customerId, sourceCiId: ci.id, targetCiId: other.id, typeId: relType.id, description: [n.localPort, n.remotePort].filter(Boolean).join(' ↔ ') || null, source: 'discovery' }).catch(() => null);
        if (row) {
          neighborsLinked++;
          await writeAudit(tx, actor, { entityType: 'ci_relationship', entityId: row.id, entityLabel: `${ci.name} connected to ${other.name}`, action: 'create', customerId: ci.customerId, metadata: { sourceCiId: ci.id, targetCiId: other.id, typeKey: 'connected_to', source: 'discovery', protocol: n.protocol ?? 'lldp' } });
        }
      }
    }
  }

  await tx.update(discoveryFindings).set({ status: 'applied', appliedAt: now, appliedBy: actor.userId, matchedCiId: ci.id }).where(eq(discoveryFindings.id, finding.id));
  await writeAudit(tx, actor, { entityType: 'discovery_finding', entityId: finding.id, entityLabel: finding.hostname ?? finding.ipAddress, action: created ? 'apply.create' : 'apply.update', customerId: finding.customerId, metadata: { ciId: ci.id, runId: finding.runId, neighborsLinked } });
  return { ci, created, neighborsLinked };
}

/** Marks a finding ignored. */
export async function ignoreFindingTx(tx: Tx, finding: FindingRow, actor: AuditActor & { userId: string | null }) {
  await tx.update(discoveryFindings).set({ status: 'ignored', appliedAt: new Date(), appliedBy: actor.userId }).where(eq(discoveryFindings.id, finding.id));
  await writeAudit(tx, actor, { entityType: 'discovery_finding', entityId: finding.id, entityLabel: finding.hostname ?? finding.ipAddress, action: 'ignore', customerId: finding.customerId, metadata: { runId: finding.runId, ciId: finding.matchedCiId } });
}

/** Pending findings count per source (for list screens). */
export const pendingFindingsSql = (sourceIdCol: unknown) => sql<number>`(select count(*)::int from ${discoveryFindings} f where f.source_id = ${sourceIdCol} and f.status = 'pending' and f.diff_status <> 'unchanged')`;
export const findingOwnerCondition = (customerId: string, ciId: string) => or(eq(discoveryFindings.customerId, customerId), eq(discoveryFindings.matchedCiId, ciId));
