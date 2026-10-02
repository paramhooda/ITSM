import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { diffChanges } from '@/core/audit';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/core/errors';
import { config } from '@/config';
import { enqueue } from '@/jobs/queues';
import { createApiKey, revokeApiKey } from '@/modules/iam/service';
import { ADAPTERS, AdapterParseError, getAdapter, isRecord, webhookPath, type NormalizedEvent } from './adapters';
import { normalizeRules, type EventsListQuery, type IntegrationCreateInput, type IntegrationPatchInput, type Rules } from './schemas';
import * as pipeline from './pipeline';

const { integrations: I, integrationEvents: E, customers: C, cis: CI, tickets: T, apiKeys: K, configOptions: O } = schema;

type IntegrationRow = typeof I.$inferSelect;
type EventRow = typeof E.$inferSelect;

const MAX_BATCH = 500;

export const webhookUrl = (type: string, id: string) => `${config.APP_URL.replace(/\/$/, '')}/api${webhookPath(type, id)}`;

// ---------------------------------------------------------------- types

export function listTypes() {
  return {
    items: Object.values(ADAPTERS).map((a) => ({
      type: a.type,
      label: a.label,
      description: a.description,
      docs: a.docs,
      samplePayload: a.samplePayload,
      defaultRules: normalizeRules({}, a.type),
      refField: a.refField,
      webhookUrlPattern: webhookUrl(a.type, '<integration-id>'),
      acceptsFormEncoded: a.type === 'prtg',
    })),
  };
}

// ---------------------------------------------------------------- integrations

function view<X extends Record<string, unknown>>(row: IntegrationRow, extra: X) {
  return {
    ...row,
    rules: normalizeRules(row.rules, row.integrationType),
    typeLabel: getAdapter(row.integrationType).label,
    webhookUrl: webhookUrl(row.integrationType, row.id),
    ...extra,
  };
}

async function loadIntegration(ctx: Ctx, id: string): Promise<IntegrationRow> {
  const [row] = await ctx.tx.select().from(I).where(eq(I.id, id)).limit(1);
  if (!row) throw new NotFoundError('Integration');
  if (row.customerId) ctx.requireCustomer(row.customerId);
  return row;
}

async function keyMeta(ctx: Ctx, apiKeyId: string | null) {
  if (!apiKeyId) return { apiKeyPrefix: null, apiKeyRevokedAt: null, apiKeyLastUsedAt: null };
  const [k] = await ctx.tx.select({ keyPrefix: K.keyPrefix, revokedAt: K.revokedAt, lastUsedAt: K.lastUsedAt }).from(K).where(eq(K.id, apiKeyId)).limit(1);
  return { apiKeyPrefix: k?.keyPrefix ?? null, apiKeyRevokedAt: k?.revokedAt ?? null, apiKeyLastUsedAt: k?.lastUsedAt ?? null };
}

export async function listIntegrations(ctx: Ctx) {
  const rows = await ctx.tx
    .select({ row: I, customerName: C.name, apiKeyPrefix: K.keyPrefix, apiKeyRevokedAt: K.revokedAt, apiKeyLastUsedAt: K.lastUsedAt })
    .from(I)
    .leftJoin(C, eq(C.id, I.customerId))
    .leftJoin(K, eq(K.id, I.apiKeyId))
    .orderBy(asc(I.name));
  const counts = await ctx.tx.execute(sql`
    select integration_id as "integrationId",
      count(*) filter (where received_at > now() - interval '24 hours')::int as "last24h",
      count(*)::int as "last7d",
      count(*) filter (where processing_status = 'error')::int as "errors7d",
      count(*) filter (where processing_status = 'error' and customer_id is null)::int as "unresolved7d"
    from integration_events where received_at > now() - interval '7 days' group by integration_id`);
  const openTickets = await ctx.tx.execute(sql`
    select e.integration_id as "integrationId", count(distinct t.id)::int as "openTickets"
    from tickets t
    join integration_events e on e.id = t.integration_event_id and e.received_at > now() - interval '90 days'
    join config_options s on s.id = t.status_id
    where s.status_category not in ('resolved', 'closed', 'cancelled')
    group by e.integration_id`);
  const countMap = new Map((counts.rows as { integrationId: string; last24h: number; last7d: number; errors7d: number; unresolved7d: number }[]).map((r) => [r.integrationId, r]));
  const openMap = new Map((openTickets.rows as { integrationId: string; openTickets: number }[]).map((r) => [r.integrationId, r.openTickets]));
  return {
    items: rows.map(({ row, customerName, apiKeyPrefix, apiKeyRevokedAt, apiKeyLastUsedAt }) => {
      const c = countMap.get(row.id);
      return view(row, { customerName, apiKeyPrefix, apiKeyRevokedAt, apiKeyLastUsedAt, counts: { last24h: c?.last24h ?? 0, last7d: c?.last7d ?? 0, errors7d: c?.errors7d ?? 0, unresolved7d: c?.unresolved7d ?? 0 }, openTickets: openMap.get(row.id) ?? 0 });
    }),
  };
}

