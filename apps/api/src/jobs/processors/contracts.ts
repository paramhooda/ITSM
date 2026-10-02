import { eq, and, inArray, lt, gte, sql } from 'drizzle-orm';
import { registerProcessor, registerSchedule } from '../workers';
import { withSystem, schema, type Tx } from '@/db/client';
import { logger } from '@/core/logger';
import { writeAudit } from '@/core/audit';
import { queueNotification } from '@/modules/notifications/dispatch';
import { todayStr, addDays, daysToExpiry, contractRecipients, claimMilestone, contractLink, type ContractRow, type CustomerRow } from '@/modules/contracts/common';
import { checkEntitlementThreshold } from '@/modules/contracts/entitlements';

const SYSTEM_ACTOR = { userId: null, userName: 'system', source: 'system' };
const DEFAULT_NOTICE = [90, 60, 30, 7];

async function noticeDays(tx: Tx): Promise<number[]> {
  const [row] = await tx.select({ value: schema.systemSettings.value }).from(schema.systemSettings).where(eq(schema.systemSettings.key, 'contracts.expiry_notice_days')).limit(1);
  const list = Array.isArray(row?.value) ? (row!.value as unknown[]).map(Number).filter((n) => !isNaN(n) && n >= 0) : DEFAULT_NOTICE;
  return [...new Set(list.length ? list : DEFAULT_NOTICE)].sort((a, b) => b - a);
}

const contractData = (c: ContractRow, customer: Pick<CustomerRow, 'id' | 'name' | 'code'>, now: Date) => ({
  contract: { id: c.id, number: c.number, name: c.name, customerName: customer.name, customerCode: customer.code, startDate: c.startDate, endDate: c.endDate, renewalDate: c.renewalDate, status: c.status, link: contractLink(c.id) },
  customer: { id: customer.id, name: customer.name, code: customer.code },
  daysLeft: daysToExpiry(c.endDate, now),
});

/** Phase 1: status transitions (active/expiring → expired, active → expiring). */
export async function transitionContractStatuses(now = new Date()) {
  const today = todayStr(now);
  const c = schema.contracts;
  return withSystem(async (tx) => {
    const thresholds = await noticeDays(tx);
    const maxNotice = Math.max(0, ...thresholds);
    const toExpire = await tx.select().from(c).where(and(inArray(c.status, ['active', 'expiring']), lt(c.endDate, today)));
    for (const row of toExpire) {
      await tx.update(c).set({ status: 'expired', updatedAt: now }).where(eq(c.id, row.id));
      await writeAudit(tx, SYSTEM_ACTOR, { entityType: 'contract', entityId: row.id, entityLabel: `${row.number} ${row.name}`, action: 'expire', customerId: row.customerId, changes: { status: { old: row.status, new: 'expired' } }, metadata: { contractId: row.id, endDate: row.endDate } });
    }
    const toExpiring = await tx
      .select()
      .from(c)
      .where(and(eq(c.status, 'active'), gte(c.endDate, today), sql`${c.endDate} <= ${today}::date + greatest(coalesce(${c.noticePeriodDays}, 0), ${maxNotice}::int)`));
    for (const row of toExpiring) {
      await tx.update(c).set({ status: 'expiring', updatedAt: now }).where(eq(c.id, row.id));
      await writeAudit(tx, SYSTEM_ACTOR, { entityType: 'contract', entityId: row.id, entityLabel: `${row.number} ${row.name}`, action: 'expiring', customerId: row.customerId, changes: { status: { old: 'active', new: 'expiring' } }, metadata: { contractId: row.id, endDate: row.endDate, daysLeft: daysToExpiry(row.endDate, now) } });
    }
    return { expired: toExpire.length, expiring: toExpiring.length };
  });
}

