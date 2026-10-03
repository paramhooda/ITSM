import { z } from 'zod';
import { eq, and, or, ilike } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ValidationError } from '@/core/errors';
import { getCi, listCisFull, history as ciHistory, impact as ciImpact, listBusinessServices, serviceMap, updateCi, addRelationship } from '@/modules/cmdb/service';
import { CI_ENVIRONMENTS, CI_CRITICALITIES, type CiPatchInput } from '@/modules/cmdb/schemas';
import { discoveryOverview, listFindings, applyFindingById, ignoreFinding } from '@/modules/discovery/service';
import { listEvents, createTicketFromEvent } from '@/modules/integrations/service';
import { portalCis } from '@/modules/portal/service';
import { define, type PreviewDetail } from './types';
import { isCustomerUser, ticketLink, trunc, iso, resolveCustomerId, resolveCi, resolveTeam, forCustomer, UUID_RE } from '../helpers';

/** CMDB tools: configuration items, relationships, business services, impact, discovery findings and monitoring events. */

const ciLink = (id: string) => `/cmdb/cis/${id}`;
const ciRef = z.string().max(200).describe('CI name, hostname, IP address or id');

async function relationshipType(ctx: Ctx, ref: string) {
  const r = ref.trim();
  const rows = await ctx.tx.select({ id: schema.ciRelationshipTypes.id, key: schema.ciRelationshipTypes.key, name: schema.ciRelationshipTypes.name }).from(schema.ciRelationshipTypes).where(and(eq(schema.ciRelationshipTypes.isActive, true), or(eq(schema.ciRelationshipTypes.key, r), ilike(schema.ciRelationshipTypes.name, `%${r.replace(/[%_]/g, (m) => `\\${m}`)}%`)))).limit(6);
  const exact = rows.filter((t) => t.key === r || t.name.toLowerCase() === r.toLowerCase());
  const pick = exact.length === 1 ? exact : rows;
  if (pick.length === 1) return pick[0]!;
  const all = await ctx.tx.select({ key: schema.ciRelationshipTypes.key }).from(schema.ciRelationshipTypes).where(eq(schema.ciRelationshipTypes.isActive, true));
  if (!pick.length) throw new ValidationError(`Unknown relationship type "${ref}". Valid: ${all.map((t) => t.key).join(', ')}`);
  throw new ValidationError(`Relationship type "${ref}" is ambiguous: ${pick.map((t) => t.key).join(', ')}`);
}

async function findingByRef(ctx: Ctx, ref: string, customerId?: string) {
  const r = ref.trim();
  if (UUID_RE.test(r)) return { id: r, label: r };
  const res = await listFindings(ctx, { page: 1, pageSize: 10, status: 'pending', q: r, customerId } as never);
  const items = res.items as unknown as { id: string; hostname: string | null; ipAddress: string | null }[];
  const low = r.toLowerCase();
  const exact = items.filter((f) => f.hostname?.toLowerCase() === low || f.ipAddress === r);
  const pick = exact.length ? exact : items;
  if (pick.length === 1) return { id: pick[0]!.id, label: pick[0]!.hostname ?? pick[0]!.ipAddress ?? pick[0]!.id };
  if (!pick.length) throw new ValidationError(`No pending discovery finding matching "${ref}"`);
  throw new ValidationError(`Finding "${ref}" is ambiguous: ${pick.map((f) => f.hostname ?? f.ipAddress ?? f.id).join(', ')}`);
}

