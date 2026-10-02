import { gte, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import { customer, type DemoState } from './state';
import { addDays, addMinutes, atIst, istWeekday } from './rng';

/**
 * The ticket, entitlement and approval services queued hundreds of emails and
 * in-app notifications while the history was replayed - all stamped "now" and
 * addressed to demo mailboxes. Remove them; a curated set is inserted instead.
 */
export async function cleanupNotifications(state: DemoState, tx: Tx) {
  const since = new Date(state.seedStartedAt.getTime() - 60_000);
  const out = await tx.delete(schema.notificationOutbox).where(gte(schema.notificationOutbox.createdAt, since)).returning({ id: schema.notificationOutbox.id });
  const inApp = await tx.delete(schema.notifications).where(gte(schema.notifications.createdAt, since)).returning({ id: schema.notifications.id });
  state.counts.notificationsPurged = out.length + inApp.length;
}

function nextWeekday(from: Date, weekday: number, hour: number): Date {
  let d = atIst(addDays(from, 1), hour, 0);
  for (let i = 0; i < 8 && istWeekday(d) !== weekday; i++) d = atIst(addDays(d, 1), hour, 0);
  return d;
}

export async function seedExtras(state: DemoState, tx: Tx) {
  const { now, refs, rng } = state;
  const admin = state.admin;
  const abc = customer(state, 'abc');
  const meridian = customer(state, 'meridian');
  const apex = customer(state, 'apex');
  const ananya = state.users.get('ananya')!;
  const vikram = state.users.get('vikram')!;
  const lakshmi = state.users.get('lakshmi')!;
  const rajesh = state.users.get('rajesh')!;

  // ---------------------------------------------------------------- report schedules
  const firstOfNextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 3, 30));
  await tx.insert(schema.reportSchedules).values([
    { name: 'ABC Manufacturing - weekly SLA report', reportKey: 'sla_performance', customerId: abc.id, recipients: [abc.contacts.find((c) => c.isPrimary)!.email, vikram.email], recipientUserIds: [vikram.id, ananya.id], frequency: 'weekly', timezone: 'Asia/Kolkata', dateRange: 'last_7_days', filters: { groupBy: 'priority', includeBreaches: true }, format: 'both', delivery: 'both', isActive: true, lastRunAt: nextWeekday(addDays(now, -8), 1, 8), nextRunAt: nextWeekday(now, 1, 8), createdBy: admin.id },
    { name: 'Meridian Bank - monthly service report', reportKey: 'service_report', customerId: meridian.id, recipients: [meridian.contacts.find((c) => c.isPrimary)!.email, 'rakesh.chandra@meridianbank.example', vikram.email], recipientUserIds: [vikram.id, ananya.id], frequency: 'monthly', timezone: 'Asia/Kolkata', dateRange: 'last_month', filters: { sections: ['executive_summary', 'incidents', 'sla', 'changes', 'security', 'entitlements'] }, format: 'html', delivery: 'both', isActive: true, lastRunAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 3, 30)), nextRunAt: firstOfNextMonth, createdBy: admin.id },
    { name: 'MSP-wide daily open tickets', reportKey: 'open_tickets', customerId: null, recipients: ['noc@msp.local', 'servicedesk@msp.local'], recipientUserIds: [rajesh.id, ananya.id], frequency: 'daily', timezone: 'Asia/Kolkata', dateRange: 'last_day', filters: { statusCategories: ['new', 'open', 'pending'], groupBy: 'team' }, format: 'html', delivery: 'email', isActive: true, lastRunAt: atIst(now, 7, 0), nextRunAt: atIst(addDays(now, 1), 7, 0), createdBy: admin.id },
    { name: 'Monthly AMC utilisation (all customers)', reportKey: 'amc_utilization', customerId: null, recipients: [lakshmi.email, vikram.email], recipientUserIds: [lakshmi.id, vikram.id], frequency: 'monthly', timezone: 'Asia/Kolkata', dateRange: 'month_to_date', filters: { contractTypes: ['amc'], includeConsumptions: true, perCustomer: true }, format: 'csv', delivery: 'email', isActive: true, lastRunAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 4, 0)), nextRunAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 4, 0)), createdBy: admin.id },
  ]);
  state.counts.reportSchedules = 4;

  // ---------------------------------------------------------------- curated in-app notifications
  const tickets = [...state.tickets.values()];
  const p1 = tickets.filter((t) => t.priorityKey === 'p1' && t.type === 'incident').sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const openP1 = p1.find((t) => t.open) ?? p1[0];
  const recentOpen = tickets.filter((t) => t.open).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const change = tickets.find((t) => t.type === 'change' && t.open);
  const apexContract = apex.contracts.find((c) => c.status === 'expiring')!;
  const abcAmc = abc.contracts.find((c) => c.typeKey === 'amc')!;
  const custOf = (key: string) => customer(state, key);
  const rows: (typeof schema.notifications.$inferInsert)[] = [];
  const push = (userId: string, event: string, title: string, body: string, link: string | null, entityType: string | null, entityId: string | null, customerId: string | null, minutesAgo: number, read = false) =>
    rows.push({ userId, customerId, event, title, body, link, entityType, entityId, readAt: read ? addMinutes(now, -minutesAgo + 5) : null, createdAt: addMinutes(now, -minutesAgo) });
  if (openP1) push(admin.id, 'ticket.escalated', `P1 escalated: ${openP1.number} ${openP1.title}`, 'Resolution SLA breached; escalation level raised to 2 and management notified.', `/tickets/${openP1.id}`, 'ticket', openP1.id, custOf(openP1.customerKey).id, 45);
  if (recentOpen[0]) push(admin.id, 'ticket.created', `New ${recentOpen[0].type}: ${recentOpen[0].number}`, recentOpen[0].title, `/tickets/${recentOpen[0].id}`, 'ticket', recentOpen[0].id, custOf(recentOpen[0].customerKey).id, 95);
  if (recentOpen[1]) push(admin.id, 'sla.warning', `SLA warning on ${recentOpen[1].number}`, `Resolution clock at 80% for "${recentOpen[1].title}".`, `/tickets/${recentOpen[1].id}`, 'ticket', recentOpen[1].id, custOf(recentOpen[1].customerKey).id, 130);
  push(admin.id, 'contract.expiring', `Contract ${apexContract.number} expires in 30 days`, `${apex.name} - ${apexContract.name}. Renewal proposal sent; follow up with the account manager.`, `/contracts/${apexContract.id}`, 'contract', apexContract.id, apex.id, 6 * 60);
  push(admin.id, 'entitlement.threshold', `Entitlement at 83%: Breakdown site visits (${abcAmc.number})`, `${abc.name} has used 10 of 12 breakdown site visits in the current period.`, `/contracts/${abcAmc.id}`, 'contract_entitlement', abcAmc.entitlements.find((e) => e.typeKey === 'site_visits')?.id ?? null, abc.id, 26 * 60, true);
  if (change) push(admin.id, 'change.approval_requested', `CAB approval requested: ${change.number}`, change.title, `/tickets/${change.id}`, 'ticket', change.id, custOf(change.customerKey).id, 3 * 60);
  push(admin.id, 'pm.due', 'PM visits due in the next 14 days', 'Scheduled preventive maintenance occurrences are waiting for engineer confirmation.', '/field/pm', null, null, null, 20 * 60, true);
  push(admin.id, 'report.delivered', 'Weekly SLA report delivered - ABC Manufacturing', 'The weekly SLA compliance report was emailed to the configured recipients.', '/reports', null, null, abc.id, 2 * 24 * 60, true);
  // A few for the people who would act on them
  if (openP1) push(rajesh.id, 'ticket.escalated', `P1 escalated: ${openP1.number}`, openP1.title, `/tickets/${openP1.id}`, 'ticket', openP1.id, custOf(openP1.customerKey).id, 45);
  push(vikram.id, 'contract.expiring', `Contract ${apexContract.number} expires in 30 days`, `${apex.name} - ${apexContract.name}`, `/contracts/${apexContract.id}`, 'contract', apexContract.id, apex.id, 6 * 60);
  push(lakshmi.id, 'entitlement.threshold', `Entitlement at 83%: Breakdown site visits (${abcAmc.number})`, `${abc.name} has used 10 of 12 breakdown site visits.`, `/contracts/${abcAmc.id}`, 'contract_entitlement', null, abc.id, 26 * 60);
  if (change) push(ananya.id, 'change.approval_requested', `CAB approval requested: ${change.number}`, change.title, `/tickets/${change.id}`, 'ticket', change.id, custOf(change.customerKey).id, 3 * 60);
  for (const t of recentOpen.slice(0, 3)) {
    const pu = custOf(t.customerKey).portalUsers[0];
    if (pu) push(pu.id, 'ticket.status_changed', `${t.number} updated`, `"${t.title}" is now being worked by our engineers.`, `/portal/tickets/${t.id}`, 'ticket', t.id, custOf(t.customerKey).id, rng.int(60, 600));
  }
  await tx.insert(schema.notifications).values(rows);
  state.counts.notifications = rows.length;

  // ---------------------------------------------------------------- shared saved views
  const p1Id = refs.option('ticket_priority', 'p1');
  const p2Id = refs.option('ticket_priority', 'p2');
  await tx.insert(schema.savedViews).values([
    { userId: admin.id, name: 'P1/P2 open', entity: 'ticket', filters: { priorityId: `${p1Id},${p2Id}`, statusCategory: 'new,open,pending' }, columns: ['number', 'title', 'customer', 'priority', 'status', 'assignee', 'sla', 'createdAt'], sort: 'priority:asc', isShared: true, isDefault: false, sortOrder: 10 },
    { userId: admin.id, name: 'Unassigned', entity: 'ticket', filters: { unassigned: 'true', statusCategory: 'new,open' }, columns: ['number', 'title', 'customer', 'priority', 'status', 'team', 'createdAt'], sort: 'createdAt:desc', isShared: true, isDefault: false, sortOrder: 20 },
    { userId: admin.id, name: 'Breached SLA', entity: 'ticket', filters: { slaState: 'breached', statusCategory: 'new,open,pending' }, columns: ['number', 'title', 'customer', 'priority', 'status', 'assignee', 'sla', 'dueAt'], sort: 'dueAt:asc', isShared: true, isDefault: false, sortOrder: 30 },
    { userId: rajesh.id, name: 'My NOC queue', entity: 'ticket', filters: { teamId: refs.team('noc'), statusCategory: 'new,open,pending', domain: 'noc' }, columns: ['number', 'title', 'customer', 'priority', 'status', 'assignee', 'sla'], sort: 'priority:asc', isShared: false, isDefault: true, sortOrder: 40 },
  ]);
  state.counts.savedViews = 4;
  await tx.execute(sql`SELECT 1`);
}
