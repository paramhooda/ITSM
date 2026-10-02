/**
 * Event pipeline shared by the worker, the review screen and the dry-run test:
 *
 *   ignore patterns → resolve customer → correlate CI → dedupe → recovery / ticket
 *
 * Tickets are always created through the regular ticket service with a
 * principal that impersonates the integration (name = integration name,
 * source = integration, customer scope = the integration's customer), so SLA,
 * assignment rules, notifications and row-level security all apply.
 */
import { and, eq, inArray, isNull, sql, asc } from 'drizzle-orm';
import type { Permission } from '@itsm/shared';
import { schema, withSystem } from '@/db/client';
import { runAs, type Ctx } from '@/core/context';
import type { Principal } from '@/core/principal';
import { logger } from '@/core/logger';
import { ValidationError } from '@/core/errors';
import { findCiByReference, type MatchedBy } from '@/modules/cmdb/match';
import { createTicket, resolveTicket, reopenTicket } from '@/modules/tickets/service';
import { addComment } from '@/modules/tickets/activity';
import { optionByKey, type TicketRow } from '@/modules/tickets/common';
import { getAdapter, normalizeKeys, firstStr, SEVERITY_RANK, type NormalizedEvent, type EventSeverity, type EventStatus } from './adapters';
import { normalizeRules, DEFAULT_SEVERITY_TO_SECURITY, type Rules } from './schemas';

export type IntegrationRow = typeof schema.integrations.$inferSelect;
export type EventRow = typeof schema.integrationEvents.$inferSelect;

const CLOSED_CATEGORIES = ['resolved', 'closed', 'cancelled'];
const RECURRING_NOTE_MINUTES = 15;

// ---------------------------------------------------------------- principal

const PIPELINE_PERMISSIONS: Permission[] = ['tickets:read', 'tickets:create', 'tickets:update', 'tickets:resolve', 'tickets:work_notes', 'tickets:assign', 'soc:read', 'soc:manage', 'cmdb:read', 'cmdb:manage', 'customers:read', 'integrations:events'];

/**
 * Principal the pipeline acts as. It is *not* a system principal: its customer
 * scope is the integration's customer, so an integration bound to customer A
 * can never read or write customer B's data (enforced by RLS as well).
 */
export function integrationPrincipal(integ: Pick<IntegrationRow, 'id' | 'name' | 'customerId' | 'apiKeyId'>): Principal {
  const perms = new Set<Permission>(PIPELINE_PERMISSIONS);
  if (!integ.customerId) perms.add('tenant:all');
  return {
    id: integ.id,
    email: `integration:${integ.id}`,
    name: integ.name,
    phone: null,
    userType: 'msp',
    customerId: integ.customerId,
    status: 'active',
    timezone: 'UTC',
    preferences: {},
    globalPermissions: perms,
    customerPermissions: new Map(),
    customerScope: integ.customerId ? [integ.customerId] : 'all',
    roles: [],
    teams: [],
    apiKeyId: integ.apiKeyId ?? `integration:${integ.id}`,
  };
}

// ---------------------------------------------------------------- helpers

export function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

