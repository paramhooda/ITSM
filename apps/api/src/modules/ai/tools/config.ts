import { z } from 'zod';
import { sql, asc } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { listOptions, listConfig, listSettings, getPriorityMatrix, optionsByIds, CONFIG_TABLES } from '@/modules/config/service';
import { teamDirectory } from '@/modules/iam/service';
import { listServices } from '@/modules/services/service';
import { listItems as listCatalogItems } from '@/modules/catalog/service';
import { portalCatalog } from '@/modules/portal/service';
import { customerScope } from '@/modules/contracts/scope';
import { define } from './types';
import { isCustomerUser, resolveCustomerId } from '../helpers';

/**
 * Configuration lookups: the real option lists, teams, services, catalog
 * items, priority matrix, rules and non-secret settings, so the assistant
 * names real values and never guesses keys.
 */

/** Settings that never leave the API through the assistant, whatever the user's role. */
export const SECRET_SETTING_KEY = /(password|secret|token|api[_-]?key|private[_-]?key|credential|signing|webhook_verify)/i;
export const HIDDEN_SETTING_PREFIXES = ['security.', 'smtp.'];
export const settingVisible = (key: string) => !HIDDEN_SETTING_PREFIXES.some((p) => key.startsWith(p)) && !SECRET_SETTING_KEY.test(key);

export const RULE_KINDS = { assignment: 'assignment-rules', escalation: 'escalation-rules', notification: 'notification-rules', approval: 'approval-workflows', template: 'notification-templates' } as const;
export type RuleKind = keyof typeof RULE_KINDS;

const stripTimestamps = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([k]) => !['createdAt', 'updatedAt', 'createdBy', 'updatedBy'].includes(k)));

