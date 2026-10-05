import { and, eq, gte, inArray, isNotNull, isNull } from 'drizzle-orm';
import { registerProcessor, registerSchedule } from '../workers';
import { withSystem, schema, type Tx } from '@/db/client';
import { logger } from '@/core/logger';
import { config } from '@/config';
import { queueNotification } from '@/modules/notifications/dispatch';
import { contractRecipients } from '@/modules/contracts/common';
import { systemCtx } from '@/modules/tickets/common';
import { todayStr, addDays, daysBetween } from '@/core/overview';
import { complianceFor, positionLabel, type CompliancePosition } from '@/modules/software/compliance';
import { loadSoftwareSettings, type SoftwareSettings } from '@/modules/software/settings';
import { claimSoftwareMilestone, clearSoftwareMilestone, titleOf } from '@/modules/software/service';

/**
 * Software daily run (06:30): licence notifications at each notice threshold
 * and the day after expiry, and one over-deployment alert per title and
 * customer while the position is over-deployed or unlicensed. Every message
 * is claimed as a milestone first, so catching up after downtime still sends
 * one message per crossing; a renewed licence is never nagged about.
 */

const base = config.APP_URL.replace(/\/$/, '');
export const licenceLink = (id: string) => `${base}/assets/software/licences/${id}`;
export const complianceLink = (customerId: string, productId: string) => `${base}/assets/software/compliance?customerId=${customerId}&productId=${productId}`;

type Scan = { settings: SoftwareSettings; positions: Map<string, CompliancePosition> };

async function scan(tx: Tx): Promise<Scan> {
  const settings = await loadSoftwareSettings(tx);
  const rows = await complianceFor(systemCtx(tx, 'software-daily'), {});
  return { settings, positions: new Map(rows.map((p) => [`${p.customerId}:${p.productId}`, p])) };
}

const complianceData = (p: CompliancePosition | undefined, customerId: string, productId: string) => ({
  installed: p?.installed ?? 0,
  entitled: p?.entitled ?? 0,
  metric: p?.metric ?? null,
  position: p?.position ?? 'compliant',
  positionLabel: positionLabel(p?.position ?? 'compliant').toLowerCase(),
  link: complianceLink(customerId, productId),
});

/** Phase 1: `licence.expiring` once per threshold crossing, `licence.expired` once the day after the end date. */
export async function sendLicenceNotifications(now = new Date(), prepared?: Scan) {
  const today = todayStr(now);
  const l = schema.softwareLicences;
  const p = schema.softwareProducts;
  const c = schema.customers;
  const rows = await withSystem((tx) =>
    tx
      .select({ licence: l, product: { publisher: p.publisher, name: p.name, versionFamily: p.versionFamily }, customer: { id: c.id, name: c.name, code: c.code, accountManagerId: c.accountManagerId } })
      .from(l)
      .innerJoin(p, eq(p.id, l.productId))
      .innerJoin(c, eq(c.id, l.customerId))
      .where(and(eq(l.isActive, true), isNull(l.successorId), isNotNull(l.endDate), gte(l.endDate, addDays(today, -30)))),
  );
  const { settings, positions } = prepared ?? (await withSystem(scan));
  let sent = 0;
  for (const { licence, product, customer } of rows) {
    const daysLeft = daysBetween(today, licence.endDate!);
    await withSystem(async (tx) => {
      const recipients = () => contractRecipients(tx, { customerId: licence.customerId, ownerUserId: licence.ownerUserId ?? null }, customer);
      const data = {
        licence: { id: licence.id, name: licence.name, quantity: Number(licence.quantity), metric: licence.metric, term: licence.term, startDate: licence.startDate, endDate: licence.endDate, renewalDate: licence.renewalDate, customerName: customer.name, link: licenceLink(licence.id) },
        product: { ...product, title: titleOf(product) },
        customer: { id: customer.id, name: customer.name, code: customer.code },
        compliance: complianceData(positions.get(`${licence.customerId}:${licence.productId}`), licence.customerId, licence.productId),
        daysLeft,
      };
      const envelope = { customerId: licence.customerId, entityType: 'software_licence', entityId: licence.id, link: licenceLink(licence.id) };
      if (daysLeft >= 0) {
        let due = false;
        for (const d of settings.noticeDays) if (daysLeft <= d && (await claimSoftwareMilestone(tx, { customerId: licence.customerId, scopeType: 'licence', scopeId: licence.id, milestone: `expiring:${d}` }))) due = true;
        if (due) {
          await queueNotification(tx, { ...envelope, event: 'licence.expiring', recipients: await recipients(), data });
          sent++;
        }
      } else if (await claimSoftwareMilestone(tx, { customerId: licence.customerId, scopeType: 'licence', scopeId: licence.id, milestone: 'expired' })) {
        await queueNotification(tx, { ...envelope, event: 'licence.expired', recipients: await recipients(), data });
        sent++;
      }
    });
  }
  return { licences: rows.length, sent };
}

