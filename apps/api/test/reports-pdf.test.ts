/**
 * Service review pack, Excel and PDF output (DB-backed).
 * Run with the dev environment sourced:  npx vitest run test/reports-pdf.test.ts
 * The PDF cases run only when a Chromium binary is found (see lib/pdf.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { withSystem, schema, closeDb, type Tx } from '@/db/client';
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
import { findReport } from '@/modules/reports/registry';

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
    await tx.update(schema.systemSettings).set({ value: '#0f172a' }).where(eq(schema.systemSettings.key, 'platform.brand_color'));
    await tx.update(schema.systemSettings).set({ value: '' }).where(eq(schema.systemSettings.key, 'platform.logo_url'));
  });
  await closeDb();
});

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
    expect(names.slice(0, 3)).toEqual(['Summary', 'Detail', 'Recommendations']);
    expect(names).toEqual(expect.arrayContaining(['Major incidents', 'Entitlement utilisation', 'Out-of-scope work', 'Charts']));
    expect(names.every((n) => n.length <= 31 && !/[\\/?*[\]:]/.test(n))).toBe(true);
    const detail = wb.getWorksheet('Detail')!;
    expect(detail.getRow(1).getCell(1).value).toBe('Area');
    expect(detail.rowCount).toBe(run.rowCount! + 1);
    expect(detail.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    const summary = wb.getWorksheet('Summary')!;
    expect(String(summary.getRow(1).getCell(1).value)).toBe('Service review pack');
    expect(String(summary.getRow(2).getCell(1).value)).toContain(`Pack Customer ${suffix}`);
    // numbers stay numbers and dates become dates in the typed sheets
    const amc = wb.getWorksheet('Entitlement utilisation')!;
    const header = amc.getRow(1).values as unknown[];
    const usedCol = header.indexOf('Used');
    expect(usedCol).toBeGreaterThan(0);
    expect(amc.getRow(2).getCell(usedCol).value).toBe(9);
    const assets = wb.getWorksheet('Expiring asset cover')!;
    const wCol = (assets.getRow(1).values as unknown[]).indexOf('Warranty end');
    expect(assets.getRow(2).getCell(wCol).value).toBeInstanceOf(Date);
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
    // unsafe values fall back
    expect(brandColor('red')).toBe('#0f172a');
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
    expect(buffer.length).toBeGreaterThan(10_000);
    expect(att.size).toBe(buffer.length);
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
    expect(def).toMatchObject({ portal: true, cover: true, category: 'customers', defaultDateRange: 'last_month' });
    expect(defs.formats).toEqual(['json', 'csv', 'html', 'pdf', 'xlsx']);
    expect(defs.pdf).toBe(pdfOn);
    expect(findReport('service_review_pack')?.permissions).toEqual(['reports:run', 'contracts:read', 'assets:read']);
  });
});