function ipToInt(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** IPv4 CIDR membership (`10.1.0.0/16`); a bare address matches exactly. */
export function ipInCidr(ip: string | undefined, cidr: string): boolean {
  if (!ip) return false;
  const [base, bitsStr] = cidr.trim().split('/');
  const bits = bitsStr === undefined ? 32 : Number(bitsStr);
  const a = ipToInt(ip);
  const b = ipToInt(base ?? '');
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

const globMatch = (pattern: string, value: string | undefined) => {
  if (!value) return false;
  const re = safeRegex(`^${pattern.trim().split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return !!re && re.test(value.trim());
};

/** First customer mapping rule whose every stated criterion matches. */
export function matchCustomerMapping(rules: Rules, ev: NormalizedEvent): string | null {
  for (const m of rules.customerMapping) {
    const c = m.match ?? {};
    let any = false;
    let ok = true;
    if (c.group) {
      any = true;
      ok = ok && globMatch(c.group, ev.group);
    }
    if (c.probe) {
      any = true;
      ok = ok && globMatch(c.probe, ev.probe);
    }
    if (c.hostPattern) {
      any = true;
      const re = safeRegex(c.hostPattern);
      ok = ok && !!re && (re.test(ev.host ?? '') || re.test(ev.ipAddress ?? ''));
    }
    if (c.ipCidr) {
      any = true;
      ok = ok && ipInCidr(ev.ipAddress, c.ipCidr);
    }
    if (any && ok) return m.customerId;
  }
  return null;
}

export function matchIgnorePattern(rules: Rules, ev: NormalizedEvent): string | null {
  const haystack = [ev.message, ev.sensor, ev.eventType, ev.host].filter(Boolean) as string[];
  for (const p of rules.ignorePatterns) {
    if (!p.trim()) continue;
    const re = safeRegex(p);
    if (re && haystack.some((h) => re.test(h))) return p;
  }
  return null;
}

/** Handlebars-lite: `{{field}}` and `{{raw.key}}` substitution, then tidy separators left by empty fields. */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  const out = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const v = key.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), vars);
    return v === undefined || v === null ? '' : String(v);
  });
  return out
    .replace(/\s+/g, ' ')
    .replace(/^[\s:\-–—,|]+/, '')
    .replace(/[\s:\-–—,|]+$/, '')
    .replace(/\s*[:\-–—,|]\s*(?=[:\-–—,|])/g, '')
    .trim();
}

function templateVars(ev: NormalizedEvent, integ: Pick<IntegrationRow, 'name' | 'integrationType'>, customerName: string | null) {
  const raw = normalizeKeys(ev.raw);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return {
    host: ev.host ?? ev.ipAddress ?? '',
    ipAddress: ev.ipAddress ?? '',
    sensor: ev.sensor ?? '',
    message: ev.message,
    severity: ev.severity,
    severityLabel: cap(ev.severity),
    status: ev.status,
    statusText: firstStr(raw, 'status', 'incidentstatus', 'sensorstatus') ?? cap(ev.status),
    eventType: ev.eventType,
    externalId: ev.externalId,
    integration: integ.name,
    source: getAdapter(integ.integrationType).label,
    customer: customerName ?? '',
    group: ev.group ?? '',
    probe: ev.probe ?? '',
    raw: ev.raw,
  };
}

function buildDescription(ev: NormalizedEvent, integ: Pick<IntegrationRow, 'name' | 'integrationType'>, row: Pick<EventRow, 'id' | 'receivedAt'>): string {
  const adapter = getAdapter(integ.integrationType);
  const lines = [
    `Source: ${adapter.label} – ${integ.name}`,
    `Event: ${ev.eventType} (severity ${ev.severity}, status ${ev.status})`,
    ev.host || ev.ipAddress ? `Host: ${[ev.host, ev.ipAddress].filter(Boolean).join(' / ')}` : null,
    ev.sensor ? `Sensor / rule: ${ev.sensor}` : null,
    `Message: ${ev.message}`,
    ev.occurredAt ? `Occurred: ${ev.occurredAt.toISOString()}` : null,
    `Received: ${row.receivedAt.toISOString()}`,
    `External id: ${ev.externalId}`,
    ev.group || ev.probe ? `Group / probe: ${[ev.group, ev.probe].filter(Boolean).join(' / ')}` : null,
    `Event record: ${row.id}`,
  ].filter(Boolean);
  let json = '';
  try {
    json = JSON.stringify(ev.raw, null, 2);
  } catch {
    json = String(ev.raw);
  }
  if (json.length > 6000) json = `${json.slice(0, 6000)}\n… (truncated)`;
  return `${lines.join('\n')}\n\nPayload:\n${json}`;
}

const refOf = (ev: NormalizedEvent) => ({ monitoringRef: ev.monitoringRef, siemRef: ev.siemRef, ipAddress: ev.ipAddress, hostname: ev.host, fqdn: ev.host?.includes('.') ? ev.host : undefined });

/** Re-derives the normalized event from the stored payload (falls back to the stored columns). */
export function reparse(integ: Pick<IntegrationRow, 'id' | 'integrationType' | 'name' | 'customerId' | 'config' | 'rules'>, row: EventRow): NormalizedEvent {
  try {
    const parsed = getAdapter(integ.integrationType).parse(row.payload, integ);
    const ev = Array.isArray(parsed) ? parsed[0] : parsed;
    if (ev) return ev;
  } catch {
    /* fall through to the stored columns */
  }
  return {
    externalId: row.externalId ?? row.id,
    eventType: row.eventType ?? 'unknown',
    severity: (row.severity as EventSeverity | null) ?? 'medium',
    status: (row.status as EventStatus | null) ?? 'open',
    host: row.host ?? undefined,
    ipAddress: row.ipAddress ?? undefined,
    sensor: row.sensor ?? undefined,
    message: row.message ?? '',
    raw: row.payload,
  };
}

// ---------------------------------------------------------------- decision

export interface CiMatch {
  id: string;
  name: string;
  siteId: string | null;
  matchedBy: MatchedBy;
  /** The CI was found by IP/hostname and its reference column is empty → write the source reference back. */
  learnRef: 'monitoringRef' | 'siemRef' | null;
}

export interface LinkedTicket {
  id: string;
  number: string;
  statusCategory: string;
  resolvedAt: Date | null;
}

export interface TicketDraft {
  title: string;
  priorityKey: string;
  categoryKey: string | null;
  categoryLabel: string | null;
  domain: string;
  teamKey: string | null;
  securitySeverityKey: string | null;
  sourceKey: string;
}

export type Outcome = 'ignored' | 'customer_unresolved' | 'deduplicated' | 'reopen' | 'recovered' | 'recovery_noted' | 'acknowledged' | 'info' | 'no_ticket' | 'below_threshold' | 'ticket';

export interface Decision {
  outcome: Outcome;
  note: string;
  customerId: string | null;
  customerName: string | null;
  customerSource: 'integration' | 'event' | 'mapping' | 'ci' | null;
  ci: CiMatch | null;
  existingTicket: LinkedTicket | null;
  draft: TicketDraft | null;
  rules: Rules;
}

async function findCi(ctx: Ctx, integ: Pick<IntegrationRow, 'integrationType'>, ev: NormalizedEvent, customerId: string | null): Promise<(CiMatch & { customerId: string }) | null> {
  const hit = await findCiByReference(ctx.tx, { customerId, ...refOf(ev) });
  if (!hit) return null;
  const refField = getAdapter(integ.integrationType).refField;
  const learnRef = refField && hit.matchedBy !== refField && !hit[refField] && ev[refField] ? refField : null;
  return { id: hit.id, name: hit.name, siteId: hit.siteId, matchedBy: hit.matchedBy, learnRef, customerId: hit.customerId };
}

/** Open ticket first, otherwise the most recent closed one (for reopen-on-recurrence). */
export async function findLinkedTicket(ctx: Ctx, integ: Pick<IntegrationRow, 'id' | 'integrationType'>, ev: NormalizedEvent, customerId: string, windowMinutes: number): Promise<LinkedTicket | null> {
  const externalRef = `${integ.integrationType}:${ev.externalId}`.slice(0, 200);
  const res = await ctx.tx.execute(sql`
    select t.id, t.number, s.status_category as "statusCategory", t.resolved_at as "resolvedAt"
    from tickets t join config_options s on s.id = t.status_id
    where t.customer_id = ${customerId}::uuid
      and (t.external_ref = ${externalRef} or t.id in (
        select e.ticket_id from integration_events e
        where e.integration_id = ${integ.id}::uuid and e.external_id = ${ev.externalId} and e.ticket_id is not null
          and e.received_at > now() - (${Math.max(0, windowMinutes)}::int * interval '1 minute')))
    order by (s.status_category in ('resolved','closed','cancelled')) asc, t.created_at desc
    limit 1`);
  const row = res.rows[0] as { id: string; number: string; statusCategory: string; resolvedAt: Date | string | null } | undefined;
  if (!row) return null;
  return { id: row.id, number: row.number, statusCategory: row.statusCategory, resolvedAt: row.resolvedAt ? new Date(row.resolvedAt) : null };
}

async function hasHumanComment(ctx: Ctx, ticketId: string): Promise<boolean> {
  const res = await ctx.tx.execute(sql`select 1 from ticket_comments where ticket_id = ${ticketId}::uuid and (author_id is not null or source not in ('integration', 'system')) limit 1`);
  return res.rows.length > 0;
}

async function recentRecurringNote(ctx: Ctx, ticketId: string): Promise<boolean> {
  const res = await ctx.tx.execute(sql`select 1 from ticket_comments where ticket_id = ${ticketId}::uuid and source = 'integration' and body like 'Recurring event%' and created_at > now() - (${RECURRING_NOTE_MINUTES}::int * interval '1 minute') limit 1`);
  return res.rows.length > 0;
}

const sourceKeyFor = (type: string) => (type === 'prtg' ? 'monitoring' : type === 'fortisiem' ? 'siem' : 'api');

export async function buildDraft(ctx: Ctx, integ: Pick<IntegrationRow, 'name' | 'integrationType'>, rules: Rules, ev: NormalizedEvent, customerName: string | null): Promise<TicketDraft> {
  const category = rules.defaultCategoryKey ? await optionByKey(ctx.tx, 'ticket_category', rules.defaultCategoryKey) : null;
  const domain = category && category.domain !== 'general' ? category.domain : rules.domain;
  const priorityKey = rules.severityToPriority[ev.severity] ?? 'p3';
  const securitySeverityKey = domain === 'soc' ? (rules.severityToSecuritySeverity?.[ev.severity] ?? DEFAULT_SEVERITY_TO_SECURITY[ev.severity]) : null;
  let title = renderTemplate(rules.titleTemplate || '{{host}}: {{message}}', templateVars(ev, integ, customerName));
  if (title.length < 3) title = `${integ.name}: ${ev.message}`;
  return { title: title.slice(0, 300), priorityKey, categoryKey: category?.key ?? null, categoryLabel: category?.label ?? null, domain, teamKey: rules.assignTeamKey ?? null, securitySeverityKey, sourceKey: sourceKeyFor(integ.integrationType) };
}

/** Pure decision: what the pipeline would do for this event. No writes. */
export async function evaluate(ctx: Ctx, integ: IntegrationRow, ev: NormalizedEvent, opts: { eventCustomerId?: string | null }): Promise<Decision> {
  const rules = normalizeRules(integ.rules, integ.integrationType);
  const base: Decision = { outcome: 'info', note: '', customerId: null, customerName: null, customerSource: null, ci: null, existingTicket: null, draft: null, rules };

  const ignored = matchIgnorePattern(rules, ev);
  if (ignored) return { ...base, outcome: 'ignored', note: `Ignored by pattern /${ignored}/` };

  // Customer: integration scope → manual assignment on the event → mapping rules → CI lookup across visible customers
  let customerId: string | null = integ.customerId;
  let customerSource: Decision['customerSource'] = customerId ? 'integration' : null;
  let ci: (CiMatch & { customerId: string }) | null = null;
  if (!customerId && opts.eventCustomerId) {
    customerId = opts.eventCustomerId;
    customerSource = 'event';
  }
  if (!customerId) {
    const mapped = matchCustomerMapping(rules, ev);
    if (mapped) {
      customerId = mapped;
      customerSource = 'mapping';
    }
  }
  if (!customerId) {
    ci = await findCi(ctx, integ, ev, null);
    if (ci) {
      customerId = ci.customerId;
      customerSource = 'ci';
    }
  }
  if (!customerId) return { ...base, outcome: 'customer_unresolved', note: 'Customer not resolved: no mapping rule matched and no CI found for the host / IP address' };
  const [cust] = await ctx.tx.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, customerId)).limit(1);
  if (!cust) return { ...base, outcome: 'customer_unresolved', note: 'Customer not resolved: the mapped customer does not exist or is not accessible' };

  if (!ci) ci = await findCi(ctx, integ, ev, customerId);
  const existing = await findLinkedTicket(ctx, integ, ev, customerId, rules.dedupeWindowMinutes);
  const open = existing && !CLOSED_CATEGORIES.includes(existing.statusCategory) ? existing : null;
  const common: Decision = { ...base, customerId, customerName: cust.name, customerSource, ci, existingTicket: existing };
  const adapterLabel = getAdapter(integ.integrationType).label;

  if (ev.status === 'resolved') {
    if (!open) return { ...common, outcome: 'no_ticket', note: 'Recovery received; no open ticket to resolve' };
    if (!rules.autoResolve) return { ...common, outcome: 'recovery_noted', note: `Recovery noted on ${open.number} (auto-resolve disabled)` };
    if (await hasHumanComment(ctx, open.id)) return { ...common, outcome: 'recovery_noted', note: `Recovery noted on ${open.number} (ticket has engineer activity)` };
    return { ...common, outcome: 'recovered', note: `Resolved ${open.number} (self recovered)` };
  }
  if (ev.status === 'acknowledged') {
    return open ? { ...common, outcome: 'acknowledged', note: `Acknowledgement noted on ${open.number}` } : { ...common, outcome: 'no_ticket', note: `Acknowledged in ${adapterLabel}; no open ticket` };
  }
  if (ev.status === 'info') return { ...common, outcome: 'info', note: 'Informational event' };

  if (open) return { ...common, outcome: 'deduplicated', note: `Attached to open ticket ${open.number}` };
  if (existing && existing.statusCategory === 'resolved' && rules.reopenOnRecurrence && existing.resolvedAt && Date.now() - existing.resolvedAt.getTime() <= rules.dedupeWindowMinutes * 60_000) {
    return { ...common, outcome: 'reopen', note: `Reopened ${existing.number} (recurrence within ${rules.dedupeWindowMinutes} min)` };
  }
  if (!integ.autoCreateTickets) return { ...common, outcome: 'no_ticket', note: 'Correlated; automatic ticket creation is disabled for this integration' };
  if (SEVERITY_RANK[ev.severity] < SEVERITY_RANK[rules.minSeverityForTicket]) return { ...common, outcome: 'below_threshold', note: `Severity ${ev.severity} is below the ticket threshold (${rules.minSeverityForTicket})` };
  const draft = await buildDraft(ctx, integ, rules, ev, cust.name);
  return { ...common, outcome: 'ticket', note: `Ticket would be created: ${draft.title}`, draft };
}

// ---------------------------------------------------------------- writes

/** Creates the incident for an event via the ticket service (SLA, assignment rules, notifications included). */
export async function createTicketForEvent(ctx: Ctx, integ: IntegrationRow, row: EventRow, ev: NormalizedEvent, opts: { customerId: string; ci: CiMatch | null; draft?: TicketDraft | null; customerName?: string | null }): Promise<TicketRow> {
  const rules = normalizeRules(integ.rules, integ.integrationType);
  const draft = opts.draft ?? (await buildDraft(ctx, integ, rules, ev, opts.customerName ?? null));
  const category = draft.categoryKey ? await optionByKey(ctx.tx, 'ticket_category', draft.categoryKey) : null;
  let subcategory = rules.defaultSubcategoryKey ? await optionByKey(ctx.tx, 'ticket_subcategory', rules.defaultSubcategoryKey) : null;
  if (subcategory && category && subcategory.parentId && subcategory.parentId !== category.id) subcategory = null;
  const priority = (await optionByKey(ctx.tx, 'ticket_priority', draft.priorityKey)) ?? null;
  const securitySeverity = draft.securitySeverityKey ? await optionByKey(ctx.tx, 'security_severity', draft.securitySeverityKey) : null;
  const source = (await optionByKey(ctx.tx, 'ticket_source', draft.sourceKey)) ?? (await optionByKey(ctx.tx, 'ticket_source', 'api'));
  const [team] = draft.teamKey ? await ctx.tx.select({ id: schema.teams.id }).from(schema.teams).where(and(eq(schema.teams.key, draft.teamKey), eq(schema.teams.isActive, true))).limit(1) : [];
  const tags = [...new Set(['integration', integ.integrationType, ...(ev.tags ?? [])].map((t) => t.trim().slice(0, 50)).filter(Boolean))].slice(0, 30);

  const ticket = await createTicket(ctx, {
    type: 'incident',
    customerId: opts.customerId,
    title: draft.title,
    description: buildDescription(ev, integ, row),
    categoryId: category?.id ?? null,
    subcategoryId: subcategory?.id ?? null,
    priorityId: priority?.id ?? null,
    sourceId: source?.id ?? null,
    primaryCiId: opts.ci?.id ?? null,
    siteId: opts.ci?.siteId ?? null,
    securitySeverityId: securitySeverity?.id ?? null,
    assignedTeamId: team?.id ?? null,
    externalRef: `${integ.integrationType}:${ev.externalId}`.slice(0, 200),
    tags,
  });
  await ctx.tx.update(schema.tickets).set({ integrationEventId: row.id }).where(eq(schema.tickets.id, ticket.id));
  return { ...ticket, integrationEventId: row.id };
}

async function learnReference(ctx: Ctx, ci: CiMatch, ev: NormalizedEvent, customerId: string) {
  if (!ci.learnRef) return;
  const value = ev[ci.learnRef];
  if (!value) return;
  await ctx.tx.update(schema.cis).set({ [ci.learnRef]: value, updatedAt: new Date() }).where(and(eq(schema.cis.id, ci.id), isNull(schema.cis[ci.learnRef])));
  await ctx.audit({ entityType: 'ci', entityId: ci.id, entityLabel: ci.name, action: 'ci.learn_reference', customerId, changes: { [ci.learnRef]: { old: null, new: value } }, metadata: { matchedBy: ci.matchedBy } });
}

async function addRecurringNote(ctx: Ctx, ticketId: string, ev: NormalizedEvent, force = false) {
  if (!force && (await recentRecurringNote(ctx, ticketId))) return false;
  const when = (ev.occurredAt ?? new Date()).toISOString();
  await addComment(ctx, ticketId, { kind: 'work_note', body: `Recurring event: ${ev.message}\nSeverity ${ev.severity} · ${[ev.host, ev.sensor].filter(Boolean).join(' / ')} · ${when}` });
  return true;
}

/** Executes a decision: ticket operations + event row update. Returns the final processing status. */
export async function apply(ctx: Ctx, integ: IntegrationRow, row: EventRow, ev: NormalizedEvent, d: Decision): Promise<string> {
  const now = new Date();
  const patch: Partial<typeof schema.integrationEvents.$inferInsert> = {
    processedAt: now,
    processingNote: d.note,
    customerId: d.customerId ?? row.customerId ?? null,
    matchedCiId: d.ci?.id ?? row.matchedCiId ?? null,
    processingStatus: 'correlated',
  };
  const open = d.existingTicket && !CLOSED_CATEGORIES.includes(d.existingTicket.statusCategory) ? d.existingTicket : null;
  if (d.ci?.learnRef && d.customerId) await learnReference(ctx, d.ci, ev, d.customerId);
  const adapterLabel = getAdapter(integ.integrationType).label;

  switch (d.outcome) {
    case 'ignored':
      patch.processingStatus = 'ignored';
      break;
    case 'customer_unresolved':
      patch.processingStatus = 'error';
      break;
    case 'deduplicated':
      patch.ticketId = open!.id;
      patch.processingStatus = 'deduplicated';
      await addRecurringNote(ctx, open!.id, ev);
      break;
    case 'reopen': {
      const t = d.existingTicket!;
      await reopenTicket(ctx, t.id, { comment: `Recurring event reported by ${adapterLabel}: ${ev.message}` });
      patch.ticketId = t.id;
      patch.processingStatus = 'deduplicated';
      break;
    }
    case 'recovered': {
      const code = await optionByKey(ctx.tx, 'resolution_code', 'self_recovered');
      await resolveTicket(ctx, open!.id, { resolutionCodeId: code?.id ?? null, resolutionNotes: `${adapterLabel} reports recovery: ${ev.message}` });
      patch.ticketId = open!.id;
      break;
    }
    case 'recovery_noted':
      await addComment(ctx, open!.id, { kind: 'work_note', body: `${adapterLabel} reports recovery: ${ev.message}` });
      patch.ticketId = open!.id;
      break;
    case 'acknowledged':
      await addComment(ctx, open!.id, { kind: 'work_note', body: `Acknowledged in ${adapterLabel}: ${ev.message}` });
      patch.ticketId = open!.id;
      break;
    case 'ticket': {
      const t = await createTicketForEvent(ctx, integ, row, ev, { customerId: d.customerId!, ci: d.ci, draft: d.draft, customerName: d.customerName });
      patch.ticketId = t.id;
      patch.processingStatus = 'ticket_created';
      patch.processingNote = `Created ${t.number}`;
      break;
    }
    case 'info':
    case 'no_ticket':
    case 'below_threshold':
      if (open) patch.ticketId = open.id;
      break;
  }
  await ctx.tx.update(schema.integrationEvents).set(patch).where(and(eq(schema.integrationEvents.id, row.id), eq(schema.integrationEvents.receivedAt, row.receivedAt)));
  return patch.processingStatus!;
}

// ---------------------------------------------------------------- orchestration

async function markError(row: Pick<EventRow, 'id' | 'receivedAt'>, note: string) {
  await withSystem((tx) => tx.update(schema.integrationEvents).set({ processingStatus: 'error', processingNote: note.slice(0, 1000), processedAt: new Date() }).where(and(eq(schema.integrationEvents.id, row.id), eq(schema.integrationEvents.receivedAt, row.receivedAt))));
}

async function processOne(integ: IntegrationRow, row: EventRow, opts: { force?: boolean; requestId?: string }): Promise<string> {
  if (integ.customerId && row.customerId && row.customerId !== integ.customerId) {
    await markError(row, 'Event customer differs from the integration customer (integration was re-scoped)');
    return 'error';
  }
  return runAs(integrationPrincipal(integ), { requestId: opts.requestId ?? `event:${row.id}`, source: 'integration' }, async (ctx) => {
    const res = await ctx.tx.execute(sql`select processed_at as "processedAt", customer_id as "customerId", matched_ci_id as "matchedCiId" from integration_events where id = ${row.id}::uuid and received_at = ${row.receivedAt} for update skip locked`);
    const locked = res.rows[0] as { processedAt: Date | null; customerId: string | null; matchedCiId: string | null } | undefined;
    if (!locked) return 'locked';
    if (locked.processedAt && !opts.force) return 'skipped';
    const current: EventRow = { ...row, customerId: integ.customerId ?? locked.customerId, matchedCiId: locked.matchedCiId };
    if (!integ.isActive) {
      await ctx.tx.update(schema.integrationEvents).set({ processingStatus: 'error', processingNote: 'Integration is disabled', processedAt: new Date() }).where(and(eq(schema.integrationEvents.id, row.id), eq(schema.integrationEvents.receivedAt, row.receivedAt)));
      return 'error';
    }
    const ev = reparse(integ, current);
    const decision = await evaluate(ctx, integ, ev, { eventCustomerId: current.customerId });
    return apply(ctx, integ, current, ev, decision);
  });
}

export interface ProcessResult {
  processed: number;
  results: Record<string, string>;
  /** Ids that were not visible (e.g. the ingest transaction has not committed yet). */
  missing: string[];
}

/** Processes the given events, each in its own transaction. Idempotent: already processed rows are skipped unless `force`. */
export async function processEvents(ids: string[], opts: { force?: boolean; requestId?: string } = {}): Promise<ProcessResult> {
  const results: Record<string, string> = {};
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return { processed: 0, results, missing: [] };
  const rows = await withSystem((tx) => tx.select().from(schema.integrationEvents).where(inArray(schema.integrationEvents.id, unique)).orderBy(asc(schema.integrationEvents.receivedAt)));
  const missing = unique.filter((id) => !rows.some((r) => r.id === id));
  const cache = new Map<string, IntegrationRow | null>();
  for (const row of rows) {
    if (row.processedAt && !opts.force) {
      results[row.id] = 'skipped';
      continue;
    }
    let integ = cache.get(row.integrationId);
    if (integ === undefined) {
      integ = (await withSystem((tx) => tx.select().from(schema.integrations).where(eq(schema.integrations.id, row.integrationId)).limit(1)))[0] ?? null;
      cache.set(row.integrationId, integ);
    }
    if (!integ) {
      await markError(row, 'Integration no longer exists');
      results[row.id] = 'error';
      continue;
    }
    try {
      results[row.id] = await processOne(integ, row, opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, eventId: row.id, integrationId: integ.id }, 'integration event processing failed');
      await markError(row, `Processing failed: ${message}`).catch(() => undefined);
      results[row.id] = 'error';
    }
  }
  return { processed: rows.length, results, missing };
}

/** Sweeps rows still in `received` (fallback when the queue job was lost). */
export async function processPendingEvents(limit = 500): Promise<ProcessResult> {
  const rows = await withSystem((tx) =>
    tx
      .select({ id: schema.integrationEvents.id })
      .from(schema.integrationEvents)
      .where(and(eq(schema.integrationEvents.processingStatus, 'received'), isNull(schema.integrationEvents.processedAt), sql`${schema.integrationEvents.receivedAt} > now() - interval '7 days'`))
      .orderBy(asc(schema.integrationEvents.receivedAt))
      .limit(limit),
  );
  return processEvents(rows.map((r) => r.id));
}

// ---------------------------------------------------------------- dry run + manual actions

export interface DryRunResult {
  event: Omit<NormalizedEvent, 'raw'> & { raw: Record<string, unknown> };
  outcome: Outcome;
  note: string;
  customer: { id: string; name: string | null; source: Decision['customerSource'] } | null;
  ci: CiMatch | null;
  existingTicket: LinkedTicket | null;
  ticket: TicketDraft | null;
  rules: Pick<Rules, 'minSeverityForTicket' | 'dedupeWindowMinutes' | 'autoResolve' | 'reopenOnRecurrence' | 'domain'>;
}

/** Runs the decision logic on the caller's transaction without writing anything. */
export async function simulate(ctx: Ctx, integ: IntegrationRow, ev: NormalizedEvent): Promise<DryRunResult> {
  const d = await evaluate(ctx, integ, ev, { eventCustomerId: null });
  return {
    event: ev,
    outcome: d.outcome,
    note: d.note,
    customer: d.customerId ? { id: d.customerId, name: d.customerName, source: d.customerSource } : null,
    ci: d.ci,
    existingTicket: d.existingTicket,
    ticket: d.draft,
    rules: { minSeverityForTicket: d.rules.minSeverityForTicket, dedupeWindowMinutes: d.rules.dedupeWindowMinutes, autoResolve: d.rules.autoResolve, reopenOnRecurrence: d.rules.reopenOnRecurrence, domain: d.rules.domain },
  };
}

/** Manual ticket creation from the review screen, on the user's own context (their permissions apply). */
export async function manualCreateTicket(ctx: Ctx, integ: IntegrationRow, row: EventRow, opts: { customerId?: string | null }): Promise<{ ticketId: string; ticketNumber: string; created: boolean; processingStatus: string; note: string }> {
  const ev = reparse(integ, row);
  const customerId = integ.customerId ?? opts.customerId ?? row.customerId ?? null;
  if (!customerId) throw new ValidationError('Select a customer for this event first');
  if (integ.customerId && opts.customerId && opts.customerId !== integ.customerId) throw new ValidationError('This integration is bound to a different customer');
  ctx.requireCustomer(customerId);
  const [cust] = await ctx.tx.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, customerId)).limit(1);
  if (!cust) throw new ValidationError('Customer not found');
  const ci = await findCi(ctx, integ, ev, customerId);
  if (ci?.learnRef) await learnReference(ctx, ci, ev, customerId);
  const existing = await findLinkedTicket(ctx, integ, ev, customerId, normalizeRules(integ.rules, integ.integrationType).dedupeWindowMinutes);
  const open = existing && !CLOSED_CATEGORIES.includes(existing.statusCategory) ? existing : null;
  const now = new Date();
  const where = and(eq(schema.integrationEvents.id, row.id), eq(schema.integrationEvents.receivedAt, row.receivedAt));
  if (open) {
    await addRecurringNote(ctx, open.id, ev, true);
    const note = `Attached to open ticket ${open.number} by ${ctx.user.name}`;
    await ctx.tx.update(schema.integrationEvents).set({ customerId, matchedCiId: ci?.id ?? null, ticketId: open.id, processingStatus: 'deduplicated', processingNote: note, processedAt: now }).where(where);
    return { ticketId: open.id, ticketNumber: open.number, created: false, processingStatus: 'deduplicated', note };
  }
  const ticket = await createTicketForEvent(ctx, integ, row, ev, { customerId, ci, customerName: cust.name });
  const note = `Created ${ticket.number} manually by ${ctx.user.name}`;
  await ctx.tx.update(schema.integrationEvents).set({ customerId, matchedCiId: ci?.id ?? null, ticketId: ticket.id, processingStatus: 'ticket_created', processingNote: note, processedAt: now }).where(where);
  return { ticketId: ticket.id, ticketNumber: ticket.number, created: true, processingStatus: 'ticket_created', note };
}
