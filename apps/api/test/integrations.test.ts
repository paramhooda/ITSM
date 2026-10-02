import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, loadApiKeyPrincipal, type Principal } from '../src/core/principal';
import { sha256 } from '../src/lib/crypto';
import { addComment } from '../src/modules/tickets/activity';
import { parsePrtgEvent, mapPrtgStatus } from '../src/modules/integrations/adapters/prtg';
import { parseFortisiemEvent, mapFortisiemSeverity, mapFortisiemStatus, parseHostRef } from '../src/modules/integrations/adapters/fortisiem';
import { parseGenericEvent } from '../src/modules/integrations/adapters/generic';
import { getAdapter, webhookPath } from '../src/modules/integrations/adapters';
import { normalizeRules } from '../src/modules/integrations/schemas';
import { renderTemplate, ipInCidr, matchCustomerMapping, matchIgnorePattern, processEvents, integrationPrincipal } from '../src/modules/integrations/pipeline';
import * as svc from '../src/modules/integrations/service';

// ---------------------------------------------------------------- pure adapter tests (no DB)

describe('PRTG adapter', () => {
  it('normalizes a JSON notification with % placeholder keys', () => {
    const ev = parsePrtgEvent({ '%sensorid': '2345', '%deviceid': '2001', '%device': 'fw-01', '%host': '10.1.1.1', '%name': 'Ping', '%status': 'Down', '%message': 'Request timed out', '%priority': '*****', '%datetime': '02.10.2026 14:03:12', '%group': 'Customer A', '%probe': 'Local Probe' });
    expect(ev).toMatchObject({ externalId: '2001:2345', eventType: 'prtg.down', severity: 'critical', status: 'open', host: 'fw-01', ipAddress: '10.1.1.1', sensor: 'Ping', message: 'Request timed out', monitoringRef: '2001', group: 'Customer A', probe: 'Local Probe' });
    expect(ev.occurredAt?.toISOString()).toBe('2026-10-02T14:03:12.000Z');
    expect(ev.tags).toContain('prtg');
  });
  it('accepts form-encoded style keys and maps statuses', () => {
    expect(parsePrtgEvent({ sensorid: '10', deviceid: '5', device: 'sw-01', host: 'sw-01.example.net', name: 'CPU', status: 'Up', message: 'OK', priority: '***' })).toMatchObject({ externalId: '5:10', status: 'resolved', eventType: 'prtg.up', host: 'sw-01', ipAddress: undefined });
    expect(parsePrtgEvent({ sensor_id: '10', status: 'Warning', priority: '*****' })).toMatchObject({ status: 'open', severity: 'medium', eventType: 'prtg.warning', externalId: '10' });
    expect(parsePrtgEvent({ sensorid: '10', status: 'Down (Partial)', priority: '4' })).toMatchObject({ status: 'open', severity: 'high', eventType: 'prtg.down_partial' });
    expect(parsePrtgEvent({ sensorid: '10', status: 'Paused' })).toMatchObject({ status: 'info', severity: 'info', eventType: 'prtg.paused' });
    expect(parsePrtgEvent({ sensorid: '10', status: 'Down (Acknowledged)' })).toMatchObject({ status: 'acknowledged' });
    expect(parsePrtgEvent({ sensorid: '10', status: 'Down' }).severity).toBe('high');
    expect(parsePrtgEvent({ sensorid: '10', status: 'Unusual' }).severity).toBe('low');
    expect(mapPrtgStatus('Error').status).toBe('open');
  });
  it('rejects payloads without a sensor id', () => {
    expect(() => parsePrtgEvent({ status: 'Down' })).toThrow(/sensorid/);
    expect(() => parsePrtgEvent('nope')).toThrow();
  });
});

