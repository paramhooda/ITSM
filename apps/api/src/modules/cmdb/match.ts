import { and, eq, sql, type SQL } from 'drizzle-orm';
import { schema, type Tx } from '@/db/client';

export interface CiReference {
  customerId?: string | null;
  monitoringRef?: string | null;
  siemRef?: string | null;
  hostname?: string | null;
  fqdn?: string | null;
  ipAddress?: string | null;
  serialNumber?: string | null;
  macAddress?: string | null;
}

export type MatchedBy = 'monitoringRef' | 'siemRef' | 'ipAddress' | 'serialNumber' | 'macAddress' | 'hostname';

export const normaliseMac = (mac?: string | null) => {
  if (!mac) return null;
  const hex = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length !== 12) return mac.trim().toLowerCase() || null;
  return hex.match(/.{2}/g)!.join(':');
};

/**
 * Resolves a CI from an external reference (monitoring events, discovery,
 * SIEM). Precedence: monitoring/SIEM reference → IP → serial → MAC → hostname
 * (case-insensitive, also matches the short name of an FQDN). Runs on the
 * caller's transaction so RLS applies; `customerId` narrows the search and is
 * strongly recommended because IPs overlap between customers.
 */
export async function findCiByReference(tx: Tx, ref: CiReference): Promise<(typeof schema.cis.$inferSelect & { matchedBy: MatchedBy }) | null> {
  const { cis } = schema;
  const scope: SQL[] = ref.customerId ? [eq(cis.customerId, ref.customerId)] : [];
  const tryFind = async (cond: SQL, matchedBy: MatchedBy) => {
    const [row] = await tx.select().from(cis).where(and(...scope, cond)).orderBy(sql`${cis.status} = 'retired'`, sql`${cis.lastSeenAt} desc nulls last`).limit(1);
    return row ? { ...row, matchedBy } : null;
  };
  if (ref.monitoringRef?.trim()) {
    const hit = await tryFind(eq(cis.monitoringRef, ref.monitoringRef.trim()), 'monitoringRef');
    if (hit) return hit;
  }
  if (ref.siemRef?.trim()) {
    const hit = await tryFind(eq(cis.siemRef, ref.siemRef.trim()), 'siemRef');
    if (hit) return hit;
  }
  if (ref.ipAddress?.trim()) {
    const hit = await tryFind(eq(cis.ipAddress, ref.ipAddress.trim()), 'ipAddress');
    if (hit) return hit;
  }
  if (ref.serialNumber?.trim()) {
    const hit = await tryFind(sql`lower(${cis.serialNumber}) = lower(${ref.serialNumber.trim()})`, 'serialNumber');
    if (hit) return hit;
  }
  const mac = normaliseMac(ref.macAddress);
  if (mac) {
    const hit = await tryFind(sql`lower(regexp_replace(coalesce(${cis.macAddress}, ''), '[^0-9a-fA-F]', '', 'g')) = ${mac.replace(/:/g, '')}`, 'macAddress');
    if (hit) return hit;
  }
  const host = (ref.hostname ?? ref.fqdn)?.trim().toLowerCase();
  if (host) {
    const short = host.split('.')[0];
    const hit = await tryFind(
      sql`(lower(${cis.hostname}) = ${host} or lower(${cis.fqdn}) = ${host} or lower(${cis.name}) = ${host} or split_part(lower(coalesce(${cis.hostname}, '')), '.', 1) = ${short} or split_part(lower(coalesce(${cis.fqdn}, '')), '.', 1) = ${short})`,
      'hostname',
    );
    if (hit) return hit;
  }
  return null;
}