export const CONFIG: ReturnType<typeof define>[] = [
  define({
    name: 'list_options',
    toolset: 'config',
    description: 'Option lists (ticket_priority, ticket_status, ticket_category, ticket_subcategory, ticket_impact, ticket_urgency, asset_status, asset_category, field_visit_type, contract_type, entitlement_type…) with their keys and labels. Without a type: every list with its size.',
    inputSchema: z.object({ type: z.string().max(60).optional(), includeInactive: z.boolean().optional() }),
    requires: [],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      if (!input.type) {
        const rows = await ctx.tx.select({ type: schema.configOptions.type, count: sql<number>`count(*)::int` }).from(schema.configOptions).groupBy(schema.configOptions.type).orderBy(asc(schema.configOptions.type));
        return { types: rows };
      }
      const rows = await listOptions(ctx, input.type, !!input.includeInactive);
      const byId = new Map(rows.map((o) => [o.id, o.key]));
      return { type: input.type, items: rows.slice(0, 100).map((o) => ({ key: o.key, label: o.label, isActive: o.isActive, ...(o.statusCategory ? { statusCategory: o.statusCategory } : {}), ...(o.parentId ? { parent: byId.get(o.parentId) ?? null } : {}), ...(o.description ? { description: o.description } : {}) })), link: '/admin/options' };
    },
    summary: (input, result) => (input.type ? `Listed ${(result as { items: unknown[] }).items.length} ${input.type.replace(/_/g, ' ')} options` : `Listed ${(result as { types: unknown[] }).types.length} option lists`),
  }),

  define({
    name: 'list_teams',
    toolset: 'config',
    description: 'Teams with their managers, members and open workload.',
    inputSchema: z.object({ q: z.string().max(100).optional() }),
    requires: [],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const res = (await teamDirectory(ctx)) as unknown as { teams: Record<string, unknown>[]; totals: Record<string, unknown> };
      const r = input.q?.toLowerCase();
      const teams = res.teams.filter((t) => !r || String(t.name).toLowerCase().includes(r) || String(t.key).toLowerCase().includes(r));
      return {
        totals: res.totals,
        facts: [`${teams.length} active team(s)`],
        teams: teams.slice(0, 30).map((t) => ({ key: t.key, name: t.name, type: t.teamType ?? null, manager: t.managerName ?? null, members: Array.isArray(t.members) ? (t.members as Record<string, unknown>[]).slice(0, 25).map((m) => ({ name: m.name, title: m.title ?? null, lead: !!m.isLead })) : [], open: t.open ?? null, unassigned: t.unassigned ?? null, breached: t.breached ?? null })),
        link: '/teams',
      };
    },
    summary: (_i, result) => `Listed ${(result as { teams: unknown[] }).teams.length} teams`,
  }),

  define({
    name: 'list_services',
    toolset: 'contracts',
    description: 'The service catalog (services the provider delivers): key, name, domain, category, default team and SLA policy, subscribed customers. Portal users see the services covered by their contracts.',
    inputSchema: z.object({ q: z.string().max(200).optional(), domain: z.enum(['noc', 'soc', 'amc', 'service_desk', 'field', 'other']).optional(), customer: z.string().max(200).optional() }),
    requires: ['services:read'],
    portal: ['portal:contracts'],
    action: false,
    run: async (ctx, input) => {
      if (isCustomerUser(ctx)) {
        const cid = (await resolveCustomerId(ctx, undefined, true))!;
        const cs = await customerScope(ctx, cid);
        const seen = new Map<string, { name: string; domain: string; slaPolicy: string | null; contract: string }>();
        for (const c of cs) for (const s of c.services) if (!seen.has(s.serviceId)) seen.set(s.serviceId, { name: s.serviceName, domain: s.domain, slaPolicy: s.effectiveSlaPolicyName, contract: c.contract.number });
        const items = [...seen.values()].filter((s) => !input.q || s.name.toLowerCase().includes(input.q.toLowerCase()));
        return { facts: [`${items.length} service(s) covered by your contracts`], items, link: '/portal/services' };
      }
      const customerId = await resolveCustomerId(ctx, input.customer);
      const res = await listServices(ctx, { q: input.q, domain: input.domain, customerId, includeInactive: 'false' } as never);
      const items = res.items as unknown as Record<string, unknown>[];
      return { total: res.total, facts: [`${res.total} active service(s)${input.domain ? ` in ${input.domain}` : ''}`], items: items.slice(0, 40).map((s) => ({ key: s.key, name: s.name, domain: s.domain, category: s.categoryLabel ?? null, subcategory: s.subcategoryLabel ?? null, defaultTeam: s.defaultTeamName ?? null, defaultSlaPolicy: s.defaultSlaPolicyName ?? null, owner: s.ownerName ?? null, counts: s.counts ?? null, link: `/services/${s.id}` })) };
    },
    summary: (_i, result) => `Listed ${(result as { items: unknown[] }).items.length} services`,
  }),

  define({
    name: 'list_catalog_items',
    toolset: 'tickets',
    description: 'Request catalog items (what can be requested): name, category, service, form fields, approval and default priority.',
    inputSchema: z.object({ q: z.string().max(200).optional(), customer: z.string().max(200).optional() }),
    requires: ['tickets:create'],
    portal: ['portal:tickets'],
    action: false,
    run: async (ctx, input) => {
      if (isCustomerUser(ctx)) {
        const res = await portalCatalog(ctx);
        const items = res.items.filter((i) => !input.q || i.name.toLowerCase().includes(input.q.toLowerCase()));
        return { items: items.slice(0, 40).map((i) => ({ id: i.id, key: i.key, name: i.name, description: i.description, category: i.categoryLabel, service: i.serviceName, requiresApproval: i.requiresApproval, defaultPriority: i.defaultPriorityLabel, fields: ((i.formSchema ?? []) as { key: string; label?: string; type?: string; required?: boolean }[]).map((f) => ({ key: f.key, label: f.label ?? f.key, type: f.type ?? 'text', required: !!f.required })) })), link: '/portal/tickets/new' };
      }
      const customerId = await resolveCustomerId(ctx, input.customer);
      const res = await listCatalogItems(ctx, { q: input.q, customerId, active: true });
      const items = res.items as unknown as Record<string, unknown>[];
      return { items: items.slice(0, 40).map((i) => ({ id: i.id, key: i.key, name: i.name, description: i.description, category: i.categoryLabel ?? null, service: i.serviceName ?? null, requiresApproval: !!i.approvalWorkflowId, defaultPriority: i.defaultPriorityLabel ?? null, portalVisible: i.portalVisible, fields: ((i.formSchema ?? []) as { key: string; label?: string; type?: string; required?: boolean }[]).map((f) => ({ key: f.key, label: f.label ?? f.key, type: f.type ?? 'text', required: !!f.required })) })), link: '/admin/catalog' };
    },
    summary: (_i, result) => `Listed ${(result as { items: unknown[] }).items.length} catalog items`,
  }),

  define({
    name: 'priority_matrix',
    toolset: 'config',
    description: 'The impact × urgency → priority matrix.',
    inputSchema: z.object({}),
    requires: ['admin:config'],
    portal: null,
    action: false,
    run: async (ctx) => {
      const cells = await getPriorityMatrix(ctx);
      const opts = await optionsByIds(ctx, cells.flatMap((c) => [c.impactId, c.urgencyId, c.priorityId]));
      const label = (id: string) => opts.get(id)?.label ?? id;
      return { cells: cells.map((c) => ({ impact: label(c.impactId), urgency: label(c.urgencyId), priority: label(c.priorityId) })), link: '/admin/priority-matrix' };
    },
    summary: (_i, result) => `Read the priority matrix (${(result as { cells: unknown[] }).cells.length} cells)`,
  }),

  define({
    name: 'list_rules',
    toolset: 'config',
    description: 'Automation configuration: assignment rules, escalation rules, notification rules, approval workflows or notification templates, with their conditions and active state.',
    inputSchema: z.object({ kind: z.enum(['assignment', 'escalation', 'notification', 'approval', 'template']), q: z.string().max(100).optional() }),
    requires: ['admin:config'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const rows = (await listConfig(ctx, RULE_KINDS[input.kind])) as unknown as Record<string, unknown>[];
      const r = input.q?.toLowerCase();
      const items = rows.filter((x) => !r || String(x.name ?? x.event ?? '').toLowerCase().includes(r)).slice(0, 40).map(stripTimestamps);
      const page = { assignment: '/admin/assignment-rules', escalation: '/admin/escalation-rules', notification: '/admin/notifications/rules', approval: '/admin/approvals', template: '/admin/notifications/templates' }[input.kind];
      return { kind: input.kind, total: rows.length, items, link: page };
    },
    summary: (input, result) => `Listed ${(result as { items: unknown[] }).items.length} ${input.kind} ${input.kind === 'template' ? 'templates' : input.kind === 'approval' ? 'workflows' : 'rules'}`,
  }),

  define({
    name: 'get_settings',
    toolset: 'config',
    description: 'Platform settings by prefix (platform., tickets., contracts., entitlements., portal., notifications., ai., whatsapp.). Secrets, security and mail-server settings are never returned.',
    inputSchema: z.object({ prefix: z.string().max(60).optional() }),
    requires: [],
    anyOf: ['admin:system', 'admin:config'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const rows = await listSettings(ctx);
      const prefix = input.prefix?.trim();
      const items = rows.filter((s) => settingVisible(s.key) && s.value !== '********' && (!prefix || s.key.startsWith(prefix))).slice(0, 80);
      return { settings: Object.fromEntries(items.map((s) => [s.key, s.value])), link: '/admin/settings' };
    },
    summary: (input, result) => `Read ${Object.keys((result as { settings: Record<string, unknown> }).settings).length} settings${input.prefix ? ` under ${input.prefix}` : ''}`,
  }),
];

export const configKinds = () => Object.keys(CONFIG_TABLES);
export type { Ctx };