/** Phase 2: expiring / expired / renewal due / missing documents notifications (each once per contract milestone). */
export async function sendContractNotifications(now = new Date()) {
  const today = todayStr(now);
  const c = schema.contracts;
  const rows = await withSystem((tx) =>
    tx
      .select({ contract: c, customer: { id: schema.customers.id, name: schema.customers.name, code: schema.customers.code, accountManagerId: schema.customers.accountManagerId } })
      .from(c)
      .innerJoin(schema.customers, eq(schema.customers.id, c.customerId))
      .where(and(inArray(c.status, ['active', 'expiring', 'expired']), gte(c.endDate, addDays(today, -30)))),
  );
  const thresholds = await withSystem(noticeDays);
  let sent = 0;
  for (const { contract, customer } of rows) {
    await withSystem(async (tx) => {
      const recipients = () => contractRecipients(tx, contract, customer);
      const data = contractData(contract, customer, now);
      const base = { customerId: contract.customerId, entityType: 'contract', entityId: contract.id, link: contractLink(contract.id) };
      const live = contract.status === 'active' || contract.status === 'expiring';
      if (live && data.daysLeft >= 0) {
        // one message per crossing; catching up after downtime still sends a single message
        let due = false;
        for (const d of thresholds) if (data.daysLeft <= d && (await claimMilestone(tx, contract.id, contract.customerId, `expiring:${d}`))) due = true;
        if (due) {
          await queueNotification(tx, { ...base, event: 'contract.expiring', recipients: await recipients(), data });
          sent++;
        }
      }
      if (contract.status === 'expired' && (await claimMilestone(tx, contract.id, contract.customerId, 'expired'))) {
        await queueNotification(tx, { ...base, event: 'contract.expired', recipients: await recipients(), data });
        sent++;
      }
      if (live && contract.renewalDate && contract.renewalDate <= addDays(today, 30) && contract.renewalDate >= addDays(today, -30) && (await claimMilestone(tx, contract.id, contract.customerId, 'renewal_due'))) {
        await queueNotification(tx, { ...base, event: 'contract.renewal_due', recipients: await recipients(), data: { ...data, daysToRenewal: daysToExpiry(contract.renewalDate, now) } });
        sent++;
      }
      if (live) {
        const [{ docs }] = await tx
          .select({ docs: sql<number>`count(*)::int` })
          .from(schema.attachments)
          .where(and(eq(schema.attachments.entityType, 'contract'), eq(schema.attachments.entityId, contract.id), inArray(schema.attachments.docType, ['agreement', 'po'])));
        if (docs === 0 && (await claimMilestone(tx, contract.id, contract.customerId, 'missing_documents'))) {
          await queueNotification(tx, { ...base, event: 'contract.missing_documents', recipients: await recipients(), data, channels: ['in_app', 'email'] });
          sent++;
        }
      }
    });
  }
  return { contracts: rows.length, sent };
}

/** Phase 3: entitlement threshold / exhaustion for every active entitlement on a covering contract. */
export async function checkEntitlements(now = new Date()) {
  const rows = await withSystem((tx) =>
    tx
      .select({ ent: schema.contractEntitlements, contract: schema.contracts })
      .from(schema.contractEntitlements)
      .innerJoin(schema.contracts, eq(schema.contracts.id, schema.contractEntitlements.contractId))
      .where(and(eq(schema.contractEntitlements.isActive, true), inArray(schema.contracts.status, ['active', 'expiring']))),
  );
  let notified = 0;
  for (const { ent, contract } of rows) {
    const { notification } = await withSystem((tx) => checkEntitlementThreshold(tx, ent, contract, now));
    if (notification) notified++;
  }
  return { checked: rows.length, notified };
}

/** The daily 06:00 run (also callable from tests / an admin action). */
export async function runContractsDaily(now = new Date()) {
  const transitions = await transitionContractStatuses(now);
  const notifications = await sendContractNotifications(now);
  const entitlements = await checkEntitlements(now);
  const stats = { ...transitions, notificationsSent: notifications.sent, contractsScanned: notifications.contracts, entitlementsChecked: entitlements.checked, entitlementsNotified: entitlements.notified };
  logger.info(stats, 'contracts daily run complete');
  return stats;
}

registerSchedule({ queue: 'maintenance', jobName: 'contracts-daily', pattern: '0 6 * * *' });
registerProcessor({ queue: 'maintenance', jobName: 'contracts-daily', processor: async () => runContractsDaily() });