export async function getIntegration(ctx: Ctx, id: string) {
  const row = await loadIntegration(ctx, id);
  const [cust] = row.customerId ? await ctx.tx.select({ name: C.name }).from(C).where(eq(C.id, row.customerId)).limit(1) : [];
  return view(row, { customerName: cust?.name ?? null, ...(await keyMeta(ctx, row.apiKeyId)) });
}

async function assertCustomerScope(ctx: Ctx, customerId: string | null | undefined, rules?: Partial<Rules>) {
  if (customerId) {
    ctx.requireCustomer(customerId);
    const [c] = await ctx.tx.select({ id: C.id }).from(C).where(eq(C.id, customerId)).limit(1);
    if (!c) throw new ValidationError('Customer not found');
  } else if (!ctx.can('tenant:all')) {
    throw new ForbiddenError('Multi-customer integrations require MSP-wide visibility (tenant:all)');
  }
  for (const m of rules?.customerMapping ?? []) ctx.requireCustomer(m.customerId);
}

const keyPermissionsFor = (customerId: string | null) => (customerId ? ['integrations:events'] : ['integrations:events', 'tenant:all']);

async function issueKey(ctx: Ctx, row: IntegrationRow) {
  const k = await createApiKey(ctx, { name: `Integration: ${row.name}`, permissions: keyPermissionsFor(row.customerId), customerId: row.customerId });
  await ctx.tx.update(I).set({ apiKeyId: k.id, updatedAt: new Date() }).where(eq(I.id, row.id));
  return { id: k.id, key: k.key, keyPrefix: k.keyPrefix };
}

export async function createIntegration(ctx: Ctx, input: IntegrationCreateInput) {
  await assertCustomerScope(ctx, input.customerId, input.rules);
  const rules = normalizeRules(input.rules ?? {}, input.integrationType);
  const [row] = await ctx.tx
    .insert(I)
    .values({ integrationType: input.integrationType, name: input.name, description: input.description ?? null, customerId: input.customerId ?? null, config: input.config ?? {}, rules, autoCreateTickets: input.autoCreateTickets, isActive: input.isActive })
    .returning();
  let apiKey: { id: string; key: string; keyPrefix: string } | null = null;
  if (input.createApiKey) {
    apiKey = await issueKey(ctx, row);
    row.apiKeyId = apiKey.id;
  }
  await ctx.audit({ entityType: 'integration', entityId: row.id, entityLabel: row.name, action: 'integration.create', customerId: row.customerId, metadata: { integrationType: row.integrationType, autoCreateTickets: row.autoCreateTickets, apiKeyCreated: !!apiKey } });
  return { ...view(row, { apiKeyPrefix: apiKey?.keyPrefix ?? null, counts: { last24h: 0, last7d: 0, errors7d: 0, unresolved7d: 0 }, openTickets: 0 }), apiKey };
}