export const CMDB: ReturnType<typeof define>[] = [
  define({
    name: 'get_ci',
    toolset: 'cmdb',
    description: 'Configuration item by name, hostname or IP: details, relationships, open tickets and recent changes.',
    inputSchema: z.object({ ci: ciRef, customer: z.string().max(200).optional() }),
    requires: ['cmdb:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const hit = await resolveCi(ctx, input.ci, await resolveCustomerId(ctx, input.customer));
      const ci = await getCi(ctx, hit.id);
      return {
        id: ci.id,
        name: ci.name,
        type: ci.type.name,
        hostname: ci.hostname,
        fqdn: ci.fqdn,
        ipAddress: ci.ipAddress,
        status: ci.status,
        environment: ci.environment,
        criticality: ci.criticality,
        customer: ci.customerName,
        site: ci.siteName,
        ownerTeam: ci.ownerTeamName,
        manufacturer: ci.manufacturer,
        model: ci.model,
        os: [ci.osName, ci.osVersion].filter(Boolean).join(' ') || null,
        serialNumber: ci.serialNumber,
        lastSeenAt: iso(ci.lastSeenAt),
        description: trunc(ci.description, 600),
        tags: ci.tags,
        services: ci.services.map((s) => s.name),
        asset: ci.asset ? { tag: ci.asset.tag, warrantyEnd: ci.asset.warrantyEnd, amcEnd: ci.asset.amcEnd, lifecycleStage: ci.asset.lifecycleStage } : null,
        relationships: [...ci.relationships.outbound.map((r) => ({ relation: r.typeName, ci: r.ci.name, type: r.ci.typeName })), ...ci.relationships.inbound.map((r) => ({ relation: r.inverseName, ci: r.ci.name, type: r.ci.typeName }))].slice(0, 40),
        openTickets: ci.openTickets.slice(0, 15).map((t) => ({ number: t.number, title: t.title, status: t.status, link: ticketLink(ctx, t.id) })),
        recentChanges: ci.recentChanges.slice(0, 10).map((t) => ({ number: t.number, title: t.title, status: t.status, createdAt: iso(t.createdAt), link: ticketLink(ctx, t.id) })),
        link: ciLink(ci.id),
      };
    },
    summary: (input, result) => `Read CI ${(result as { name: string }).name ?? input.ci}`,
  }),

  define({
    name: 'list_cis',
    toolset: 'cmdb',
    description: 'Configuration items by customer, type, status, criticality, environment or free text; also stale (not seen by discovery for 30 days), unowned or discovered-only CIs.',
    inputSchema: z.object({ customer: z.string().max(200).optional(), q: z.string().max(200).optional(), typeKey: z.string().max(64).optional().describe('CI type key, e.g. server, switch, firewall, business_service'), status: z.string().max(32).optional(), criticality: z.enum(CI_CRITICALITIES).optional(), environment: z.enum(CI_ENVIRONMENTS).optional(), stale: z.boolean().optional(), unowned: z.boolean().optional(), limit: z.number().int().min(1).max(30).optional() }),
    requires: ['cmdb:read'],
    portal: ['portal:assets'],
    action: false,
    run: async (ctx, input) => {
      const limit = input.limit ?? 20;
      if (isCustomerUser(ctx)) {
        const res = await portalCis(ctx, { page: 1, pageSize: limit, q: input.q, criticality: input.criticality, status: input.status } as never);
        return { total: res.total, facts: [`${res.total} configuration item(s)${input.q ? ` matching "${input.q}"` : ''}`], items: res.items.map((c) => ({ name: c.name, type: c.typeName, hostname: c.hostname, ipAddress: c.ipAddress, site: c.siteName, status: c.status, criticality: c.criticality, environment: c.environment, model: c.model, link: '/portal/assets/inventory' })) };
      }
      const customerId = await resolveCustomerId(ctx, input.customer);
      const res = await listCisFull(ctx, { page: 1, pageSize: limit, q: input.q, customerId, typeKey: input.typeKey, status: input.status as never, criticality: input.criticality, environment: input.environment, stale: input.stale, unowned: input.unowned, sort: 'name', order: 'asc' } as never);
      const items = res.items as unknown as { id: string; name: string; typeName: string | null; hostname: string | null; ipAddress: string | null; customerName: string | null; siteName: string | null; status: string; criticality: string; environment: string | null; ownerTeamName?: string | null; lastSeenAt: Date | null }[];
      return { total: res.total, facts: [`${res.total} configuration item(s)${await forCustomer(ctx, customerId)}${input.typeKey ? ` of type ${input.typeKey}` : ''}${input.stale ? ' not seen for 30 days' : ''}${input.unowned ? ' without an owner team' : ''}`], items: items.map((c) => ({ name: c.name, type: c.typeName, hostname: c.hostname, ipAddress: c.ipAddress, customer: c.customerName, site: c.siteName, status: c.status, criticality: c.criticality, environment: c.environment, ownerTeam: c.ownerTeamName ?? null, lastSeenAt: iso(c.lastSeenAt), link: ciLink(c.id) })) };
    },
    summary: (_i, result) => `Listed ${(result as { items: unknown[] }).items.length} configuration items`,
  }),

  define({
    name: 'ci_history',
    toolset: 'cmdb',
    description: 'Audit history of a configuration item (attribute changes, relationship changes, discovery updates).',
    inputSchema: z.object({ ci: ciRef, customer: z.string().max(200).optional(), limit: z.number().int().min(1).max(50).optional() }),
    requires: ['cmdb:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const hit = await resolveCi(ctx, input.ci, await resolveCustomerId(ctx, input.customer));
      const res = await ciHistory(ctx, hit.id, input.limit ?? 25);
      return { ci: 'name' in hit ? hit.name : hit.id, items: res.items.map((r) => ({ at: iso(r.occurredAt), by: r.userName, action: r.action, source: r.source, entity: r.entityLabel, changes: Object.fromEntries(Object.entries(r.changes ?? {}).slice(0, 12).map(([k, v]) => [k, { old: trunc(String((v as { old: unknown }).old ?? ''), 80), new: trunc(String((v as { new: unknown }).new ?? ''), 80) }])) })) };
    },
    summary: (input, result) => `Read ${(result as { items: unknown[] }).items.length} history entries of ${input.ci}`,
  }),

  define({
    name: 'impact_analysis',
    toolset: 'cmdb',
    description: 'Downstream impact of a configuration item: dependent CIs, affected business services and their open tickets.',
    inputSchema: z.object({ ci: ciRef, customer: z.string().max(200).optional() }),
    requires: ['cmdb:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const hit = await resolveCi(ctx, input.ci, await resolveCustomerId(ctx, input.customer));
      const res = await ciImpact(ctx, hit.id);
      return { root: res.root.name, facts: [`${res.dependents.length} dependent CI(s) and ${res.businessServices.length} business service(s) depend on ${res.root.name}${res.truncated ? ' (list truncated)' : ''}`], dependents: res.dependents.slice(0, 40).map((d) => ({ name: d.name, type: d.typeName, criticality: d.criticality, depth: d.depth, via: d.via, path: d.path.join(' → ') })), businessServices: res.businessServices.map((b) => b.name), openTickets: res.openTickets.slice(0, 15).map((t) => ({ number: t.number, title: t.title, status: t.status, link: ticketLink(ctx, t.id) })), truncated: res.truncated };
    },
    summary: (input, result) => `Analysed impact of ${input.ci} (${(result as { dependents: unknown[] }).dependents.length} dependents)`,
  }),

  define({
    name: 'service_map',
    toolset: 'cmdb',
    description: 'Business services and their health (open incidents, dependencies). With a service name: the layered dependency map of that service (what it relies on).',
    inputSchema: z.object({ customer: z.string().max(200).optional(), service: z.string().max(200).optional().describe('Business service (CI) name for its dependency map') }),
    requires: ['cmdb:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      if (!input.service) {
        const res = await listBusinessServices(ctx, customerId);
        return { facts: [`${res.items.length} business service(s)${await forCustomer(ctx, customerId)}, ${res.items.filter((s) => s.health !== 'good').length} with open incidents`], items: res.items.map((s) => ({ name: s.name, customer: s.customerName, status: s.status, criticality: s.criticality, tier: s.tier, owner: s.owner, dependencies: s.dependencies, openIncidents: s.openIncidents, health: s.health, link: `/cmdb/services/${s.id}` })) };
      }
      const hit = await resolveCi(ctx, input.service, customerId);
      const map = (await serviceMap(ctx, hit.id)) as unknown as { nodes: { id: string; name: string; typeName?: string; type?: string; criticality?: string; status?: string; depth?: number; layer?: number }[]; edges: unknown[]; truncated?: boolean };
      return { service: 'name' in hit ? hit.name : input.service, nodes: map.nodes.slice(0, 60).map((n) => ({ name: n.name, type: n.typeName ?? n.type ?? null, criticality: n.criticality ?? null, status: n.status ?? null, depth: n.depth ?? n.layer ?? null })), edges: map.edges.length, truncated: !!map.truncated, link: `/cmdb/services/${hit.id}` };
    },
    summary: (input, result) => (input.service ? `Read the service map of ${input.service} (${(result as { nodes: unknown[] }).nodes.length} nodes)` : `Listed ${(result as { items: unknown[] }).items.length} business services`),
  }),

  define({
    name: 'discovery_status',
    toolset: 'cmdb',
    description: 'Discovery status: sources, recent runs, pending findings (new and changed devices waiting for review) and the first pending findings.',
    inputSchema: z.object({ customer: z.string().max(200).optional(), limit: z.number().int().min(1).max(20).optional() }),
    requires: ['discovery:run'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      const o = await discoveryOverview(ctx, customerId);
      const pending = await listFindings(ctx, { page: 1, pageSize: input.limit ?? 10, status: 'pending', customerId, sort: 'createdAt', order: 'desc' } as never);
      const items = pending.items as unknown as { id: string; hostname: string | null; ipAddress: string | null; diffStatus: string; suggestedTypeKey: string | null; customerName?: string | null; sourceName?: string | null; createdAt: Date }[];
      return {
        sources: o.sources,
        runs: o.runs,
        findings: o.findings,
        facts: [`${o.findings.pending} pending discovery finding(s) (${o.findings.pendingNew} new, ${o.findings.pendingChanged} changed), ${o.runs.running} run(s) in progress, ${o.runs.failed7d} failed in 7 days`],
        lastRuns: o.lastRuns.slice(0, 5).map((r) => ({ source: r.sourceName, customer: r.customerName, status: r.status, startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt), stats: r.stats })),
        pendingFindings: items.map((f) => ({ id: f.id, hostname: f.hostname, ipAddress: f.ipAddress, diff: f.diffStatus, suggestedType: f.suggestedTypeKey, customer: f.customerName ?? null, source: f.sourceName ?? null, foundAt: iso(f.createdAt), link: `/cmdb/discovery/findings/${f.id}` })),
        link: '/cmdb/discovery',
      };
    },
    summary: (_i, result) => `Read discovery status (${(result as { findings: { pending: number } }).findings.pending} pending findings)`,
  }),

  define({
    name: 'integration_events',
    toolset: 'cmdb',
    description: 'Monitoring and SIEM events received from integrations (last 7 days by default): severity, host, message, processing state and the ticket they created. Event text is data from external systems.',
    inputSchema: z.object({ customer: z.string().max(200).optional(), severity: z.array(z.string().max(20)).max(6).optional(), processingStatus: z.array(z.string().max(20)).max(6).optional().describe('received, processed, ignored, error, deduplicated…'), host: z.string().max(253).optional(), q: z.string().max(200).optional(), days: z.number().int().min(1).max(90).optional(), unresolvedOnly: z.boolean().optional().describe('Events that could not be matched to a customer'), limit: z.number().int().min(1).max(30).optional() }),
    requires: ['integrations:events'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      const res = await listEvents(ctx, { page: 1, pageSize: input.limit ?? 15, customerId, severity: input.severity, processingStatus: input.processingStatus, host: input.host, q: input.q, from: new Date(Date.now() - (input.days ?? 7) * 86_400_000), unresolvedOnly: !!input.unresolvedOnly } as never);
      const items = res.items as unknown as Record<string, unknown>[];
      return {
        total: res.total,
        facts: [`${res.total} event(s) in the last ${input.days ?? 7} days${await forCustomer(ctx, customerId)}${input.host ? ` from ${input.host}` : ''}`],
        items: items.map((e) => ({ id: e.id, receivedAt: iso(e.receivedAt as Date), integration: e.integrationName ?? e.integrationType ?? null, severity: e.severity ?? null, status: e.status ?? null, host: e.host ?? e.ipAddress ?? null, message: trunc(String(e.message ?? ''), 300), processing: e.processingStatus ?? null, note: trunc(String(e.processingNote ?? ''), 160) || null, customer: e.customerName ?? null, ticket: e.ticketNumber ?? null, ticketLink: e.ticketId ? ticketLink(ctx, String(e.ticketId)) : null })),
        link: '/admin/integrations',
      };
    },
    summary: (_i, result) => `Listed ${(result as { items: unknown[] }).items.length} integration events`,
  }),

  define({
    name: 'update_ci',
    toolset: 'cmdb',
    description: 'Change a configuration item: status, environment, criticality, owner team, hostname, IP address, description or tags.',
    inputSchema: z.object({ ci: ciRef, customer: z.string().max(200).optional(), status: z.string().max(32).optional(), environment: z.enum(CI_ENVIRONMENTS).optional(), criticality: z.enum(CI_CRITICALITIES).optional(), ownerTeam: z.string().max(200).optional(), hostname: z.string().max(253).optional(), ipAddress: z.string().max(64).optional(), description: z.string().max(5000).optional(), tags: z.array(z.string().max(50)).max(50).optional() }),
    requires: ['cmdb:manage'],
    portal: null,
    action: true,
    invalidates: ['cmdb'],
    run: async (ctx, input) => {
      const hit = await resolveCi(ctx, input.ci, await resolveCustomerId(ctx, input.customer));
      const { patch, lines } = await ciPatch(ctx, input);
      const ci = await updateCi(ctx, hit.id, patch);
      return { ci: ci.name, changed: lines, link: ciLink(ci.id) };
    },
    summary: (input, result) => `Updated CI ${(result as { ci: string }).ci ?? input.ci} (${((result as { changed?: string[] }).changed ?? []).join('; ')})`,
    preview: async (ctx, input): Promise<PreviewDetail> => {
      const hit = await resolveCi(ctx, input.ci, await resolveCustomerId(ctx, input.customer));
      const { lines } = await ciPatch(ctx, input);
      if (!lines.length) throw new ValidationError('No change requested');
      return { text: `Update CI ${'name' in hit ? hit.name : input.ci}: ${lines.join('; ')}`, lines };
    },
  }),

  define({
    name: 'add_ci_relationship',
    toolset: 'cmdb',
    description: 'Add a relationship between two configuration items (e.g. "depends_on", "hosted_on", "connected_to"); the type must exist.',
    inputSchema: z.object({ ci: ciRef.describe('Source CI'), relationship: z.string().max(80).describe('Relationship type key or name'), target: ciRef.describe('Target CI'), customer: z.string().max(200).optional(), description: z.string().max(500).optional() }),
    requires: ['cmdb:manage'],
    portal: null,
    action: true,
    invalidates: ['cmdb'],
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      const [source, target, type] = await Promise.all([resolveCi(ctx, input.ci, customerId), resolveCi(ctx, input.target, customerId), relationshipType(ctx, input.relationship)]);
      await addRelationship(ctx, source.id, { targetCiId: target.id, typeId: type.id, description: input.description ?? null });
      return { source: 'name' in source ? source.name : input.ci, relationship: type.key, target: 'name' in target ? target.name : input.target, link: ciLink(source.id) };
    },
    summary: (input, result) => `Linked ${(result as { source: string }).source ?? input.ci} ${(result as { relationship: string }).relationship ?? input.relationship} ${(result as { target: string }).target ?? input.target}`,
    preview: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      const [source, target, type] = await Promise.all([resolveCi(ctx, input.ci, customerId), resolveCi(ctx, input.target, customerId), relationshipType(ctx, input.relationship)]);
      return `Add the relationship "${'name' in source ? source.name : input.ci}" ${type.name} "${'name' in target ? target.name : input.target}"`;
    },
  }),

  define({
    name: 'decide_discovery_finding',
    toolset: 'cmdb',
    description: 'Apply a pending discovery finding (create or update the CI from what discovery found) or ignore it.',
    inputSchema: z.object({ finding: z.string().max(253).describe('Finding id, or the discovered hostname / IP address'), decision: z.enum(['apply', 'ignore']), customer: z.string().max(200).optional() }),
    requires: ['discovery:run'],
    portal: null,
    action: true,
    invalidates: ['cmdb'],
    run: async (ctx, input) => {
      const f = await findingByRef(ctx, input.finding, await resolveCustomerId(ctx, input.customer));
      if (input.decision === 'ignore') {
        await ignoreFinding(ctx, f.id);
        return { finding: f.label, decision: 'ignored', link: `/cmdb/discovery/findings/${f.id}` };
      }
      const res = await applyFindingById(ctx, f.id);
      return { finding: f.label, decision: 'applied', ci: res.ciName, created: res.created, neighborsLinked: res.neighborsLinked, link: ciLink(res.ciId) };
    },
    summary: (input, result) => `${input.decision === 'apply' ? 'Applied' : 'Ignored'} discovery finding ${(result as { finding: string }).finding ?? input.finding}`,
    preview: async (ctx, input) => {
      const f = await findingByRef(ctx, input.finding, await resolveCustomerId(ctx, input.customer));
      return input.decision === 'apply' ? `Apply discovery finding ${f.label}: create or update the configuration item from what discovery found` : `Ignore discovery finding ${f.label}`;
    },
  }),

  define({
    name: 'create_ticket_from_event',
    toolset: 'cmdb',
    description: 'Create an incident from a monitoring or SIEM event (the integration\'s rules build the ticket); use the event id from integration_events.',
    inputSchema: z.object({ eventId: z.string().uuid(), customer: z.string().max(200).optional().describe('Required when the event could not be matched to a customer') }),
    requires: ['integrations:events', 'tickets:create'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      const res = await createTicketFromEvent(ctx, input.eventId, customerId ?? null);
      return { ticket: res.ticketNumber, created: res.created, note: res.note, link: ticketLink(ctx, res.ticketId) };
    },
    summary: (_i, result) => `${(result as { created: boolean }).created ? 'Created' : 'Linked'} ticket ${(result as { ticket: string }).ticket} from the event`,
    preview: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      const [row] = await ctx.tx.select({ host: schema.integrationEvents.host, message: schema.integrationEvents.message, severity: schema.integrationEvents.severity, ticketId: schema.integrationEvents.ticketId }).from(schema.integrationEvents).where(eq(schema.integrationEvents.id, input.eventId)).limit(1);
      if (!row) throw new ValidationError('No such integration event');
      if (row.ticketId) throw new ValidationError('That event is already linked to a ticket');
      return `Create an incident from the ${row.severity ?? ''} event on ${row.host ?? 'unknown host'} ("${trunc(row.message, 100)}")${customerId ? ' for the named customer' : ''}`;
    },
  }),
];

