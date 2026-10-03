import { z } from 'zod';
import { eq, and, asc, gte, lte } from 'drizzle-orm';
import type { TicketType } from '@itsm/shared';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ValidationError } from '@/core/errors';
import { listContracts, getContract } from '@/modules/contracts/service';
import { customerEntitlements, recordConsumption } from '@/modules/contracts/entitlements';
import { customerScope } from '@/modules/contracts/scope';
import { slaCompliance, listPolicies, type ComplianceGroupBy } from '@/modules/sla/policies';
import { define } from './types';
import { ticketRef } from './core';
import { isCustomerUser, period, resolveCustomerId, resolveContract, resolveTicket, customerName, forCustomer } from '../helpers';

/** Contract tools: contracts, entitlements, scope, service levels and compliance (customer users see their own organisation only). */

interface ContractDetail {
  id: string;
  number: string;
  name: string;
  status: string;
  typeLabel: string | null;
  customerName: string | null;
  customer: { accountManagerName: string | null } | null;
  ownerName: string | null;
  startDate: string;
  endDate: string;
  renewalDate: string | null;
  daysToExpiry: number;
  autoRenew: boolean;
  slaPolicyName: string | null;
  supportHoursCalendarName: string | null;
  responseCommitment: string | null;
  resolutionCommitment: string | null;
  services: { serviceName: string; domain: string; effectiveSlaPolicyName: string | null; teamName: string | null }[];
  sites: { name: string }[];
  allSites: boolean;
  entitlements: { name: string; unit: string; period: string; utilization?: { quantity: number; used: number; remaining: number; pct: number } }[];
  scopeItems: { name: string; classification: string }[];
  escalationMatrix: Record<string, unknown>[];
  documents: { signedAgreement: boolean; sow: boolean; count: number };
}

async function entitlementByName(ctx: Ctx, customerId: string, ref: string) {
  const ents = await customerEntitlements(ctx, customerId);
  const r = ref.trim().toLowerCase();
  const hits = ents.filter((e) => e.id === ref || e.name.toLowerCase() === r);
  const pick = hits.length ? hits : ents.filter((e) => e.name.toLowerCase().includes(r) || (e.typeLabel ?? '').toLowerCase().includes(r));
  if (pick.length === 1) return pick[0]!;
  if (!pick.length) throw new ValidationError(`No entitlement matching "${ref}" for this customer. Available: ${ents.map((e) => `${e.name} (${e.contractNumber})`).join(', ') || 'none'}`);
  throw new ValidationError(`Entitlement "${ref}" is ambiguous: ${pick.map((e) => `${e.name} (${e.contractNumber})`).join(', ')}`);
}