export async function updateIntegration(ctx: Ctx, id: string, patch: IntegrationPatchInput) {
  const before = await loadIntegration(ctx, id);
  const customerId = patch.customerId !== undefined ? patch.customerId : before.customerId;
  const rules = patch.rules ? normalizeRules({ ...before.rules, ...patch.rules }, before.integrationType) : undefined;
  if (patch.customerId !== undefined || rules) await assertCustomerScope(ctx, customerId, rules ?? normalizeRules(before.rules, before.integrationType));
  const values: Partial<typeof I.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.customerId !== undefined) values.customerId = patch.customerId;
  if (patch.autoCreateTickets !== undefined) values.autoCreateTickets = patch.autoCreateTickets;
  if (patch.isActive !== undefined) values.isActive = patch.isActive;
  if (patch.config !== undefined) values.config = patch.config;
  if (rules) values.rules = rules;
  const [row] = await ctx.tx.update(I).set(values).where(eq(I.id, id)).returning();
  // Keep the API key's scope aligned with the integration so the key can never post for another customer.
  if (row.apiKeyId && (customerId !== before.customerId || patch.name !== undefined)) {
    await ctx.tx.update(K).set({ customerId: row.customerId, permissions: keyPermissionsFor(row.customerId), name: `Integration: ${row.name}` }).where(eq(K.id, row.apiKeyId));
  }
  const changes = diffChanges(before as unknown as Record<string, unknown>, values as Record<string, unknown>);
  await ctx.audit({ entityType: 'integration', entityId: row.id, entityLabel: row.name, action: 'integration.update', customerId: row.customerId, changes });
  return getIntegration(ctx, id);
}

export async function deleteIntegration(ctx: Ctx, id: string) {
  const row = await loadIntegration(ctx, id);
  if (row.apiKeyId) {
    const [k] = await ctx.tx.select({ id: K.id, revokedAt: K.revokedAt }).from(K).where(eq(K.id, row.apiKeyId)).limit(1);
    if (k && !k.revokedAt) await revokeApiKey(ctx, k.id);
  }
  await ctx.tx.delete(I).where(eq(I.id, id));
  await ctx.audit({ entityType: 'integration', entityId: id, entityLabel: row.name, action: 'integration.delete', customerId: row.customerId, metadata: { integrationType: row.integrationType } });
  return { ok: true };
}

export async function rotateKey(ctx: Ctx, id: string) {
  const row = await loadIntegration(ctx, id);
  if (row.apiKeyId) {
    const [k] = await ctx.tx.select({ id: K.id, revokedAt: K.revokedAt }).from(K).where(eq(K.id, row.apiKeyId)).limit(1);
    if (k && !k.revokedAt) await revokeApiKey(ctx, k.id);
  }
  const apiKey = await issueKey(ctx, row);
  await ctx.audit({ entityType: 'integration', entityId: row.id, entityLabel: row.name, action: 'integration.rotate_key', customerId: row.customerId, metadata: { previousKeyId: row.apiKeyId, apiKeyId: apiKey.id } });
  return apiKey;
}