type CiInput = { status?: string; environment?: (typeof CI_ENVIRONMENTS)[number]; criticality?: (typeof CI_CRITICALITIES)[number]; ownerTeam?: string; hostname?: string; ipAddress?: string; description?: string; tags?: string[] };
async function ciPatch(ctx: Ctx, input: CiInput): Promise<{ patch: CiPatchInput; lines: string[] }> {
  const patch: CiPatchInput = {};
  const lines: string[] = [];
  if (input.status) { patch.status = input.status as never; lines.push(`status → ${input.status}`); }
  if (input.environment) { patch.environment = input.environment; lines.push(`environment → ${input.environment}`); }
  if (input.criticality) { patch.criticality = input.criticality; lines.push(`criticality → ${input.criticality}`); }
  if (input.ownerTeam) { const team = (await resolveTeam(ctx, input.ownerTeam))!; patch.ownerTeamId = team.id; lines.push(`owner team → ${team.name}`); }
  if (input.hostname !== undefined) { patch.hostname = input.hostname; lines.push(`hostname → ${input.hostname}`); }
  if (input.ipAddress !== undefined) { patch.ipAddress = input.ipAddress; lines.push(`IP address → ${input.ipAddress}`); }
  if (input.description !== undefined) { patch.description = input.description; lines.push('description replaced'); }
  if (input.tags) { patch.tags = input.tags; lines.push(`tags → ${input.tags.join(', ')}`); }
  return { patch, lines };
}