describe('FortiSIEM adapter', () => {
  it('maps severity, status and hosts', () => {
    expect(mapFortisiemSeverity(9, undefined)).toBe('critical');
    expect(mapFortisiemSeverity('7', undefined)).toBe('high');
    expect(mapFortisiemSeverity(4, undefined)).toBe('medium');
    expect(mapFortisiemSeverity(2, undefined)).toBe('low');
    expect(mapFortisiemSeverity(undefined, 'HIGH')).toBe('high');
    expect(mapFortisiemSeverity(undefined, 'LOW')).toBe('low');
    expect(mapFortisiemStatus('Active')).toBe('open');
    expect(mapFortisiemStatus(0)).toBe('open');
    expect(mapFortisiemStatus('Cleared')).toBe('resolved');
    expect(mapFortisiemStatus('Manually Cleared')).toBe('resolved');
    expect(mapFortisiemStatus('Closed')).toBe('resolved');
    expect(parseHostRef('hostName:fw-01,hostIpAddr:10.1.1.1')).toEqual({ hostName: 'fw-01', ip: '10.1.1.1' });
    expect(parseHostRef({ hostName: 'x', hostIpAddr: 'not-an-ip' })).toEqual({ hostName: 'x', ip: undefined });
  });
  it('normalizes an incident notification', () => {
    const ev = parseFortisiemEvent(getAdapter('fortisiem').samplePayload);
    expect(ev).toMatchObject({ externalId: '1024', severity: 'high', status: 'open', host: 'fw-01', ipAddress: '10.1.1.1', siemRef: 'fw-01', eventType: 'fortisiem.security_authentication', group: 'Customer A' });
    expect(ev.message).toContain('Brute force');
    expect(ev.tags).toContain('category:security_authentication');
    expect(ev.occurredAt?.getTime()).toBe(1760000300000);
    const src = parseFortisiemEvent({ incidentId: 7, incidentSrc: { hostName: 'pc-7', hostIpAddr: '10.2.2.2' }, incidentSeverity: 10, incidentStatus: 'Cleared' });
    expect(src).toMatchObject({ host: 'pc-7', ipAddress: '10.2.2.2', severity: 'critical', status: 'resolved', eventType: 'fortisiem.incident' });
    expect(() => parseFortisiemEvent({ incidentTitle: 'x' })).toThrow(/incidentId/);
  });
});

describe('generic adapter + rule helpers', () => {
  it('parses normalized events and applies defaults', () => {
    expect(parseGenericEvent({ externalId: 42, host: 'srv' })).toMatchObject({ externalId: '42', severity: 'medium', status: 'open', eventType: 'generic.event', message: 'generic.event' });
    expect(() => parseGenericEvent({ severity: 'high' })).toThrow(/externalId/);
    expect(() => parseGenericEvent({ externalId: 'a', severity: 'urgent' })).toThrow(/severity/);
  });
  it('normalizes rules with adapter defaults', () => {
    const r = normalizeRules({ dedupeWindowMinutes: 30, severityToPriority: { critical: 'p1' } }, 'fortisiem');
    expect(r).toMatchObject({ domain: 'soc', defaultCategoryKey: 'security_incident', dedupeWindowMinutes: 30, minSeverityForTicket: 'medium', autoResolve: true });
    expect(r.severityToPriority).toEqual({ critical: 'p1', high: 'p2', medium: 'p3', low: 'p4', info: 'p5' });
    expect(r.severityToSecuritySeverity?.info).toBe('informational');
    expect(normalizeRules('garbage', 'prtg').domain).toBe('noc');
  });
  it('renders title templates, CIDR and mapping rules', () => {
    expect(renderTemplate('{{host}}: {{sensor}} {{statusText}}', { host: 'fw-01', sensor: 'Ping', statusText: 'Down' })).toBe('fw-01: Ping Down');
    expect(renderTemplate('{{host}}: {{message}}', { host: '', message: 'Disk full' })).toBe('Disk full');
    expect(renderTemplate('{{raw.device}} - {{missing}}', { raw: { device: 'x' } })).toBe('x');
    expect(ipInCidr('10.1.1.7', '10.1.1.0/24')).toBe(true);
    expect(ipInCidr('10.1.2.7', '10.1.1.0/24')).toBe(false);
    expect(ipInCidr('10.1.1.7', '10.1.1.7')).toBe(true);
    expect(ipInCidr('bad', '10.1.1.0/24')).toBe(false);
    const rules = normalizeRules({ customerMapping: [{ match: { group: 'Cust*' }, customerId: '11111111-1111-4111-8111-111111111111' }, { match: { ipCidr: '192.168.0.0/16', hostPattern: '^db-' }, customerId: '22222222-2222-4222-8222-222222222222' }], ignorePatterns: ['maintenance', '('] }, 'prtg');
    const base = { externalId: '1', eventType: 'x', severity: 'high' as const, status: 'open' as const, message: 'm', raw: {} };
    expect(matchCustomerMapping(rules, { ...base, group: 'Customer A' })).toBe('11111111-1111-4111-8111-111111111111');
    expect(matchCustomerMapping(rules, { ...base, host: 'db-01', ipAddress: '192.168.5.5' })).toBe('22222222-2222-4222-8222-222222222222');
    expect(matchCustomerMapping(rules, { ...base, host: 'db-01', ipAddress: '10.0.0.1' })).toBeNull();
    expect(matchIgnorePattern(rules, { ...base, message: 'Scheduled MAINTENANCE window' })).toBe('maintenance');
    expect(matchIgnorePattern(rules, { ...base, message: 'all good' })).toBeNull();
    expect(webhookPath('prtg', 'abc')).toBe('/integrations/prtg/abc');
    expect(webhookPath('generic', 'abc')).toBe('/integrations/abc/events');
  });
});