export const CONTRACTS: ReturnType<typeof define>[] = [
  define({
    name: 'list_contracts',
    toolset: 'contracts',
    description: 'Contracts with status, dates and days to expiry. Filter by customer, status, or contracts expiring within N days.',
    inputSchema: z.object({ customer: z.string().max(200).optional(), status: z.enum(['draft', 'active', 'expiring', 'expired', 'terminated', 'renewed', 'suspended']).optional(), expiringWithinDays: z.number().int().min(0).max(3650).optional(), q: z.string().max(200).optional(), limit: z.number().int().min(1).max(50).optional() }),
    requires: ['contracts:read'],
    portal: ['portal:contracts'],
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      if (isCustomerUser(ctx)) {
        ctx.requireCustomer(customerId);
        const today = new Date().toISOString().slice(0, 10);
        const conds = [eq(schema.contracts.customerId, customerId!)];
        if (input.status) conds.push(eq(schema.contracts.status, input.status));
        if (input.expiringWithinDays !== undefined) conds.push(gte(schema.contracts.endDate, today), lte(schema.contracts.endDate, new Date(Date.now() + input.expiringWithinDays * 86_400_000).toISOString().slice(0, 10)));
        const rows = await ctx.tx.select({ id: schema.contracts.id, number: schema.contracts.number, name: schema.contracts.name, status: schema.contracts.status, startDate: schema.contracts.startDate, endDate: schema.contracts.endDate, renewalDate: schema.contracts.renewalDate, responseCommitment: schema.contracts.responseCommitment, resolutionCommitment: schema.contracts.resolutionCommitment }).from(schema.contracts).where(and(...conds)).orderBy(asc(schema.contracts.endDate)).limit(input.limit ?? 20);
        return { total: rows.length, facts: [`${rows.length} contract(s)`], items: rows.map((c) => ({ ...c, daysToExpiry: Math.round((new Date(c.endDate).getTime() - Date.now()) / 86_400_000), link: '/portal/services/contracts' })) };
      }
      const res = await listContracts(ctx, { page: 1, pageSize: input.limit ?? 20, sort: 'endDate', order: 'asc', customerId, status: input.status ? [input.status] : undefined, expiringWithinDays: input.expiringWithinDays, q: input.q });
      return {
        total: res.total,
        facts: [`${res.total} contract(s)${input.status ? ` with status ${input.status}` : ''}${input.expiringWithinDays !== undefined ? ` expiring within ${input.expiringWithinDays} days` : ''}${await forCustomer(ctx, customerId)}`],
        items: res.items.map((c) => ({ id: c.id, number: c.number, name: c.name, customer: c.customerName, status: c.status, type: c.typeLabel, startDate: c.startDate, endDate: c.endDate, renewalDate: c.renewalDate, daysToExpiry: c.daysToExpiry, autoRenew: c.autoRenew, services: c.serviceNames, entitlements: c.entitlements, link: `/contracts/${c.id}` })),
      };
    },
    summary: (input, result) => `Listed ${(result as { items: unknown[] }).items.length} contracts${input.expiringWithinDays !== undefined ? ` expiring within ${input.expiringWithinDays} days` : ''}`,
  }),

  define({
    name: 'get_contract',
    toolset: 'contracts',
    description: 'One contract in full: dates, service levels, covered services and sites, entitlements with usage, scope items, and (staff) owner, escalation matrix and documents.',
    inputSchema: z.object({ contract: z.string().max(80).describe('Contract number (e.g. CON-2026-0001) or id') }),
    requires: ['contracts:read'],
    portal: ['portal:contracts'],
    action: false,
    run: async (ctx, input) => {
      const c = await resolveContract(ctx, input.contract);
      const d = (await getContract(ctx, c.id)) as unknown as ContractDetail;
      const portal = isCustomerUser(ctx);
      return {
        number: d.number,
        name: d.name,
        customer: d.customerName,
        status: d.status,
        type: d.typeLabel,
        startDate: d.startDate,
        endDate: d.endDate,
        renewalDate: d.renewalDate,
        daysToExpiry: d.daysToExpiry,
        autoRenew: d.autoRenew,
        slaPolicy: d.slaPolicyName,
        supportHours: d.supportHoursCalendarName,
        responseCommitment: d.responseCommitment,
        resolutionCommitment: d.resolutionCommitment,
        services: d.services.map((s) => ({ name: s.serviceName, domain: s.domain, slaPolicy: s.effectiveSlaPolicyName, ...(portal ? {} : { team: s.teamName }) })),
        sites: d.allSites ? 'all sites of the customer' : d.sites.map((s) => s.name),
        entitlements: d.entitlements.map((e) => ({ name: e.name, unit: e.unit, period: e.period, quantity: e.utilization?.quantity ?? null, used: e.utilization?.used ?? null, remaining: e.utilization?.remaining ?? null, pct: e.utilization?.pct ?? null })),
        scope: d.scopeItems.slice(0, 40).map((i) => ({ name: i.name, classification: i.classification })),
        ...(portal
          ? {}
          : {
              owner: d.ownerName,
              accountManager: d.customer?.accountManagerName ?? null,
              escalationMatrix: d.escalationMatrix.slice(0, 8).map((m) => ({ level: m.level ?? null, contact: m.contactName ?? null, user: m.userName ?? null })),
              documents: { signedAgreement: d.documents.signedAgreement, sow: d.documents.sow, count: d.documents.count },
            }),
        link: portal ? '/portal/services/contracts' : `/contracts/${d.id}`,
      };
    },
    summary: (input, result) => `Read contract ${(result as { number: string }).number ?? input.contract}`,
  }),

  define({
    name: 'entitlement_usage',
    toolset: 'contracts',
    description: 'Entitlement consumption for a customer (AMC visits, support hours, incident quotas): quantity, used, remaining, percentage and the current period.',
    inputSchema: z.object({ customer: z.string().max(200).optional().describe('Customer name, code or id (ignored for portal users)') }),
    requires: ['contracts:read'],
    portal: ['portal:contracts'],
    action: false,
    run: async (ctx, input) => {
      const id = (await resolveCustomerId(ctx, input.customer, true))!;
      const ents = await customerEntitlements(ctx, id);
      const scope = await forCustomer(ctx, id);
      return { customerId: id, customer: scope.replace(/^ for /, ''), facts: [`${ents.length} entitlement(s)${scope}${ents.filter((e) => e.utilization.exhausted).length ? `, ${ents.filter((e) => e.utilization.exhausted).length} exhausted` : ''}`], items: ents.map((e) => ({ name: e.name, type: e.typeLabel, service: e.serviceName, unit: e.unit, contract: e.contractNumber, period: e.utilization.period, periodStart: e.utilization.periodStart, periodEnd: e.utilization.periodEnd, quantity: e.utilization.quantity, used: e.utilization.used, remaining: e.utilization.remaining, pct: e.utilization.pct, overThreshold: e.utilization.overThreshold, exhausted: e.utilization.exhausted })) };
    },
    summary: (_i, result) => `Read ${(result as { items: unknown[] }).items.length} entitlements for ${(result as { customer: string }).customer}`,
  }),

  define({
    name: 'customer_scope',
    toolset: 'contracts',
    description: 'What is covered for a customer: each live contract with its services (effective SLA policy and team), covered sites and the in-scope / out-of-scope items.',
    inputSchema: z.object({ customer: z.string().max(200).optional() }),
    requires: ['contracts:read'],
    portal: ['portal:contracts'],
    action: false,
    run: async (ctx, input) => {
      const id = (await resolveCustomerId(ctx, input.customer, true))!;
      const portal = isCustomerUser(ctx);
      const cs = await customerScope(ctx, id);
      return {
        customer: await customerName(ctx, id),
        contracts: cs.map((c) => ({
          number: c.contract.number,
          name: c.contract.name,
          status: c.contract.status,
          endDate: c.contract.endDate,
          slaPolicy: c.contract.slaPolicyName,
          services: c.services.map((s) => ({ name: s.serviceName, domain: s.domain, slaPolicy: s.effectiveSlaPolicyName, ...(portal ? {} : { team: s.teamName }) })),
          sites: c.sites.map((s) => s.name),
          scope: (c.groups as unknown[]).slice(0, 8),
        })),
      };
    },
    summary: (input, result) => `Read the scope of ${(result as { customer: string }).customer ?? input.customer} (${(result as { contracts: unknown[] }).contracts.length} contracts)`,
  }),

  define({
    name: 'sla_compliance',
    toolset: 'contracts',
    description: 'SLA compliance figures (met/breached/running, compliance %) for a period, grouped by metric, priority, customer, service, policy or ticket type.',
    inputSchema: z.object({ customer: z.string().max(200).optional(), days: z.number().int().min(1).max(365).optional().describe('Look-back window in days (default 30)'), groupBy: z.enum(['metric', 'priority', 'customer', 'service', 'policy', 'ticketType']).optional(), ticketType: z.enum(['incident', 'request', 'problem', 'change']).optional() }),
    requires: ['tickets:read'],
    portal: ['portal:access'],
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      const days = input.days ?? 30;
      const res = await slaCompliance(ctx, { customerId, from: period(days).toISOString(), groupBy: (input.groupBy ?? 'metric') as ComplianceGroupBy, ticketType: input.ticketType as TicketType | undefined });
      const t = res.totals as { met?: number; breached?: number; running?: number; compliancePct?: number | null };
      return { days, groupBy: res.groupBy, totals: res.totals, facts: [`SLA compliance over ${days} days: ${t.met ?? 0} met, ${t.breached ?? 0} breached, ${t.running ?? 0} still running${t.compliancePct !== undefined && t.compliancePct !== null ? ` (${t.compliancePct}% compliant)` : ''}`], groups: res.groups.slice(0, 40).map((g) => ({ label: g.label, met: g.met, breached: g.breached, running: g.running, compliancePct: g.compliancePct, avgElapsedMinutes: g.avgElapsedMinutes })) };
    },
    summary: (input) => `Computed SLA compliance (${input.days ?? 30} days, by ${input.groupBy ?? 'metric'})`,
  }),

  define({
    name: 'sla_policy',
    toolset: 'contracts',
    description: 'SLA policies and their targets (response and resolution minutes per priority, calendar, pause statuses, where they are used). Portal users see the policies that apply to their contracts.',
    inputSchema: z.object({ name: z.string().max(200).optional().describe('Policy name to narrow to') }),
    requires: ['contracts:read'],
    portal: ['portal:contracts'],
    action: false,
    run: async (ctx, input) => {
      const all = (await listPolicies(ctx)).items;
      let items = all;
      if (isCustomerUser(ctx)) {
        const cs = await customerScope(ctx, (await resolveCustomerId(ctx, undefined, true))!);
        const ids = new Set(cs.flatMap((c) => [c.contract.slaPolicyId, ...c.services.map((s) => s.effectiveSlaPolicyId)]).filter((x): x is string => !!x));
        items = all.filter((p) => ids.has(p.id) || (ids.size === 0 && p.isDefault));
      }
      if (input.name) {
        const r = input.name.toLowerCase();
        items = items.filter((p) => p.name.toLowerCase().includes(r));
      }
      return {
        items: items.slice(0, 20).map((p) => ({
          name: p.name,
          description: p.description,
          isDefault: p.isDefault,
          isActive: p.isActive,
          calendar: p.calendarName ?? (p.calendarIs24x7 ? '24x7' : null),
          timezone: p.calendarTimezone ?? null,
          targets: p.targetSummary.map((t) => ({ priority: t.priorityLabel, responseMinutes: t.response, resolutionMinutes: t.resolution })),
          pauseStatuses: p.pauseStatuses.map((s) => s.label),
          ...(isCustomerUser(ctx) ? {} : { usage: p.usage, link: `/admin/sla/${p.id}` }),
        })),
      };
    },
    summary: (_i, result) => `Read ${(result as { items: unknown[] }).items.length} SLA polic${(result as { items: unknown[] }).items.length === 1 ? 'y' : 'ies'}`,
  }),

  define({
    name: 'record_consumption',
    toolset: 'contracts',
    description: 'Record consumption against a customer entitlement (e.g. one AMC visit, 2 support hours), optionally tied to a ticket.',
    inputSchema: z.object({ customer: z.string().max(200), entitlement: z.string().max(200).describe('Entitlement name (e.g. "AMC visits")'), quantity: z.number().positive().max(100000), notes: z.string().max(1000).optional(), ticket: ticketRef.optional() }),
    requires: ['contracts:manage'],
    portal: null,
    action: true,
    invalidates: ['contracts'],
    run: async (ctx, input) => {
      const customerId = (await resolveCustomerId(ctx, input.customer, true))!;
      const e = await entitlementByName(ctx, customerId, input.entitlement);
      const t = input.ticket ? await resolveTicket(ctx, input.ticket) : null;
      await recordConsumption(ctx, e.id, { quantity: input.quantity, notes: input.notes ?? null, ticketId: t?.id ?? null, sourceType: 'manual' });
      const after = (await customerEntitlements(ctx, customerId)).find((x) => x.id === e.id);
      return { entitlement: e.name, contract: e.contractNumber, recorded: input.quantity, unit: e.unit, used: after?.utilization.used ?? null, remaining: after?.utilization.remaining ?? null, link: `/customers/${customerId}` };
    },
    summary: (input, result) => `Recorded ${input.quantity} ${(result as { unit: string }).unit ?? ''} against ${(result as { entitlement: string }).entitlement ?? input.entitlement}`,
    preview: async (ctx, input) => {
      const customerId = (await resolveCustomerId(ctx, input.customer, true))!;
      const name = await customerName(ctx, customerId);
      const e = await entitlementByName(ctx, customerId, input.entitlement);
      const t = input.ticket ? await resolveTicket(ctx, input.ticket) : null;
      return `Record ${input.quantity} ${e.unit} against "${e.name}" (${e.contractNumber}) for ${name}${t ? `, linked to ${t.number}` : ''}; currently ${e.utilization.used} of ${e.utilization.quantity} used, ${e.utilization.remaining} remaining`;
    },
  }),
];
