/**
 * Known error database: a problem flagged as a known error gets a lifecycle,
 * a permanent-fix change and customer-facing wording; staff search it, the
 * portal sees published entries of its own organisation with the customer
 * wording only, incidents are matched and linked, publishing notifies the
 * organisation's portal users once, the fix change resolves the entry, the
 * draft falls back without a provider, and the report, the search, the
 * dashboards and Grady's tools all respect the same fences.
 * Run with the dev environment sourced: npx vitest run test/known-errors.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { NotFoundError } from '../src/core/errors';
import { changeStatus, createTicket, getTicket, resolveTicket, updateProblemDetails } from '../src/modules/tickets/service';
import { listTickets, ticketStats } from '../src/modules/tickets/list';
import { addLink } from '../src/modules/tickets/activity';
import { loadTicket } from '../src/modules/tickets/common';
import { getPortalTicket } from '../src/modules/portal/service';
import * as kedb from '../src/modules/known-errors/service';
import { listQuerySchema } from '../src/modules/known-errors/schemas';
import { draftCustomerWording } from '../src/modules/known-errors/draft';
import { knowledgeOverview } from '../src/modules/knowledge/overview';
import * as dashboards from '../src/modules/dashboards/service';
import { findReport } from '../src/modules/reports/registry';
import '../src/modules/reports/definitions';
import { postgresSearchProvider } from '../src/modules/search/postgres';
import { ALL_TOOLS, listQuery } from '../src/modules/ai/tools';
import * as ai from '../src/modules/ai/service';
import type { ChatResponse } from '../src/lib/ai';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-kedb-${S}`, ip: '127.0.0.1' };
const WORKAROUND = 'Rerun the job after 04:00';
const SUMMARY = 'Nightly backups of some servers report a failure on the first attempt and succeed on retry.';
const CUSTOMER_WORKAROUND = 'No action is needed on your side; our team reruns failed jobs after 04:00 and verifies the backup.';
const ids = { a: '', b: '', service: '', mgr: '', desk: '', userA: '', userB: '', userC: '', role: '', p1: '', p2: '', p3: '', p4: '', c1: '', c2: '', c3: '', i1: '', i2: '', i3: '', r1: '' };
const numbers = { p1: '', p2: '', p3: '', p4: '', c1: '', c2: '', i1: '', i3: '' };
let mgr: Principal;
let desk: Principal;
let portalA: Principal;
let portalB: Principal;
let portalC: Principal;
const asMgr = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(mgr, meta, fn);
const asDesk = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(desk, meta, fn);
const asA = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portalA, meta, fn);
const asB = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portalB, meta, fn);
const asC = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portalC, meta, fn);
const json = (o: unknown): ChatResponse => ({ text: JSON.stringify(o), toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } });
const lq = (q: Record<string, unknown>) => listQuerySchema.parse(q);
const tool = (name: string) => ALL_TOOLS.find((t) => t.name === name)!;
const setSetting = (key: string, value: unknown) => withSystem((tx) => tx.update(schema.systemSettings).set({ value: value as never }).where(eq(schema.systemSettings.key, key)));
const pdRow = (id: string) => withSystem(async (tx) => (await tx.select().from(schema.problemDetails).where(eq(schema.problemDetails.ticketId, id)).limit(1))[0]!);
const auditRows = (id: string, action: string) => withSystem((tx) => tx.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, id), eq(schema.auditLog.action, action))));
const loadStatusKey = (id: string) => withSystem(async (tx) => (await tx.select({ key: schema.configOptions.key }).from(schema.tickets).innerJoin(schema.configOptions, eq(schema.configOptions.id, schema.tickets.statusId)).where(eq(schema.tickets.id, id)).limit(1))[0]?.key);

async function roleId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  if (!row) throw new Error(`role ${key} missing (seed not applied?)`);
  return row.id;
}

beforeAll(async () => {
  ai.setProviderForTests({ name: 'stub', model: 'stub', chat: async () => json({ summary: SUMMARY, workaround: CUSTOMER_WORKAROUND }) });
  await withSystem(async (tx) => {
    const [a] = await tx.insert(schema.customers).values({ code: `KEA${S.toUpperCase()}`, name: `Known Error Customer A ${S}` }).returning();
    const [b] = await tx.insert(schema.customers).values({ code: `KEB${S.toUpperCase()}`, name: `Known Error Customer B ${S}` }).returning();
    ids.a = a!.id;
    ids.b = b!.id;
    await tx.insert(schema.sites).values([{ customerId: a!.id, code: 'HQ', name: `A HQ ${S}`, isPrimary: true }, { customerId: b!.id, code: 'HQ', name: `B HQ ${S}`, isPrimary: true }]);
    const [svc] = await tx.insert(schema.services).values({ key: `ke_svc_${S}`, name: `Backup Service ${S}`, domain: 'noc' }).returning();
    ids.service = svc!.id;
    const mk = async (email: string, name: string, role: string, customerId: string | null, userType: 'msp' | 'customer') => {
      const [u] = await tx.insert(schema.users).values({ email, name, userType, customerId, status: 'active' }).returning();
      await tx.insert(schema.userRoles).values({ userId: u!.id, roleId: await roleId(tx, role), customerId });
      return u!.id;
    };
    ids.mgr = await mk(`ke-mgr-${S}@test.local`, 'Known Error Manager', 'noc_manager', null, 'msp');
    ids.desk = await mk(`ke-desk-${S}@test.local`, 'Known Error Desk', 'service_desk', null, 'msp');
    ids.userA = await mk(`ke-a-${S}@test.local`, 'Portal User A', 'customer_user', a!.id, 'customer');
    ids.userB = await mk(`ke-b-${S}@test.local`, 'Portal User B', 'customer_user', b!.id, 'customer');
    // A portal user of A without portal:kedb: a custom role with portal:access and portal:tickets only.
    const [limited] = await tx.insert(schema.roles).values({ key: `ke_limited_${S}`, name: `Limited portal ${S}`, userType: 'customer' }).returning();
    ids.role = limited!.id;
    await tx.insert(schema.rolePermissions).values([{ roleId: limited!.id, permission: 'portal:access' }, { roleId: limited!.id, permission: 'portal:tickets' }]);
    const [c] = await tx.insert(schema.users).values({ email: `ke-c-${S}@test.local`, name: 'Portal User C', userType: 'customer', customerId: a!.id, status: 'active' }).returning();
    ids.userC = c!.id;
    await tx.insert(schema.userRoles).values({ userId: c!.id, roleId: limited!.id, customerId: a!.id });
  });
  for (const id of [ids.mgr, ids.desk, ids.userA, ids.userB, ids.userC]) invalidatePrincipal(id);
  mgr = (await loadPrincipal(ids.mgr))!;
  desk = (await loadPrincipal(ids.desk))!;
  portalA = (await loadPrincipal(ids.userA))!;
  portalB = (await loadPrincipal(ids.userB))!;
  portalC = (await loadPrincipal(ids.userC))!;
  await asMgr(async (ctx) => {
    const p1 = await createTicket(ctx, { type: 'problem', customerId: ids.a, serviceId: ids.service, title: `Nightly VSS snapshot timeout ${S}`, description: 'Backup jobs time out on VSS snapshots', problem: { symptoms: 'Backup jobs fail with VSS freeze timeouts on the first attempt. Retries succeed.', workaround: WORKAROUND, rootCause: 'Antivirus scan overlapping the backup window' } });
    const p2 = await createTicket(ctx, { type: 'problem', customerId: ids.a, title: `Spare problem ${S}`, description: 'Not a known error' });
    const p3 = await createTicket(ctx, { type: 'problem', customerId: ids.b, title: `Beta backup issue ${S}`, description: 'Another customer', problem: { symptoms: 'Beta backups stall', workaround: `Beta workaround ${S}` } });
    const c1 = await createTicket(ctx, { type: 'change', customerId: ids.a, title: `Move antivirus scan ${S}`, description: 'Permanent fix' });
    const c2 = await createTicket(ctx, { type: 'change', customerId: ids.b, title: `Beta change ${S}`, description: 'Other customer' });
    const i1 = await createTicket(ctx, { type: 'incident', customerId: ids.a, serviceId: ids.service, title: `VSS snapshot failed again ${S}`, description: 'Backup failed overnight', requesterUserId: ids.userA });
    const i2 = await createTicket(ctx, { type: 'incident', customerId: ids.a, title: `VSS snapshot timeout on file server ${S}`, description: 'Same symptoms' });
    const i3 = await createTicket(ctx, { type: 'incident', customerId: ids.b, title: `Beta incident ${S}`, description: 'Other customer' });
    Object.assign(ids, { p1: p1.id, p2: p2.id, p3: p3.id, c1: c1.id, c2: c2.id, i1: i1.id, i2: i2.id, i3: i3.id });
    Object.assign(numbers, { p1: p1.number, p2: p2.number, p3: p3.number, c1: c1.number, c2: c2.number, i1: i1.number, i3: i3.number });
  });
});

afterAll(async () => {
  ai.setProviderForTests(null);
  await setSetting('known_errors.notify_customers', true);
  await setSetting('known_errors.resolve_on_fix', true);
  await setSetting('ai.disabled_features', []);
  await withSystem(async (tx) => {
    const tickets = [ids.p1, ids.p2, ids.p3, ids.p4, ids.c1, ids.c2, ids.c3, ids.i1, ids.i2, ids.i3, ids.r1].filter(Boolean);
    await tx.delete(schema.notificationOutbox).where(eq(schema.notificationOutbox.event, 'known_error.published'));
    await tx.delete(schema.notifications).where(eq(schema.notifications.event, 'known_error.published'));
    if (tickets.length) await tx.delete(schema.aiSuggestions).where(inArray(schema.aiSuggestions.entityId, tickets));
    if (tickets.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, tickets));
    await tx.delete(schema.users).where(inArray(schema.users.id, [ids.mgr, ids.desk, ids.userA, ids.userB, ids.userC]));
    await tx.delete(schema.roles).where(eq(schema.roles.id, ids.role));
    await tx.delete(schema.customers).where(inArray(schema.customers.id, [ids.a, ids.b]));
  });
  await closeDb();
});

describe('known error database', () => {
  it('1. flagging a problem opens the known-error lifecycle, moves the ticket to Known Error and audits it', async () => {
    await asMgr((ctx) => updateProblemDetails(ctx, ids.p1, { isKnownError: true }));
    await asMgr((ctx) => updateProblemDetails(ctx, ids.p3, { isKnownError: true }));
    const pd = await pdRow(ids.p1);
    expect(pd.isKnownError).toBe(true);
    expect(pd.keStatus).toBe('open');
    expect(pd.keIdentifiedAt).toBeTruthy();
    expect(pd.keStatusAt).toBeTruthy();
    const t = await asMgr((ctx) => getTicket(ctx, ids.p1));
    expect(t.status?.key).toBe('known_error');
    expect((await auditRows(ids.p1, 'known_error.update')).length).toBeGreaterThanOrEqual(1);
    const list = await asMgr((ctx) => kedb.listKnownErrors(ctx, lq({ customerId: ids.a })));
    expect(list.items.map((i) => i.id)).toContain(ids.p1);
    expect(list.items.map((i) => i.id)).not.toContain(ids.p2);
    expect(list.items.find((i) => i.id === ids.p1)!.workaround).toBe(WORKAROUND);
  });

  it('2. the permanent fix must be a change of the same customer; setting it stamps the status date', async () => {
    await expect(asMgr((ctx) => kedb.updateKnownError(ctx, ids.p1, { fixChangeNumber: numbers.c2 }))).rejects.toThrow(/same customer/);
    await expect(asMgr((ctx) => kedb.updateKnownError(ctx, ids.p1, { fixChangeNumber: numbers.i1 }))).rejects.toThrow(/change/);
    const d = await asMgr((ctx) => kedb.updateKnownError(ctx, ids.p1, { fixChangeNumber: numbers.c1, keStatus: 'fix_in_progress' }));
    expect(d.fixChange?.number).toBe(numbers.c1);
    expect(d.keStatus).toBe('fix_in_progress');
    expect(d.keStatusAt).toBeTruthy();
    const again = await asMgr((ctx) => kedb.getKnownError(ctx, ids.p1));
    expect(again.fixChange?.number).toBe(numbers.c1);
    expect(again.permissions).toEqual({ manage: true, publish: true });
    const back = await asMgr((ctx) => kedb.setKnownErrorStatus(ctx, ids.p1, 'open'));
    expect(back.keStatus).toBe('open');
    await asMgr((ctx) => kedb.setKnownErrorStatus(ctx, ids.p1, 'fix_in_progress'));
  });

  it('3. search covers the title and the problem text; stats count per status', async () => {
    const byTitle = await asMgr((ctx) => kedb.listKnownErrors(ctx, lq({ q: 'snapshot timeout', customerId: ids.a })));
    expect(byTitle.items.map((i) => i.id)).toContain(ids.p1);
    const byWorkaround = await asMgr((ctx) => kedb.listKnownErrors(ctx, lq({ q: 'rerun after 04:00', customerId: ids.a })));
    expect(byWorkaround.items.map((i) => i.id)).toContain(ids.p1);
    const resolved = await asMgr((ctx) => kedb.listKnownErrors(ctx, lq({ status: 'resolved', customerId: ids.a })));
    expect(resolved.items).toEqual([]);
    const stats = await asMgr((ctx) => kedb.knownErrorStats(ctx, ids.a));
    expect(stats).toMatchObject({ total: 1, open: 0, fixInProgress: 1, published: 0 });
  });

  it('4. the desk reads but neither edits nor publishes; an unflagged problem cannot be published', async () => {
    const list = await asDesk((ctx) => kedb.listKnownErrors(ctx, lq({ customerId: ids.a })));
    expect(list.items.map((i) => i.id)).toContain(ids.p1);
    const d = await asDesk((ctx) => kedb.getKnownError(ctx, ids.p1));
    expect(d.permissions).toEqual({ manage: false, publish: false });
    await expect(asDesk((ctx) => kedb.updateKnownError(ctx, ids.p1, { keStatus: 'resolved' }))).rejects.toThrow(/permission/);
    await expect(asDesk((ctx) => kedb.publishKnownError(ctx, ids.p1, { customerSummary: SUMMARY, customerWorkaround: CUSTOMER_WORKAROUND }))).rejects.toThrow(/permission/);
    await expect(asMgr((ctx) => kedb.publishKnownError(ctx, ids.p2, { customerSummary: SUMMARY, customerWorkaround: CUSTOMER_WORKAROUND }))).rejects.toThrow(/known error/);
    await expect(asMgr((ctx) => kedb.getKnownError(ctx, ids.p2))).rejects.toBeInstanceOf(NotFoundError);
    // Lifecycle keys never flag a problem by themselves: the entry exists only once the flag is set on the problem record.
    await expect(asMgr((ctx) => kedb.updateKnownError(ctx, ids.p2, { keStatus: 'open' }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(asMgr((ctx) => updateProblemDetails(ctx, ids.p2, { keStatus: 'fix_in_progress', customerSummary: SUMMARY }))).rejects.toThrow(/known error first/);
    expect((await pdRow(ids.p2))?.isKnownError ?? false).toBe(false);
  });

  it('5. publishing notifies the organisation\'s portal users once; re-wording and a switched-off setting notify nobody', async () => {
    const preview = (await asMgr((ctx) => tool('publish_known_error').preview!(ctx, { problem: numbers.p1, customerSummary: SUMMARY, customerWorkaround: CUSTOMER_WORKAROUND }))) as { text: string; lines: string[]; count: number };
    // User C is an active portal user of A without portal:kedb: not counted, not notified (the link would open a page C may not see).
    expect(preview.count).toBe(1);
    expect(preview.text).toContain(`Known Error Customer A ${S}`);
    expect(preview.lines.some((l) => l.includes('1 portal user(s)'))).toBe(true);
    const d = await asMgr((ctx) => kedb.publishKnownError(ctx, ids.p1, { customerSummary: SUMMARY, customerWorkaround: CUSTOMER_WORKAROUND }));
    expect(d.portalVisible).toBe(true);
    expect(d.publishedAt).toBeTruthy();
    expect(d.notified).toBe(1);
    expect(d.first).toBe(true);
    expect((await pdRow(ids.p1)).publishedBy).toBe(ids.mgr);
    const inAppA = await withSystem((tx) => tx.select().from(schema.notifications).where(and(eq(schema.notifications.userId, ids.userA), eq(schema.notifications.event, 'known_error.published'))));
    expect(inAppA.length).toBe(1);
    expect(inAppA[0]!.link).toBe(`/knowledge/known-errors/${ids.p1}`);
    const inAppB = await withSystem((tx) => tx.select().from(schema.notifications).where(and(eq(schema.notifications.userId, ids.userB), eq(schema.notifications.event, 'known_error.published'))));
    expect(inAppB.length).toBe(0);
    const mails = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.event, 'known_error.published'), eq(schema.notificationOutbox.entityId, ids.p1), eq(schema.notificationOutbox.channel, 'email'))));
    expect(mails.map((m) => m.recipient).sort()).toEqual([`ke-a-${S}@test.local`]);
    expect((await withSystem((tx) => tx.select().from(schema.notifications).where(and(eq(schema.notifications.userId, ids.userC), eq(schema.notifications.event, 'known_error.published'))))).length).toBe(0);
    expect(mails[0]!.body).toContain(CUSTOMER_WORKAROUND);
    expect(mails[0]!.body).not.toContain(WORKAROUND);
    const audit = await auditRows(ids.p1, 'known_error.publish');
    expect(audit.length).toBe(1);
    expect((audit[0]!.metadata as { notified: number; first: boolean })).toMatchObject({ notified: 1, first: true });
    // Re-wording: the text changes, nobody is told again.
    const again = await asMgr((ctx) => kedb.publishKnownError(ctx, ids.p1, { customerSummary: `${SUMMARY} Updated.`, customerWorkaround: CUSTOMER_WORKAROUND }));
    expect(again.customerSummary).toBe(`${SUMMARY} Updated.`);
    expect(again.notified).toBe(0);
    expect((await withSystem((tx) => tx.select().from(schema.notifications).where(and(eq(schema.notifications.userId, ids.userA), eq(schema.notifications.event, 'known_error.published'))))).length).toBe(1);
    // Setting off: a fresh publish writes no notification.
    await setSetting('known_errors.notify_customers', false);
    const p3 = await asMgr((ctx) => kedb.publishKnownError(ctx, ids.p3, { customerSummary: `Beta customers may notice stalled backups ${S}.`, customerWorkaround: `Nothing to do on your side ${S}; we rerun the jobs.` }));
    expect(p3.notified).toBe(0);
    expect((await withSystem((tx) => tx.select().from(schema.notifications).where(and(eq(schema.notifications.userId, ids.userB), eq(schema.notifications.event, 'known_error.published'))))).length).toBe(0);
    await setSetting('known_errors.notify_customers', true);
  });

  it('6. the portal sees its own published entries with the customer wording only', async () => {
    const res = await asA((ctx) => kedb.listPortalKnownErrors(ctx, { page: 1, pageSize: 20, status: 'all' }));
    expect(res.items.map((i) => i.id)).toEqual([ids.p1]);
    expect(Object.keys(res.items[0]!).sort()).toEqual(['id', 'keStatus', 'number', 'publishedAt', 'service', 'summary', 'title', 'updatedAt', 'workaround']);
    expect(res.services.map((s) => s.id)).toEqual([ids.service]);
    const text = JSON.stringify(res);
    expect(text).not.toContain(WORKAROUND);
    expect(text).not.toContain('Antivirus scan');
    expect(text).toContain(CUSTOMER_WORKAROUND);
    expect(text).not.toContain(`Beta backup issue ${S}`);
    const one = await asA((ctx) => kedb.getPortalKnownError(ctx, ids.p1));
    expect(one.workaround).toBe(CUSTOMER_WORKAROUND);
    expect((await asB((ctx) => kedb.listPortalKnownErrors(ctx, { page: 1, pageSize: 20, status: 'all' }))).items.map((i) => i.id)).toEqual([ids.p3]);
    await expect(asB((ctx) => kedb.getPortalKnownError(ctx, ids.p1))).rejects.toBeInstanceOf(NotFoundError);
    await expect(asA((ctx) => kedb.getPortalKnownError(ctx, ids.p2))).rejects.toBeInstanceOf(NotFoundError);
    await expect(asC((ctx) => kedb.listPortalKnownErrors(ctx, { page: 1, pageSize: 20, status: 'all' }))).rejects.toThrow(/portal:kedb/);
    const suggest = await asA((ctx) => kedb.suggestPortalKnownErrors(ctx, { q: 'VSS snapshot timeout' }));
    expect(suggest.items.map((i) => i.id)).toEqual([ids.p1]);
  });

  it('7. incidents are matched against known errors and carry the linked one, customer-safe in the portal', async () => {
    const m = await asMgr(async (ctx) => kedb.matchForIncident(ctx, await loadTicket(ctx, ids.i1)));
    expect(m?.linked).toBeNull();
    expect(m?.suggestions[0]?.id).toBe(ids.p1);
    await asMgr((ctx) => addLink(ctx, ids.i1, { targetTicketId: ids.p1, linkType: 'problem_of' }));
    const t = await asMgr((ctx) => getTicket(ctx, ids.i1));
    expect(t.knownError?.linked?.id).toBe(ids.p1);
    expect(t.links.find((l) => l.linkType === 'problem_of')?.ticket.isKnownError).toBe(true);
    const d = await asMgr((ctx) => kedb.getKnownError(ctx, ids.p1));
    expect(d.linkedIncidents.map((i) => i.id)).toEqual([ids.i1]);
    expect(d.incidents).toBe(1);
    const pt = await asA((ctx) => getPortalTicket(ctx, ids.i1));
    expect(pt.knownError?.linked?.summary).toBe(`${SUMMARY} Updated.`);
    expect(JSON.stringify(pt.knownError)).not.toContain(WORKAROUND);
    expect((await asC((ctx) => getPortalTicket(ctx, ids.i1))).knownError).toBeNull();
    // A staff preview of the portal ticket recomputes the block from the published entry alone.
    const preview = await asMgr((ctx) => getPortalTicket(ctx, ids.i1, ids.a));
    expect(preview.knownError?.linked?.id).toBe(ids.p1);
    expect(JSON.stringify(preview.knownError)).not.toContain(WORKAROUND);
    const other = await asMgr((ctx) => kedb.suggestKnownErrors(ctx, { q: 'snapshot', customerId: ids.b }));
    expect(other.items.map((i) => i.id)).not.toContain(ids.p1);
    const i2 = await asMgr((ctx) => getTicket(ctx, ids.i2));
    expect(i2.knownError?.linked).toBeNull();
    expect(i2.knownError?.suggestions.map((s) => s.id)).toContain(ids.p1);
    // A request linked problem_of is not an incident: it neither counts nor lists under the known error.
    const r1 = await asMgr((ctx) => createTicket(ctx, { type: 'request', customerId: ids.a, title: `Question about the backup reports ${S}`, description: 'Not an incident' }));
    ids.r1 = r1.id;
    await asMgr((ctx) => addLink(ctx, ids.r1, { targetTicketId: ids.p1, linkType: 'problem_of' }));
    const afterRequest = await asMgr((ctx) => kedb.getKnownError(ctx, ids.p1));
    expect(afterRequest.incidents).toBe(1);
    expect(afterRequest.linkedIncidents.map((i) => i.id)).toEqual([ids.i1]);
  });

  it('8. the ticket list filters problems by the known-error flag and counts them', async () => {
    const flagged = await asMgr((ctx) => listTickets(ctx, listQuery({ type: 'problem', knownError: true, customerId: ids.a })));
    expect(flagged.items.map((t) => t.id)).toEqual([ids.p1]);
    expect(flagged.items[0]!.isKnownError).toBe(true);
    const unflagged = await asMgr((ctx) => listTickets(ctx, listQuery({ type: 'problem', knownError: false, customerId: ids.a })));
    expect(unflagged.items.map((t) => t.id)).toEqual([ids.p2]);
    const stats = await asMgr((ctx) => ticketStats(ctx, { type: 'problem', customerId: ids.a }));
    expect(stats.knownErrors).toBe(1);
  });

  it('9. implementing the permanent-fix change resolves the known error, unless the setting is off', async () => {
    await asMgr((ctx) => resolveTicket(ctx, ids.c1, { resolutionNotes: 'Patched' }));
    expect((await pdRow(ids.p1)).keStatus).toBe('resolved');
    expect((await auditRows(ids.p1, 'known_error.resolve_on_fix')).length).toBe(1);
    await setSetting('known_errors.resolve_on_fix', false);
    await asMgr((ctx) => kedb.updateKnownError(ctx, ids.p3, { fixChangeNumber: numbers.c2, keStatus: 'fix_in_progress' }));
    await asMgr((ctx) => resolveTicket(ctx, ids.c2, { resolutionNotes: 'Patched too' }));
    expect((await pdRow(ids.p3)).keStatus).toBe('fix_in_progress');
    await setSetting('known_errors.resolve_on_fix', true);
    // "Failed / Backed Out" shares the resolved status category with "Implemented" but delivers no fix: the entry stays as it is.
    await asMgr(async (ctx) => {
      const p4 = await createTicket(ctx, { type: 'problem', customerId: ids.a, title: `Print spooler stops overnight ${S}`, description: 'Spooler', problem: { symptoms: 'The spooler service stops every night.', workaround: 'Restart the spooler service' } });
      const c3 = await createTicket(ctx, { type: 'change', customerId: ids.a, title: `Spooler driver update ${S}`, description: 'Permanent fix attempt' });
      ids.p4 = p4.id;
      ids.c3 = c3.id;
      numbers.p4 = p4.number;
      await updateProblemDetails(ctx, p4.id, { isKnownError: true, fixChangeNumber: c3.number, keStatus: 'fix_in_progress' });
    });
    expect((await pdRow(ids.p4)).keStatus).toBe('fix_in_progress');
    const failed = await withSystem(async (tx) => (await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'ticket_status'), eq(schema.configOptions.key, 'failed'))).limit(1))[0]!);
    await asMgr((ctx) => changeStatus(ctx, ids.c3, { statusId: failed.id, resolutionNotes: 'Driver update backed out' }));
    expect((await loadStatusKey(ids.c3))).toBe('failed');
    expect((await pdRow(ids.p4)).keStatus).toBe('fix_in_progress');
    expect((await auditRows(ids.p4, 'known_error.resolve_on_fix')).length).toBe(0);
  });

  it('10. the wording draft uses the provider when there is one and a deterministic fallback otherwise', async () => {
    const drafted = await asMgr((ctx) => draftCustomerWording(ai.stepsOf(ctx), ids.p1));
    expect(drafted.aiGenerated).toBe(true);
    expect(drafted.summary).toBe(SUMMARY);
    const rows = await withSystem((tx) => tx.select().from(schema.aiSuggestions).where(and(eq(schema.aiSuggestions.entityId, ids.p1), eq(schema.aiSuggestions.kind, 'known_error_wording'))));
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(drafted.suggestionId);
    ai.setProviderForTests(null);
    const fallback = await asMgr((ctx) => draftCustomerWording(ai.stepsOf(ctx), ids.p1));
    expect(fallback.aiGenerated).toBe(false);
    expect(fallback.summary.startsWith('Backup jobs fail with VSS freeze timeouts on the first attempt.')).toBe(true);
    expect(fallback.workaround).toBe(WORKAROUND);
    ai.setProviderForTests({ name: 'stub', model: 'stub', chat: async () => json({ summary: SUMMARY, workaround: CUSTOMER_WORKAROUND }) });
    await setSetting('ai.disabled_features', ['kedb_draft']);
    await expect(asMgr((ctx) => draftCustomerWording(ai.stepsOf(ctx), ids.p1))).rejects.toMatchObject({ code: 'ai_feature_disabled' });
    await setSetting('ai.disabled_features', []);
    await expect(asDesk((ctx) => draftCustomerWording(ai.stepsOf(ctx), ids.p1))).rejects.toThrow(/permission/);
  });

  it('11. the known error report shows the full record to staff and the customer wording to the portal', async () => {
    const def = findReport('known_errors')!;
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const staff = await asMgr((ctx) => def.run(ctx, { customerId: ids.a, from, to, status: 'all' }));
    const row = staff.rows.find((r) => r.number === numbers.p1)!;
    expect(row).toBeDefined();
    expect(row.fix_change).toBe(numbers.c1);
    expect(row.root_cause).toContain('Antivirus');
    expect(staff.summary!.map((s) => s.label)).toEqual(['Known errors', 'Open', 'Fix in progress', 'Published to portal', 'Linked incidents']);
    const portal = await asA((ctx) => def.run(ctx, { customerId: ids.a, from, to, status: 'all' }));
    expect(portal.rows.length).toBe(1);
    expect(portal.rows[0]!.workaround).toBe(CUSTOMER_WORKAROUND);
    expect(portal.rows[0]!.summary).toBe(`${SUMMARY} Updated.`);
    expect('root_cause' in portal.rows[0]!).toBe(false);
    expect(JSON.stringify(portal)).not.toContain(WORKAROUND);
    await expect(asC((ctx) => def.run(ctx, { customerId: ids.a, from, to, status: 'all' }))).rejects.toThrow(/portal:kedb/);
    const summary = await asMgr((ctx) => findReport('problem_summary')!.run(ctx, { customerId: ids.a, from, to }));
    expect(summary.rows.find((r) => r.number === numbers.p1)!.ke_status).toBe('Resolved');
    expect(summary.rows.find((r) => r.number === numbers.p1)!.fix_change).toBe(numbers.c1);
    expect(summary.summary!.map((s) => s.label)).toContain('Published to portal');
  });

  it('12. the global search finds known errors for staff and only published own entries for the portal', async () => {
    const hits = await asMgr((ctx) => postgresSearchProvider.search(ctx, 'snapshot', ['known_error'], 10));
    expect(hits.some((h) => h.link === `/knowledge/known-errors/${ids.p1}` && h.badge === 'Known error')).toBe(true);
    expect((await asB((ctx) => postgresSearchProvider.search(ctx, 'snapshot', ['known_error'], 10))).length).toBe(0);
    const own = await asA((ctx) => postgresSearchProvider.search(ctx, 'snapshot', ['known_error'], 10));
    expect(own.map((h) => h.id)).toEqual([ids.p1]);
    expect(JSON.stringify(own)).not.toContain(WORKAROUND);
    expect((await asC((ctx) => postgresSearchProvider.search(ctx, 'snapshot', ['known_error'], 10))).length).toBe(0);
  });

  it('13. Grady\'s tools answer within the same fences', async () => {
    const staff = (await asMgr((ctx) => tool('known_errors').run(ctx, { customer: `KEA${S.toUpperCase()}`, status: 'all' }))) as { facts: string[]; items: { number: string }[] };
    // Customer A holds P1 (resolved, published) and P4 (fix in progress, unpublished) by now.
    expect(staff.facts[0]).toMatch(/^2 known error\(s\) for Known Error Customer A/);
    expect(staff.items.map((i) => i.number).sort()).toEqual([numbers.p1, numbers.p4].sort());
    const portal = (await asA((ctx) => tool('known_errors').run(ctx, { status: 'all', customer: `KEB${S.toUpperCase()}` }))) as { facts: string[]; items: { number: string; workaround: string }[] };
    expect(portal.items.map((i) => i.number)).toEqual([numbers.p1]);
    expect(portal.items[0]!.workaround).toBe(CUSTOMER_WORKAROUND);
    expect(JSON.stringify(portal)).not.toContain(WORKAROUND);
    expect(JSON.stringify(portal)).not.toContain(`KEB${S.toUpperCase()}`);
    const one = (await asA((ctx) => tool('get_known_error').run(ctx, { knownError: numbers.p1 }))) as Record<string, unknown>;
    expect(one.workaround).toBe(CUSTOMER_WORKAROUND);
    expect('rootCause' in one).toBe(false);
    const full = (await asMgr((ctx) => tool('get_known_error').run(ctx, { knownError: numbers.p1 }))) as { rootCause: string; incidents: unknown[]; facts: string[] };
    expect(full.rootCause).toContain('Antivirus');
    expect(full.incidents.length).toBe(1);
    expect(full.facts[0]).toContain('linked to 1 incident');
    const match = (await asMgr((ctx) => tool('match_known_errors').run(ctx, { ticket: numbers.i1 }))) as { linked: { number: string } | null };
    expect(match.linked?.number).toBe(numbers.p1);
    await expect(asA((ctx) => tool('match_known_errors').run(ctx, { ticket: numbers.i3 }))).rejects.toThrow();
    await expect(asA((ctx) => tool('get_known_error').run(ctx, { knownError: numbers.p2 }))).rejects.toThrow();
    await expect(asDesk((ctx) => tool('mark_known_error').preview!(ctx, { problem: numbers.p2 }))).rejects.toThrow(/permission/);
    const markPreview = (await asMgr((ctx) => tool('mark_known_error').preview!(ctx, { problem: numbers.p2, workaround: 'Restart the agent', fixChange: numbers.c1 }))) as { text: string; lines: string[] };
    expect(markPreview.text).toContain(`Mark ${numbers.p2}`);
    expect(markPreview.lines.some((l) => l.startsWith('Permanent fix:'))).toBe(true);
    await expect(asMgr((ctx) => tool('mark_known_error').preview!(ctx, { problem: numbers.p2, fixChange: numbers.c2 }))).rejects.toThrow(/same customer/);
    await expect(asMgr((ctx) => tool('publish_known_error').run(ctx, { problem: numbers.p2, customerSummary: SUMMARY, customerWorkaround: CUSTOMER_WORKAROUND }))).rejects.toBeInstanceOf(NotFoundError);
    const marked = (await asMgr((ctx) => tool('mark_known_error').run(ctx, { problem: numbers.p2, workaround: 'Restart the agent', status: 'open' }))) as { knownError: string; status: string };
    expect(marked).toMatchObject({ knownError: numbers.p2, status: 'Open known error' });
    expect((await pdRow(ids.p2)).isKnownError).toBe(true);
  });

  it('14. overview, dashboards and withdrawal from the portal', async () => {
    const overview = await asMgr((ctx) => knowledgeOverview(ctx));
    expect(overview.knownErrors.open + overview.knownErrors.fixInProgress).toBeGreaterThanOrEqual(1);
    expect(overview.knownErrors.published).toBeGreaterThanOrEqual(1);
    const home = await asA((ctx) => dashboards.customer(ctx));
    expect(home.knownErrors.published).toBe(1);
    expect(JSON.stringify(home.knownErrors)).not.toContain(WORKAROUND);
    const limited = await asC((ctx) => dashboards.customer(ctx));
    expect(limited.knownErrors).toEqual({ published: 0, items: [] });
    const management = await asMgr((ctx) => dashboards.management(ctx, { customerId: ids.a }));
    expect(typeof management.kpis.knownErrorsOpen).toBe('number');
    expect(management.kpis.knownErrorsPublished).toBe(1);
    const noc = await asMgr((ctx) => dashboards.noc(ctx, { customerId: ids.b }));
    expect(noc.totals.knownErrorsOpen).toBe(1);
    await expect(asDesk((ctx) => kedb.unpublishKnownError(ctx, ids.p1))).rejects.toThrow(/permission/);
    const withdrawn = await asMgr((ctx) => kedb.unpublishKnownError(ctx, ids.p1));
    expect(withdrawn.portalVisible).toBe(false);
    expect((await asA((ctx) => kedb.listPortalKnownErrors(ctx, { page: 1, pageSize: 20, status: 'all' }))).items).toEqual([]);
    expect((await auditRows(ids.p1, 'known_error.unpublish')).length).toBe(1);
    // A retired entry never reaches the portal, so it cannot be published until it is reopened.
    await asMgr((ctx) => kedb.setKnownErrorStatus(ctx, ids.p1, 'retired'));
    await expect(asMgr((ctx) => kedb.publishKnownError(ctx, ids.p1, { customerSummary: SUMMARY, customerWorkaround: CUSTOMER_WORKAROUND }))).rejects.toThrow(/retired/);
  });
});