// ---------------------------------------------------------------- DB-backed pipeline tests

const hasDb = !!process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith('x');
const suffix = Math.random().toString(36).slice(2, 8);
const ids = { customerA: '', customerB: '', siteA: '', ciA: '', prtg: '', prtgB: '', siem: '', apiKeyA: '', apiKeyB: '' };
let admin: Principal;
let rawKeyA = '';
let rawKeyB = '';
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, { requestId: `test-${suffix}` }, fn);
const asKey = async <T>(rawKey: string, fn: (ctx: Ctx) => Promise<T>) => {
  const p = await loadApiKeyPrincipal(rawKey, sha256);
  if (!p) throw new Error('api key principal not loadable');
  return runAs(p, { requestId: `test-key-${suffix}`, source: 'integration' }, fn);
};
async function optionId(tx: Tx, type: string, key: string) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1);
  if (!row) throw new Error(`option ${type}:${key} missing`);
  return row.id;
}
const eventRow = (id: string) => withSystem(async (tx) => (await tx.select().from(schema.integrationEvents).where(eq(schema.integrationEvents.id, id)).limit(1))[0]!);
const ticketRow = (id: string) => withSystem(async (tx) => (await tx.select().from(schema.tickets).where(eq(schema.tickets.id, id)).limit(1))[0]!);
const prtgDown = (sensorid: string, extra: Record<string, unknown> = {}) => ({ sensorid, deviceid: '2001', device: 'fw-01', host: '10.1.1.1', name: 'Ping', status: 'Down', message: `Request timed out ${suffix}`, priority: '*****', group: 'Customer A', ...extra });

