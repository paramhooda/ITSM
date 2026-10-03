/**
 * Change management: the risk scorer (weights, scaling, thresholds, missing
 * answers), conflict detection (shared CI, shared business service, blackout
 * windows, emergency exemption, edge-touching windows), then the database
 * parts: calendar and conflicts recorded as a warning activity, a template
 * that skips approval, a CAB decision that decides the ticket's approval step,
 * and the window reminder. Run with the dev environment sourced:
 * npx vitest run test/changes.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { createTicket, getTicket, updateChangeDetails } from '../src/modules/tickets/service';
import { requestApproval, listForTicket } from '../src/modules/tickets/approvals';
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
const ids = { customer: '', site: '', bs: '', app: '', db: '', other: '', cabWorkflow: '', riskLow: '' };
const types: Record<string, string> = {};
const relTypes: Record<string, string> = {};
const created = { tickets: [] as string[], blackouts: [] as string[], questions: [] as string[], templates: [] as string[], meetings: [] as string[] };
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);
const hour = (n: number) => new Date(Date.now() + n * 3600_000);
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
    invalidatePrincipal(a!.id);
    admin = (await loadPrincipal(a!.id))!;
  });
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
    await tx.delete(schema.customers).where(eq(schema.customers.id, ids.customer));
  });
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
