/**
 * Service review pack, Excel and PDF output (DB-backed).
 * Run with the dev environment sourced:  npx vitest run test/reports-pdf.test.ts
 * The PDF cases run only when a Chromium binary is found (see lib/pdf.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ExcelJS from 'exceljs';
import { withSystem, schema, closeDb, pool, type Tx } from '@/db/client';
import { runAs, type Ctx } from '@/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '@/core/principal';
import { storage } from '@/lib/storage';
import { pdfAvailable, htmlToPdf } from '@/lib/pdf';
import { createTicket, resolveTicket, setScope } from '@/modules/tickets/service';
import * as reports from '@/modules/reports/service';
import * as schedules from '@/modules/reports/schedules';
import { scheduleFormats } from '@/modules/reports/schedules';
import { executeSchedule } from '@/jobs/processors/reports';
import { renderXlsx, renderHtml, brandColor, logoUrl } from '@/modules/reports/render';
import { findReport, registerReport } from '@/modules/reports/registry';
import { col, dateRangeParam } from '@/modules/reports/definitions/helpers';
import { addDays } from '@/modules/reports/dates';
import * as ai from '@/modules/ai/service';
import type { AiProvider, ChatOptions, ChatResponse } from '@/lib/ai';

const suffix = Math.random().toString(36).slice(2, 8);
const ids = { adminUser: '', customer: '', service: '', contract: '', entitlement: '', p1: '', p3: '', customerUser: '', asset: '', schedule: '' };
const tickets: string[] = [];
let admin: Principal;
let portalUser: Principal;
let pdfOn = false;

async function optionId(tx: Tx, type: string, key: string) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1);
  if (!row) throw new Error(`option ${type}:${key} missing (seed not applied?)`);
  return row.id;
}
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, { requestId: `test-${suffix}`, source: 'api' }, fn);
const asPortal = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(portalUser, { requestId: `test-${suffix}`, source: 'api' }, fn);
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  pdfOn = await pdfAvailable();
  await withSystem(async (tx) => {
    const [adminUser] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    if (!adminUser) throw new Error('admin user missing (seed not applied?)');
    ids.adminUser = adminUser.id;
    ids.p1 = await optionId(tx, 'ticket_priority', 'p1');
    ids.p3 = await optionId(tx, 'ticket_priority', 'p3');
    const [policy] = await tx.select({ id: schema.slaPolicies.id }).from(schema.slaPolicies).where(eq(schema.slaPolicies.isDefault, true)).limit(1);
    const [c] = await tx.insert(schema.customers).values({ code: `PK${suffix.toUpperCase()}`, name: `Pack Customer ${suffix}`, accountManagerId: adminUser.id }).returning();
    ids.customer = c.id;
    const [service] = await tx.insert(schema.services).values({ key: `pksvc_${suffix}`, name: `Pack Service ${suffix}`, domain: 'noc' }).returning();
    ids.service = service.id;
    const [contract] = await tx.insert(schema.contracts).values({ customerId: c.id, number: `PACK-${suffix}`, name: `Pack AMC ${suffix}`, status: 'active', startDate: day(-40), endDate: day(200), slaPolicyId: policy?.id ?? null }).returning();
    ids.contract = contract.id;
    await tx.insert(schema.contractServices).values({ contractId: contract.id, customerId: c.id, serviceId: service.id });
    const [ent] = await tx.insert(schema.contractEntitlements).values({ contractId: contract.id, customerId: c.id, name: 'Support hours', quantity: '10', unit: 'hours', period: 'contract', warnThresholdPct: 50 }).returning();
    ids.entitlement = ent.id;
    await tx.insert(schema.entitlementConsumptions).values({ entitlementId: ent.id, customerId: c.id, quantity: '9', sourceType: 'manual', notes: 'onsite' });
    const [asset] = await tx.insert(schema.assets).values({ customerId: c.id, tag: `PK-${suffix}`, name: `Edge firewall ${suffix}`, warrantyEnd: day(20), lifecycleStage: 'deployed' }).returning();
    ids.asset = asset.id;
    const [role] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, 'customer_admin')).limit(1);
    const [cu] = await tx.insert(schema.users).values({ email: `pack-${suffix}@customer.test`, name: `Pack Portal ${suffix}`, userType: 'customer', customerId: c.id, status: 'active' }).returning();
    ids.customerUser = cu.id;
    await tx.insert(schema.userRoles).values({ userId: cu.id, roleId: role.id, customerId: null });
  });
  invalidatePrincipal();
  admin = (await loadPrincipal(ids.adminUser))!;
  portalUser = (await loadPrincipal(ids.customerUser))!;
  await asAdmin(async (ctx) => {
    const major = await createTicket(ctx, { type: 'incident', customerId: ids.customer, serviceId: ids.service, title: `Site down ${suffix}`, priorityId: ids.p1 });
    const t2 = await createTicket(ctx, { type: 'incident', customerId: ids.customer, serviceId: ids.service, title: `Slow wifi ${suffix}`, priorityId: ids.p3 });
    const oos = await createTicket(ctx, { type: 'request', customerId: ids.customer, serviceId: ids.service, title: `Home printer ${suffix}`, priorityId: ids.p3 });
    tickets.push(major.id, t2.id, oos.id);
    await setScope(ctx, oos.id, { scopeStatus: 'out_of_scope', scopeNote: 'Not under contract' });
    await resolveTicket(ctx, t2.id, { resolutionNotes: 'Channel changed' });
  });
  await withSystem((tx) => tx.update(schema.tickets).set({ isMajor: true }).where(eq(schema.tickets.id, tickets[0]!)));
});

afterAll(async () => {
  await withSystem(async (tx) => {
    const runs = await tx.select({ id: schema.reportRuns.id, attachmentId: schema.reportRuns.attachmentId }).from(schema.reportRuns).where(eq(schema.reportRuns.customerId, ids.customer));
    const attIds = runs.map((r) => r.attachmentId).filter((x): x is string => !!x);
    if (attIds.length) {
      const atts = await tx.select().from(schema.attachments).where(inArray(schema.attachments.id, attIds));
      for (const a of atts) await storage.delete(a.storageKey).catch(() => undefined);
      await tx.delete(schema.attachments).where(inArray(schema.attachments.id, attIds));
    }
    if (runs.length) await tx.delete(schema.notificationOutbox).where(inArray(schema.notificationOutbox.entityId, runs.map((r) => r.id)));
    if (runs.length) await tx.delete(schema.reportRuns).where(inArray(schema.reportRuns.id, runs.map((r) => r.id)));
    if (ids.schedule) await tx.delete(schema.reportSchedules).where(eq(schema.reportSchedules.id, ids.schedule));
    if (tickets.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, tickets));
    if (ids.customerUser) await tx.delete(schema.users).where(eq(schema.users.id, ids.customerUser));
    if (ids.customer) await tx.delete(schema.customers).where(eq(schema.customers.id, ids.customer));
    if (ids.service) await tx.delete(schema.services).where(eq(schema.services.id, ids.service));
    await tx.update(schema.systemSettings).set({ value: '#292345' }).where(eq(schema.systemSettings.key, 'platform.brand_color'));
    await tx.update(schema.systemSettings).set({ value: '' }).where(eq(schema.systemSettings.key, 'platform.logo_url'));
    await tx.update(schema.systemSettings).set({ value: true }).where(eq(schema.systemSettings.key, 'reports.narrative'));
  });
  ai.setProviderForTests(null);
  await closeDb();
});

async function storedFile(attachmentId: string) {
  const [att] = await withSystem((tx) => tx.select().from(schema.attachments).where(eq(schema.attachments.id, attachmentId)).limit(1));
  return { att, buffer: await storage.get(att.storageKey) };
}

async function openWorkbook(attachmentId: string) {
  const [att] = await withSystem((tx) => tx.select().from(schema.attachments).where(eq(schema.attachments.id, attachmentId)).limit(1));
  const buffer = await storage.get(att.storageKey);
  expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return { att, wb };
}

describe('service review pack', () => {
  it('composes the scorecard, every part and recommendations for one customer', async () => {
    const out = await asAdmin((ctx) => reports.runReport(ctx, { reportKey: 'service_review_pack', parameters: { customerId: ids.customer, dateRange: 'last_7_days' } }));
    if (!('result' in out)) throw new Error('expected preview');
    const r = out.result;
    expect(out.report.cover).toBe(true);
    expect(r.rows.map((x) => x.metric)).toEqual(expect.arrayContaining(['Overall SLA compliance', 'Tickets opened', 'Major incidents', 'Entitlements over threshold', 'Out-of-scope requests']));
    expect(r.rows.find((x) => x.metric === 'Major incidents')?.value).toBe(1);
    expect(r.rows.find((x) => x.metric === 'Entitlements over threshold')?.value).toBe(1);
    expect(r.rows.find((x) => x.metric === 'Out-of-scope requests')?.value).toBe(1);
    expect(r.rows.find((x) => x.metric === 'Cover expiring within 90 days or lapsed')?.value).toBe(1);
    const titles = (r.sections ?? []).map((s) => s.title);
    expect(titles).toEqual(expect.arrayContaining(['Recommendations', 'SLA by priority and metric', 'Ticket volume by week', 'Major incidents', 'Entitlement utilisation', 'Expiring asset cover', 'Out-of-scope work']));
    const recs = r.sections!.find((s) => s.title === 'Recommendations')!.rows;
    expect(recs.length).toBeGreaterThanOrEqual(3);
    expect(recs.map((x) => x.area)).toEqual(expect.arrayContaining(['Major incidents', 'Entitlements', 'Asset cover', 'Scope']));
    expect(recs.every((x) => typeof x.evidence === 'string' && (x.evidence as string).length > 0)).toBe(true);
    // the customer column is dropped from every part: the pack is about one organisation
    expect(r.sections!.find((s) => s.title === 'Entitlement utilisation')!.columns.some((c) => c.key === 'customer')).toBe(false);
    expect(r.summary?.find((s) => s.label === 'Major incidents')?.value).toBe(1);
    // Customer satisfaction travels with the pack: a tile, a scorecard line and its two sections (no responses yet in this fixture).
    expect(r.summary?.find((s) => s.label === 'Customer satisfaction')?.value).toBe('n/a');
    expect(r.rows.some((row) => row.metric === 'Customer satisfaction')).toBe(true);
    expect(r.sections?.some((s) => s.title === 'Customer satisfaction by service')).toBe(true);
    expect(r.sections?.some((s) => s.title === 'Lowest-rated tickets')).toBe(true);
    expect(r.charts?.length).toBeGreaterThan(0);
    // the monthly review: chapters by group, every frozen title kept, recommendations last
    const groups = new Set(r.sections!.map((s) => s.group ?? s.title));
    expect([...groups]).toEqual(expect.arrayContaining(['Service levels', 'Demand and workload', 'Responsiveness', 'Major incidents', 'Problems and known errors', 'Changes', 'Customer satisfaction', 'Contracts and entitlements', 'Assets and software', 'Field service and maintenance', 'Out-of-scope work', 'Recommendations']));
    expect(titles).toEqual(expect.arrayContaining(['Breached tickets', 'By site', 'Responsiveness by priority', 'Resolution by engineer', 'Known errors', 'Changes in the period', 'Failed or backed out', 'CAB decisions', 'Consumption detail', 'Software positions', 'Preventive maintenance', 'Field visits']));
    expect(titles[titles.length - 1]).toBe('Recommendations');
    const volume = r.sections!.find((s) => s.title === 'Ticket volume by week')!;
    expect(volume.group).toBe('Demand and workload');
    expect(volume.charts?.some((c) => c.type === 'heatmap' && c.width === 'full')).toBe(true);
    expect(volume.charts?.some((c) => c.type === 'donut')).toBe(true);
    // the scorecard and the tiles grew with the analytics, every tile with a previous-period twin carries a delta
    expect(r.rows.map((x) => x.metric)).toEqual(expect.arrayContaining(['MTTA', 'MTTR', 'First-contact resolution', 'Reopen rate', 'Backlog at period end', 'Change success rate', 'Open known errors', 'Licence position', 'PM on time']));
    expect(r.summary!.map((s) => s.label)).toEqual(expect.arrayContaining(['SLA compliance', 'MTTR (min)', 'First-contact resolution', 'Backlog', 'Change success rate', 'Recommendations']));
    expect(typeof r.summary!.find((s) => s.label === 'Tickets opened')!.delta?.previous).toBe('number');
    expect(r.summary!.find((s) => s.label === 'First-contact resolution')).toMatchObject({ unit: 'pct', target: 70 });
    expect(r.comparison).toMatchObject({ from: expect.any(String), to: expect.any(String), label: expect.any(String) });
    expect(r.insights!.length).toBeGreaterThanOrEqual(3);
    expect(r.narrative?.source).toBe('rules');
    expect(r.narrative?.nextSteps.length).toBeGreaterThanOrEqual(1);
  });

  it('needs a customer and skips the recommendations on request', async () => {
    await expect(asAdmin((ctx) => reports.runReport(ctx, { reportKey: 'service_review_pack', parameters: { dateRange: 'last_7_days' } }))).rejects.toThrow(/customer/i);
    const out = await asAdmin((ctx) => reports.runReport(ctx, { reportKey: 'service_review_pack', parameters: { customerId: ids.customer, dateRange: 'last_7_days', recommendations: false } }));
    if (!('result' in out)) throw new Error('expected preview');
    expect(out.result.sections?.some((s) => s.title === 'Recommendations')).toBe(false);
    expect(out.result.summary?.find((s) => s.label === 'Recommendations')?.value).toBe(0);
  });

  it('a portal user gets their own pack without the out-of-scope part', async () => {
    const out = await asPortal((ctx) => reports.runReport(ctx, { reportKey: 'service_review_pack', parameters: { dateRange: 'last_7_days' } }));
    if (!('result' in out)) throw new Error('expected preview');
    expect(out.parameters.customerId).toBe(ids.customer);
    expect(out.result.sections?.some((s) => s.title === 'Out-of-scope work')).toBe(false);
    expect(out.result.rows.some((x) => x.metric === 'Out-of-scope requests')).toBe(false);
    expect(out.result.rows.find((x) => x.metric === 'Major incidents')?.value).toBe(1);
    // no engineer breakdown, no CAB section and no staff name column anywhere in a customer's pack
    const sections = out.result.sections ?? [];
    expect(sections.some((s) => ['Resolution by engineer', 'CAB decisions'].includes(s.title))).toBe(false);
    const staffKeys = ['assignee', 'engineer', 'owner', 'recorded_by', 'decided_by', 'chair'];
    expect(sections.every((s) => !s.columns.some((c) => staffKeys.includes(c.key)))).toBe(true);
    // the row objects of the preview carry only the printed columns: no staff name hides behind a dropped column
    expect(sections.every((s) => s.rows.every((row) => !Object.keys(row).some((k) => staffKeys.includes(k))))).toBe(true);
    expect(sections.find((s) => s.title === 'Major incidents')!.rows.length).toBeGreaterThan(0);
    expect(sections.every((s) => s.rows.every((row) => Object.keys(row).every((k) => s.columns.some((c) => c.key === k))))).toBe(true);
    expect(sections.some((s) => s.title === 'Responsiveness by priority')).toBe(true);
    expect(sections.some((s) => s.title === 'Known errors')).toBe(true);
    expect(out.result.summary?.some((s) => s.label === 'Out of scope')).toBe(false);
  });
});

describe('Excel output', () => {
  it('stores a workbook with a summary sheet, the detail and one sheet per part', async () => {
    const run = await asAdmin((ctx) => reports.runReport(ctx, { reportKey: 'service_review_pack', parameters: { customerId: ids.customer, dateRange: 'last_7_days' }, format: 'xlsx' }));
    if (!('status' in run)) throw new Error('expected run');
    expect(run.status).toBe('completed');
    expect(run.format).toBe('xlsx');
    expect(run.filename).toMatch(/\.xlsx$/);
    expect(run.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const { wb } = await openWorkbook(run.attachmentId!);
    const names = wb.worksheets.map((w) => w.name);
    expect(names.slice(0, 2)).toEqual(['Summary', 'Detail']);
    expect(names).toContain('Recommendations');
    expect(names).toEqual(expect.arrayContaining(['Major incidents', 'Entitlement utilisation', 'Out-of-scope work', 'Charts']));
    expect(names.every((n) => n.length <= 31 && !/[\\/?*[\]:]/.test(n))).toBe(true);
    const detail = wb.getWorksheet('Detail')!;
    expect(detail.getRow(1).getCell(1).value).toBe('Area');
    expect(detail.rowCount).toBe(run.rowCount! + 1);
    expect(detail.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    const summary = wb.getWorksheet('Summary')!;
    expect(String(summary.getRow(1).getCell(1).value)).toBe('Service review pack');
    expect(String(summary.getRow(2).getCell(1).value)).toContain(`Pack Customer ${suffix}`);
    // the insights and the recommendations travel with the workbook
    const firstCells: string[] = [];
    summary.eachRow((row) => firstCells.push(String(row.getCell(1).value ?? '')));
    expect(firstCells).toContain('Insights');
    expect(firstCells).toContain('Recommendations');
    expect(firstCells).toContain('Next step');
    // numbers stay numbers and dates become dates in the typed sheets
    const amc = wb.getWorksheet('Entitlement utilisation')!;
    const header = amc.getRow(1).values as unknown[];
    const usedCol = header.indexOf('Used');
    expect(usedCol).toBeGreaterThan(0);
    expect(amc.getRow(2).getCell(usedCol).value).toBe(9);
    const assets = wb.getWorksheet('Expiring asset cover')!;
    const wCol = (assets.getRow(1).values as unknown[]).indexOf('Warranty end');
    expect(assets.getRow(2).getCell(wCol).value).toBeInstanceOf(Date);
    // the heatmap travels as row, col, value triples on the Charts sheet
    const charts = wb.getWorksheet('Charts')!;
    const lines: string[][] = [];
    charts.eachRow((row) => lines.push((row.values as unknown[]).slice(1).map((v) => String(v ?? ''))));
    const at = lines.findIndex((l) => l[0] === 'Arrivals by weekday and hour');
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toEqual(['row', 'col', 'value']);
    expect(lines[at + 2]!.slice(0, 2)).toEqual(['Mon', '00']);
  });

  it('renders a plain report with typed columns and keeps sheet names unique', async () => {
    const result = { columns: [{ key: 'n', label: 'Number' }, { key: 'v', label: 'Value', type: 'number' as const }, { key: 'p', label: 'Share', type: 'pct' as const }, { key: 'ok', label: 'Flag', type: 'boolean' as const }], rows: [{ n: 'A', v: 1.5, p: 42.4, ok: true }, { n: 'B', v: null, p: 0, ok: false }], sections: [{ title: 'Tickets: open/closed?', columns: [{ key: 'x', label: 'X' }], rows: [{ x: 1 }] }, { title: 'Tickets: open/closed?', columns: [{ key: 'x', label: 'X' }], rows: [] }], summary: [{ label: 'Rows', value: 2 }] };
    const buffer = await renderXlsx(result, { reportName: 'Unit', platformName: 'Progression', period: 'This week', generatedAt: new Date('2026-03-01T10:00:00Z'), brandColor: '#336699' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toEqual(['Summary', 'Detail', 'Tickets open closed', 'Tickets open closed 2']);
    const detail = wb.getWorksheet('Detail')!;
    expect(detail.getRow(2).getCell(2).value).toBe(1.5);
    expect(detail.getRow(2).getCell(3).numFmt).toBe('0.0"%"');
    expect(detail.getRow(2).getCell(4).value).toBe('Yes');
    expect(detail.getRow(3).getCell(2).value).toBeNull();
    expect(detail.getRow(1).getCell(1).fill).toMatchObject({ fgColor: { argb: 'FF336699' } });
  });
});

describe('branding, cover page and PDF', () => {
  it('uses the platform logo and brand colour from settings and opens the pack with a cover', async () => {
    await withSystem(async (tx) => {
      await tx.update(schema.systemSettings).set({ value: '#336699' }).where(eq(schema.systemSettings.key, 'platform.brand_color'));
      await tx.update(schema.systemSettings).set({ value: 'https://example.com/logo.png' }).where(eq(schema.systemSettings.key, 'platform.logo_url'));
    });
    const run = await asAdmin((ctx) => reports.runReport(ctx, { reportKey: 'service_review_pack', parameters: { customerId: ids.customer, dateRange: 'last_7_days' }, format: 'html' }));
    if (!('status' in run)) throw new Error('expected run');
    const [att] = await withSystem((tx) => tx.select().from(schema.attachments).where(eq(schema.attachments.id, run.attachmentId!)).limit(1));
    const html = (await storage.get(att.storageKey)).toString('utf8');
    expect(html).toContain('class="cover"');
    expect(html).toContain('#336699');
    expect(html).toContain('src="https://example.com/logo.png"');
    expect(html).toContain('@page{size:A4');
    expect(html).toContain(`Pack Customer ${suffix}`);
    expect(html).toContain('<li>Recommendations');
    // a plain report has no cover unless asked
    const plain = renderHtml({ columns: [{ key: 'a', label: 'A' }], rows: [] }, { reportName: 'Plain', platformName: 'P', period: 'x', generatedAt: new Date() });
    expect(plain).not.toContain('class="cover"');
    // unsafe values fall back to the Progression navy
    expect(brandColor('red')).toBe('#292345');
    expect(brandColor('#ABCDEF')).toBe('#abcdef');
    expect(logoUrl('javascript:alert(1)')).toBeNull();
    expect(logoUrl('http://insecure.example/logo.png')).toBeNull();
    expect(logoUrl('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('renders a PDF through Chromium (or refuses clearly when it is not installed)', async () => {
    if (!pdfOn) {
      await expect(asAdmin((ctx) => reports.runReport(ctx, { reportKey: 'open_tickets', parameters: { customerId: ids.customer }, format: 'pdf' }))).rejects.toThrow(/Chromium/);
      return;
    }
    const pdf = await htmlToPdf('<!doctype html><html><body><h1>Hello</h1></body></html>');
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const run = await asAdmin((ctx) => reports.runReport(ctx, { reportKey: 'service_review_pack', parameters: { customerId: ids.customer, dateRange: 'last_7_days' }, format: 'pdf' }));
    if (!('status' in run)) throw new Error('expected run');
    expect(run.status).toBe('completed');
    expect(run.filename).toMatch(/\.pdf$/);
    expect(run.contentType).toBe('application/pdf');
    const [att] = await withSystem((tx) => tx.select().from(schema.attachments).where(eq(schema.attachments.id, run.attachmentId!)).limit(1));
    const buffer = await storage.get(att.storageKey);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(60_000);
    expect(att.size).toBe(buffer.length);
    // the printed text: running footer with page numbers, the executive summary, the three lists and the appendix
    if (existsSync('/usr/bin/pdftotext')) {
      const dir = mkdtempSync(join(tmpdir(), 'itsm-pdf-test-'));
      try {
        const file = join(dir, 'pack.pdf');
        writeFileSync(file, buffer);
        const text = spawnSync('/usr/bin/pdftotext', [file, '-'], { encoding: 'utf8' }).stdout;
        for (const needle of ['Page 2 of', 'Executive summary', 'What went well', 'Next steps', 'Appendix', `Pack Customer ${suffix}`]) expect(text).toContain(needle);
        for (const bad of ['undefined', 'NaN', '[object']) expect(text).not.toContain(bad);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 90_000);

  it('a schedule in pack format delivers the PDF and the workbook together', async () => {
    expect(scheduleFormats('pack')).toEqual(['pdf', 'xlsx']);
    expect(scheduleFormats('both')).toEqual(['csv', 'html']);
    expect(scheduleFormats('xlsx')).toEqual(['xlsx']);
    const input = { name: `Monthly review ${suffix}`, reportKey: 'service_review_pack', customerId: ids.customer, recipients: [`am-${suffix}@msp.test`], recipientUserIds: [], frequency: 'monthly' as const, timezone: 'UTC', dateRange: 'last_month' as const, filters: {}, format: 'pack' as const, delivery: 'both' as const, isActive: true };
    if (!pdfOn) {
      await expect(asAdmin((ctx) => schedules.createSchedule(ctx, input))).rejects.toThrow(/Chromium/);
      return;
    }
    const s = await asAdmin((ctx) => schedules.createSchedule(ctx, input));
    ids.schedule = s.id;
    const out = await executeSchedule(s.id, { manual: true, requestedBy: admin.id });
    expect(out).toMatchObject({ targets: 1, runs: 2, failures: [] });
    const runs = await withSystem((tx) => tx.select().from(schema.reportRuns).where(eq(schema.reportRuns.scheduleId, s.id)));
    expect(runs.map((r) => r.format).sort()).toEqual(['pdf', 'xlsx']);
    expect(runs.every((r) => r.status === 'completed' && r.portalVisible && r.attachmentId)).toBe(true);
    const mails = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.event, 'report.delivered'), inArray(schema.notificationOutbox.entityId, runs.map((r) => r.id)))));
    expect(mails.length).toBe(1);
    expect(mails[0]!.attachments.map((a) => a.contentType).sort()).toEqual(['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
  }, 120_000);

  it('the definition is listed as portal-visible with a cover and the pdf flag reflects the server', async () => {
    const defs = await asAdmin((ctx) => reports.listDefinitions(ctx));
    const def = defs.items.find((d) => d.key === 'service_review_pack');
    expect(def).toMatchObject({ portal: true, cover: true, category: 'customers', defaultDateRange: 'last_month', kind: 'pack', compare: false });
    expect(defs.items.find((d) => d.key === 'sla_performance')).toMatchObject({ kind: 'report', compare: true });
    expect(defs.items.find((d) => d.key === 'open_tickets')).toMatchObject({ compare: false });
    expect(defs.items.find((d) => d.key === 'audit_activity')).toMatchObject({ compare: false });
    expect(defs.formats).toEqual(['json', 'csv', 'html', 'pdf', 'xlsx']);
    expect(defs.pdf).toBe(pdfOn);
    expect(findReport('service_review_pack')?.permissions).toEqual(['reports:run', 'contracts:read', 'assets:read']);
  });
});

describe('comparison, insights and the narrative', () => {
  it('a report with a period is compared with the previous period and carries insights; a snapshot report is not', async () => {
    const out = await asAdmin((ctx) => reports.runReport(ctx, { reportKey: 'ticket_volume', parameters: { customerId: ids.customer, dateRange: 'last_7_days' } }));
    if (!('result' in out)) throw new Error('expected preview');
    expect(out.result.comparison).toMatchObject({ from: addDays(out.period.from, -7), to: addDays(out.period.from, -1) });
    const opened = out.result.summary?.find((s) => s.label === 'Opened');
    expect(opened?.delta).toMatchObject({ previous: expect.any(Number), lowerIsBetter: false });
    expect(opened?.unit).toBe('count');
    expect(Array.isArray(out.result.insights)).toBe(true);
    expect(out.result.narrative?.source).toBe('rules');
    expect(out.result.glossary).toBeDefined();
    const snapshot = await asAdmin((ctx) => reports.runReport(ctx, { reportKey: 'open_tickets', parameters: { customerId: ids.customer } }));
    if (!('result' in snapshot)) throw new Error('expected preview');
    expect(snapshot.result.comparison).toBeUndefined();
    expect(snapshot.result.summary?.every((s) => s.delta === undefined)).toBe(true);
  });

  it('the pack carries recommendations on the result and the rules narrative for a plain Ctx caller', async () => {
    const out = await asAdmin((ctx) => reports.runReport(ctx, { reportKey: 'service_review_pack', parameters: { customerId: ids.customer, dateRange: 'last_7_days' } }));
    if (!('result' in out)) throw new Error('expected preview');
    expect(out.result.recommendations?.length).toBeGreaterThanOrEqual(3);
    expect(out.result.narrative?.source).toBe('rules');
    expect(out.result.narrative?.nextSteps.length).toBeGreaterThanOrEqual(1);
    // the pack compares internally and names its own previous period (the executor ran no second pass)
    expect(out.result.comparison).toMatchObject({ from: addDays(out.period.from, -7), to: addDays(out.period.from, -1) });
    expect(out.result.summary?.find((s) => s.label === 'Backlog')?.delta?.lowerIsBetter).toBe(true);
  });

  it('a comparison that fails in SQL is contained by its savepoint and the file still ships', async () => {
    let calls = 0;
    registerReport({
      key: `compare_fails_${suffix}`,
      name: 'Comparison failure probe',
      description: 'A definition whose previous-period run breaks in SQL; the main run must still produce the document.',
      category: 'tickets',
      permissions: [],
      portal: false,
      parameters: [dateRangeParam],
      defaultDateRange: 'last_7_days',
      async run(ctx) {
        calls++;
        // the second call is the comparison run: a real SQL error aborts the transaction unless it is under a savepoint
        if (calls === 2) await ctx.tx.execute(sql`SELECT 1 / 0`);
        return { columns: [col('n', 'N', 'number')], rows: [{ n: 1 }], summary: [{ label: 'Opened', value: 1 }] };
      },
    });
    const run = await asAdmin((ctx) => reports.runReport(ctx, { reportKey: `compare_fails_${suffix}`, parameters: { dateRange: 'last_7_days' }, format: 'html' }));
    if (!('status' in run)) throw new Error('expected run');
    expect(calls).toBe(2);
    expect(run.status).toBe('completed');
    const { buffer } = await storedFile(run.attachmentId!);
    expect(buffer.toString('utf8')).toContain('Comparison with the previous period unavailable');
    const [row] = await withSystem((tx) => tx.select({ id: schema.reportRuns.id }).from(schema.reportRuns).where(eq(schema.reportRuns.id, run.id)).limit(1));
    expect(row?.id).toBe(run.id);
  });

  it('a portal reader gets the confidentiality line with their organisation, never the internal one', async () => {
    const run = await asPortal((ctx) => reports.runReport(ctx, { reportKey: 'service_review_pack', parameters: { dateRange: 'last_7_days' }, format: 'html' }));
    if (!('status' in run)) throw new Error('expected run');
    const { buffer } = await storedFile(run.attachmentId!);
    const html = buffer.toString('utf8');
    const footer = /@bottom-left\{content:"([^"]*)"/.exec(html)?.[1] ?? '';
    expect(footer).toMatch(/prepared for Pack Customer/i);
    expect(footer).not.toMatch(/internal/i);
    expect(html).toContain(`Pack Customer ${suffix}`);
  });

  it('phrases the narrative through the model between the transactions, drops invented figures and honours the switch', async () => {
    let calls = 0;
    let busy = -1;
    let idleInTx = -1;
    let reply: (payload: { kpis: { label: string; value: unknown }[] }) => Record<string, unknown> = (payload) => {
      const opened = payload.kpis.find((k) => k.label === 'Tickets opened')?.value;
      return { summary: `Tickets opened was ${opened} this period.`, wentWell: [`Tickets opened was ${opened}.`], needsAttention: [], nextSteps: ['Keep the standing review.'] };
    };
    const provider: AiProvider = {
      name: 'fake',
      model: 'fake-1',
      async chat(opts: ChatOptions): Promise<ChatResponse> {
        calls++;
        busy = pool.totalCount - pool.idleCount;
        const res = await withSystem((tx) => tx.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()`));
        idleInTx = Number((res.rows[0] as { n: number }).n);
        const payload = JSON.parse(opts.messages[opts.messages.length - 1]!.content as string) as { kpis: { label: string; value: unknown }[] };
        return { text: JSON.stringify(reply(payload)), toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    ai.setProviderForTests(provider);
    try {
      const steps = reports.reportSteps(admin, { requestId: `test-pdf-narrative-${suffix}`, source: 'api' });
      const out = await reports.executeReport(steps, { reportKey: 'service_review_pack', parameters: { customerId: ids.customer, dateRange: 'last_7_days' }, format: 'html' });
      expect(calls).toBe(1);
      expect(busy).toBe(0);
      expect(idleInTx).toBe(0);
      expect(out.result.narrative?.source).toBe('model');
      expect(out.result.narrative?.summary).toMatch(/^Tickets opened was \d+ this period\.$/);
      expect(out.result.narrative?.nextSteps).toEqual(['Keep the standing review.']);
      const { buffer } = await storedFile(out.attachment!.id);
      expect(buffer.toString('utf8')).toContain(out.result.narrative!.summary);
      // an invented figure is dropped and the rules' sentence stands
      reply = () => ({ summary: 'Compliance was 97% this week.', wentWell: ['Compliance was 97%.'], needsAttention: [], nextSteps: ['Call the customer about 97 tickets.'] });
      const invented = await reports.executeReport(steps, { reportKey: 'service_review_pack', parameters: { customerId: ids.customer, dateRange: 'last_7_days' }, format: 'html' });
      expect(calls).toBe(2);
      expect(invented.result.narrative?.source).toBe('model');
      expect(invented.result.narrative?.summary).not.toContain('97');
      expect(invented.result.narrative?.wentWell.some((t) => t.includes('97'))).toBe(false);
      expect(invented.result.narrative?.nextSteps.some((t) => t.includes('97'))).toBe(false);
      // the switch: reports.narrative off means the model is never asked
      await withSystem((tx) => tx.update(schema.systemSettings).set({ value: false }).where(eq(schema.systemSettings.key, 'reports.narrative')));
      const off = await reports.executeReport(steps, { reportKey: 'service_review_pack', parameters: { customerId: ids.customer, dateRange: 'last_7_days' }, format: 'html' });
      expect(calls).toBe(2);
      expect(off.result.narrative?.source).toBe('rules');
      await withSystem((tx) => tx.update(schema.systemSettings).set({ value: true }).where(eq(schema.systemSettings.key, 'reports.narrative')));
      // a plain Ctx caller (a Grady tool) runs inside one transaction and never calls the model
      const plain = await asAdmin((ctx) => reports.executeReport(ctx, { reportKey: 'service_review_pack', parameters: { customerId: ids.customer, dateRange: 'last_7_days' }, format: 'html' }));
      expect(calls).toBe(2);
      expect(plain.result.narrative?.source).toBe('rules');
      // json previews never call the model either
      await reports.executeReport(steps, { reportKey: 'service_review_pack', parameters: { customerId: ids.customer, dateRange: 'last_7_days' }, format: 'json' });
      expect(calls).toBe(2);
    } finally {
      ai.setProviderForTests(null);
    }
  }, 60_000);
});
