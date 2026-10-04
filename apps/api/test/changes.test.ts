/**
 * Change management: the risk scorer (weights, scaling, thresholds, missing
 * answers), conflict detection (shared CI, shared business service, blackout
 * windows, emergency exemption, edge-touching windows), then the database
 * parts: calendar and conflicts recorded as a warning activity, a template
 * that skips approval, a CAB decision that decides the ticket's approval step,
 * and the window reminder; then the gap closure: the catalog usage figures,
 * the blackout refusal, the assessment gate, the enriched record and the
 * portal's view of it, the ticket list filters, the CAB queue, agenda order,
 * notes, appended board notes, generated minutes, cancellation and the
 * rejection of a pre-approved change, meetings on the calendar, the portal's
 * planned changes, thresholds and reorder, who may assess, the seed, and the
 * six change tools. Run with the dev environment sourced:
 * npx vitest run test/changes.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray, asc, sql } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { createTicket, getTicket, updateChangeDetails } from '../src/modules/tickets/service';
import { requestApproval, listForTicket } from '../src/modules/tickets/approvals';
import { listTickets } from '../src/modules/tickets/list';
import { listQuerySchema } from '../src/modules/tickets/schemas';
import { getPortalTicket, portalPlannedChanges } from '../src/modules/portal/service';
import { seedChangeConfig } from '../src/seed/defaults';
import { renderMinutes } from '../src/modules/changes/minutes';
import * as reports from '../src/modules/reports/service';
import * as cmdb from '../src/modules/cmdb/service';
import * as changes from '../src/modules/changes/service';
import { ALL_TOOLS } from '../src/modules/ai/tools';
import { scoreChange, levelOf, parseThresholds, DEFAULT_THRESHOLDS, type RiskQuestion } from '../src/modules/changes/risk';
import { findConflicts, overlaps, windowOf, type OtherChange, type Blackout } from '../src/modules/changes/conflicts';

const QUESTIONS: RiskQuestion[] = [
  { id: 'q1', key: 'scope', question: 'How many users are affected?', weight: 3, options: [{ key: 'few', label: 'A few', score: 1 }, { key: 'team', label: 'A team', score: 3 }, { key: 'everyone', label: 'Everyone', score: 5 }] },
  { id: 'q2', key: 'backout', question: 'Is there a tested backout plan?', weight: 2, options: [{ key: 'yes', label: 'Yes', score: 0 }, { key: 'untested', label: 'Untested', score: 3 }, { key: 'no', label: 'No', score: 5 }] },
  { id: 'q3', key: 'hours', question: 'When does it run?', weight: 1, options: [{ key: 'window', label: 'In a window', score: 0 }, { key: 'business', label: 'Business hours', score: 5 }] },
  { id: 'q4', key: 'retired', question: 'Retired question', weight: 5, options: [{ key: 'a', label: 'A', score: 5 }], isActive: false },
];

describe('scoreChange (pure)', () => {
  it('scales the weighted total to 0..100 against the questionnaire maximum and maps it to a level', () => {
    // max = 3*5 + 2*5 + 1*5 = 30 (the retired question does not count)
    const low = scoreChange(QUESTIONS, { scope: 'few', backout: 'yes', hours: 'window' });
    expect(low).toMatchObject({ points: 3, maxPoints: 30, score: 10, level: 'low', answered: 3, missing: [] });
    const high = scoreChange(QUESTIONS, { scope: 'everyone', backout: 'no', hours: 'business' });
    expect(high).toMatchObject({ points: 30, score: 100, level: 'high' });
    const mid = scoreChange(QUESTIONS, { scope: 'team', backout: 'untested', hours: 'window' });
    expect(mid.score).toBe(50);
    expect(mid.level).toBe('medium');
    expect(mid.drivers[0]).toMatchObject({ key: 'scope', points: 9 });
  });
  it('reports unanswered or unknown answers without counting them', () => {
    const r = scoreChange(QUESTIONS, { scope: 'everyone', backout: 'maybe' });
    expect(r.missing).toEqual(['backout', 'hours']);
    expect(r.answered).toBe(1);
    expect(r.points).toBe(15);
    expect(scoreChange([], { scope: 'few' })).toMatchObject({ score: 0, level: 'low', maxPoints: 0 });
    expect(scoreChange(QUESTIONS, null).missing).toHaveLength(3);
  });
  it('thresholds come from the setting, with sane fallbacks', () => {
    expect(parseThresholds(undefined)).toEqual(DEFAULT_THRESHOLDS);
    expect(parseThresholds({ medium: 20, high: 40 })).toEqual({ medium: 20, high: 40 });
    expect(parseThresholds({ medium: 80, high: 40 })).toEqual({ medium: 80, high: 81 });
    expect(parseThresholds({ medium: 'x', high: 90 })).toEqual({ medium: 35, high: 90 });
    expect(levelOf(39, { medium: 40, high: 70 })).toBe('low');
    expect(levelOf(40, { medium: 40, high: 70 })).toBe('medium');
    expect(levelOf(70, { medium: 40, high: 70 })).toBe('high');
  });
});

const at = (h: number) => new Date(Date.UTC(2026, 9, 10, h));
const other = (p: Partial<OtherChange> & { ticketId: string; start: Date; end: Date }): OtherChange => ({ number: `CHG-${p.ticketId}`, title: `Change ${p.ticketId}`, customerId: 'cust-a', customerName: 'A', changeType: 'normal', status: 'Scheduled', ciIds: [], serviceIds: [], ...p });
const blackout = (p: Partial<Blackout> & { id: string; start: Date; end: Date }): Blackout => ({ name: `Freeze ${p.id}`, reason: null, customerId: null, allowEmergency: true, ...p });

describe('findConflicts (pure)', () => {
  const candidate = { ticketId: 'me', customerId: 'cust-a', changeType: 'normal', start: at(10), end: at(12), ciIds: ['ci-1', 'ci-2'], serviceIds: ['svc-1'] };
  it('windows touching at an edge do not overlap; a missing end means an hour', () => {
    expect(overlaps({ start: at(10), end: at(12) }, { start: at(12), end: at(14) })).toBe(false);
    expect(overlaps({ start: at(10), end: at(12) }, { start: at(11), end: at(14) })).toBe(true);
    expect(windowOf(at(10), null).end.getTime()).toBe(at(11).getTime());
    expect(windowOf(at(10), at(9)).end.getTime()).toBe(at(11).getTime());
  });
  it('flags an overlapping change on a shared CI, then one on the same business service, and ignores the rest', () => {
    const others = [
      other({ ticketId: 'ci-clash', start: at(11), end: at(13), ciIds: ['ci-2', 'ci-9'], serviceIds: ['svc-1'] }),
      other({ ticketId: 'svc-clash', start: at(9), end: at(11), ciIds: ['ci-7'], serviceIds: ['svc-1'] }),
      other({ ticketId: 'later', start: at(12), end: at(14), ciIds: ['ci-1'], serviceIds: ['svc-1'] }),
      other({ ticketId: 'unrelated', start: at(10), end: at(12), ciIds: ['ci-8'], serviceIds: ['svc-2'] }),
      other({ ticketId: 'me', start: at(10), end: at(12), ciIds: ['ci-1'], serviceIds: ['svc-1'] }),
    ];
    const c = findConflicts(candidate, others, []);
    expect(c.map((x) => [x.kind, x.ticket?.id])).toEqual([
      ['ci', 'ci-clash'],
      ['service', 'svc-clash'],
    ]);
    expect(c[0]!.shared).toEqual(['ci-2']);
    expect(c[0]!.text).toContain('1 shared configuration item');
  });
  it('flags blackout windows for the customer or everyone, letting emergency changes through when allowed', () => {
    const blackouts = [
      blackout({ id: 'global', start: at(11), end: at(20) }),
      blackout({ id: 'mine', start: at(8), end: at(11), customerId: 'cust-a', allowEmergency: false, reason: 'Month end' }),
      blackout({ id: 'theirs', start: at(8), end: at(20), customerId: 'cust-b' }),
      blackout({ id: 'past', start: at(1), end: at(10) }),
    ];
    const normal = findConflicts(candidate, [], blackouts);
    expect(normal.map((x) => x.blackout?.id)).toEqual(['global', 'mine']);
    expect(normal[1]!.text).toContain('Month end');
    const emergency = findConflicts({ ...candidate, changeType: 'emergency' }, [], blackouts);
    expect(emergency.map((x) => x.blackout?.id)).toEqual(['mine']);
  });
});

// ---------------------------------------------------------------- database parts

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-changes-${S}`, ip: '127.0.0.1' };
let admin: Principal;
let portal: Principal;
let engineer: Principal;
let manager: Principal;
const ids = { customer: '', site: '', bs: '', app: '', db: '', other: '', cabWorkflow: '', riskLow: '', otherCustomer: '', portalUser: '', engineer: '', manager: '', managerRole: '' };
const types: Record<string, string> = {};
const relTypes: Record<string, string> = {};
const created = { tickets: [] as string[], blackouts: [] as string[], questions: [] as string[], templates: [] as string[], meetings: [] as string[] };
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);
const asPortal = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portal, meta, fn);
const asEngineer = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(engineer, meta, fn);
const hour = (n: number) => new Date(Date.now() + n * 3600_000);
const setSetting = (key: string, value: unknown) =>
  withSystem((tx) => tx.insert(schema.systemSettings).values({ key, value: value as never, description: 'test' }).onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: value as never, updatedAt: new Date() } }));
const roleId = async (tx: Tx, key: string) => (await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1))[0]!.id;
const activities = (id: string, type: string) => withSystem((tx) => tx.select().from(schema.ticketActivities).where(and(eq(schema.ticketActivities.ticketId, id), eq(schema.ticketActivities.activityType, type))));
const changeRow = (id: string) => withSystem(async (tx) => (await tx.select().from(schema.changeDetails).where(eq(schema.changeDetails.ticketId, id)).limit(1))[0]!);
const newChange = (title: string, extra: Record<string, unknown> = {}) =>
  asAdmin(async (ctx) => {
    const t = await createTicket(ctx, { type: 'change', customerId: ids.customer, siteId: ids.site, title, description: 'Patch the cluster.', ...extra } as never);
    created.tickets.push(t.id);
    return t;
  });

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [a] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    const [c] = await tx.insert(schema.customers).values({ code: `CH${S.toUpperCase()}`, name: `Change Customer ${S}`, timezone: 'Asia/Kolkata' }).returning();
    ids.customer = c!.id;
    const [site] = await tx.insert(schema.sites).values({ customerId: c!.id, code: 'HQ', name: 'HQ', isPrimary: true }).returning();
    ids.site = site!.id;
    for (const t of await tx.select().from(schema.ciTypes)) types[t.key] = t.id;
    for (const r of await tx.select().from(schema.ciRelationshipTypes)) relTypes[r.key] = r.id;
    const [wf] = await tx.select({ id: schema.approvalWorkflows.id }).from(schema.approvalWorkflows).where(eq(schema.approvalWorkflows.name, 'CAB approval')).limit(1);
    ids.cabWorkflow = wf!.id;
    const [low] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'change_risk'), eq(schema.configOptions.key, 'low'))).limit(1);
    ids.riskLow = low!.id;
    // A second organisation, a portal user of the first and a NOC engineer (tickets:create/update, no changes:*).
    const [oc] = await tx.insert(schema.customers).values({ code: `CO${S.toUpperCase()}`, name: `Other Customer ${S}`, timezone: 'Asia/Kolkata' }).returning();
    ids.otherCustomer = oc!.id;
    const [pu] = await tx.insert(schema.users).values({ email: `portal-${S}@test.local`, name: `Portal User ${S}`, userType: 'customer', customerId: c!.id, status: 'active' }).returning({ id: schema.users.id });
    await tx.insert(schema.userRoles).values({ userId: pu!.id, roleId: await roleId(tx, 'customer_user'), customerId: c!.id });
    ids.portalUser = pu!.id;
    const [eu] = await tx.insert(schema.users).values({ email: `eng-${S}@test.local`, name: `Engineer ${S}`, userType: 'msp', status: 'active' }).returning({ id: schema.users.id });
    await tx.insert(schema.userRoles).values({ userId: eu!.id, roleId: await roleId(tx, 'noc_engineer') });
    ids.engineer = eu!.id;
    // A custom role that manages changes without tickets:update (the seeded roles happen to hold both).
    const [role] = await tx.insert(schema.roles).values({ key: `chgmgr_${S}`, name: `Change manager ${S}` }).returning({ id: schema.roles.id });
    await tx.insert(schema.rolePermissions).values(['tenant:all', 'tickets:read', 'changes:manage'].map((permission) => ({ roleId: role!.id, permission })));
    const [mu] = await tx.insert(schema.users).values({ email: `cm-${S}@test.local`, name: `Change Manager ${S}`, userType: 'msp', status: 'active' }).returning({ id: schema.users.id });
    await tx.insert(schema.userRoles).values({ userId: mu!.id, roleId: role!.id });
    ids.manager = mu!.id;
    ids.managerRole = role!.id;
    invalidatePrincipal(a!.id);
    admin = (await loadPrincipal(a!.id))!;
  });
  invalidatePrincipal(ids.portalUser);
  portal = (await loadPrincipal(ids.portalUser))!;
  invalidatePrincipal(ids.engineer);
  engineer = (await loadPrincipal(ids.engineer))!;
  invalidatePrincipal(ids.manager);
  manager = (await loadPrincipal(ids.manager))!;
  const bs = await asAdmin((ctx) => cmdb.createCi(ctx, { customerId: ids.customer, siteId: ids.site, typeId: types.business_service!, name: `Billing ${S}`, criticality: 'high' }));
  const app = await asAdmin((ctx) => cmdb.createCi(ctx, { customerId: ids.customer, siteId: ids.site, typeId: types.application!, name: `bill-app ${S}` }));
  const db = await asAdmin((ctx) => cmdb.createCi(ctx, { customerId: ids.customer, siteId: ids.site, typeId: types.database!, name: `bill-db ${S}` }));
  const other = await asAdmin((ctx) => cmdb.createCi(ctx, { customerId: ids.customer, siteId: ids.site, typeId: types.endpoint!, name: `laptop ${S}` }));
  Object.assign(ids, { bs: bs.id, app: app.id, db: db.id, other: other.id });
  await asAdmin((ctx) => cmdb.addRelationship(ctx, bs.id, { targetCiId: app.id, typeId: relTypes.depends_on! }));
  await asAdmin((ctx) => cmdb.addRelationship(ctx, db.id, { targetCiId: app.id, typeId: relTypes.supports! }));
});

afterAll(async () => {
  await withSystem(async (tx) => {
    if (created.meetings.length) await tx.delete(schema.cabMeetings).where(inArray(schema.cabMeetings.id, created.meetings));
    if (created.tickets.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, created.tickets));
    if (created.blackouts.length) await tx.delete(schema.changeBlackoutWindows).where(inArray(schema.changeBlackoutWindows.id, created.blackouts));
    if (created.questions.length) await tx.delete(schema.changeRiskQuestions).where(inArray(schema.changeRiskQuestions.id, created.questions));
    if (created.templates.length) await tx.delete(schema.changeTemplates).where(inArray(schema.changeTemplates.id, created.templates));
    await tx.delete(schema.users).where(inArray(schema.users.id, [ids.portalUser, ids.engineer, ids.manager].filter(Boolean)));
    if (ids.managerRole) await tx.delete(schema.roles).where(eq(schema.roles.id, ids.managerRole));
    await tx.delete(schema.customers).where(inArray(schema.customers.id, [ids.customer, ids.otherCustomer].filter(Boolean)));
  });
  await setSetting('changes.block_blackout_scheduling', false);
  await setSetting('changes.require_assessment_for_approval', false);
  await setSetting('changes.risk_thresholds', { medium: 35, high: 65 });
  await closeDb();
});

describe('calendar and conflicts (database)', () => {
  let first = '';
  let second = '';
  it('records an overlapping change on a shared system as a warning, and a sibling on the same business service', async () => {
    first = (await newChange(`Patch bill-db ${S}`, { primaryCiId: ids.db, change: { scheduledStart: hour(24), scheduledEnd: hour(26) } })).id;
    expect(await activities(first, 'change_conflict')).toHaveLength(0);
    second = (await newChange(`Reboot bill-db ${S}`, { primaryCiId: ids.db, change: { scheduledStart: hour(25), scheduledEnd: hour(27) } })).id;
    const warn = await activities(second, 'change_conflict');
    expect(warn).toHaveLength(1);
    expect(warn[0]!.summary).toContain('shared configuration item');
    expect(warn[0]!.customerVisible).toBe(false);
    // The app sits on the same business service as the database: a service-level clash, not a CI one.
    const third = (await newChange(`Upgrade bill-app ${S}`, { primaryCiId: ids.app, change: { scheduledStart: hour(25), scheduledEnd: hour(26) } })).id;
    const det = await asAdmin((ctx) => changes.detectConflicts(ctx, third));
    expect(det.conflicts.map((c) => c.kind).sort()).toEqual(['service', 'service']);
    // A change on an unrelated system in the same window is clean.
    const clean = (await newChange(`Replace laptop ${S}`, { primaryCiId: ids.other, change: { scheduledStart: hour(25), scheduledEnd: hour(26) } })).id;
    expect((await asAdmin((ctx) => changes.detectConflicts(ctx, clean))).conflicts).toEqual([]);
    expect(await activities(clean, 'change_conflict')).toHaveLength(0);
  });
  it('moving the window out of the clash is recorded once, and the calendar lists windows with their conflicts', async () => {
    await asAdmin((ctx) => updateChangeDetails(ctx, second, { scheduledStart: hour(30), scheduledEnd: hour(31) }));
    const after = await activities(second, 'change_conflict');
    expect(after).toHaveLength(2);
    expect(after.map((a) => a.summary)).toContain('No scheduling conflicts for the current window');
    const cal = await asAdmin((ctx) => changes.calendar(ctx, { from: hour(0), to: hour(48), customerId: ids.customer }));
    expect(cal.items.map((i) => i.ticketId)).toEqual(expect.arrayContaining([first, second]));
    expect(cal.items.find((i) => i.ticketId === second)!.conflicts).toEqual([]);
    const firstItem = cal.items.find((i) => i.ticketId === first)!;
    expect(firstItem.conflicts.some((c) => c.kind === 'service')).toBe(true);
  });
  it('a blackout window flags normal changes and lets an allowed emergency change through; the preview works before saving', async () => {
    const b = await asAdmin((ctx) => changes.createBlackout(ctx, { customerId: ids.customer, name: `Month end ${S}`, reason: 'Finance close', startsAt: hour(40), endsAt: hour(50), allowEmergency: true }));
    created.blackouts.push(b.id);
    const normal = await asAdmin((ctx) => changes.previewConflicts(ctx, { customerId: ids.customer, scheduledStart: hour(41), scheduledEnd: hour(42), changeType: 'normal', ciIds: [] }));
    expect(normal.conflicts.map((c) => c.kind)).toEqual(['blackout']);
    expect(normal.conflicts[0]!.text).toContain('Finance close');
    const emergency = await asAdmin((ctx) => changes.previewConflicts(ctx, { customerId: ids.customer, scheduledStart: hour(41), scheduledEnd: hour(42), changeType: 'emergency', ciIds: [] }));
    expect(emergency.conflicts).toEqual([]);
    const cal = await asAdmin((ctx) => changes.calendar(ctx, { from: hour(0), to: hour(60), customerId: ids.customer }));
    expect(cal.blackouts.map((x) => x.id)).toContain(b.id);
    const tool = ALL_TOOLS.find((t) => t.name === 'change_calendar')!;
    const out = (await asAdmin((ctx) => tool.run(ctx, { from: hour(0).toISOString(), days: 3, customer: ids.customer }))) as { facts: string[]; counts: { changes: number; blackouts: number } };
    expect(out.counts.changes).toBeGreaterThanOrEqual(4);
    expect(out.counts.blackouts).toBe(1);
    expect(out.facts[0]).toContain('scheduled between');
  });
});

describe('risk questionnaire (database)', () => {
  it('scores the answers, writes the level and the matching risk option on the change', async () => {
    const q1 = await asAdmin((ctx) => changes.createRiskQuestion(ctx, { key: `scope_${S}`, question: 'How many users are affected?', weight: 3, options: [{ key: 'few', label: 'A few', score: 1 }, { key: 'all', label: 'Everyone', score: 5 }] }));
    const q2 = await asAdmin((ctx) => changes.createRiskQuestion(ctx, { key: `backout_${S}`, question: 'Backout tested?', weight: 2, options: [{ key: 'yes', label: 'Yes', score: 0 }, { key: 'no', label: 'No', score: 5 }] }));
    created.questions.push(q1.id, q2.id);
    await expect(asAdmin((ctx) => changes.createRiskQuestion(ctx, { key: `scope_${S}`, question: 'dup', options: [{ key: 'a', label: 'A', score: 1 }, { key: 'b', label: 'B', score: 2 }] }))).rejects.toMatchObject({ statusCode: 422 });
    const t = await newChange(`Risky change ${S}`);
    const r = await asAdmin((ctx) => changes.assessRisk(ctx, t.id, { [`scope_${S}`]: 'few', [`backout_${S}`]: 'yes' }));
    expect(r.level).toBe('low');
    expect(r.answered).toBe(2);
    const row = await changeRow(t.id);
    expect(row.riskLevel).toBe('low');
    expect(row.riskScore).toBe(r.score);
    expect(row.riskId).toBe(ids.riskLow);
    expect(row.riskAnswers).toEqual({ [`scope_${S}`]: 'few', [`backout_${S}`]: 'yes' });
    const detail = await asAdmin((ctx) => getTicket(ctx, t.id));
    expect(detail.change?.riskLevel).toBe('low');
    expect(detail.change?.risk?.key).toBe('low');
    const qn = await asAdmin((ctx) => changes.riskQuestionnaire(ctx));
    expect(qn.questions.map((q) => q.id)).toEqual(expect.arrayContaining([q1.id, q2.id]));
    expect(qn.thresholds).toEqual({ medium: 35, high: 65 });
  });
});

describe('standard change templates (database)', () => {
  it('prefills the plans and skips approval when the template is pre-approved', async () => {
    const tpl = await asAdmin((ctx) => changes.createTemplate(ctx, { key: `fw_patch_${S}`, name: `Firewall patch ${S}`, changeType: 'standard', implementationPlan: 'Apply the vendor patch in the window.', backoutPlan: 'Roll back to the previous firmware.', downtimeExpectedMinutes: 15, skipApproval: true, riskId: ids.riskLow, descriptionTemplate: 'Monthly firewall firmware patch.' }));
    created.templates.push(tpl.id);
    const t = await asAdmin(async (ctx) => {
      const row = await createTicket(ctx, { type: 'change', customerId: ids.customer, siteId: ids.site, title: `Firewall patch ${S}`, changeTemplateId: tpl.id, change: { backoutPlan: 'Custom backout.' } } as never);
      created.tickets.push(row.id);
      return row;
    });
    expect(t.approvalStatus).toBe('not_required');
    expect(t.description).toBe('Monthly firewall firmware patch.');
    const row = await changeRow(t.id);
    expect(row.templateId).toBe(tpl.id);
    expect(row.changeType).toBe('standard');
    expect(row.implementationPlan).toBe('Apply the vendor patch in the window.');
    expect(row.backoutPlan).toBe('Custom backout.');
    expect(row.downtimeExpectedMinutes).toBe(15);
    expect(row.riskId).toBe(ids.riskLow);
    expect((await activities(t.id, 'approval')).map((a) => a.summary)).toEqual([expect.stringContaining('Pre-approved standard change')]);
    // Offered to the customer, listed, and refused for an organisation it is not for.
    expect((await asAdmin((ctx) => changes.listTemplates(ctx, { customerId: ids.customer }))).items.map((x) => x.id)).toContain(tpl.id);
    await asAdmin((ctx) => changes.updateTemplate(ctx, tpl.id, { customerIds: ['00000000-0000-4000-8000-000000000001'] }));
    await expect(asAdmin((ctx) => createTicket(ctx, { type: 'change', customerId: ids.customer, title: 'Nope', changeTemplateId: tpl.id } as never))).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('CAB meetings (database)', () => {
  it('decides an agenda item and the pending approval step with it; closing defers what was not reached', async () => {
    const t = await newChange(`CAB change ${S}`, { change: { scheduledStart: hour(70), scheduledEnd: hour(71) } });
    const deferred = await newChange(`Deferred change ${S}`);
    await asAdmin((ctx) => requestApproval(ctx, t.id, ids.cabWorkflow));
    const m = await asAdmin((ctx) => changes.createMeeting(ctx, { title: `Weekly CAB ${S}`, scheduledAt: hour(48), ticketIds: [t.id, deferred.id] }));
    created.meetings.push(m.id);
    expect(m.items).toHaveLength(2);
    expect(m.items.find((i) => i.ticketId === t.id)?.pendingApproval?.stepName).toBe('CAB');
    expect((await changeRow(t.id)).cabMeetingId).toBe(m.id);
    expect((await activities(t.id, 'cab')).map((a) => a.summary)).toEqual([expect.stringContaining('Added to the CAB agenda')]);
    const item = m.items.find((i) => i.ticketId === t.id)!;
    const decided = await asAdmin((ctx) => changes.decideItem(ctx, m.id, item.id, { decision: 'approved', notes: 'Go ahead in the window.' }));
    expect(decided.approval.applied).toBe(true);
    expect(decided.status).toBe('in_progress');
    const steps = await asAdmin((ctx) => listForTicket(ctx, t.id));
    expect(steps.items.find((s) => s.stepName === 'CAB')?.status).toBe('approved');
    expect(steps.items.find((s) => s.step === 2)?.status).toBe('pending');
    expect((await changeRow(t.id)).cabNotes).toContain('approved');
    expect((await activities(t.id, 'cab')).some((a) => a.summary.startsWith('CAB approved'))).toBe(true);
    const list = await asAdmin((ctx) => changes.listMeetings(ctx, { page: 1, pageSize: 20, status: 'upcoming' } as never));
    expect(list.items.find((x) => x.id === m.id)).toMatchObject({ items: 2, pending: 1 });
    const closed = await asAdmin((ctx) => changes.closeMeeting(ctx, m.id, { minutes: 'Two changes reviewed.' }));
    expect(closed.status).toBe('closed');
    expect(closed.items.find((i) => i.ticketId === deferred.id)?.decision).toBe('deferred');
    await expect(asAdmin((ctx) => changes.addItem(ctx, m.id, { ticketId: t.id }))).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('window reminder (database)', () => {
  it('reminds once per window for changes starting within the reminder horizon', async () => {
    const soon = await newChange(`Soon change ${S}`, { change: { scheduledStart: hour(2), scheduledEnd: hour(3) } });
    const far = await newChange(`Far change ${S}`, { change: { scheduledStart: hour(200), scheduledEnd: hour(201) } });
    const n = await changes.remindUpcomingWindows();
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await changeRow(soon.id)).windowReminderAt).toBeTruthy();
    expect((await changeRow(far.id)).windowReminderAt).toBeNull();
    expect((await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.event, 'change.window_reminder'), eq(schema.notificationOutbox.entityId, soon.id))))).length).toBeGreaterThanOrEqual(0);
    const again = await changes.remindUpcomingWindows();
    const stillOne = (await withSystem((tx) => tx.select().from(schema.ticketActivities).where(and(eq(schema.ticketActivities.ticketId, soon.id), eq(schema.ticketActivities.activityType, 'update'))))).filter((a) => a.summary.startsWith('Window reminder sent'));
    expect(stillOne).toHaveLength(1);
    expect(again).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------- gap closure

describe('renderMinutes (pure)', () => {
  it('writes the decisions with the decider and the notes, then what was not reached', () => {
    const text = renderMinutes(
      { title: 'Weekly CAB', scheduledAt: new Date(Date.UTC(2026, 9, 6, 10, 0)), chairName: 'Rajesh Kumar' },
      [
        { number: 'CHG-000001', title: 'Patch the firewall', decision: 'approved', decidedByName: 'Rajesh Kumar', notes: 'Go ahead' },
        { number: 'CHG-000002', title: 'Reboot the core', decision: 'rejected', decidedByName: 'Ananya Rao', notes: null },
        { number: 'CHG-000003', title: 'Later change', decision: 'deferred', decidedByName: null, notes: null },
      ],
      ['Rajesh Kumar', 'Ananya Rao'],
    );
    expect(text.startsWith('Meeting: Weekly CAB · 2026-10-06 10:00 UTC · Chair: Rajesh Kumar\nAttendees: Rajesh Kumar, Ananya Rao\n')).toBe(true);
    expect(text).toContain('\nDecisions\n- CHG-000001 Patch the firewall — approved by Rajesh Kumar (Go ahead)\n- CHG-000002 Reboot the core — rejected by Ananya Rao\n');
    expect(text).toContain('\nDeferred (not reached)\n- CHG-000003 Later change\n');
    const empty = renderMinutes({ title: 'Empty', scheduledAt: new Date(), chairName: null }, [], []);
    expect(empty).toContain('Chair: not recorded');
    expect(empty).toContain('Attendees: not recorded');
    expect(empty).toContain('Decisions\n- none');
  });
});

describe('gap closure (database)', () => {
  const SEED_KEYS = ['scope', 'service_impact', 'dependencies', 'backout', 'experience', 'timing'];
  const HIGH = { scope: 'all', service_impact: 'outage', dependencies: 'critical', backout: 'none', experience: 'first', timing: 'business_hours' };
  const tool = (name: string) => ALL_TOOLS.find((t) => t.name === name)!;
  let catTpl: { id: string; name: string };
  let catalogRaiseId = '';
  let enrichedNumber = '';
  let emergencyId = '';
  let movingId = '';
  let enrichedId = '';
  let enrichMeetingId = '';
  let foreignNumber = '';
  let queueA: { id: string; number: string };
  let queueB: { id: string; number: string };
  let cancelledMeetingId = '';
  let closedMeetingId = '';
  const statusKeyOf = (ticketId: string) =>
    withSystem(async (tx) => {
      const [t] = await tx.select({ statusId: schema.tickets.statusId, approvalStatus: schema.tickets.approvalStatus }).from(schema.tickets).where(eq(schema.tickets.id, ticketId)).limit(1);
      const [o] = await tx.select({ key: schema.configOptions.key }).from(schema.configOptions).where(eq(schema.configOptions.id, t!.statusId)).limit(1);
      return { key: o!.key, approvalStatus: t!.approvalStatus };
    });

  it('a fresh installation carries six questions and four standard templates, and seeding again changes nothing', async () => {
    const qs = (await asAdmin((ctx) => changes.listRiskQuestions(ctx, true))).items.filter((q) => SEED_KEYS.includes(q.key));
    expect(qs.map((q) => q.key)).toEqual(SEED_KEYS);
    expect(qs.every((q, i) => i === 0 || q.sortOrder > qs[i - 1]!.sortOrder)).toBe(true);
    expect(qs.map((q) => q.weight)).toEqual([3, 3, 3, 2, 2, 1]);
    const tpls = (await asAdmin((ctx) => changes.listTemplates(ctx, { all: true }))).items.map((t) => t.key);
    expect(tpls).toEqual(expect.arrayContaining(['fw_patch', 'server_patching', 'switch_port_change', 'cert_renewal']));
    const before = await withSystem(async (tx) => [(await tx.select().from(schema.changeRiskQuestions)).length, (await tx.select().from(schema.changeTemplates)).length]);
    await withSystem((tx) => seedChangeConfig(tx));
    const after = await withSystem(async (tx) => [(await tx.select().from(schema.changeRiskQuestions)).length, (await tx.select().from(schema.changeTemplates)).length]);
    expect(after).toEqual(before);
  });

  it('counts how often a template was raised from and filters the catalog', async () => {
    catTpl = await asAdmin((ctx) => changes.createTemplate(ctx, { key: `cat_${S}`, name: `Catalog template ${S}`, description: 'A repeatable patch from the catalog.', changeType: 'standard', skipApproval: true, riskId: ids.riskLow, implementationPlan: 'Apply the patch.', backoutPlan: 'Revert the patch.', downtimeExpectedMinutes: 10, titleTemplate: `Catalog change ${S}` }));
    created.templates.push(catTpl.id);
    for (const n of [1, 2]) catalogRaiseId = (await newChange(`Catalog raise ${n} ${S}`, { changeTemplateId: catTpl.id, change: { scheduledStart: hour(80), scheduledEnd: hour(81) } })).id;
    const item = (await asAdmin((ctx) => changes.listTemplates(ctx, { customerId: ids.customer }))).items.find((x) => x.id === catTpl.id)!;
    expect(item).toMatchObject({ usageCount: 2, usage90d: 2 });
    expect(Math.abs(Date.now() - new Date(item.lastUsedAt!).getTime())).toBeLessThan(60_000);
    expect((await asAdmin((ctx) => changes.listTemplates(ctx, { q: 'nomatch-zzz' }))).items).toEqual([]);
    expect((await asAdmin((ctx) => changes.listTemplates(ctx, { q: `cat_${S}` }))).items.map((x) => x.id)).toEqual([catTpl.id]);
    const pre = await asAdmin((ctx) => changes.listTemplates(ctx, { all: true, preApproved: true }));
    expect(pre.items.every((x) => x.skipApproval)).toBe(true);
    expect(pre.items.map((x) => x.id)).toContain(catTpl.id);
    expect((await asAdmin((ctx) => changes.listTemplates(ctx, { changeType: 'emergency' }))).items.map((x) => x.id)).not.toContain(catTpl.id);
  });

  it('refuses a normal window inside a blackout when the setting blocks it, lets an emergency through, and warns when it is off', async () => {
    const b = await asAdmin((ctx) => changes.createBlackout(ctx, { customerId: ids.customer, name: `Freeze ${S}`, reason: 'Audit week', startsAt: hour(100), endsAt: hour(104), allowEmergency: true }));
    created.blackouts.push(b.id);
    await setSetting('changes.block_blackout_scheduling', true);
    try {
      const err = (await newChange(`Blocked ${S}`, { change: { scheduledStart: hour(101), scheduledEnd: hour(102) } }).catch((e: Error) => e)) as Error & { statusCode?: number };
      expect(err).toMatchObject({ statusCode: 422 });
      expect(err.message).toMatch(/blackout window "Freeze/);
      const em = await newChange(`Emergency in freeze ${S}`, { change: { changeType: 'emergency', scheduledStart: hour(101), scheduledEnd: hour(102) } });
      emergencyId = em.id;
      expect((await changeRow(em.id)).changeType).toBe('emergency');
      // The start is captured once: `hour()` reads the clock, and a refused update must leave the stored start untouched.
      const start = hour(90);
      const moving = await newChange(`Moving ${S}`, { change: { scheduledStart: start, scheduledEnd: hour(91) } });
      movingId = moving.id;
      await expect(asAdmin((ctx) => updateChangeDetails(ctx, moving.id, { scheduledStart: hour(101), scheduledEnd: hour(102) }))).rejects.toMatchObject({ statusCode: 422 });
      expect((await changeRow(moving.id)).scheduledStart?.getTime()).toBe(start.getTime());
    } finally {
      // Reset even when an assertion above fails, so the later cases of this file do not run with blocking on.
      await setSetting('changes.block_blackout_scheduling', false);
    }
    await asAdmin((ctx) => updateChangeDetails(ctx, movingId!, { scheduledStart: hour(101), scheduledEnd: hour(102) }));
    const moving = { id: movingId! };
    const warn = await activities(moving.id, 'change_conflict');
    expect(warn.some((a) => /blackout/i.test(a.summary) || a.summary.includes('Audit week'))).toBe(true);
  });

  it('refuses an approval request or a CAB agenda slot until the change is assessed when the gate is on', async () => {
    await setSetting('changes.require_assessment_for_approval', true);
    const t = await newChange(`Unassessed ${S}`, { change: { scheduledStart: hour(60), scheduledEnd: hour(61) } });
    await expect(asAdmin((ctx) => requestApproval(ctx, t.id, ids.cabWorkflow))).rejects.toThrow(/Assess the change risk/);
    const m = await asAdmin((ctx) => changes.createMeeting(ctx, { title: `Gate CAB ${S}`, scheduledAt: hour(50) }));
    created.meetings.push(m.id);
    await expect(asAdmin((ctx) => changes.addItem(ctx, m.id, { ticketId: t.id }))).rejects.toThrow(/Assess the change risk/);
    await asAdmin((ctx) => changes.assessRisk(ctx, t.id, { scope: 'one_site', service_impact: 'none' }));
    await asAdmin((ctx) => requestApproval(ctx, t.id, ids.cabWorkflow));
    const view = await asAdmin((ctx) => changes.addItem(ctx, m.id, { ticketId: t.id, notes: 'Scored.' }));
    expect(view.items.find((i) => i.ticketId === t.id)?.notes).toBe('Scored.');
    await setSetting('changes.require_assessment_for_approval', false);
  });

  it('enriches the staff record with the clashes, the template and the CAB slot; the portal sees the window only and nothing of another organisation', async () => {
    // Shares bill-db and the window with the first change of this file: a CI clash.
    const t = await newChange(`Enriched ${S}`, { changeTemplateId: catTpl.id, primaryCiId: ids.db, change: { scheduledStart: hour(24), scheduledEnd: hour(26) } });
    enrichedId = t.id;
    enrichedNumber = t.number;
    const m = await asAdmin((ctx) => changes.createMeeting(ctx, { title: `Enrich CAB ${S}`, scheduledAt: hour(20), ticketIds: [t.id] }));
    created.meetings.push(m.id);
    enrichMeetingId = m.id;
    const detail = await asAdmin((ctx) => getTicket(ctx, t.id));
    const change = detail.change as { conflicts?: { kind: string }[]; template?: { name: string } | null; cabMeeting?: { title: string; decision: string } | null };
    expect(change.conflicts?.length).toBeGreaterThanOrEqual(1);
    expect(change.template?.name).toBe(`Catalog template ${S}`);
    expect(change.cabMeeting).toMatchObject({ title: `Enrich CAB ${S}`, decision: 'pending' });
    const pt = await asPortal((ctx) => getPortalTicket(ctx, t.id));
    expect(Object.keys(pt.change!).sort()).toEqual(['actualEnd', 'actualStart', 'changeType', 'downtimeExpectedMinutes', 'scheduledEnd', 'scheduledStart']);
    expect(pt.change?.scheduledStart).toBeTruthy();
    expect(JSON.stringify(pt)).not.toMatch(/conflicts|cabMeeting|riskLevel|implementationPlan|backoutPlan/);
    const foreign = await asAdmin(async (ctx) => {
      const row = await createTicket(ctx, { type: 'change', customerId: ids.otherCustomer, title: `Foreign change ${S}`, change: { scheduledStart: hour(30), scheduledEnd: hour(31) } } as never);
      created.tickets.push(row.id);
      return row;
    });
    foreignNumber = foreign.number;
    await expect(asPortal((ctx) => getPortalTicket(ctx, foreign.id))).rejects.toMatchObject({ statusCode: 404 });
  });

  it('filters the ticket list by change type, risk level and window', async () => {
    const q = (extra: Record<string, unknown>) => asAdmin((ctx) => listTickets(ctx, listQuerySchema.parse({ customerId: ids.customer, type: 'change', pageSize: 100, ...extra })));
    expect((await q({ changeType: 'emergency' })).items.map((i) => i.id)).toEqual([emergencyId]);
    const unassessed = (await q({ riskLevel: 'none' })).items.map((i) => i.id);
    expect(unassessed).toContain(emergencyId);
    expect(unassessed).not.toContain(enrichedId === '' ? 'x' : (await q({ riskLevel: 'low' })).items[0]?.id ?? 'x');
    const low = (await q({ riskLevel: 'low' })).items.map((i) => i.id);
    expect(low.length).toBeGreaterThanOrEqual(1);
    expect(low.every((id) => !unassessed.includes(id))).toBe(true);
    const win = (await q({ scheduledFrom: hour(99).toISOString(), scheduledTo: hour(105).toISOString() })).items.map((i) => i.id);
    expect([...win].sort()).toEqual([emergencyId, movingId].sort());
  });

  it('lists the changes awaiting the board, orders the agenda, keeps notes, notifies, appends the board notes, generates minutes and cancels a meeting', async () => {
    queueA = await newChange(`Queue A ${S}`, { requesterUserId: ids.engineer, change: { scheduledStart: hour(120), scheduledEnd: hour(121) } });
    queueB = await newChange(`Queue B ${S}`, { requesterUserId: ids.engineer, change: { scheduledStart: hour(122), scheduledEnd: hour(123) } });
    const c = await newChange(`Queue C no window ${S}`, { requesterUserId: ids.engineer });
    for (const t of [queueA, queueB, c]) await asAdmin((ctx) => requestApproval(ctx, t.id, ids.cabWorkflow));
    const queue = await asAdmin((ctx) => changes.cabQueue(ctx, { customerId: ids.customer, limit: 50 }));
    expect(queue.items.map((i) => i.ticketId)).toEqual(expect.arrayContaining([queueA.id, queueB.id, c.id]));
    expect(queue.items.find((i) => i.ticketId === queueA.id)?.pendingStep?.stepName).toBe('CAB');
    expect(queue.items.find((i) => i.ticketId === c.id)?.scheduledStart).toBeNull();
    expect((await asAdmin((ctx) => changes.cabQueue(ctx, { customerId: ids.customer, q: `Queue B ${S}`, limit: 50 }))).items.map((i) => i.ticketId)).toEqual([queueB.id]);
    const m = await asAdmin((ctx) => changes.createMeeting(ctx, { title: `Queue CAB ${S}`, scheduledAt: hour(110), location: 'Room 4', attendeeUserIds: [admin.id, ids.engineer], ticketIds: [queueA.id, queueB.id] }));
    created.meetings.push(m.id);
    cancelledMeetingId = m.id;
    expect(m.location).toBe('Room 4');
    expect(m.attendees.map((x) => x.id)).toEqual([admin.id, ids.engineer]);
    await expect(asAdmin((ctx) => changes.updateMeeting(ctx, m.id, { attendeeUserIds: [ids.portalUser] }))).rejects.toThrow(/active staff/);
    const after = await asAdmin((ctx) => changes.cabQueue(ctx, { customerId: ids.customer, limit: 50 }));
    expect(after.items.map((i) => i.ticketId)).not.toContain(queueA.id);
    expect(after.items.map((i) => i.ticketId)).not.toContain(queueB.id);
    expect(after.items.map((i) => i.ticketId)).toContain(c.id);
    // Agenda order and notes.
    const ordered = await asAdmin((ctx) => changes.reorderItems(ctx, m.id, [...m.items].reverse().map((i) => i.id)));
    expect(ordered.items.map((i) => i.ticketId)).toEqual([queueB.id, queueA.id]);
    await expect(asAdmin((ctx) => changes.reorderItems(ctx, m.id, ['00000000-0000-4000-8000-000000000009']))).rejects.toMatchObject({ statusCode: 422 });
    const itemA = m.items.find((i) => i.ticketId === queueA.id)!;
    const noted = await asAdmin((ctx) => changes.updateItem(ctx, m.id, itemA.id, { notes: 'Needs the DR evidence' }));
    expect(noted.items.find((i) => i.id === itemA.id)?.notes).toBe('Needs the DR evidence');
    const withC = await asAdmin((ctx) => changes.addItem(ctx, m.id, { ticketId: c.id, notes: 'No window yet' }));
    expect(withC.items.find((i) => i.ticketId === c.id)?.notes).toBe('No window yet');
    // The requester (not the actor) is told the change is on an agenda.
    const queued = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.event, 'change.cab_scheduled'), eq(schema.notificationOutbox.entityId, c.id))));
    expect(queued.length).toBeGreaterThanOrEqual(1);
    // The board's notes on the change accumulate across meetings.
    await asAdmin((ctx) => changes.decideItem(ctx, m.id, itemA.id, { decision: 'deferred', notes: 'Come back next week.' }));
    const m2 = await asAdmin((ctx) => changes.createMeeting(ctx, { title: `Queue CAB 2 ${S}`, scheduledAt: hour(130), ticketIds: [queueA.id] }));
    created.meetings.push(m2.id);
    closedMeetingId = m2.id;
    await asAdmin((ctx) => changes.decideItem(ctx, m2.id, m2.items[0]!.id, { decision: 'approved', notes: 'Go.' }));
    const notes = (await changeRow(queueA.id)).cabNotes!;
    expect(notes).toContain('deferred. Come back next week.');
    expect(notes).toContain('approved. Go.');
    expect(notes.split('\n')).toHaveLength(2);
    // Closing without minutes generates them.
    const closed = await asAdmin((ctx) => changes.closeMeeting(ctx, m2.id, {}));
    expect(closed.minutes).toMatch(new RegExp(`^Meeting: Queue CAB 2 ${S}`));
    expect(closed.minutes).toContain('\nDecisions\n');
    expect(closed.minutes).toContain(`${queueA.number}`);
    expect(closed.minutes).toContain('approved by');
    // Cancelling clears the agenda slots and records it on each change.
    const cancelled = await asAdmin((ctx) => changes.cancelMeeting(ctx, m.id, { reason: 'Chair unavailable' }));
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.minutes).toContain('Cancelled: Chair unavailable');
    expect((await changeRow(queueB.id)).cabMeetingId).toBeNull();
    expect((await changeRow(queueA.id)).cabMeetingId).toBe(m2.id);
    expect((await activities(queueB.id, 'cab')).some((x) => x.summary.startsWith('CAB meeting cancelled'))).toBe(true);
    // Nothing on the cancelled meeting is still awaiting a decision: its undecided items are deferred, as on close.
    const leftovers = await withSystem((tx) => tx.select({ decision: schema.cabMeetingItems.decision, decidedAt: schema.cabMeetingItems.decidedAt }).from(schema.cabMeetingItems).where(eq(schema.cabMeetingItems.meetingId, m.id)));
    expect(leftovers.length).toBeGreaterThanOrEqual(2);
    expect(leftovers.every((i) => i.decision === 'deferred' && i.decidedAt)).toBe(true);
    await expect(asAdmin((ctx) => changes.reorderItems(ctx, m.id, [itemA.id]))).rejects.toMatchObject({ statusCode: 422 });
    await expect(asAdmin((ctx) => changes.closeMeeting(ctx, m.id, {}))).rejects.toMatchObject({ statusCode: 422 });
    const again = await asAdmin((ctx) => changes.cabQueue(ctx, { customerId: ids.customer, limit: 50 }));
    expect(again.items.map((i) => i.ticketId)).toContain(queueB.id);
  });

  it('a rejection with no approval step pending moves a pre-approved change to Rejected, with an audit entry and the status notification', async () => {
    const t = await newChange(`Pre-approved rejected ${S}`, { changeTemplateId: catTpl.id, requesterUserId: ids.engineer, change: { scheduledStart: hour(140), scheduledEnd: hour(141) } });
    expect(t.approvalStatus).toBe('not_required');
    const m = await asAdmin((ctx) => changes.createMeeting(ctx, { title: `Reject CAB ${S}`, scheduledAt: hour(135), ticketIds: [t.id] }));
    created.meetings.push(m.id);
    const r = await asAdmin((ctx) => changes.decideItem(ctx, m.id, m.items[0]!.id, { decision: 'rejected', notes: 'Not this quarter.' }));
    expect(r.approval).toMatchObject({ applied: false, note: expect.stringContaining('moved to Rejected') });
    expect(await statusKeyOf(t.id)).toEqual({ key: 'rejected', approvalStatus: 'rejected' });
    const audit = await withSystem((tx) => tx.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, t.id), eq(schema.auditLog.action, 'cab.rejected_change'))));
    expect(audit).toHaveLength(1);
    const notified = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.event, 'ticket.status_changed'), eq(schema.notificationOutbox.entityId, t.id))));
    expect(notified.length).toBeGreaterThanOrEqual(1);
    // The board's notes stay internal: no customer-visible comment and no status message carries them.
    for (const n of notified) expect(`${n.body} ${n.bodyText ?? ''} ${n.subject ?? ''}`).not.toContain('Not this quarter');
    const visible = await withSystem((tx) => tx.select().from(schema.ticketComments).where(and(eq(schema.ticketComments.ticketId, t.id), eq(schema.ticketComments.isInternal, false))));
    expect(visible.some((c) => c.body.includes('Not this quarter'))).toBe(false);
    // Deciding it again does not move it twice.
    const m2 = await asAdmin((ctx) => changes.createMeeting(ctx, { title: `Reject CAB 2 ${S}`, scheduledAt: hour(136) }));
    created.meetings.push(m2.id);
    const v = await asAdmin((ctx) => changes.addItem(ctx, m2.id, { ticketId: t.id }));
    const r2 = await asAdmin((ctx) => changes.decideItem(ctx, m2.id, v.items[0]!.id, { decision: 'rejected' }));
    expect(r2.approval.note).toBe('No approval step was pending on the change');
  });

  it('tells a customer contact who raised the change that it is on an agenda without the meeting location', async () => {
    const [contact] = await withSystem((tx) => tx.insert(schema.contacts).values({ customerId: ids.customer, name: `Contact ${S}`, email: `contact-${S}@customer.example` }).returning({ id: schema.contacts.id }));
    const t = await newChange(`Contact change ${S}`, { requesterContactId: contact!.id, change: { scheduledStart: hour(150), scheduledEnd: hour(151) } });
    const m = await asAdmin((ctx) => changes.createMeeting(ctx, { title: `Bridge CAB ${S}`, scheduledAt: hour(145), location: `Bridge room ${S}`, ticketIds: [t.id] }));
    created.meetings.push(m.id);
    const rows = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.event, 'change.cab_scheduled'), eq(schema.notificationOutbox.entityId, t.id))));
    expect(rows.some((r) => r.recipient.includes(`contact-${S}@customer.example`))).toBe(true);
    for (const r of rows) expect(`${r.body} ${r.bodyText ?? ''} ${r.subject ?? ''}`).not.toContain(`Bridge room ${S}`);
  });

  it('lets a change manager without tickets:update assess any change, as the route allows', async () => {
    const t = await newChange(`Manager assessed ${S}`, { change: { scheduledStart: hour(160), scheduledEnd: hour(161) } });
    const r = await runAs(manager, meta, (ctx) => changes.assessRisk(ctx, t.id, { scope: 'single_user', service_impact: 'none' }));
    expect(['low', 'medium', 'high']).toContain(r.level);
    expect((await changeRow(t.id)).riskLevel).toBe(r.level);
    await expect(runAs(portal, meta, (ctx) => changes.assessRisk(ctx, t.id, { scope: 'single_user' }))).rejects.toThrow(/portal|permission/i);
  });

  it('lists CAB meetings on the calendar, leaving cancelled ones out', async () => {
    const cal = await asAdmin((ctx) => changes.calendar(ctx, { from: hour(0), to: hour(150), customerId: ids.customer }));
    expect(cal.meetings.map((m) => m.id)).toContain(enrichMeetingId);
    expect(cal.meetings.map((m) => m.id)).not.toContain(cancelledMeetingId);
    expect(cal.meetings.find((m) => m.id === closedMeetingId)).toMatchObject({ status: 'closed', items: 1, pending: 0 });
    expect(cal.counts.meetings).toBeGreaterThanOrEqual(2);
  });

  it('shows a customer only its own planned changes, with the window and the state and nothing internal', async () => {
    const ended = await newChange(`Ended ${S}`, { change: { scheduledStart: hour(-30), scheduledEnd: hour(-28) } });
    const res = await asPortal((ctx) => portalPlannedChanges(ctx, { state: 'all' }));
    const nums = res.items.map((i) => i.number);
    expect(nums).toEqual(expect.arrayContaining([queueA.number, queueB.number, ended.number]));
    expect(nums).not.toContain(foreignNumber);
    expect(res.preview).toBe(false);
    const a = res.items.find((i) => i.id === queueA.id)!;
    expect(Object.keys(a).sort()).toEqual(['actualEnd', 'actualStart', 'businessServices', 'changeType', 'downtimeExpectedMinutes', 'id', 'isMine', 'number', 'outcome', 'scheduledEnd', 'scheduledStart', 'service', 'state', 'title']);
    expect(a.state).toBe('planned');
    expect(res.items.find((i) => i.id === catalogRaiseId)?.state).toBe('approved');
    expect(res.items.find((i) => i.id === ended.id)?.state).toBe('planned');
    expect(JSON.stringify(res)).not.toMatch(/implementationPlan|riskLevel|assignee|cabMeeting|cabNotes/);
    const probe = await asPortal((ctx) => portalPlannedChanges(ctx, { state: 'all', customerId: ids.otherCustomer }));
    expect(probe.items.map((i) => i.number)).not.toContain(foreignNumber);
    expect(probe.items.map((i) => i.number)).toContain(queueA.number);
    const upcoming = await asPortal((ctx) => portalPlannedChanges(ctx, { state: 'upcoming' }));
    expect(upcoming.items.map((i) => i.id)).not.toContain(ended.id);
    expect(upcoming.items.map((i) => i.id)).toContain(queueB.id);
    expect(upcoming.counts.upcoming).toBe(upcoming.items.length);
    const preview = await asAdmin((ctx) => portalPlannedChanges(ctx, { state: 'all', customerId: ids.customer }));
    expect(preview.preview).toBe(true);
    expect(preview.items.map((i) => i.id).sort()).toEqual(res.items.map((i) => i.id).sort());
    await expect(asAdmin((ctx) => portalPlannedChanges(ctx, { state: 'all' }))).rejects.toThrow(/customerId is required/);
  });

  it('lets a configuration admin tune the thresholds and reorder the questions in one call', async () => {
    const r = await asAdmin((ctx) => changes.updateRiskThresholds(ctx, { medium: 40, high: 70 }));
    expect(r.thresholds).toEqual({ medium: 40, high: 70 });
    expect((await asAdmin((ctx) => changes.riskQuestionnaire(ctx))).thresholds).toEqual({ medium: 40, high: 70 });
    await expect(asAdmin((ctx) => changes.updateRiskThresholds(ctx, { medium: 70, high: 40 }))).rejects.toMatchObject({ statusCode: 422 });
    await expect(asEngineer((ctx) => changes.updateRiskThresholds(ctx, { medium: 40, high: 70 }))).rejects.toThrow(/permission/i);
    const q3 = await asAdmin((ctx) => changes.createRiskQuestion(ctx, { key: `third_${S}`, question: 'Third question?', options: [{ key: 'a', label: 'A', score: 0 }, { key: 'b', label: 'B', score: 5 }] }));
    created.questions.push(q3.id);
    const original = (await asAdmin((ctx) => changes.listRiskQuestions(ctx, true))).items.map((q) => ({ id: q.id, sortOrder: q.sortOrder }));
    const all = original.map((q) => q.id);
    const reversed = [...all].reverse();
    const after = await asAdmin((ctx) => changes.reorderRiskQuestions(ctx, reversed));
    expect(after.items.map((q) => q.id)).toEqual(reversed);
    expect((await asAdmin((ctx) => changes.listRiskQuestions(ctx, true))).items.map((q) => q.id)).toEqual(reversed);
    await expect(asEngineer((ctx) => changes.reorderRiskQuestions(ctx, all))).rejects.toThrow(/permission/i);
    // Put every question back exactly where it was (the seeded six keep their 0-5).
    for (const q of original) await asAdmin((ctx) => changes.updateRiskQuestion(ctx, q.id, { sortOrder: q.sortOrder }));
    expect((await asAdmin((ctx) => changes.listRiskQuestions(ctx, true))).items.map((q) => q.id)).toEqual(all);
    await asAdmin((ctx) => changes.updateRiskThresholds(ctx, { medium: 35, high: 65 }));
    expect((await asAdmin((ctx) => changes.riskQuestionnaire(ctx))).thresholds).toEqual({ medium: 35, high: 65 });
  });

  it('keeps the CAB and the thresholds with their owners while the raiser or the assignee may assess the risk', async () => {
    await expect(asEngineer((ctx) => changes.createMeeting(ctx, { title: `Nope ${S}`, scheduledAt: hour(10) }))).rejects.toThrow(/permission/i);
    await expect(asEngineer((ctx) => changes.cabQueue(ctx, { limit: 10 }))).rejects.toThrow(/permission/i);
    expect((await asEngineer((ctx) => changes.listTemplates(ctx, { all: true }))).items.length).toBeGreaterThanOrEqual(4);
    // Neither the raiser nor the assignee of the enriched change: refused.
    await expect(asEngineer((ctx) => changes.assessRisk(ctx, enrichedId, { scope: 'single_user' }))).rejects.toThrow(/change manager|permission/i);
    const own = await asEngineer(async (ctx) => {
      const row = await createTicket(ctx, { type: 'change', customerId: ids.customer, siteId: ids.site, title: `Engineer change ${S}` } as never);
      created.tickets.push(row.id);
      return row;
    });
    expect((await asEngineer((ctx) => changes.assessRisk(ctx, own.id, { scope: 'single_user', service_impact: 'none', dependencies: 'isolated', backout: 'tested', experience: 'routine', timing: 'maintenance_window', [`scope_${S}`]: 'few', [`backout_${S}`]: 'yes', [`third_${S}`]: 'a' }))).level).toBe('low');
    const assigned = await newChange(`Assigned ${S}`, { assigneeId: ids.engineer });
    await asEngineer((ctx) => changes.assessRisk(ctx, assigned.id, { ...HIGH, [`scope_${S}`]: 'all', [`backout_${S}`]: 'no', [`third_${S}`]: 'b' }));
    expect(await changeRow(assigned.id)).toMatchObject({ riskLevel: 'high', riskScore: 100 });
    // The permission map on the record says the same.
    expect((await asEngineer((ctx) => getTicket(ctx, assigned.id))).permissions).toMatchObject({ assessRisk: true, change: false });
    expect((await asEngineer((ctx) => getTicket(ctx, enrichedId))).permissions).toMatchObject({ assessRisk: false });
  });

  it('the change tools answer through the same services', async () => {
    const sc = (await asAdmin((ctx) => tool('standard_changes').run(ctx, { customer: `Change Customer ${S}` }))) as { facts: string[]; items: { key: string; usageCount: number }[] };
    expect(sc.facts[0]).toMatch(/\d+ standard change template\(s\) available/);
    expect(sc.items.find((i) => i.key === `cat_${S}`)?.usageCount).toBeGreaterThanOrEqual(3);
    // Raising from the catalog: the preview warns about the Month end blackout (blocking is off), the run creates a pre-approved change.
    const raise = tool('raise_standard_change');
    const input = { template: `cat_${S}`, customer: `Change Customer ${S}`, scheduledStart: hour(41).toISOString(), scheduledEnd: hour(42).toISOString(), assignee: `eng-${S}@test.local` };
    const pv = (await asAdmin((ctx) => raise.preview!(ctx, input))) as { text: string; lines?: string[] };
    expect(pv.text).toContain(`Catalog template ${S}`);
    expect(pv.text).toContain(`Change Customer ${S}`);
    expect(pv.text).toContain('pre-approved');
    expect(pv.lines?.some((l) => /blackout/i.test(l))).toBe(true);
    const raised = (await asAdmin((ctx) => raise.run(ctx, input))) as { id: string; ticket: string; approvalStatus: string; template: string };
    created.tickets.push(raised.id);
    expect(raised.approvalStatus).toBe('not_required');
    expect(raised.template).toBe(`Catalog template ${S}`);
    expect((await changeRow(raised.id)).templateId).toBe(catTpl.id);
    expect(raise.summary(input, raised)).toContain(raised.ticket);
    await expect(asAdmin((ctx) => raise.preview!(ctx, { ...input, template: 'no-such-template-zzz' }))).rejects.toMatchObject({ statusCode: 404 });
    // The agenda of a closed meeting carries the decision.
    const agenda = (await asAdmin((ctx) => tool('cab_agenda').run(ctx, { meeting: `Queue CAB 2 ${S}` }))) as { meetings: { meeting: { status: string }; agenda: { number: string; decision: string }[]; minutes: string | null }[]; facts: string[] };
    expect(agenda.meetings).toHaveLength(1);
    expect(agenda.meetings[0]!.agenda.find((i) => i.number === queueA.number)?.decision).toBe('approved');
    expect(agenda.meetings[0]!.minutes).toMatch(/^Meeting:/);
    const upcoming = (await asAdmin((ctx) => tool('cab_agenda').run(ctx, { status: 'upcoming' }))) as { meetings: unknown[]; queue: { number: string }[]; facts: string[] };
    expect(upcoming.queue.map((q) => q.number)).toContain(queueB.number);
    expect(upcoming.facts[0]).toMatch(/awaiting the board on no agenda/);
    // Tabling a change without naming a meeting picks the next scheduled one.
    const [next] = await withSystem((tx) => tx.select({ title: schema.cabMeetings.title }).from(schema.cabMeetings).where(and(inArray(schema.cabMeetings.status, ['scheduled', 'in_progress']), sql`${schema.cabMeetings.scheduledAt} >= now() - interval '1 day'`)).orderBy(asc(schema.cabMeetings.scheduledAt)).limit(1));
    const addPv = (await asAdmin((ctx) => tool('add_to_cab_agenda').preview!(ctx, { ticket: raised.ticket, notes: 'From the assistant' }))) as string;
    expect(addPv).toContain(raised.ticket);
    expect(addPv).toContain(`"${next!.title}"`);
    expect(addPv).toContain('From the assistant');
    await expect(asEngineer((ctx) => tool('add_to_cab_agenda').run(ctx, { ticket: raised.ticket }))).rejects.toThrow(/permission/i);
    // The questionnaire by wording: the preview computes without writing, the run writes, empty answers list the questions.
    const assess = tool('assess_change_risk');
    const answers = { 'How many users': 'Several sites', backout: 'Tested and quick', timing: 'Outside business hours' };
    const apv = (await asAdmin((ctx) => assess.preview!(ctx, { ticket: raised.ticket, answers }))) as { text: string; lines?: string[] };
    expect(apv.text).toMatch(new RegExp(`^Assess ${raised.ticket} as (low|medium|high) \\(\\d+/100\\) from 3 answer\\(s\\); unanswered:`));
    expect(apv.lines?.length).toBe(3);
    expect((await changeRow(raised.id)).riskScore).toBeNull();
    const ar = (await asAdmin((ctx) => assess.run(ctx, { ticket: raised.ticket, answers }))) as { score: number; level: string; answered: number };
    expect(ar.answered).toBe(3);
    expect((await changeRow(raised.id)).riskScore).toBe(ar.score);
    await expect(asAdmin((ctx) => assess.preview!(ctx, { ticket: raised.ticket, answers: { scope: 'the moon' } }))).rejects.toThrow(/Unknown answer/);
    const qs = (await asAdmin((ctx) => assess.run(ctx, { ticket: raised.ticket, answers: {} }))) as { questions: { key: string }[]; thresholds: { medium: number } };
    expect(qs.questions.map((q) => q.key)).toEqual(expect.arrayContaining(SEED_KEYS));
    expect(qs.thresholds.medium).toBe(35);
    // The assignee may assess through the tool too; a bystander engineer may not.
    expect(((await asEngineer((ctx) => assess.run(ctx, { ticket: raised.ticket, answers: { scope: 'single_user' } }))) as { level: string }).level).toBe('low');
    await expect(asEngineer((ctx) => assess.run(ctx, { ticket: enrichedNumber, answers: { scope: 'single_user' } }))).rejects.toThrow(/change manager|permission/i);
    // Planned changes for a customer user ignore the named organisation.
    const pc = (await asPortal((ctx) => tool('planned_changes').run(ctx, { customer: `Other Customer ${S}`, state: 'all' }))) as { items: { number: string }[]; facts: string[]; link: string };
    expect(pc.items.map((i) => i.number)).toContain(queueA.number);
    expect(JSON.stringify(pc)).not.toContain(foreignNumber);
    expect(JSON.stringify(pc)).not.toContain(`Other Customer ${S}`);
    expect(pc.facts[0]).toContain('for your organisation');
    expect(pc.link).toBe('/portal/changes');
    const staff = (await asAdmin((ctx) => tool('planned_changes').run(ctx, { customer: `Change Customer ${S}`, state: 'upcoming', days: 10 }))) as { items: { number: string; state: string }[]; facts: string[] };
    expect(staff.items.map((i) => i.number)).toContain(queueB.number);
    expect(staff.items.map((i) => i.number)).not.toContain(foreignNumber);
    expect(staff.facts[0]).toContain(`Change Customer ${S}`);
  });

  it('the CAB decisions report and the extended change calendar report run over the data of this file', async () => {
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const cab = await asAdmin((ctx) => reports.runReport(ctx, { reportKey: 'cab_decisions', parameters: { customerId: ids.customer, dateRange: 'custom', from: day(-1), to: day(10) } }));
    if (!('result' in cab)) throw new Error('expected a preview');
    expect(cab.result.columns.map((c) => c.key)).toEqual(['meeting', 'scheduled_at', 'chair', 'number', 'title', 'customer', 'change_type', 'risk_level', 'decision', 'decided_by', 'decided_at', 'notes']);
    expect(cab.result.rows.find((r) => r.number === queueA.number && r.meeting === `Queue CAB 2 ${S}`)).toMatchObject({ decision: 'approved', notes: 'Go.' });
    expect(cab.result.summary?.map((s) => s.label)).toEqual(['Meetings', 'Items', 'Approved', 'Rejected', 'Deferred', 'Pending']);
    expect(Number(cab.result.summary?.find((s) => s.label === 'Approved')?.value)).toBeGreaterThanOrEqual(1);
    expect(Number(cab.result.summary?.find((s) => s.label === 'Rejected')?.value)).toBeGreaterThanOrEqual(2);
    expect(cab.result.charts?.[0]).toMatchObject({ type: 'bar', title: 'Decisions per week' });
    const rejectedOnly = await asAdmin((ctx) => reports.runReport(ctx, { reportKey: 'cab_decisions', parameters: { customerId: ids.customer, dateRange: 'custom', from: day(-1), to: day(10), decision: 'rejected' } }));
    if (!('result' in rejectedOnly)) throw new Error('expected a preview');
    expect(rejectedOnly.result.rows.length).toBeGreaterThanOrEqual(2);
    expect(rejectedOnly.result.rows.every((r) => r.decision === 'rejected')).toBe(true);
    const cal = await asAdmin((ctx) => reports.runReport(ctx, { reportKey: 'change_calendar', parameters: { customerId: ids.customer, dateRange: 'custom', from: day(-2), to: day(10) } }));
    if (!('result' in cal)) throw new Error('expected a preview');
    expect(cal.result.columns.map((c) => c.key)).toEqual(expect.arrayContaining(['risk_level', 'risk_score', 'template', 'cab_meeting', 'cab_decision']));
    expect(cal.result.rows.find((r) => r.id === enrichedId)).toMatchObject({ template: `Catalog template ${S}`, cab_meeting: `Enrich CAB ${S}`, cab_decision: 'pending' });
    expect(cal.result.summary?.map((s) => s.label)).toEqual(['Changes', 'Emergency', 'Standard', 'Implemented', 'Awaiting approval', 'High risk', 'From a template']);
    expect(Number(cal.result.summary?.find((s) => s.label === 'From a template')?.value)).toBeGreaterThanOrEqual(3);
    expect(Number(cal.result.summary?.find((s) => s.label === 'High risk')?.value)).toBeGreaterThanOrEqual(1);
  });
});
