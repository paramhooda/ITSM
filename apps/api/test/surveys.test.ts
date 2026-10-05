/**
 * Customer satisfaction surveys: the policy and its overrides, the survey
 * issued on every way a ticket ends (resolve, close, confirm, auto-close,
 * direct close) and withdrawn on reopen or cancel, the public token
 * endpoints (one answer, one comment, uniform 404, 410 on expiry, 409 on a
 * second answer, no-store, per-IP limit), the portal answer and "to rate"
 * list, the low-rating alert, the aggregates and their tenant fence, the
 * ticket list filters and sort, the manual send, the reminder sweep, the
 * dashboards, the reports, the review pack and the assistant tools.
 * Run with the dev environment sourced: npx vitest run test/surveys.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, asc, inArray, sql } from 'drizzle-orm';
import { buildApp } from '../src/core/app';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../src/core/errors';
import { decryptSecret } from '../src/lib/crypto';
import { createTicket, getTicket, resolveTicket, closeTicket, reopenTicket, cancelTicket } from '../src/modules/tickets/service';
import { listTickets } from '../src/modules/tickets/list';
import { listQuerySchema } from '../src/modules/tickets/schemas';
import { loadTicket, systemCtx } from '../src/modules/tickets/common';
import { getPortalTicket, listPortalTickets, me } from '../src/modules/portal/service';
import { ticketListQuery } from '../src/modules/portal/schemas';
import { effectivePolicy, isSampled, loadSurveyDefaults } from '../src/modules/surveys/policy';
import * as svc from '../src/modules/surveys/service';
import { answerPortalSurvey, pendingForPortal } from '../src/modules/surveys/portal';
import { publicSurvey, publicRate, publicComment } from '../src/modules/surveys/public';
import { autoCloseResolved } from '../src/jobs/processors/tickets';
import * as dashboards from '../src/modules/dashboards/service';
import { customerOverview } from '../src/modules/customers/service';
import { findReport } from '../src/modules/reports/registry';
import { executeReport, runReport } from '../src/modules/reports/service';
import '../src/modules/reports/definitions';
import { toolByName, availableTools } from '../src/modules/ai/tools';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-csat-${S}`, ip: '127.0.0.1' };
const REQUESTED = 'ticket.survey_requested';
const LOW = 'ticket.survey_low_rating';
const DAY = 86_400_000;
const ids = { a: '', b: '', c: '', am: '', mgr: '', eng: '', alphaAdmin: '', alphaUser: '', beta: '', team: '', contact: '', contractA: '', contractC: '', configA: '', configB: '' };
const emails = { am: `csat-am-${S}@test.local`, mgr: `csat-mgr-${S}@test.local`, eng: `csat-eng-${S}@test.local`, alphaAdmin: `csat-alpha-admin-${S}@test.local`, alphaUser: `csat-alpha-${S}@test.local`, beta: `csat-beta-${S}@test.local`, contact: `csat-contact-${S}@test.local` };
const nameA = `Survey Customer A ${S}`;
const nameB = `Survey Customer B ${S}`;
let admin: Principal;
let mgr: Principal;
let eng: Principal;
let alphaAdmin: Principal;
let alphaUser: Principal;
let beta: Principal;
let app: Awaited<ReturnType<typeof buildApp>>;
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);
const asMgr = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(mgr, meta, fn);
const asEng = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(eng, meta, fn);
const asAlpha = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(alphaUser, meta, fn);
const asAlphaAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(alphaAdmin, meta, fn);
const asBeta = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(beta, meta, fn);
const createdTickets: string[] = [];

const rowFor = (ticketId: string) => withSystem(async (tx) => (await tx.select().from(schema.ticketSurveys).where(eq(schema.ticketSurveys.ticketId, ticketId)).limit(1))[0] ?? null);
const outboxFor = (event: string, ticketId: string) => withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.event, event), eq(schema.notificationOutbox.entityId, ticketId))).orderBy(asc(schema.notificationOutbox.createdAt)));
const inAppFor = (event: string, ticketId: string) => withSystem((tx) => tx.select().from(schema.notifications).where(and(eq(schema.notifications.event, event), eq(schema.notifications.entityId, ticketId))));
const activitiesOf = (ticketId: string) => withSystem((tx) => tx.select().from(schema.ticketActivities).where(and(eq(schema.ticketActivities.ticketId, ticketId), eq(schema.ticketActivities.activityType, 'survey'))).orderBy(asc(schema.ticketActivities.createdAt)));
const auditsOf = (ticketId: string, action: string) => withSystem((tx) => tx.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, ticketId), eq(schema.auditLog.action, action))));
const setSetting = (key: string, value: unknown) => withSystem((tx) => tx.update(schema.systemSettings).set({ value: value as never }).where(eq(schema.systemSettings.key, key)));
const patchConfig = (id: string, patch: Partial<typeof schema.surveyConfigs.$inferInsert>) => withSystem((tx) => tx.update(schema.surveyConfigs).set(patch).where(eq(schema.surveyConfigs.id, id)));
const patchSurvey = (ticketId: string, patch: Partial<typeof schema.ticketSurveys.$inferInsert>) => withSystem((tx) => tx.update(schema.ticketSurveys).set(patch).where(eq(schema.ticketSurveys.ticketId, ticketId)));
const tokenOf = (row: { tokenEnc: string }) => decryptSecret(row.tokenEnc);
const statusKeyOf = (ticketId: string) => withSystem(async (tx) => (await tx.select({ key: schema.configOptions.key }).from(schema.tickets).innerJoin(schema.configOptions, eq(schema.configOptions.id, schema.tickets.statusId)).where(eq(schema.tickets.id, ticketId)).limit(1))[0]?.key);
const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - DAY).toISOString().slice(0, 10);

async function roleId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  if (!row) throw new Error(`role ${key} missing (seed not applied?)`);
  return row.id;
}

interface MkOpts {
  title: string;
  type?: 'incident' | 'request' | 'problem';
  customerId?: string;
  requesterUserId?: string | null;
  requesterContactId?: string | null;
  assign?: boolean;
}
async function mk(o: MkOpts) {
  const t = await asAdmin((ctx) => createTicket(ctx, { type: o.type ?? 'incident', customerId: o.customerId ?? ids.a, title: `${o.title} ${S}`, description: 'Survey test ticket', requesterUserId: o.requesterUserId ?? null, requesterContactId: o.requesterContactId ?? null, ...(o.assign === false ? {} : { assigneeId: ids.eng, assignedTeamId: ids.team }) }));
  createdTickets.push(t.id);
  return t;
}
const resolve = (id: string) => asEng((ctx) => resolveTicket(ctx, id, { resolutionNotes: 'Replaced the failed component and verified with the requester' }));
const close = (id: string) => asEng((ctx) => closeTicket(ctx, id, {}));

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const [adminRow] = await withSystem((tx) => tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1));
  await withSystem(async (tx) => {
    const mkUser = async (email: string, name: string, role: string, customerId: string | null, userType: 'msp' | 'customer') => {
      const [u] = await tx.insert(schema.users).values({ email, name, userType, customerId, status: 'active' }).returning();
      await tx.insert(schema.userRoles).values({ userId: u!.id, roleId: await roleId(tx, role), customerId });
      return u!.id;
    };
    ids.am = await mkUser(emails.am, 'Survey Account Manager', 'account_manager', null, 'msp');
    ids.mgr = await mkUser(emails.mgr, 'Survey Service Manager', 'service_manager', null, 'msp');
    ids.eng = await mkUser(emails.eng, 'Survey Engineer', 'engineer', null, 'msp');
    const [a] = await tx.insert(schema.customers).values({ code: `SVA${S.toUpperCase()}`, name: nameA, accountManagerId: ids.am }).returning();
    const [b] = await tx.insert(schema.customers).values({ code: `SVB${S.toUpperCase()}`, name: nameB }).returning();
    const [c] = await tx.insert(schema.customers).values({ code: `SVC${S.toUpperCase()}`, name: `Survey Customer C ${S}` }).returning();
    ids.a = a!.id;
    ids.b = b!.id;
    ids.c = c!.id;
    await tx.insert(schema.sites).values([{ customerId: a!.id, code: 'HQ', name: `A HQ ${S}`, isPrimary: true }, { customerId: b!.id, code: 'HQ', name: `B HQ ${S}`, isPrimary: true }]);
    await tx.insert(schema.userCustomerAccess).values([{ userId: ids.eng, customerId: a!.id }, { userId: ids.eng, customerId: b!.id }, { userId: ids.am, customerId: a!.id }]);
    const [team] = await tx.insert(schema.teams).values({ key: `sv_desk_${S}`, name: `Survey Desk ${S}`, managerUserId: ids.mgr }).returning();
    ids.team = team!.id;
    await tx.insert(schema.teamMembers).values({ teamId: team!.id, userId: ids.eng });
    ids.alphaAdmin = await mkUser(emails.alphaAdmin, 'Alpha Admin', 'customer_admin', a!.id, 'customer');
    ids.alphaUser = await mkUser(emails.alphaUser, 'Alpha User', 'customer_user', a!.id, 'customer');
    ids.beta = await mkUser(emails.beta, 'Beta User', 'customer_user', b!.id, 'customer');
    const [contact] = await tx.insert(schema.contacts).values({ customerId: a!.id, name: 'Contact Only', email: emails.contact }).returning();
    ids.contact = contact!.id;
    const [kA] = await tx.insert(schema.contracts).values({ customerId: a!.id, number: `SVA-${S}`, name: `A support ${S}`, status: 'active', startDate: '2025-01-01', endDate: '2027-12-31' }).returning();
    const [kC] = await tx.insert(schema.contracts).values({ customerId: c!.id, number: `SVC-${S}`, name: `C support ${S}`, status: 'active', startDate: '2025-01-01', endDate: '2027-12-31' }).returning();
    ids.contractA = kA!.id;
    ids.contractC = kC!.id;
    // The fixtures resolve many tickets for the same requester, so fatigue is off for A and B and tested explicitly.
    const [cfgA] = await tx.insert(schema.surveyConfigs).values({ customerId: a!.id, fatigueDays: 0 }).returning();
    const [cfgB] = await tx.insert(schema.surveyConfigs).values({ customerId: b!.id, fatigueDays: 0 }).returning();
    ids.configA = cfgA!.id;
    ids.configB = cfgB!.id;
  });
  for (const id of [adminRow!.id, ids.am, ids.mgr, ids.eng, ids.alphaAdmin, ids.alphaUser, ids.beta]) invalidatePrincipal(id);
  admin = (await loadPrincipal(adminRow!.id))!;
  mgr = (await loadPrincipal(ids.mgr))!;
  eng = (await loadPrincipal(ids.eng))!;
  alphaAdmin = (await loadPrincipal(ids.alphaAdmin))!;
  alphaUser = (await loadPrincipal(ids.alphaUser))!;
  beta = (await loadPrincipal(ids.beta))!;
});

afterAll(async () => {
  await setSetting('surveys.enabled', true);
  await setSetting('surveys.send_on', 'resolved');
  await withSystem(async (tx) => {
    await tx.delete(schema.notificationOutbox).where(inArray(schema.notificationOutbox.event, [REQUESTED, LOW]));
    await tx.delete(schema.notifications).where(inArray(schema.notifications.event, [REQUESTED, LOW]));
    if (createdTickets.length) await tx.delete(schema.aiSuggestions).where(inArray(schema.aiSuggestions.entityId, createdTickets));
    if (createdTickets.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, createdTickets));
    await tx.delete(schema.surveyConfigs).where(inArray(schema.surveyConfigs.customerId, [ids.a, ids.b, ids.c]));
    await tx.delete(schema.teams).where(eq(schema.teams.id, ids.team));
    await tx.delete(schema.users).where(inArray(schema.users.id, [ids.am, ids.mgr, ids.eng, ids.alphaAdmin, ids.alphaUser, ids.beta]));
    await tx.delete(schema.customers).where(inArray(schema.customers.id, [ids.a, ids.b, ids.c]));
  });
  await app.close();
  await closeDb();
});

describe('customer satisfaction surveys', () => {
  it('1. the policy comes from the settings, a customer row overrides it and a contract row overrides the customer row; sampling is deterministic', async () => {
    const defaults = await withSystem((tx) => loadSurveyDefaults(tx));
    expect(defaults).toMatchObject({ enabled: true, sendOn: 'resolved', resendOnClose: true, samplingPct: 100, reminderDays: 3, expiryDays: 14, fatigueDays: 7, lowRatingThreshold: 2, satisfiedThreshold: 4, ticketTypes: ['incident', 'request'] });
    const base = await withSystem((tx) => effectivePolicy(tx, { customerId: ids.c }));
    expect(base.source).toBe('default');
    expect(base.samplingPct).toBe(100);
    await asAdmin((ctx) => svc.createConfig(ctx, { customerId: ids.c, samplingPct: 0 }));
    await expect(asAdmin((ctx) => svc.createConfig(ctx, { customerId: ids.c, samplingPct: 50 }))).rejects.toBeInstanceOf(ConflictError);
    await expect(asAdmin((ctx) => svc.createConfig(ctx, { customerId: ids.c, contractId: ids.contractA }))).rejects.toBeInstanceOf(ValidationError);
    const customerLevel = await withSystem((tx) => effectivePolicy(tx, { customerId: ids.c, contractId: ids.contractC }));
    expect(customerLevel).toMatchObject({ source: 'customer', samplingPct: 0, question: defaults.question });
    const contractRow = await asAdmin((ctx) => svc.createConfig(ctx, { customerId: ids.c, contractId: ids.contractC, question: `How was the security desk on this ticket? ${S}` }));
    const contractLevel = await withSystem((tx) => effectivePolicy(tx, { customerId: ids.c, contractId: ids.contractC }));
    expect(contractLevel).toMatchObject({ source: 'contract', samplingPct: 0, question: `How was the security desk on this ticket? ${S}` });
    const listed = await asAdmin((ctx) => svc.listConfigs(ctx, { customerId: ids.c }));
    expect(listed.items).toHaveLength(2);
    expect(listed.items.find((i) => i.id === contractRow.id)?.contractNumber).toBe(`SVC-${S}`);
    await expect(asEng((ctx) => svc.listConfigs(ctx, {}))).rejects.toBeInstanceOf(ForbiddenError);
    const policy = await asMgr((ctx) => svc.getPolicy(ctx, { customerId: ids.c, contractId: ids.contractC }));
    expect(policy.source).toBe('contract');
    expect(isSampled('11111111-1111-1111-1111-111111111111', 100)).toBe(true);
    expect(isSampled('11111111-1111-1111-1111-111111111111', 0)).toBe(false);
    expect(isSampled(ids.a, 37)).toBe(isSampled(ids.a, 37));
    const hits = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((x) => isSampled(`${x}${S}`, 50)).filter(Boolean).length;
    expect(hits).toBeGreaterThan(0);
    expect(hits).toBeLessThan(10);
  });

  it('2. resolving a ticket issues the survey: a hashed and encrypted token, the email with five one-click links, the in-app notice, the activity and the audit', async () => {
    const t = await mk({ title: 'Printer offline', requesterUserId: ids.alphaUser });
    await resolve(t.id);
    const row = await rowFor(t.id);
    expect(row).toBeTruthy();
    expect(row).toMatchObject({ status: 'pending', trigger: 'resolved', assigneeId: ids.eng, assignedTeamId: ids.team, recipientUserId: ids.alphaUser, recipientEmail: emails.alphaUser, sendCount: 1, ticketType: 'incident' });
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.tokenEnc.startsWith('enc:v1:')).toBe(true);
    const token = tokenOf(row!);
    expect(token.length).toBeGreaterThanOrEqual(24);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row!.expiresAt.getTime() - row!.requestedAt.getTime()).toBeCloseTo(14 * DAY, -4);
    const mails = await outboxFor(REQUESTED, t.id);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.recipient).toBe(emails.alphaUser);
    expect(mails[0]!.channel).toBe('email');
    for (const n of [1, 2, 3, 4, 5]) expect(mails[0]!.body).toContain(`/survey/${token}?rating=${n}`);
    expect(mails[0]!.body).not.toContain('&#x3D;');
    expect(mails[0]!.body).toContain('How satisfied are you with how we handled this ticket?');
    expect(mails[0]!.subject).toBe(`How did we do on ${t.number}?`);
    const inApp = await inAppFor(REQUESTED, t.id);
    expect(inApp).toHaveLength(1);
    expect(inApp[0]!.userId).toBe(ids.alphaUser);
    expect(inApp[0]!.link).toBe(`/portal/tickets/${t.id}?survey=1`);
    const acts = await activitiesOf(t.id);
    expect(acts.some((a) => a.summary.startsWith('Satisfaction survey sent to Alpha User') && !a.customerVisible)).toBe(true);
    expect(await auditsOf(t.id, 'survey.send')).toHaveLength(1);
  });

  it('3. a contact without a portal account gets the email only; a staff-raised ticket without a customer requester gets nothing', async () => {
    const t = await mk({ title: 'Contact requester', requesterContactId: ids.contact });
    await resolve(t.id);
    const row = await rowFor(t.id);
    expect(row).toMatchObject({ recipientContactId: ids.contact, recipientUserId: null, recipientEmail: emails.contact, status: 'pending' });
    expect(await outboxFor(REQUESTED, t.id)).toHaveLength(1);
    expect(await inAppFor(REQUESTED, t.id)).toHaveLength(0);
    const staff = await mk({ title: 'Raised on the phone' });
    await resolve(staff.id);
    expect(await rowFor(staff.id)).toBeNull();
    const acts = await activitiesOf(staff.id);
    expect(acts.map((a) => a.summary)).toContain('Satisfaction survey not sent: no customer requester');
    expect(await auditsOf(staff.id, 'survey.skip')).toHaveLength(1);
    // The closure of a ticket skipped at resolution does not ask again: one skip line, not one per ending.
    await withSystem((tx) => tx.update(schema.tickets).set({ resolvedAt: new Date(Date.now() - 6 * DAY) }).where(eq(schema.tickets.id, staff.id)));
    await autoCloseResolved();
    expect(await statusKeyOf(staff.id)).toBe('closed');
    expect(await rowFor(staff.id)).toBeNull();
    expect((await activitiesOf(staff.id)).filter((a) => a.summary.startsWith('Satisfaction survey not sent'))).toHaveLength(1);
    expect(await auditsOf(staff.id, 'survey.skip')).toHaveLength(1);
  });

  it('4. a customer switched off by policy, a ticket type outside the policy and the global switch all skip silently', async () => {
    await patchConfig(ids.configA, { enabled: false });
    const t = await mk({ title: 'Disabled by customer policy', requesterUserId: ids.alphaUser });
    await resolve(t.id);
    expect(await rowFor(t.id)).toBeNull();
    expect(await activitiesOf(t.id)).toHaveLength(0);
    await patchConfig(ids.configA, { enabled: null });
    const embed = await asMgr((ctx) => svc.ticketSurvey(ctx, t.id));
    expect(embed.status).toBe('none');
    const problem = await mk({ title: 'A problem record', type: 'problem', requesterUserId: ids.alphaUser });
    const out = await asAdmin(async (ctx) => svc.requestSurvey(ctx, await loadTicket(ctx, problem.id), { trigger: 'manual' }));
    expect(out).toEqual({ sent: false, reason: 'type' });
    expect(await activitiesOf(problem.id)).toHaveLength(0);
    await setSetting('surveys.enabled', false);
    const t2 = await mk({ title: 'Globally disabled', requesterUserId: ids.alphaUser });
    await resolve(t2.id);
    expect(await rowFor(t2.id)).toBeNull();
    await setSetting('surveys.enabled', true);
  });

  it('5. sampling and fatigue skip with an internal note; fatigue off sends', async () => {
    await patchConfig(ids.configA, { samplingPct: 0 });
    const t = await mk({ title: 'Sampled out', requesterUserId: ids.alphaUser });
    await resolve(t.id);
    expect(await rowFor(t.id)).toBeNull();
    expect((await activitiesOf(t.id)).map((a) => a.summary)).toContain('Satisfaction survey not sent: sampling');
    const embed = await asMgr((ctx) => svc.ticketSurvey(ctx, t.id));
    expect(embed).toMatchObject({ status: 'none', reason: 'sampling' });
    await patchConfig(ids.configA, { samplingPct: null, fatigueDays: 7 });
    const t2 = await mk({ title: 'Surveyed recently', requesterUserId: ids.alphaUser });
    await resolve(t2.id);
    expect(await rowFor(t2.id)).toBeNull();
    expect((await activitiesOf(t2.id)).map((a) => a.summary)).toContain('Satisfaction survey not sent: the requester was surveyed recently');
    await patchConfig(ids.configA, { fatigueDays: 0 });
    const out = await asAdmin(async (ctx) => svc.requestSurvey(ctx, await loadTicket(ctx, t2.id), { trigger: 'manual' }));
    expect(out.sent).toBe(true);
    expect((await rowFor(t2.id))?.trigger).toBe('manual');
  });

  it('6. closure: send-on-closed, the closure resend after a day, the auto-close path and a ticket closed straight from open', async () => {
    await setSetting('surveys.send_on', 'closed');
    const t1 = await mk({ title: 'Send on closure', requesterUserId: ids.alphaUser });
    await resolve(t1.id);
    expect(await rowFor(t1.id)).toBeNull();
    await close(t1.id);
    expect(await rowFor(t1.id)).toMatchObject({ status: 'pending', trigger: 'closed' });
    await setSetting('surveys.send_on', 'resolved');

    const t2 = await mk({ title: 'Closed within a day', requesterUserId: ids.alphaUser });
    await resolve(t2.id);
    await close(t2.id);
    expect(await outboxFor(REQUESTED, t2.id)).toHaveLength(1);
    expect((await rowFor(t2.id))?.resentAt).toBeNull();

    const t3 = await mk({ title: 'Closed after a day', requesterUserId: ids.alphaUser });
    await resolve(t3.id);
    await patchSurvey(t3.id, { requestedAt: new Date(Date.now() - 25 * 3_600_000) });
    await close(t3.id);
    const mails = await outboxFor(REQUESTED, t3.id);
    expect(mails).toHaveLength(2);
    expect(mails[1]!.subject?.startsWith('Reminder:')).toBe(true);
    expect(mails[1]!.body).toContain('has been closed');
    expect(await rowFor(t3.id)).toMatchObject({ sendCount: 2 });
    expect((await rowFor(t3.id))!.resentAt).toBeTruthy();
    expect((await activitiesOf(t3.id)).map((a) => a.summary)).toContain('Satisfaction survey sent again at closure');

    const t4 = await mk({ title: 'Auto-closed', requesterUserId: ids.alphaUser });
    await resolve(t4.id);
    await withSystem((tx) => tx.update(schema.tickets).set({ resolvedAt: new Date(Date.now() - 6 * DAY) }).where(eq(schema.tickets.id, t4.id)));
    await patchSurvey(t4.id, { requestedAt: new Date(Date.now() - 6 * DAY) });
    await autoCloseResolved();
    expect(await statusKeyOf(t4.id)).toBe('closed');
    expect(await outboxFor(REQUESTED, t4.id)).toHaveLength(2);
    expect(await rowFor(t4.id)).toMatchObject({ sendCount: 2, status: 'pending' });

    const t5 = await mk({ title: 'Closed from open', requesterUserId: ids.alphaUser });
    await close(t5.id);
    expect(await rowFor(t5.id)).toMatchObject({ status: 'pending', trigger: 'closed' });

    // Resolving an already resolved ticket (amending the notes) keeps the live survey and its links as they are.
    const t6 = await mk({ title: 'Resolution amended', requesterUserId: ids.alphaUser });
    await resolve(t6.id);
    const issued = (await rowFor(t6.id))!;
    await resolve(t6.id);
    expect(await rowFor(t6.id)).toMatchObject({ sendCount: 1, tokenHash: issued.tokenHash, status: 'pending' });
    expect(await outboxFor(REQUESTED, t6.id)).toHaveLength(1);
  });

  it('7. cancel and reopen withdraw a pending survey, a second resolution re-issues it, an answer stands, and a link used after a silent reopen is refused', async () => {
    const open = await mk({ title: 'Cancelled while open', requesterUserId: ids.alphaUser });
    await asEng((ctx) => cancelTicket(ctx, open.id, {}));
    expect(await rowFor(open.id)).toBeNull();

    const t1 = await mk({ title: 'Cancelled after resolution', requesterUserId: ids.alphaUser });
    await resolve(t1.id);
    await asEng((ctx) => cancelTicket(ctx, t1.id, {}));
    expect((await rowFor(t1.id))?.status).toBe('cancelled');
    expect((await activitiesOf(t1.id)).map((a) => a.summary)).toContain('Satisfaction survey withdrawn (ticket cancelled)');
    expect(await auditsOf(t1.id, 'survey.cancel')).toHaveLength(1);

    const t2 = await mk({ title: 'Reopened then resolved again', requesterUserId: ids.alphaUser });
    await resolve(t2.id);
    const first = (await rowFor(t2.id))!;
    await asEng((ctx) => reopenTicket(ctx, t2.id, { comment: 'Still broken' }));
    expect((await rowFor(t2.id))?.status).toBe('cancelled');
    expect((await activitiesOf(t2.id)).map((a) => a.summary)).toContain('Satisfaction survey withdrawn (ticket reopened)');
    await resolve(t2.id);
    const second = (await rowFor(t2.id))!;
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ status: 'pending', sendCount: 2 });
    expect(second.tokenHash).not.toBe(first.tokenHash);
    expect(await outboxFor(REQUESTED, t2.id)).toHaveLength(2);

    const t3 = await mk({ title: 'Answered then reopened', requesterUserId: ids.alphaUser });
    await resolve(t3.id);
    const answered = await publicRate(tokenOf((await rowFor(t3.id))!), 5);
    expect(answered.ok).toBe(true);
    await asEng((ctx) => reopenTicket(ctx, t3.id, { comment: 'One more thing' }));
    expect(await rowFor(t3.id)).toMatchObject({ status: 'answered', rating: 5 });
    await resolve(t3.id);
    expect(await rowFor(t3.id)).toMatchObject({ status: 'answered', rating: 5, sendCount: 1 });
    expect(await outboxFor(REQUESTED, t3.id)).toHaveLength(1);

    const t5 = await mk({ title: 'Reopened then closed', requesterUserId: ids.alphaUser });
    await resolve(t5.id);
    const issued5 = (await rowFor(t5.id))!;
    await asEng((ctx) => reopenTicket(ctx, t5.id, { comment: 'Not fixed after all' }));
    expect((await rowFor(t5.id))?.status).toBe('cancelled');
    await close(t5.id);
    const closed5 = (await rowFor(t5.id))!;
    expect(closed5).toMatchObject({ id: issued5.id, status: 'pending', trigger: 'closed', sendCount: 2 });
    expect(closed5.tokenHash).not.toBe(issued5.tokenHash);
    const mails5 = await outboxFor(REQUESTED, t5.id);
    expect(mails5).toHaveLength(2);
    expect(mails5[1]!.body).toContain('has been closed');

    const t4 = await mk({ title: 'Reopened behind the hook', requesterUserId: ids.alphaUser });
    await resolve(t4.id);
    const token = tokenOf((await rowFor(t4.id))!);
    const [inProgress] = await withSystem((tx) => tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'ticket_status'), eq(schema.configOptions.key, 'in_progress'))).limit(1));
    await withSystem((tx) => tx.update(schema.tickets).set({ statusId: inProgress!.id }).where(eq(schema.tickets.id, t4.id)));
    const refused = await publicRate(token, 4);
    expect(refused).toEqual({ ok: false, code: 'gone' });
    expect((await rowFor(t4.id))?.status).toBe('cancelled');
  });

  it('8. the public token endpoints: one answer, one comment, a uniform 404, 410 on expiry, no-store, and a per-IP limit', async () => {
    const t = await mk({ title: 'Public link', requesterUserId: ids.alphaUser });
    await resolve(t.id);
    const row = (await rowFor(t.id))!;
    const token = tokenOf(row);
    const page = await publicSurvey(token);
    expect(page).toMatchObject({ status: 'pending', ticket: { number: t.number }, rating: null, hasPortal: true });
    expect(JSON.stringify(page)).not.toContain(nameA);
    expect(JSON.stringify(page)).not.toContain('Survey Engineer');
    expect(JSON.stringify(page)).not.toContain(emails.alphaUser);
    const rated = await publicRate(token, 4);
    expect(rated).toEqual({ ok: true, data: { status: 'answered', rating: 4, hasComment: false } });
    const ticket = await withSystem(async (tx) => (await tx.select().from(schema.tickets).where(eq(schema.tickets.id, t.id)).limit(1))[0]!);
    expect(ticket.csatRating).toBe(4);
    expect(ticket.csatAt).toBeTruthy();
    expect(await rowFor(t.id)).toMatchObject({ status: 'answered', rating: 4, channel: 'email', answeredByUserId: ids.alphaUser });
    const acts = await activitiesOf(t.id);
    expect(acts.some((a) => a.summary === 'Customer rated this ticket 4/5' && a.customerVisible)).toBe(true);
    expect(await auditsOf(t.id, 'survey.answer')).toHaveLength(1);
    expect(await publicRate(token, 5)).toEqual({ ok: false, code: 'conflict' });
    expect(await publicComment(token, 'Quick and friendly')).toEqual({ ok: true, data: { status: 'answered', hasComment: true } });
    expect((await rowFor(t.id))?.comment).toBe('Quick and friendly');
    expect(await publicComment(token, 'Again')).toEqual({ ok: false, code: 'conflict' });
    expect(await publicSurvey(token)).toMatchObject({ status: 'answered', rating: 4, hasComment: true });

    const cancelled = await mk({ title: 'Revoked link', requesterUserId: ids.alphaUser });
    await resolve(cancelled.id);
    const revokedToken = tokenOf((await rowFor(cancelled.id))!);
    await asEng((ctx) => cancelTicket(ctx, cancelled.id, {}));
    expect(await publicSurvey(revokedToken)).toBeNull();
    expect(await publicSurvey('A'.repeat(32))).toBeNull();
    expect(await publicSurvey('not a token!')).toBeNull();
    const bodies = await Promise.all(['A'.repeat(32), revokedToken, 'bad token'].map(async (tok) => {
      const res = await app.inject({ method: 'GET', url: `/api/public/surveys/${encodeURIComponent(tok)}` });
      return { statusCode: res.statusCode, body: res.json() as { error: string; message: string }, cache: res.headers['cache-control'] };
    }));
    for (const b of bodies) {
      expect(b.statusCode).toBe(404);
      expect(b.body).toEqual({ error: 'not_found', message: 'This survey link is not valid.' });
      expect(b.cache).toBe('no-store');
    }
    const okRes = await app.inject({ method: 'GET', url: `/api/public/surveys/${token}` });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.headers['cache-control']).toBe('no-store');
    expect((okRes.json() as { ticket: { number: string } }).ticket.number).toBe(t.number);
    expect(JSON.stringify(okRes.json())).not.toContain(nameA);

    const expired = await mk({ title: 'Expired link', requesterUserId: ids.alphaUser });
    await resolve(expired.id);
    const expiredToken = tokenOf((await rowFor(expired.id))!);
    await patchSurvey(expired.id, { expiresAt: new Date(Date.now() - DAY) });
    const gone = await app.inject({ method: 'POST', url: `/api/public/surveys/${expiredToken}/rating`, payload: { rating: 3 } });
    expect(gone.statusCode).toBe(410);
    expect(gone.json()).toEqual({ error: 'gone', message: 'This survey has closed.' });
    expect((await rowFor(expired.id))?.status).toBe('expired');
    const again = await app.inject({ method: 'POST', url: `/api/public/surveys/${token}/rating`, payload: { rating: 3 } });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'conflict', message: 'This ticket has already been rated.' });
    const unauth = await app.inject({ method: 'GET', url: '/api/surveys/policy' });
    expect(unauth.statusCode).toBe(401);

    const codes: number[] = [];
    for (let i = 0; i < 36; i++) codes.push((await app.inject({ method: 'GET', url: `/api/public/surveys/${'B'.repeat(32)}` })).statusCode);
    expect(codes).toContain(429);
    expect(codes.filter((c) => c === 404).length).toBeGreaterThanOrEqual(20);
    expect(codes.indexOf(429)).toBeGreaterThan(codes.lastIndexOf(404) - 1);
  });

  it('9. the portal: a customer rates their own ticket once, never another organisation\'s, and the "to rate" list and counts follow', async () => {
    const t = await mk({ title: 'Portal rating', requesterUserId: ids.alphaUser });
    await resolve(t.id);
    const view = await asAlpha((ctx) => answerPortalSurvey(ctx, t.id, { rating: 5, comment: 'Great work' }));
    expect(view).toMatchObject({ status: 'answered', rating: 5, comment: 'Great work', channel: 'portal' });
    expect(view).not.toHaveProperty('recipientEmail');
    expect(await rowFor(t.id)).toMatchObject({ channel: 'portal', answeredByUserId: ids.alphaUser });
    await expect(asAlpha((ctx) => answerPortalSurvey(ctx, t.id, { rating: 4 }))).rejects.toBeInstanceOf(ConflictError);

    const pending = await mk({ title: 'Pending for the portal', requesterUserId: ids.alphaUser });
    await resolve(pending.id);
    await expect(asBeta((ctx) => answerPortalSurvey(ctx, pending.id, { rating: 1 }))).rejects.toBeInstanceOf(NotFoundError);
    const openTicket = await mk({ title: 'Still open', requesterUserId: ids.alphaUser });
    await expect(asAlpha((ctx) => answerPortalSurvey(ctx, openTicket.id, { rating: 4 }))).rejects.toBeInstanceOf(ValidationError);

    await patchConfig(ids.configA, { samplingPct: 0 });
    const unsampled = await mk({ title: 'Rated without a survey', requesterUserId: ids.alphaUser });
    await resolve(unsampled.id);
    await patchConfig(ids.configA, { samplingPct: null });
    expect(await rowFor(unsampled.id)).toBeNull();
    const voluntary = await asAlpha((ctx) => answerPortalSurvey(ctx, unsampled.id, { rating: 4 }));
    expect(voluntary).toMatchObject({ status: 'answered', rating: 4, trigger: 'manual' });
    expect(await rowFor(unsampled.id)).toMatchObject({ sendCount: 0, recipientUserId: ids.alphaUser });
    expect(await outboxFor(REQUESTED, unsampled.id)).toHaveLength(0);

    await patchConfig(ids.configA, { enabled: false });
    const off = await mk({ title: 'Surveys off for the customer', requesterUserId: ids.alphaUser });
    await resolve(off.id);
    expect(await rowFor(off.id)).toBeNull();
    expect((await asAlpha((ctx) => getPortalTicket(ctx, off.id))).actions.rate).toBe(false);
    await expect(asAlpha((ctx) => answerPortalSurvey(ctx, off.id, { rating: 5 }))).rejects.toBeInstanceOf(ValidationError);
    await patchConfig(ids.configA, { enabled: null });
    const problem = await mk({ title: 'Problem raised by the customer', type: 'problem', requesterUserId: ids.alphaUser });
    await resolve(problem.id);
    expect((await asAlpha((ctx) => getPortalTicket(ctx, problem.id))).actions.rate).toBe(false);
    await expect(asAlpha((ctx) => answerPortalSurvey(ctx, problem.id, { rating: 5 }))).rejects.toBeInstanceOf(ValidationError);
    expect(await rowFor(problem.id)).toBeNull();

    const detail = await asAlpha((ctx) => getPortalTicket(ctx, t.id));
    expect(detail.survey).toMatchObject({ status: 'answered', rating: 5 });
    expect(JSON.stringify(detail.survey)).not.toContain(emails.alphaUser);
    expect(detail.actions.rate).toBe(false);
    const pendingDetail = await asAlpha((ctx) => getPortalTicket(ctx, pending.id));
    expect(pendingDetail.survey).toMatchObject({ status: 'pending', canAnswer: true });
    expect(pendingDetail.actions.rate).toBe(true);
    const list = await asAlpha((ctx) => listPortalTickets(ctx, ticketListQuery.parse({ status: 'rate', pageSize: 100 })));
    expect(list.items.map((i) => i.id)).toContain(pending.id);
    expect(list.items.map((i) => i.id)).not.toContain(t.id);
    expect(list.items.every((i) => i.surveyPending)).toBe(true);
    expect(list.counts.rate).toBe(list.total);
    expect(list.counts.rate).toBeGreaterThanOrEqual(1);
    const profile = await asAlpha((ctx) => me(ctx));
    expect(profile.counts.surveysPending).toBe(list.counts.rate);
    const toRate = await asAlpha((ctx) => pendingForPortal(ctx));
    expect(toRate.count).toBe(list.counts.rate);
    expect(toRate.items.some((i) => i.ticketId === pending.id)).toBe(true);
    expect(toRate.items.length).toBeLessThanOrEqual(5);
  });

  it('10. a low rating alerts the account manager, the team manager and the assignee; the threshold follows the customer policy', async () => {
    const t = await mk({ title: 'Poor rating', requesterUserId: ids.alphaUser });
    await resolve(t.id);
    expect(await publicRate(tokenOf((await rowFor(t.id))!), 2)).toMatchObject({ ok: true });
    const mails = await outboxFor(LOW, t.id);
    expect(mails.map((m) => m.recipient).sort()).toEqual([emails.am, emails.eng, emails.mgr].sort());
    expect(mails[0]!.subject).toContain('Rated 2/5');
    const inApp = await inAppFor(LOW, t.id);
    expect(inApp.map((n) => n.userId).sort()).toEqual([ids.am, ids.eng, ids.mgr].sort());
    expect((await rowFor(t.id))?.lowRatingAlertedAt).toBeTruthy();

    const fine = await mk({ title: 'Neutral rating', requesterUserId: ids.alphaUser });
    await resolve(fine.id);
    await publicRate(tokenOf((await rowFor(fine.id))!), 3);
    expect(await outboxFor(LOW, fine.id)).toHaveLength(0);
    expect((await rowFor(fine.id))?.lowRatingAlertedAt).toBeNull();

    await patchConfig(ids.configA, { lowRatingThreshold: 3 });
    const stricter = await mk({ title: 'Stricter threshold', requesterUserId: ids.alphaUser });
    await resolve(stricter.id);
    await publicRate(tokenOf((await rowFor(stricter.id))!), 3);
    expect(await outboxFor(LOW, stricter.id)).toHaveLength(3);
    await patchConfig(ids.configA, { lowRatingThreshold: null });

    // The same alert from the portal, where the answer runs under the customer's own context.
    const viaPortal = await mk({ title: 'Poor rating from the portal', requesterUserId: ids.alphaUser });
    await resolve(viaPortal.id);
    await asAlpha((ctx) => answerPortalSurvey(ctx, viaPortal.id, { rating: 2, comment: 'Nobody called back' }));
    const portalMails = await outboxFor(LOW, viaPortal.id);
    expect(portalMails.map((m) => m.recipient).sort()).toEqual([emails.am, emails.eng, emails.mgr].sort());
    expect(portalMails[0]!.body).toContain('Nobody called back');
    expect((await inAppFor(LOW, viaPortal.id)).map((n) => n.userId).sort()).toEqual([ids.am, ids.eng, ids.mgr].sort());
    expect((await rowFor(viaPortal.id))?.lowRatingAlertedAt).toBeTruthy();

    // Two answers racing on one survey (the one-click link open twice): the second loses; the rating, the activity and the alert exist once.
    const raced = await mk({ title: 'Answered twice at once', requesterUserId: ids.alphaUser });
    await resolve(raced.id);
    const stale = (await rowFor(raced.id))!;
    const answer = (rating: number) => withSystem((tx) => svc.recordAnswer(systemCtx(tx, 'race'), stale, { rating, comment: null, channel: 'email', byUserId: ids.alphaUser, byName: 'Alpha User' }));
    const first = await answer(1);
    expect(first).toMatchObject({ rating: 1, status: 'answered' });
    expect(first.lowRatingAlertedAt).toBeTruthy();
    await expect(answer(5)).rejects.toBeInstanceOf(ConflictError);
    expect(await rowFor(raced.id)).toMatchObject({ rating: 1, status: 'answered' });
    expect(await outboxFor(LOW, raced.id)).toHaveLength(3);
    expect((await activitiesOf(raced.id)).filter((a) => (a.data as { action?: string } | null)?.action === 'answer')).toHaveLength(1);
    expect(await auditsOf(raced.id, 'survey.answer')).toHaveLength(1);
    const commentOnce = (text: string) => withSystem((tx) => svc.addComment(systemCtx(tx, 'race'), first, text, ids.alphaUser));
    await commentOnce('First comment');
    await expect(commentOnce('Second comment')).rejects.toBeInstanceOf(ConflictError);
    expect((await rowFor(raced.id))?.comment).toBe('First comment');
  });

  it('11. the aggregates: figures, groups and lowest for staff; the organisation only, no engineer names and a coerced breakdown for customers', async () => {
    const b1 = await mk({ title: 'Beta ticket one', customerId: ids.b, requesterUserId: ids.beta });
    const b2 = await mk({ title: 'Beta ticket two', customerId: ids.b, requesterUserId: ids.beta });
    await resolve(b1.id);
    await resolve(b2.id);
    await publicRate(tokenOf((await rowFor(b1.id))!), 4);
    await publicRate(tokenOf((await rowFor(b2.id))!), 1);
    const expected = await withSystem(async (tx) => {
      const [row] = (await tx.execute(sql`SELECT count(*)::int AS n, avg(rating) AS avg, count(*) FILTER (WHERE rating >= 4)::int AS satisfied, count(*) FILTER (WHERE rating <= 2)::int AS low, count(*) FILTER (WHERE rating = 5)::int AS fives, min(rating)::int AS lowest FROM ticket_surveys WHERE customer_id = ${ids.a}::uuid AND status = 'answered'`)).rows as { n: number; avg: string; satisfied: number; low: number; fives: number; lowest: number }[];
      return row!;
    });
    expect(expected.n).toBeGreaterThanOrEqual(6);
    const summary = await asAdmin((ctx) => svc.csatSummary(ctx, { customerId: ids.a, days: 7, groupBy: 'engineer' }));
    expect(summary.figures.responses).toBe(expected.n);
    expect(summary.figures.avg).toBe(Math.round(Number(expected.avg) * 10) / 10);
    expect(summary.figures.satisfiedPct).toBe(Math.round((expected.satisfied / expected.n) * 1000) / 10);
    expect(summary.figures.low).toBe(expected.low);
    expect(summary.figures.distribution['5']).toBe(expected.fives);
    expect(summary.figures.sent).toBeGreaterThan(expected.n);
    expect(summary.figures.responseRate).toBeGreaterThan(0);
    expect(summary.figures.responseRate).toBeLessThan(100);
    expect(summary.figures.series.length).toBeGreaterThanOrEqual(1);
    expect(summary.groups.map((g) => g.label)).toContain('Survey Engineer');
    expect(summary.lowest[0]?.rating).toBe(expected.lowest);
    expect(expected.low).toBeGreaterThanOrEqual(1);
    expect(summary.lowest.every((l) => l.customerId === ids.a)).toBe(true);
    expect(summary.lowest[0]).toHaveProperty('assigneeName', 'Survey Engineer');

    const everyone = await asAdmin((ctx) => svc.csatSummary(ctx, { days: 7 }));
    expect(everyone.figures.responses).toBeGreaterThanOrEqual(expected.n + 2);
    expect(everyone.groups.map((g) => g.label)).toEqual(expect.arrayContaining([nameA, nameB]));

    const mine = await asAlpha((ctx) => svc.csatSummary(ctx, { customerId: ids.b, days: 7, groupBy: 'engineer' }));
    expect(mine.figures.responses).toBe(expected.n);
    expect(mine.groupBy).toBe('service');
    expect(mine.lowest.every((l) => l.customerId === ids.a && !('assigneeName' in l))).toBe(true);
    expect(JSON.stringify(mine)).not.toContain('Survey Engineer');
    expect(JSON.stringify(mine)).not.toContain(nameB);
    await expect(asEng((ctx) => svc.csatSummary(ctx, { days: 7 }))).rejects.toBeInstanceOf(ForbiddenError);

    const responses = await asAlpha((ctx) => svc.listResponses(ctx, { page: 1, pageSize: 50, days: 7 }));
    expect(responses.total).toBe(expected.n);
    expect(responses.items.every((r) => r.customerId === ids.a && !('assigneeName' in r) && !('teamName' in r) && !('recipientEmail' in r))).toBe(true);
    const staffRows = await asAdmin((ctx) => svc.listResponses(ctx, { page: 1, pageSize: 50, days: 7, customerId: ids.a }));
    expect(staffRows.items[0]).toHaveProperty('assigneeName', 'Survey Engineer');
    expect(staffRows.items[0]).toHaveProperty('teamName', `Survey Desk ${S}`);
    const fives = await asAdmin((ctx) => svc.listResponses(ctx, { page: 1, pageSize: 50, days: 7, customerId: ids.a, rating: 5 }));
    expect(fives.total).toBe(expected.fives);
    expect(fives.items.every((r) => r.rating === 5)).toBe(true);
    const low = await asAdmin((ctx) => svc.listResponses(ctx, { page: 1, pageSize: 50, days: 7, customerId: ids.a, low: true }));
    expect(low.total).toBe(expected.low);
    const byComment = await asAdmin((ctx) => svc.listResponses(ctx, { page: 1, pageSize: 50, days: 7, customerId: ids.a, q: 'Quick and friendly' }));
    expect(byComment.total).toBe(1);
    expect(byComment.items[0]?.comment).toBe('Quick and friendly');
    const pendingRows = await asAdmin((ctx) => svc.listResponses(ctx, { page: 1, pageSize: 50, days: 7, customerId: ids.a, status: 'pending' }));
    expect(pendingRows.items.every((r) => r.status === 'pending' && r.rating === null)).toBe(true);
    expect(pendingRows.total).toBeGreaterThanOrEqual(1);
  });

  it('12. the ticket list filters and sorts by rating, and the ticket read embeds the survey with the recipient for staff only', async () => {
    const rated = await asAdmin((ctx) => listTickets(ctx, listQuerySchema.parse({ csat: 'rated', customerId: ids.a, pageSize: 200 })));
    expect(rated.items.length).toBeGreaterThanOrEqual(6);
    expect(rated.items.every((t) => t.csatRating !== null && t.surveyStatus === 'answered')).toBe(true);
    const low = await asAdmin((ctx) => listTickets(ctx, listQuerySchema.parse({ csat: 'low', customerId: ids.a, pageSize: 200 })));
    expect(low.items.length).toBeGreaterThanOrEqual(1);
    expect(low.items.every((t) => (t.csatRating ?? 9) <= 2)).toBe(true);
    const pending = await asAdmin((ctx) => listTickets(ctx, listQuerySchema.parse({ csat: 'pending', customerId: ids.a, pageSize: 200 })));
    expect(pending.items.length).toBeGreaterThanOrEqual(1);
    expect(pending.items.every((t) => t.surveyStatus === 'pending' && t.csatRating === null)).toBe(true);
    const unrated = await asAdmin((ctx) => listTickets(ctx, listQuerySchema.parse({ csat: 'unrated', customerId: ids.a, pageSize: 200 })));
    expect(unrated.items.every((t) => t.csatRating === null && ['resolved', 'closed'].includes(t.status.category ?? ''))).toBe(true);
    expect(unrated.items.length).toBeGreaterThanOrEqual(pending.items.length);
    const sorted = await asAdmin((ctx) => listTickets(ctx, listQuerySchema.parse({ csat: 'rated', customerId: ids.a, sort: 'csat', order: 'asc', pageSize: 200 })));
    const ratings = sorted.items.map((t) => t.csatRating!);
    expect(ratings).toEqual([...ratings].sort((x, y) => x - y));
    const lapsed = await mk({ title: 'Survey lapsed before the sweep', requesterUserId: ids.alphaUser });
    await resolve(lapsed.id);
    await patchSurvey(lapsed.id, { expiresAt: new Date(Date.now() - 3_600_000) });
    const stillPending = await asAdmin((ctx) => listTickets(ctx, listQuerySchema.parse({ csat: 'pending', customerId: ids.a, pageSize: 200 })));
    expect(stillPending.items.map((t) => t.id)).not.toContain(lapsed.id);
    const unratedNow = await asAdmin((ctx) => listTickets(ctx, listQuerySchema.parse({ csat: 'unrated', customerId: ids.a, pageSize: 200 })));
    expect(unratedNow.items.find((t) => t.id === lapsed.id)?.surveyStatus).toBe('expired');
    const portalRows = await asAlpha((ctx) => listPortalTickets(ctx, ticketListQuery.parse({ status: 'rate', pageSize: 100 })));
    expect(portalRows.items.map((i) => i.id)).not.toContain(lapsed.id);
    expect((await asAlpha((ctx) => getPortalTicket(ctx, lapsed.id))).actions.rate).toBe(false);

    const ratedTicket = rated.items[0]!;
    const staffView = await asAdmin((ctx) => getTicket(ctx, ratedTicket.id));
    expect(staffView.survey).toMatchObject({ status: 'answered' });
    expect(staffView.survey).toHaveProperty('recipientEmail');
    expect(staffView.permissions.survey).toBe(true);
    const customerView = await asAlpha((ctx) => getTicket(ctx, ratedTicket.id));
    expect(customerView.survey).toMatchObject({ status: 'answered' });
    expect(customerView.survey).not.toHaveProperty('recipientEmail');
    expect(customerView.permissions.survey).toBe(false);
    const mgrView = await asMgr((ctx) => getTicket(ctx, ratedTicket.id));
    expect(mgrView.permissions.survey).toBe(true);
    const engView = await asEng((ctx) => getTicket(ctx, ratedTicket.id));
    expect(engView.permissions.survey).toBe(false);
  });

  it('13. the manual send bypasses sampling, needs surveys:manage, a resolved or closed ticket and no answer yet', async () => {
    await patchConfig(ids.configA, { samplingPct: 0 });
    const t = await mk({ title: 'Manual send', requesterUserId: ids.alphaUser });
    await resolve(t.id);
    await patchConfig(ids.configA, { samplingPct: null });
    expect(await rowFor(t.id)).toBeNull();
    await expect(asEng((ctx) => svc.sendSurvey(ctx, t.id))).rejects.toBeInstanceOf(ForbiddenError);
    const sent = await asMgr((ctx) => svc.sendSurvey(ctx, t.id));
    expect(sent).toMatchObject({ status: 'pending', trigger: 'manual', recipientEmail: emails.alphaUser });
    expect(await outboxFor(REQUESTED, t.id)).toHaveLength(1);
    const openTicket = await mk({ title: 'Manual send while open', requesterUserId: ids.alphaUser });
    await expect(asMgr((ctx) => svc.sendSurvey(ctx, openTicket.id))).rejects.toBeInstanceOf(ValidationError);
    await publicRate(tokenOf((await rowFor(t.id))!), 5);
    await expect(asMgr((ctx) => svc.sendSurvey(ctx, t.id))).rejects.toBeInstanceOf(ConflictError);
    const noRequester = await mk({ title: 'Manual send without requester' });
    await resolve(noRequester.id);
    await expect(asMgr((ctx) => svc.sendSurvey(ctx, noRequester.id))).rejects.toBeInstanceOf(ValidationError);
  });

  it('14. the sweep sends one reminder after the policy delay, expires old surveys and honours a customer with reminders off', async () => {
    const t = await mk({ title: 'Reminder due', requesterUserId: ids.alphaUser });
    await resolve(t.id);
    await patchSurvey(t.id, { requestedAt: new Date(Date.now() - 4 * DAY) });
    const stale = await mk({ title: 'Expired by the sweep', requesterUserId: ids.alphaUser });
    await resolve(stale.id);
    await patchSurvey(stale.id, { requestedAt: new Date(Date.now() - 20 * DAY), expiresAt: new Date(Date.now() - 6 * DAY) });
    await patchConfig(ids.configB, { reminderDays: 0 });
    const quiet = await mk({ title: 'Reminders off', customerId: ids.b, requesterUserId: ids.beta });
    await resolve(quiet.id);
    await patchSurvey(quiet.id, { requestedAt: new Date(Date.now() - 4 * DAY) });
    await svc.sweep();
    const mails = await outboxFor(REQUESTED, t.id);
    expect(mails).toHaveLength(2);
    expect(mails[1]!.subject).toBe(`Reminder: How did we do on ${t.number}?`);
    expect(await rowFor(t.id)).toMatchObject({ sendCount: 2, status: 'pending' });
    expect((await rowFor(t.id))?.remindedAt).toBeTruthy();
    expect((await activitiesOf(t.id)).map((a) => a.summary)).toContain('Satisfaction survey reminder sent');
    expect((await rowFor(stale.id))?.status).toBe('expired');
    expect(await outboxFor(REQUESTED, quiet.id)).toHaveLength(1);
    await svc.sweep();
    expect(await outboxFor(REQUESTED, t.id)).toHaveLength(2);
    await patchConfig(ids.configB, { reminderDays: null });
  });

  it('15. the dashboards carry the figures: management, customer (with the tickets to rate), engineer (with the recent ratings) and AMC', async () => {
    const management = await asAdmin((ctx) => dashboards.management(ctx, { days: 30, customerId: ids.a }));
    expect(typeof management.kpis.csatAvg).toBe('number');
    expect(typeof management.kpis.csatSatisfiedPct).toBe('number');
    expect(typeof management.kpis.csatResponseRate).toBe('number');
    expect(management.csat.avg).toBe(management.kpis.csatAvg);
    expect(management.csat.series.length).toBeGreaterThanOrEqual(1);
    expect(management.csat.lowest.length).toBeGreaterThanOrEqual(1);
    expect(management.csat.lowest[0]!.rating).toBeLessThanOrEqual(2);
    expect(management.csat.low).toBeGreaterThanOrEqual(1);
    expect(management.csat.trendAvg).toHaveProperty('current', management.csat.avg);
    const customerHome = await asAlpha((ctx) => dashboards.customer(ctx, { days: 30 }));
    expect(customerHome.csat.responses).toBeGreaterThanOrEqual(6);
    expect(customerHome.csat.pending.count).toBeGreaterThanOrEqual(1);
    expect(customerHome.csat.pending.items.length).toBeGreaterThanOrEqual(1);
    const staffPreview = await asAdmin((ctx) => dashboards.customer(ctx, { days: 30, customerId: ids.a }));
    expect(staffPreview.csat.pending.items).toEqual([]);
    expect(staffPreview.csat.pending.count).toBe(customerHome.csat.pending.count);
    const engineer = await asEng((ctx) => dashboards.engineer(ctx, { days: 30 }));
    expect(engineer.csat.responses).toBeGreaterThanOrEqual(6);
    expect(engineer.csat.recent.length).toBeGreaterThanOrEqual(1);
    expect(engineer.csat.recent.length).toBeLessThanOrEqual(5);
    expect(engineer.csat.recent[0]).toHaveProperty('number');
    const amc = await asAdmin((ctx) => dashboards.amc(ctx, { days: 30 }));
    expect(amc.csat30d).toHaveProperty('responses');
    expect(amc.csat30d).toHaveProperty('avg');
  });

  it('16. the reports: the summary with its frozen tiles, the customer-pinned portal run, the responses CSV, the review pack and the service report', async () => {
    const summary = await asAdmin((ctx) => findReport('csat_summary')!.run(ctx, { customerId: ids.a, from: yesterday(), to: today(), groupBy: 'engineer' }));
    const tile = (label: string) => summary.summary?.find((s) => s.label === label)?.value;
    const live = await asAdmin((ctx) => svc.csatSummary(ctx, { customerId: ids.a, from: yesterday(), to: today() }));
    expect(tile('Responses')).toBe(live.figures.responses);
    expect(tile('Surveys sent')).toBe(live.figures.sent);
    expect(tile('Average rating')).toBe(`${live.figures.avg}/5`);
    expect(tile('Satisfied')).toBe(`${live.figures.satisfiedPct}%`);
    expect(tile('Response rate')).toBe(`${live.figures.responseRate}%`);
    expect(tile('Low ratings')).toBe(live.figures.low);
    expect(summary.columns[0]!.label).toBe('Engineer');
    expect(summary.rows.some((r) => r.label === 'Survey Engineer')).toBe(true);
    expect(summary.sections?.map((s) => s.title)).toEqual(['Rating distribution', 'Lowest-rated tickets']);
    expect(summary.sections?.[1]?.columns.some((c) => c.key === 'engineer')).toBe(true);
    expect(summary.charts?.map((c) => c.title)).toEqual(['Average rating by engineer', 'Average rating per week']);

    const portal = await asAlphaAdmin((ctx) => executeReport(ctx, { reportKey: 'csat_summary', parameters: { groupBy: 'engineer', dateRange: 'last_7_days' }, format: 'json' }));
    expect(portal.params.customerId).toBe(ids.a);
    expect(portal.result.columns[0]!.label).toBe('Service');
    expect(portal.result.summary?.find((s) => s.label === 'Responses')?.value).toBe(live.figures.responses);
    expect(portal.result.sections?.[1]?.columns.some((c) => c.key === 'engineer')).toBe(false);
    expect(JSON.stringify(portal.result)).not.toContain('Survey Engineer');

    const csv = await asAdmin((ctx) => runReport(ctx, { reportKey: 'csat_responses', parameters: { customerId: ids.a, dateRange: 'last_7_days' }, format: 'csv' }));
    const storedKey = (csv as { reportKey?: string }).reportKey ?? (csv as { run?: { reportKey?: string } }).run?.reportKey;
    expect(storedKey).toBe('csat_responses');
    const responses = await asAdmin((ctx) => findReport('csat_responses')!.run(ctx, { customerId: ids.a, from: yesterday(), to: today(), lowOnly: true }));
    expect(responses.rows.length).toBe(live.figures.low);
    expect(responses.rows.every((r) => Number(r.rating) <= 2)).toBe(true);
    expect(responses.columns.some((c) => c.key === 'engineer')).toBe(true);

    const pack = await asAdmin((ctx) => runReport(ctx, { reportKey: 'service_review_pack', parameters: { customerId: ids.a, dateRange: 'last_7_days', recommendations: false } }));
    const packResult = (pack as { result: { summary?: { label: string; value: unknown }[]; rows: Record<string, unknown>[]; sections?: { title: string }[] } }).result;
    // the pack's tile is numeric (unit rating, target 4, delta) so the document can judge and compare it; the label is frozen
    expect(packResult.summary?.find((s) => s.label === 'Customer satisfaction')?.value).toBe(live.figures.avg);
    expect(packResult.rows.some((r) => r.metric === 'Customer satisfaction' && r.area === 'Satisfaction')).toBe(true);
    expect(packResult.sections?.map((s) => s.title)).toEqual(expect.arrayContaining(['Customer satisfaction by service', 'Lowest-rated tickets']));
    const service = await asAdmin((ctx) => findReport('service_report')!.run(ctx, { customerId: ids.a, from: yesterday(), to: today() }));
    expect(service.summary?.find((s) => s.label === 'Customer satisfaction')?.value).toBe(`${live.figures.avg}/5`);

    // An engineer can run the pack (reports:run, contracts:read, assets:read) but holds no surveys:read: the part is left out, not refused.
    const engPack = await asEng((ctx) => executeReport(ctx, { reportKey: 'service_review_pack', parameters: { customerId: ids.a, dateRange: 'last_7_days', recommendations: false }, format: 'json' }));
    expect(engPack.result.summary?.some((s) => s.label === 'Customer satisfaction')).toBe(false);
    expect(engPack.result.rows.some((r) => r.area === 'Satisfaction')).toBe(false);
    expect(engPack.result.sections?.map((s) => s.title)).not.toContain('Customer satisfaction by service');
    expect(engPack.result.summary?.some((s) => s.label === 'SLA compliance')).toBe(true);
    await expect(asEng((ctx) => executeReport(ctx, { reportKey: 'csat_summary', parameters: { customerId: ids.a, dateRange: 'last_7_days' }, format: 'json' }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('17. the assistant: figures for staff and for the organisation only, poor ratings without engineer names, the portal-only rating and the confirmed send', async () => {
    const csat = toolByName('csat_summary')!;
    const staff = (await asAdmin((ctx) => csat.run(ctx, { customer: nameA, days: 30 }))) as { facts: string[]; figures: { responses: number } };
    expect(staff.facts[0]).toMatch(/Average CSAT \d(\.\d)?\/5 from \d+ response\(s\) over 30 days/);
    expect(staff.facts[0]).toContain(nameA);
    const own = (await asAlpha((ctx) => csat.run(ctx, { customer: nameB, days: 30, groupBy: 'engineer' }))) as { figures: { responses: number }; groupBy: string; lowest: unknown[] };
    expect(own.figures.responses).toBe(staff.figures.responses);
    expect(own.groupBy).toBe('service');
    expect(JSON.stringify(own)).not.toContain(nameB);
    expect(JSON.stringify(own)).not.toContain('Survey Engineer');
    const lowTool = toolByName('csat_low_ratings')!;
    const low = (await asAlpha((ctx) => lowTool.run(ctx, { days: 30 }))) as { items: Record<string, unknown>[]; facts: string[] };
    expect(low.items.length).toBeGreaterThanOrEqual(1);
    expect(low.items.every((i) => !('assignee' in i) && Number(i.rating) <= 2)).toBe(true);
    const lowStaff = (await asAdmin((ctx) => lowTool.run(ctx, { customer: nameA, days: 30, threshold: 3 }))) as { items: Record<string, unknown>[] };
    expect(lowStaff.items.every((i) => Number(i.rating) <= 3 && 'assignee' in i)).toBe(true);
    expect(lowStaff.items.length).toBeGreaterThan(low.items.length);

    const rate = toolByName('rate_ticket')!;
    expect(rate.portalOnly).toBe(true);
    const pending = await mk({ title: 'Rated through the assistant', requesterUserId: ids.alphaUser });
    await resolve(pending.id);
    await expect(asBeta((ctx) => rate.preview!(ctx, { ticket: pending.number, rating: 5 }))).rejects.toBeInstanceOf(NotFoundError);
    const preview = await asAlpha((ctx) => rate.preview!(ctx, { ticket: pending.number, rating: 4, comment: 'The engineer was quick' }));
    expect(typeof preview === 'string' ? preview : preview.text).toContain(`Rate ${pending.number}`);
    const result = (await asAlpha((ctx) => rate.run(ctx, { ticket: pending.number, rating: 4, comment: 'The engineer was quick' }))) as { rated: boolean; rating: number };
    expect(result).toMatchObject({ rated: true, rating: 4 });
    expect(await rowFor(pending.id)).toMatchObject({ status: 'answered', channel: 'assistant', comment: 'The engineer was quick', answeredByUserId: ids.alphaUser });

    const send = toolByName('send_survey')!;
    const again = await mk({ title: 'Send through the assistant', requesterUserId: ids.alphaUser });
    await resolve(again.id);
    const sendPreview = await asMgr((ctx) => send.preview!(ctx, { ticket: again.number }));
    expect(typeof sendPreview === 'string' ? sendPreview : sendPreview.text).toContain(`to Alpha User (${emails.alphaUser})`);
    const offered = async (as: typeof asMgr) => as(async (ctx) => availableTools(ctx).map((t) => t.name));
    expect(await offered(asMgr)).toContain('send_survey');
    expect(await offered(asEng)).not.toContain('send_survey');
    expect(await offered(asAlpha)).toEqual(expect.arrayContaining(['csat_summary', 'csat_low_ratings', 'rate_ticket']));
    expect(await offered(asAlpha)).not.toContain('send_survey');
    expect(await offered(asAdmin)).not.toContain('rate_ticket');
  });

  it('18. the customer overview carries the ninety-day satisfaction', async () => {
    const overview = await asAdmin((ctx) => customerOverview(ctx, ids.a));
    const live = await asAdmin((ctx) => svc.csatSummary(ctx, { customerId: ids.a, days: 90 }));
    expect(overview.csat90d).toEqual({ avg: live.figures.avg, responses: live.figures.responses, satisfiedPct: live.figures.satisfiedPct });
  });

  it('19. security tickets stay behind soc:read: their ratings are absent for surveys:read holders without it, present for the customer', async () => {
    const am = (await loadPrincipal(ids.am))!;
    const asAm = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(am, meta, fn);
    const secure = await mk({ title: 'Security incident', requesterUserId: ids.alphaUser });
    await resolve(secure.id);
    expect(await publicRate(tokenOf((await rowFor(secure.id))!), 1)).toMatchObject({ ok: true });
    await withSystem((tx) => tx.update(schema.tickets).set({ domain: 'soc' }).where(eq(schema.tickets.id, secure.id)));
    const full = await asAdmin((ctx) => svc.csatSummary(ctx, { customerId: ids.a, days: 30 }));
    const fenced = await asAm((ctx) => svc.csatSummary(ctx, { customerId: ids.a, days: 30 }));
    expect(full.lowest.some((l) => l.ticketId === secure.id)).toBe(true);
    expect(fenced.lowest.some((l) => l.ticketId === secure.id)).toBe(false);
    expect(fenced.figures.responses).toBe(full.figures.responses - 1);
    expect(fenced.figures.low).toBe(full.figures.low - 1);
    const fencedList = await asAm((ctx) => svc.listResponses(ctx, { page: 1, pageSize: 200, days: 30, customerId: ids.a }));
    expect(fencedList.items.some((i) => i.ticketId === secure.id)).toBe(false);
    const fullList = await asAdmin((ctx) => svc.listResponses(ctx, { page: 1, pageSize: 200, days: 30, customerId: ids.a }));
    expect(fullList.items.some((i) => i.ticketId === secure.id)).toBe(true);
    const own = await asAlpha((ctx) => svc.csatSummary(ctx, { days: 30 }));
    expect(own.figures.responses).toBe(full.figures.responses);
    const report = await asAm((ctx) => findReport('csat_summary')!.run(ctx, { customerId: ids.a, from: yesterday(), to: today() }));
    expect(report.sections?.[1]?.rows.some((r) => r.id === secure.id)).toBe(false);
    const overview = await asAm((ctx) => customerOverview(ctx, ids.a));
    expect(overview.csat90d.responses).toBe(fenced.figures.responses);
  });
});