describe.skipIf(!hasDb)('integration pipeline (database)', () => {
  beforeAll(async () => {
    await withSystem(async (tx) => {
      const [adminUser] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
      if (!adminUser) throw new Error('admin user missing (seed not applied?)');
      const [a] = await tx.insert(schema.customers).values({ code: `INTA${suffix.toUpperCase()}`, name: `Integration Customer A ${suffix}` }).returning();
      const [b] = await tx.insert(schema.customers).values({ code: `INTB${suffix.toUpperCase()}`, name: `Integration Customer B ${suffix}` }).returning();
      ids.customerA = a.id;
      ids.customerB = b.id;
      const [site] = await tx.insert(schema.sites).values({ customerId: a.id, code: 'DC1', name: 'Data centre', isPrimary: true }).returning();
      ids.siteA = site.id;
      const [type] = await tx.select({ id: schema.ciTypes.id }).from(schema.ciTypes).where(eq(schema.ciTypes.key, 'firewall')).limit(1);
      const typeId = type?.id ?? (await tx.select({ id: schema.ciTypes.id }).from(schema.ciTypes).limit(1))[0]!.id;
      const [ci] = await tx.insert(schema.cis).values({ customerId: a.id, siteId: site.id, typeId, name: 'fw-01', hostname: 'fw-01', ipAddress: '10.1.1.1', monitoringRef: '2001' }).returning();
      ids.ciA = ci.id;
      const p = await loadPrincipal(adminUser.id);
      if (!p) throw new Error('could not load admin principal');
      admin = p;
    });
  });

  afterAll(async () => {
    await withSystem(async (tx) => {
      const integrationIds = [ids.prtg, ids.prtgB, ids.siem].filter(Boolean);
      if (integrationIds.length) {
        const evs = await tx.select({ ticketId: schema.integrationEvents.ticketId }).from(schema.integrationEvents).where(inArray(schema.integrationEvents.integrationId, integrationIds));
        const ticketIds = [...new Set(evs.map((e) => e.ticketId).filter((x): x is string => !!x))];
        if (ticketIds.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, ticketIds));
        await tx.delete(schema.integrationEvents).where(inArray(schema.integrationEvents.integrationId, integrationIds));
        await tx.delete(schema.integrations).where(inArray(schema.integrations.id, integrationIds));
      }
      const keyIds = [ids.apiKeyA, ids.apiKeyB].filter(Boolean);
      if (keyIds.length) await tx.delete(schema.apiKeys).where(inArray(schema.apiKeys.id, keyIds));
      await tx.delete(schema.tickets).where(inArray(schema.tickets.customerId, [ids.customerA, ids.customerB].filter(Boolean)));
      if (ids.customerA) await tx.delete(schema.customers).where(eq(schema.customers.id, ids.customerA));
      if (ids.customerB) await tx.delete(schema.customers).where(eq(schema.customers.id, ids.customerB));
    });
    await closeDb();
  });

  it('creates a customer-scoped PRTG integration with a scoped API key (shown once)', async () => {
    const res = await asAdmin((ctx) => svc.createIntegration(ctx, { integrationType: 'prtg', name: `PRTG ${suffix}`, customerId: ids.customerA, autoCreateTickets: true, isActive: true, createApiKey: true, rules: {} }));
    ids.prtg = res.id;
    expect(res.apiKey?.key).toMatch(/^itsm_/);
    rawKeyA = res.apiKey!.key;
    ids.apiKeyA = res.apiKey!.id;
    expect(res.rules).toMatchObject({ domain: 'noc', defaultCategoryKey: 'availability', dedupeWindowMinutes: 240, autoResolve: true });
    expect(res.webhookUrl).toContain(`/api/integrations/prtg/${res.id}`);
    const [key] = await withSystem((tx) => tx.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, ids.apiKeyA)));
    expect(key.customerId).toBe(ids.customerA);
    expect(key.permissions).toEqual(['integrations:events']);
    const audit = await withSystem((tx) => tx.execute(sql`select action from audit_log where entity_type = 'integration' and entity_id = ${res.id}::uuid`));
    expect((audit.rows as { action: string }[]).map((r) => r.action)).toContain('integration.create');
  });

  let downEventId = '';
  let ticketId = '';

  it('ingests a PRTG Down event with the integration key and creates a P1 incident on the matched CI', async () => {
    const res = await asKey(rawKeyA, (ctx) => svc.ingest(ctx, ids.prtg, prtgDown('3001')));
    expect(res.accepted).toBe(1);
    downEventId = res.ids[0];
    const stored = await eventRow(downEventId);
    expect(stored).toMatchObject({ processingStatus: 'received', customerId: ids.customerA, severity: 'critical', host: 'fw-01', ipAddress: '10.1.1.1', externalId: '2001:3001' });

    const out = await processEvents([downEventId]);
    expect(out.results[downEventId]).toBe('ticket_created');
    const ev = await eventRow(downEventId);
    expect(ev.processingStatus).toBe('ticket_created');
    expect(ev.matchedCiId).toBe(ids.ciA);
    expect(ev.ticketId).toBeTruthy();
    ticketId = ev.ticketId!;
    const t = await ticketRow(ticketId);
    const p1 = await withSystem((tx) => optionId(tx, 'ticket_priority', 'p1'));
    const monitoring = await withSystem((tx) => optionId(tx, 'ticket_source', 'monitoring'));
    expect(t).toMatchObject({ type: 'incident', customerId: ids.customerA, primaryCiId: ids.ciA, siteId: ids.siteA, priorityId: p1, sourceId: monitoring, domain: 'noc', externalRef: 'prtg:2001:3001', integrationEventId: downEventId });
    expect(t.title).toBe('fw-01: Ping Down');
    expect(t.tags).toContain('prtg');
    const [team] = await withSystem((tx) => tx.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.key, 'noc')));
    if (team) expect(t.assignedTeamId).toBe(team.id);
    // idempotent: re-running without force skips
    expect((await processEvents([downEventId])).results[downEventId]).toBe('skipped');
  });

  it('deduplicates a repeated Down event onto the open ticket with a work note', async () => {
    const res = await asKey(rawKeyA, (ctx) => svc.ingest(ctx, ids.prtg, [prtgDown('3001')]));
    const id = res.ids[0];
    await processEvents([id]);
    const ev = await eventRow(id);
    expect(ev.processingStatus).toBe('deduplicated');
    expect(ev.ticketId).toBe(ticketId);
    const tickets = await withSystem((tx) => tx.select({ id: schema.tickets.id }).from(schema.tickets).where(eq(schema.tickets.externalRef, 'prtg:2001:3001')));
    expect(tickets).toHaveLength(1);
    const notes = await withSystem((tx) => tx.select().from(schema.ticketComments).where(eq(schema.ticketComments.ticketId, ticketId)));
    const recurring = notes.filter((n) => n.body.startsWith('Recurring event'));
    expect(recurring).toHaveLength(1);
    expect(recurring[0]).toMatchObject({ kind: 'work_note', isInternal: true, source: 'integration', authorName: `PRTG ${suffix}` });
  });

  it('auto-resolves the ticket when the Up event arrives (resolution code self_recovered)', async () => {
    const res = await asKey(rawKeyA, (ctx) => svc.ingest(ctx, ids.prtg, prtgDown('3001', { status: 'Up', message: 'OK' })));
    const id = res.ids[0];
    await processEvents([id]);
    const ev = await eventRow(id);
    expect(ev.processingStatus).toBe('correlated');
    expect(ev.ticketId).toBe(ticketId);
    expect(ev.processingNote).toMatch(/self recovered/i);
    const t = await ticketRow(ticketId);
    const resolved = await withSystem((tx) => optionId(tx, 'ticket_status', 'resolved'));
    const selfRecovered = await withSystem((tx) => optionId(tx, 'resolution_code', 'self_recovered'));
    expect(t.statusId).toBe(resolved);
    expect(t.resolutionCodeId).toBe(selfRecovered);
    expect(t.resolvedAt).toBeTruthy();
  });

  it('only adds a work note on recovery when an engineer has commented', async () => {
    const down = await asKey(rawKeyA, (ctx) => svc.ingest(ctx, ids.prtg, prtgDown('3002', { name: 'HTTP' })));
    await processEvents(down.ids);
    const newTicketId = (await eventRow(down.ids[0])).ticketId!;
    expect(newTicketId).not.toBe(ticketId);
    await asAdmin((ctx) => addComment(ctx, newTicketId, { kind: 'work_note', body: 'Looking into it' }));
    const up = await asKey(rawKeyA, (ctx) => svc.ingest(ctx, ids.prtg, prtgDown('3002', { name: 'HTTP', status: 'Up' })));
    await processEvents(up.ids);
    const ev = await eventRow(up.ids[0]);
    expect(ev.processingStatus).toBe('correlated');
    expect(ev.processingNote).toMatch(/engineer activity/);
    const t = await ticketRow(newTicketId);
    expect(t.resolvedAt).toBeNull();
    const notes = await withSystem((tx) => tx.select().from(schema.ticketComments).where(eq(schema.ticketComments.ticketId, newTicketId)));
    expect(notes.some((n) => n.body.includes('reports recovery'))).toBe(true);
  });

  it('respects ignore patterns and the severity threshold', async () => {
    await asAdmin((ctx) => svc.updateIntegration(ctx, ids.prtg, { rules: { ignorePatterns: ['maintenance window'], minSeverityForTicket: 'high' } }));
    const res = await asKey(rawKeyA, (ctx) => svc.ingest(ctx, ids.prtg, [prtgDown('3003', { message: 'Scheduled maintenance window' }), prtgDown('3004', { status: 'Warning', message: 'CPU 85%' })]));
    expect(res.accepted).toBe(2);
    await processEvents(res.ids);
    expect((await eventRow(res.ids[0])).processingStatus).toBe('ignored');
    const warn = await eventRow(res.ids[1]);
    expect(warn.processingStatus).toBe('correlated');
    expect(warn.processingNote).toMatch(/below the ticket threshold/);
    expect(warn.ticketId).toBeNull();
    await asAdmin((ctx) => svc.updateIntegration(ctx, ids.prtg, { rules: { ignorePatterns: [], minSeverityForTicket: 'medium' } }));
  });

  it('stores unparseable items as error rows without failing the batch', async () => {
    const res = await asKey(rawKeyA, (ctx) => svc.ingest(ctx, ids.prtg, [{ status: 'Down' }, prtgDown('3005', { status: 'Paused' })]));
    expect(res.accepted).toBe(1);
    expect(res.rejected).toBe(1);
    expect(res.errors[0]).toMatchObject({ index: 0 });
    expect((await eventRow(res.ids[0])).processingStatus).toBe('error');
    await processEvents(res.ids);
    expect((await eventRow(res.ids[1])).processingStatus).toBe('correlated');
  });

  it('never lets a customer-scoped key post to another customer or another integration', async () => {
    const b = await asAdmin((ctx) => svc.createIntegration(ctx, { integrationType: 'prtg', name: `PRTG B ${suffix}`, customerId: ids.customerB, autoCreateTickets: true, isActive: true, createApiKey: true }));
    ids.prtgB = b.id;
    ids.apiKeyB = b.apiKey!.id;
    rawKeyB = b.apiKey!.key;
    await expect(asKey(rawKeyA, (ctx) => svc.ingest(ctx, ids.prtgB, prtgDown('1')))).rejects.toThrow(/not found|not authorised/i);
    await expect(asKey(rawKeyB, (ctx) => svc.ingest(ctx, ids.prtg, prtgDown('1')))).rejects.toThrow(/not found|not authorised/i);
    // The pipeline principal of integration A cannot even see customer B's CIs or tickets.
    const pA = integrationPrincipal({ id: ids.prtg, name: 'x', customerId: ids.customerA, apiKeyId: ids.apiKeyA });
    expect(pA.customerScope).toEqual([ids.customerA]);
    expect(pA.globalPermissions.has('tenant:all')).toBe(false);
  });

  let siemEventId = '';

  it('flags FortiSIEM incidents for unknown hosts in a multi-customer integration as unresolved', async () => {
    const siem = await asAdmin((ctx) => svc.createIntegration(ctx, { integrationType: 'fortisiem', name: `FortiSIEM ${suffix}`, customerId: null, autoCreateTickets: true, isActive: true, createApiKey: false }));
    ids.siem = siem.id;
    expect(siem.rules.domain).toBe('soc');
    const payload = { ...getAdapter('fortisiem').samplePayload, incidentId: `inc-${suffix}`, incidentTarget: { hostName: `unknown-${suffix}`, hostIpAddr: '192.0.2.9' }, customer: 'Nobody' };
    const res = await asAdmin((ctx) => svc.ingest(ctx, ids.siem, payload));
    siemEventId = res.ids[0];
    await processEvents([siemEventId]);
    const ev = await eventRow(siemEventId);
    expect(ev.processingStatus).toBe('error');
    expect(ev.processingNote).toMatch(/Customer not resolved/);
    expect(ev.customerId).toBeNull();
    const stats = await asAdmin((ctx) => svc.stats(ctx, 7));
    expect(stats.unresolvedCustomer).toBeGreaterThanOrEqual(1);
    const list = await asAdmin((ctx) => svc.listEvents(ctx, { page: 1, pageSize: 50, integrationId: ids.siem, unresolvedOnly: true }));
    expect(list.items.map((i) => i.id)).toContain(siemEventId);
  });

  it('creates a SOC ticket with security severity after the customer is assigned and the event reprocessed', async () => {
    await asAdmin((ctx) => svc.assignCustomer(ctx, siemEventId, ids.customerA));
    const out = await processEvents([siemEventId], { force: true });
    expect(out.results[siemEventId]).toBe('ticket_created');
    const ev = await eventRow(siemEventId);
    expect(ev.customerId).toBe(ids.customerA);
    const t = await ticketRow(ev.ticketId!);
    const high = await withSystem((tx) => optionId(tx, 'security_severity', 'high'));
    const p2 = await withSystem((tx) => optionId(tx, 'ticket_priority', 'p2'));
    const siemSource = await withSystem((tx) => optionId(tx, 'ticket_source', 'siem'));
    const category = await withSystem((tx) => optionId(tx, 'ticket_category', 'security_incident'));
    expect(t).toMatchObject({ domain: 'soc', securitySeverityId: high, priorityId: p2, sourceId: siemSource, categoryId: category, externalRef: `fortisiem:inc-${suffix}` });
    expect(t.tags).toContain('fortisiem');
    const detail = await asAdmin((ctx) => svc.getEvent(ctx, siemEventId));
    expect(detail.ticket?.number).toBe(t.number);
    expect(detail.normalized?.host).toBe(`unknown-${suffix}`);
  });

  it('resolves customers through mapping rules and learns the SIEM reference on the CI', async () => {
    await asAdmin((ctx) => svc.updateIntegration(ctx, ids.siem, { rules: { customerMapping: [{ match: { group: 'Customer A' }, customerId: ids.customerA }] } }));
    const payload = { ...getAdapter('fortisiem').samplePayload, incidentId: `inc2-${suffix}`, incidentSeverity: 3 };
    const res = await asAdmin((ctx) => svc.ingest(ctx, ids.siem, payload));
    await processEvents(res.ids);
    const ev = await eventRow(res.ids[0]);
    expect(ev.customerId).toBe(ids.customerA);
    expect(ev.matchedCiId).toBe(ids.ciA);
    expect(ev.processingStatus).toBe('correlated'); // severity low < medium threshold
    const [ci] = await withSystem((tx) => tx.select({ siemRef: schema.cis.siemRef }).from(schema.cis).where(eq(schema.cis.id, ids.ciA)));
    expect(ci.siemRef).toBe('fw-01');
  });

  it('dry-runs a payload without storing anything', async () => {
    const before = await asAdmin((ctx) => svc.listEvents(ctx, { page: 1, pageSize: 1, integrationId: ids.prtg }));
    const sim = await asAdmin((ctx) => svc.testIntegration(ctx, ids.prtg, prtgDown('9999')));
    expect(sim.outcome).toBe('ticket');
    expect(sim.customer?.id).toBe(ids.customerA);
    expect(sim.ci?.id).toBe(ids.ciA);
    expect(sim.ticket).toMatchObject({ priorityKey: 'p1', categoryKey: 'availability', domain: 'noc', title: 'fw-01: Ping Down' });
    const after = await asAdmin((ctx) => svc.listEvents(ctx, { page: 1, pageSize: 1, integrationId: ids.prtg }));
    expect(after.total).toBe(before.total);
  });

  it('rotates and revokes keys and lists integrations with counters', async () => {
    const rotated = await asAdmin((ctx) => svc.rotateKey(ctx, ids.prtg));
    expect(rotated.key).toMatch(/^itsm_/);
    expect(await loadApiKeyPrincipal(rawKeyA, sha256)).toBeNull();
    const [old] = await withSystem((tx) => tx.select({ revokedAt: schema.apiKeys.revokedAt }).from(schema.apiKeys).where(eq(schema.apiKeys.id, ids.apiKeyA)));
    expect(old.revokedAt).toBeTruthy();
    ids.apiKeyA = rotated.id;
    const list = await asAdmin((ctx) => svc.listIntegrations(ctx));
    const mine = list.items.find((i) => i.id === ids.prtg)!;
    expect(mine.counts.last7d).toBeGreaterThanOrEqual(7);
    expect(mine.openTickets).toBeGreaterThanOrEqual(1);
    expect(mine.apiKeyPrefix).toBe(rotated.keyPrefix);
    await asAdmin((ctx) => svc.deleteIntegration(ctx, ids.prtgB));
    const [keyB] = await withSystem((tx) => tx.select({ revokedAt: schema.apiKeys.revokedAt }).from(schema.apiKeys).where(eq(schema.apiKeys.id, ids.apiKeyB)));
    expect(keyB.revokedAt).toBeTruthy();
    ids.prtgB = '';
  });
});