export async function testIntegration(ctx: Ctx, id: string, payload: unknown) {
  const row = await loadIntegration(ctx, id);
  const adapter = getAdapter(row.integrationType);
  const input = payload === undefined || payload === null ? adapter.samplePayload : payload;
  let events: NormalizedEvent[];
  try {
    const parsed = adapter.parse(input, row);
    events = Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    throw new ValidationError(`Payload could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!events.length) throw new ValidationError('The payload contains no events');
  const result = await pipeline.simulate(ctx, row, events[0]);
  return { parsedCount: events.length, autoCreateTickets: row.autoCreateTickets, isActive: row.isActive, ...result };
}

// ---------------------------------------------------------------- ingestion

export interface IngestResult {
  accepted: number;
  rejected: number;
  ids: string[];
  errors: { index: number; message: string }[];
}

/** Stores inbound events immediately and queues processing. Never throws for individual bad events. */
export async function ingest(ctx: Ctx, integrationId: string, body: unknown): Promise<IngestResult> {
  const [integ] = await ctx.tx.select().from(I).where(eq(I.id, integrationId)).limit(1);
  if (!integ) throw new NotFoundError('Integration');
  const ownKey = !!ctx.user.apiKeyId && ctx.user.apiKeyId === integ.apiKeyId;
  if (!ownKey && !ctx.user.isSystem && !ctx.can('integrations:manage', integ.customerId)) throw new ForbiddenError('This API key is not authorised for this integration');
  if (!integ.isActive) throw new ConflictError('Integration is disabled');
  if (body === undefined || body === null || body === '') throw new ValidationError('Empty payload');
  const items = Array.isArray(body) ? body : [body];
  if (!items.length) throw new ValidationError('Empty payload');
  if (items.length > MAX_BATCH) throw new ValidationError(`At most ${MAX_BATCH} events per request`);
  const adapter = getAdapter(integ.integrationType);
  const now = new Date();
  const rows: (typeof E.$inferInsert)[] = [];
  const errors: { index: number; message: string }[] = [];
  items.forEach((item, index) => {
    try {
      const parsed = adapter.parse(item, integ);
      for (const ev of Array.isArray(parsed) ? parsed : [parsed]) {
        rows.push({
          receivedAt: now,
          integrationId: integ.id,
          integrationType: integ.integrationType,
          customerId: integ.customerId,
          externalId: ev.externalId.slice(0, 300),
          eventType: ev.eventType.slice(0, 100),
          severity: ev.severity,
          status: ev.status,
          host: ev.host?.slice(0, 253) ?? null,
          ipAddress: ev.ipAddress?.slice(0, 64) ?? null,
          sensor: ev.sensor?.slice(0, 300) ?? null,
          message: ev.message.slice(0, 2000),
          payload: ev.raw,
          processingStatus: 'received',
        });
      }
    } catch (err) {
      const message = err instanceof AdapterParseError || err instanceof Error ? err.message : String(err);
      errors.push({ index, message });
      rows.push({
        receivedAt: now,
        integrationId: integ.id,
        integrationType: integ.integrationType,
        customerId: integ.customerId,
        message: `Unparseable ${adapter.label} payload`,
        payload: isRecord(item) ? item : { value: item },
        processingStatus: 'error',
        processingNote: `Parse error: ${message}`.slice(0, 1000),
        processedAt: now,
      });
    }
  });
  const inserted = await ctx.tx.insert(E).values(rows).returning({ id: E.id, processingStatus: E.processingStatus });
  await ctx.tx.update(I).set({ lastEventAt: now }).where(eq(I.id, integ.id));
  const pending = inserted.filter((r) => r.processingStatus === 'received').map((r) => r.id);
  if (pending.length) await enqueue('integrations', 'process-events', { ids: pending }, { delay: 1000 });
  return { accepted: pending.length, rejected: errors.length, ids: inserted.map((r) => r.id), errors };
}

// ---------------------------------------------------------------- events

const like = (s: string) => `%${s.trim().replace(/[%_]/g, (m) => `\\${m}`)}%`;

const eventColumns = {
  id: E.id,
  receivedAt: E.receivedAt,
  integrationId: E.integrationId,
  integrationName: I.name,
  integrationType: E.integrationType,
  customerId: E.customerId,
  customerName: C.name,
  externalId: E.externalId,
  eventType: E.eventType,
  severity: E.severity,
  status: E.status,
  host: E.host,
  ipAddress: E.ipAddress,
  sensor: E.sensor,
  message: E.message,
  matchedCiId: E.matchedCiId,
  ciName: CI.name,
  ticketId: E.ticketId,
  ticketNumber: T.number,
  processingStatus: E.processingStatus,
  processingNote: E.processingNote,
  processedAt: E.processedAt,
};

function eventsQuery(ctx: Ctx) {
  return ctx.tx.select(eventColumns).from(E).leftJoin(I, eq(I.id, E.integrationId)).leftJoin(C, eq(C.id, E.customerId)).leftJoin(CI, eq(CI.id, E.matchedCiId)).leftJoin(T, eq(T.id, E.ticketId));
}

/** Filters are optional for programmatic callers; the route always passes the parsed query. */
export type EventsListInput = Pick<EventsListQuery, 'page' | 'pageSize'> & Partial<Omit<EventsListQuery, 'page' | 'pageSize'>>;

export async function listEvents(ctx: Ctx, q: EventsListInput) {
  const from = q.from ?? new Date(Date.now() - 7 * 86_400_000);
  const conds: SQL[] = [gte(E.receivedAt, from)];
  if (q.to) conds.push(lte(E.receivedAt, q.to));
  if (q.integrationId) conds.push(eq(E.integrationId, q.integrationId));
  if (q.integrationType) conds.push(eq(E.integrationType, q.integrationType));
  if (q.customerId) conds.push(eq(E.customerId, q.customerId));
  if (q.ticketId) conds.push(eq(E.ticketId, q.ticketId));
  if (q.severity?.length) conds.push(inArray(E.severity, q.severity));
  if (q.status?.length) conds.push(inArray(E.status, q.status));
  if (q.processingStatus?.length) conds.push(inArray(E.processingStatus, q.processingStatus));
  if (q.host?.trim()) conds.push(or(ilike(E.host, like(q.host)), ilike(E.ipAddress, like(q.host)))!);
  if (q.q?.trim()) conds.push(or(ilike(E.message, like(q.q)), ilike(E.host, like(q.q)), ilike(E.sensor, like(q.q)), ilike(E.externalId, like(q.q)))!);
  if (q.unresolvedOnly) conds.push(and(eq(E.processingStatus, 'error'), isNull(E.customerId))!);
  const where = and(...conds);
  const [{ total }] = await ctx.tx.select({ total: sql<number>`count(*)::int` }).from(E).where(where);
  const items = await eventsQuery(ctx)
    .where(where)
    .orderBy(desc(E.receivedAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  return { items, total, page: q.page, pageSize: q.pageSize };
}

async function loadEvent(ctx: Ctx, id: string): Promise<EventRow> {
  const [row] = await ctx.tx.select().from(E).where(eq(E.id, id)).limit(1);
  if (!row) throw new NotFoundError('Integration event');
  return row;
}

export async function getEvent(ctx: Ctx, id: string) {
  const [row] = await eventsQuery(ctx).where(eq(E.id, id)).limit(1);
  if (!row) throw new NotFoundError('Integration event');
  const [full] = await ctx.tx.select({ payload: E.payload }).from(E).where(eq(E.id, id)).limit(1);
  const [integ] = await ctx.tx.select().from(I).where(eq(I.id, row.integrationId)).limit(1);
  const normalized = integ ? pipeline.reparse(integ, { ...row, payload: full?.payload ?? {} } as EventRow) : null;
  const ticket = row.ticketId
    ? (await ctx.tx.select({ id: T.id, number: T.number, title: T.title, statusLabel: O.label, statusCategory: O.statusCategory, statusColor: O.color, resolvedAt: T.resolvedAt }).from(T).leftJoin(O, eq(O.id, T.statusId)).where(eq(T.id, row.ticketId)).limit(1))[0] ?? null
    : null;
  return { ...row, payload: full?.payload ?? {}, normalized: normalized ? { ...normalized, raw: undefined } : null, ticket, integrationCustomerId: integ?.customerId ?? null };
}

export async function reprocessEvent(ctx: Ctx, id: string) {
  const row = await loadEvent(ctx, id);
  await ctx.tx.update(E).set({ processingStatus: 'received', processedAt: null, processingNote: `Reprocess requested by ${ctx.user.name}` }).where(and(eq(E.id, row.id), eq(E.receivedAt, row.receivedAt)));
  await ctx.audit({ entityType: 'integration_event', entityId: row.id, action: 'integration_event.reprocess', customerId: row.customerId, metadata: { previousStatus: row.processingStatus } });
  return { id: row.id };
}

export async function assignCustomer(ctx: Ctx, id: string, customerId: string) {
  const row = await loadEvent(ctx, id);
  const [integ] = await ctx.tx.select({ customerId: I.customerId }).from(I).where(eq(I.id, row.integrationId)).limit(1);
  if (integ?.customerId && integ.customerId !== customerId) throw new ValidationError('This integration is bound to a different customer');
  ctx.requireCustomer(customerId);
  const [cust] = await ctx.tx.select({ id: C.id }).from(C).where(eq(C.id, customerId)).limit(1);
  if (!cust) throw new ValidationError('Customer not found');
  if (row.ticketId) throw new ConflictError('The event is already linked to a ticket');
  await ctx.tx.update(E).set({ customerId, processingStatus: 'received', processedAt: null, processingNote: `Customer assigned by ${ctx.user.name}` }).where(and(eq(E.id, row.id), eq(E.receivedAt, row.receivedAt)));
  await ctx.audit({ entityType: 'integration_event', entityId: row.id, action: 'integration_event.assign_customer', customerId, changes: { customerId: { old: row.customerId, new: customerId } } });
  return { id: row.id };
}

export async function ignoreEvent(ctx: Ctx, id: string) {
  const row = await loadEvent(ctx, id);
  await ctx.tx.update(E).set({ processingStatus: 'ignored', processedAt: new Date(), processingNote: `Ignored by ${ctx.user.name}` }).where(and(eq(E.id, row.id), eq(E.receivedAt, row.receivedAt)));
  await ctx.audit({ entityType: 'integration_event', entityId: row.id, action: 'integration_event.ignore', customerId: row.customerId, metadata: { previousStatus: row.processingStatus } });
  return getEvent(ctx, id);
}

export async function createTicketFromEvent(ctx: Ctx, id: string, customerId?: string | null) {
  const row = await loadEvent(ctx, id);
  if (row.ticketId) throw new ConflictError('The event is already linked to a ticket');
  const [integ] = await ctx.tx.select().from(I).where(eq(I.id, row.integrationId)).limit(1);
  if (!integ) throw new NotFoundError('Integration');
  const result = await pipeline.manualCreateTicket(ctx, integ, row, { customerId });
  await ctx.audit({ entityType: 'integration_event', entityId: row.id, action: 'integration_event.create_ticket', customerId: integ.customerId ?? customerId ?? row.customerId, metadata: { ticketId: result.ticketId, ticketNumber: result.ticketNumber, created: result.created } });
  return { ...result, event: await getEvent(ctx, id) };
}

// ---------------------------------------------------------------- stats

export async function stats(ctx: Ctx, days: number, customerId?: string) {
  const from = new Date(Date.now() - days * 86_400_000);
  const customerCond = customerId ? sql`and customer_id = ${customerId}::uuid` : sql``;
  const grouped = await ctx.tx.execute(sql`
    select integration_type as "integrationType", severity, processing_status as "processingStatus", to_char(date_trunc('day', received_at), 'YYYY-MM-DD') as day, count(*)::int as n,
      count(*) filter (where processing_status = 'error' and customer_id is null)::int as unresolved
    from integration_events where received_at >= ${from} ${customerCond}
    group by 1, 2, 3, 4`);
  const rows = grouped.rows as { integrationType: string; severity: string | null; processingStatus: string; day: string; n: number; unresolved: number }[];
  const byType: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byDayMap = new Map<string, { day: string; total: number; bySeverity: Record<string, number>; ticketsCreated: number }>();
  let total = 0;
  let unresolvedCustomer = 0;
  for (const r of rows) {
    total += r.n;
    unresolvedCustomer += r.unresolved;
    byType[r.integrationType] = (byType[r.integrationType] ?? 0) + r.n;
    const sev = r.severity ?? 'unknown';
    bySeverity[sev] = (bySeverity[sev] ?? 0) + r.n;
    byStatus[r.processingStatus] = (byStatus[r.processingStatus] ?? 0) + r.n;
    const d = byDayMap.get(r.day) ?? { day: r.day, total: 0, bySeverity: {}, ticketsCreated: 0 };
    d.total += r.n;
    d.bySeverity[sev] = (d.bySeverity[sev] ?? 0) + r.n;
    if (r.processingStatus === 'ticket_created') d.ticketsCreated += r.n;
    byDayMap.set(r.day, d);
  }
  // Fill empty days so charts have a continuous axis.
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    if (!byDayMap.has(day)) byDayMap.set(day, { day, total: 0, bySeverity: {}, ticketsCreated: 0 });
  }
  const ticketsCreated = byStatus.ticket_created ?? 0;
  const deduplicated = byStatus.deduplicated ?? 0;
  const open = await ctx.tx.execute(sql`
    select count(distinct t.id)::int as n from tickets t
    join integration_events e on e.id = t.integration_event_id and e.received_at >= ${from}
    join config_options s on s.id = t.status_id
    where s.status_category not in ('resolved', 'closed', 'cancelled') ${customerId ? sql`and t.customer_id = ${customerId}::uuid` : sql``}`);
  const [activeIntegrations] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(I).where(eq(I.isActive, true));
  return {
    days,
    total,
    ticketsCreated,
    deduplicated,
    dedupRate: ticketsCreated + deduplicated ? Math.round((deduplicated / (ticketsCreated + deduplicated)) * 100) : 0,
    errors: byStatus.error ?? 0,
    unresolvedCustomer,
    pending: byStatus.received ?? 0,
    openTickets: (open.rows[0] as { n: number } | undefined)?.n ?? 0,
    activeIntegrations: activeIntegrations?.n ?? 0,
    byType,
    bySeverity,
    byStatus,
    byDay: [...byDayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}