/** Phase 2: `software.over_deployed` once per title and customer while over-deployed or unlicensed; the milestone is cleared when the position recovers. */
export async function sendComplianceNotifications(prepared?: Scan) {
  const { positions } = prepared ?? (await withSystem(scan));
  let sent = 0;
  let cleared = 0;
  const customerIds = [...new Set([...positions.values()].map((p) => p.customerId))];
  const customers = customerIds.length ? await withSystem((tx) => tx.select({ id: schema.customers.id, name: schema.customers.name, code: schema.customers.code, accountManagerId: schema.customers.accountManagerId }).from(schema.customers).where(inArray(schema.customers.id, customerIds))) : [];
  const customerById = new Map(customers.map((x) => [x.id, x]));
  for (const pos of positions.values()) {
    const customer = customerById.get(pos.customerId);
    if (!customer) continue;
    const milestone = { scopeType: 'product' as const, scopeId: pos.productId, milestone: `over_deployed:${pos.customerId}` };
    await withSystem(async (tx) => {
      if (pos.position === 'over_deployed' || pos.position === 'unlicensed') {
        if (!(await claimSoftwareMilestone(tx, { customerId: pos.customerId, ...milestone }))) return;
        const data = {
          product: { id: pos.productId, publisher: pos.publisher, name: pos.name, versionFamily: pos.versionFamily, title: titleOf(pos) },
          customer: { id: customer.id, name: customer.name, code: customer.code },
          compliance: complianceData(pos, pos.customerId, pos.productId),
        };
        await queueNotification(tx, { event: 'software.over_deployed', recipients: await contractRecipients(tx, { customerId: pos.customerId, ownerUserId: null }, customer), customerId: pos.customerId, entityType: 'software_product', entityId: pos.productId, link: complianceLink(pos.customerId, pos.productId), data });
        sent++;
      } else {
        const [existing] = await tx.select({ id: schema.softwareNotifications.id }).from(schema.softwareNotifications).where(and(eq(schema.softwareNotifications.scopeType, 'product'), eq(schema.softwareNotifications.scopeId, pos.productId), eq(schema.softwareNotifications.milestone, milestone.milestone))).limit(1);
        if (existing) {
          await clearSoftwareMilestone(tx, milestone);
          cleared++;
        }
      }
    });
  }
  return { positions: positions.size, sent, cleared };
}

/** The daily 06:30 run (also callable from tests). */
export async function runSoftwareDaily(now = new Date()) {
  const prepared = await withSystem(scan);
  const licences = await sendLicenceNotifications(now, prepared);
  const compliance = await sendComplianceNotifications(prepared);
  const stats = { licencesScanned: licences.licences, licenceNotificationsSent: licences.sent, positionsScanned: compliance.positions, overDeployedSent: compliance.sent, milestonesCleared: compliance.cleared };
  logger.info(stats, 'software daily run complete');
  return stats;
}

registerSchedule({ queue: 'maintenance', jobName: 'software-daily', pattern: '30 6 * * *' });
registerProcessor({ queue: 'maintenance', jobName: 'software-daily', concurrency: 1, processor: async () => runSoftwareDaily() });
