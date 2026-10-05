import { and, eq, sql } from 'drizzle-orm';
import { INSTALL_SOURCES } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { parseCsv, headerIndex, rowValue, CSV_LIMITS } from '@/modules/assets/csv';
import { findCiByReference } from '@/modules/cmdb/match';
import { loadSoftwareSettings } from './settings';
import { productKey, findInstallation, titleOf } from './service';
import { SOFTWARE_IMPORT_COLUMNS } from './schemas';

/**
 * CSV import of installations for one customer: one row per title on one
 * host. The title is resolved (and, when the setting allows, created) by its
 * normalised key; the host by asset tag, then serial number, then host name;
 * a row that matches an existing installation updates it. Every row runs in a
 * savepoint so one bad row never spoils the file.
 */

export interface ImportResult { created: number; updated: number; skipped: number; errors: { row: number; message: string }[] }

const { softwareProducts: products, softwareInstallations: installs, assets, cis } = schema;

function parseDate(v?: string): string | null | undefined {
  if (v === undefined) return undefined;
  const s = v.trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  throw new Error(`Unrecognised date "${s}"`);
}

export async function importInstallations(ctx: Ctx, customerId: string, csv: Buffer): Promise<ImportResult> {
  ctx.requireCustomer(customerId);
  ctx.require('software:manage', customerId);
  if (csv.length > CSV_LIMITS.maxBytes) throw new ValidationError('CSV file is too large (max 10 MB)');
  const table = parseCsv(csv, { maxRows: CSV_LIMITS.maxRows });
  if (!table.headers.length) throw new ValidationError('CSV file is empty');
  const idx = headerIndex(table.headers);
  if (!idx('publisher') || !idx('product')) throw new ValidationError(`CSV must contain "publisher" and "product" columns. Expected columns: ${SOFTWARE_IMPORT_COLUMNS.join(', ')}`);
  const settings = await loadSoftwareSettings(ctx.tx);
  const productCache = new Map<string, typeof products.$inferSelect>();
  // The key of a title created inside the current row's savepoint: a rollback of that row removes the title again, so the cache must forget it too.
  let createdKey: string | null = null;
  const now = new Date();

  const resolveProduct = async (publisher: string, name: string, versionFamily?: string) => {
    const key = productKey(publisher, name, versionFamily);
    const cached = productCache.get(key);
    if (cached) return cached;
    const [found] = await ctx.tx.select().from(products).where(eq(products.key, key)).limit(1);
    if (found) {
      productCache.set(key, found);
      return found;
    }
    if (!settings.importCreatesProducts) throw new Error(`Unknown title "${publisher} ${name}${versionFamily ? ` ${versionFamily}` : ''}"`);
    const [created] = await ctx.tx.insert(products).values({ key, publisher: publisher.trim(), name: name.trim(), versionFamily: versionFamily?.trim() || null, customerId: null }).returning();
    await ctx.audit({ entityType: 'software_product', entityId: created!.id, entityLabel: titleOf(created!), action: 'import_create', customerId: null, metadata: { key } });
    productCache.set(key, created!);
    createdKey = key;
    return created!;
  };

  const resolveHost = async (assetTag?: string, serialNumber?: string, hostname?: string) => {
    let assetId: string | null = null;
    let ciId: string | null = null;
    if (assetTag) {
      const [a] = await ctx.tx.select({ id: assets.id, ciId: assets.ciId }).from(assets).where(and(eq(assets.customerId, customerId), sql`lower(${assets.tag}) = ${assetTag.toLowerCase()}`)).limit(1);
      if (a) {
        assetId = a.id;
        ciId = a.ciId;
      }
    }
    if (!assetId && serialNumber) {
      const [a] = await ctx.tx.select({ id: assets.id, ciId: assets.ciId }).from(assets).where(and(eq(assets.customerId, customerId), sql`lower(${assets.serialNumber}) = ${serialNumber.toLowerCase()}`)).limit(1);
      if (a) {
        assetId = a.id;
        ciId = a.ciId;
      }
    }
    if (!ciId) {
      const ci = await findCiByReference(ctx.tx, { customerId, serialNumber: !assetId ? serialNumber : null, hostname });
      if (ci) {
        ciId = ci.id;
        if (!assetId && ci.assetId) assetId = ci.assetId;
      }
    }
    if (ciId && !assetId) {
      const [c] = await ctx.tx.select({ assetId: cis.assetId }).from(cis).where(eq(cis.id, ciId)).limit(1);
      assetId = c?.assetId ?? null;
    }
    return { assetId, ciId };
  };

  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] };
  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i]!;
    const v = (n: string) => rowValue(row, idx, n);
    const lineNo = i + 2;
    createdKey = null;
    await ctx.tx.execute(sql`savepoint import_row`);
    try {
      const publisher = v('publisher')?.trim();
      const productName = v('product')?.trim();
      if (!publisher && !productName) {
        result.skipped++;
        await ctx.tx.execute(sql`release savepoint import_row`);
        continue;
      }
      if (!publisher || !productName) throw new Error('Both publisher and product are required');
      const product = await resolveProduct(publisher, productName, v('versionFamily'));
      const hostname = v('hostname')?.trim() || undefined;
      const assignedUser = v('user')?.trim() || null;
      const host = await resolveHost(v('assetTag')?.trim() || undefined, v('serialNumber')?.trim() || undefined, hostname);
      if (!host.ciId && !host.assetId && !hostname && !assignedUser) throw new Error('A row needs a hostname, an asset tag, a serial number or a user');
      const coresRaw = v('cores');
      const cores = coresRaw ? Number(coresRaw) : undefined;
      if (cores !== undefined && (!Number.isInteger(cores) || cores < 1 || cores > 4096)) throw new Error(`Invalid cores "${coresRaw}"`);
      const sourceRaw = v('source')?.trim().toLowerCase();
      const source = sourceRaw && (INSTALL_SOURCES as readonly string[]).includes(sourceRaw) && sourceRaw !== 'manual' ? sourceRaw : 'csv';
      const data = {
        version: v('version')?.trim() || undefined,
        edition: v('edition')?.trim() || undefined,
        cores,
        installedAt: parseDate(v('installedAt')),
        notes: v('notes')?.trim() || undefined,
      };
      const clean = Object.fromEntries(Object.entries(data).filter(([, val]) => val !== undefined));
      const existing = await findInstallation(ctx.tx, { customerId, productId: product.id, ciId: host.ciId, assetId: host.assetId, hostName: hostname, assignedUser });
      if (existing) {
        const values = { ...clean, assignedUser: assignedUser ?? existing.assignedUser, ciId: host.ciId ?? existing.ciId, assetId: host.assetId ?? existing.assetId, hostName: hostname ?? existing.hostName, source, lastSeenAt: now };
        await ctx.tx.update(installs).set({ ...values, updatedAt: now } as never).where(eq(installs.id, existing.id));
        const changes = diffChanges(existing as Record<string, unknown>, values as Record<string, unknown>, ['updatedAt', 'lastSeenAt']);
        if (Object.keys(changes).length) await ctx.audit({ entityType: 'software_installation', entityId: existing.id, entityLabel: `${titleOf(product)} @ ${hostname ?? assignedUser ?? 'host'}`, action: 'import_update', customerId, changes });
        result.updated++;
      } else {
        const [created] = await ctx.tx.insert(installs).values({ ...clean, customerId, productId: product.id, ciId: host.ciId, assetId: host.assetId, hostName: hostname ?? null, assignedUser, source, lastSeenAt: now } as typeof installs.$inferInsert).returning({ id: installs.id });
        await ctx.audit({ entityType: 'software_installation', entityId: created!.id, entityLabel: `${titleOf(product)} @ ${hostname ?? assignedUser ?? 'host'}`, action: 'import_create', customerId, metadata: { productId: product.id, ciId: host.ciId, assetId: host.assetId } });
        result.created++;
      }
      await ctx.tx.execute(sql`release savepoint import_row`);
    } catch (err) {
      await ctx.tx.execute(sql`rollback to savepoint import_row`);
      if (createdKey) productCache.delete(createdKey);
      result.errors.push({ row: lineNo, message: (err as Error).message });
      if (result.errors.length > 200) {
        result.errors.push({ row: lineNo, message: 'Too many errors; import aborted' });
        break;
      }
    }
  }
  await ctx.audit({ entityType: 'software_installation', action: 'import', customerId, metadata: { created: result.created, updated: result.updated, skipped: result.skipped, errors: result.errors.length } });
  return result;
}
