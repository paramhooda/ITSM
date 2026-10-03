import { z } from 'zod';
import { listCustomers, customerOverview } from '@/modules/customers/service';
import { listSites } from '@/modules/customers/sites';
import { listContacts, escalationContacts } from '@/modules/customers/contacts';
import { define } from './types';
import { ticketLink, iso, resolveCustomerId, customerName } from '../helpers';

/** Customer tools (staff only: customer users have no customer directory). */

const pick = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => row[k] !== undefined).map((k) => [k, row[k]]));

export const CUSTOMERS: ReturnType<typeof define>[] = [
  define({
    name: 'list_customers',
    toolset: 'customers',
    description: 'Customers visible to the user with open ticket and active contract counts. Supports a name/code search.',
    inputSchema: z.object({ q: z.string().max(200).optional(), limit: z.number().int().min(1).max(20).optional() }),
    requires: ['customers:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const res = await listCustomers(ctx, { page: 1, pageSize: input.limit ?? 20, q: input.q, sort: 'name', order: 'asc' });
      return { total: res.total, facts: [`${res.total} customer(s) visible${input.q ? ` matching "${input.q}"` : ''}`], items: res.items.map((c) => ({ id: c.id, code: c.code, name: c.name, status: 'statusLabel' in c ? c.statusLabel : null, openTickets: 'openTickets' in c ? c.openTickets : null, activeContracts: 'activeContracts' in c ? c.activeContracts : null, accountManager: 'accountManagerName' in c ? c.accountManagerName : null, link: `/customers/${c.id}` })) };
    },
    summary: (_i, result) => `Listed ${(result as { items: unknown[] }).items.length} customers`,
  }),

  define({
    name: 'get_customer',
    toolset: 'customers',
    description: 'Customer overview: open tickets by priority, recent tickets, contracts with expiry, entitlement usage, 30-day SLA compliance and upcoming visits / maintenance.',
    inputSchema: z.object({ customer: z.string().max(200).describe('Customer name, code or id') }),
    requires: ['customers:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const id = (await resolveCustomerId(ctx, input.customer, true))!;
      const o = await customerOverview(ctx, id);
      return {
        customer: { ...o.customer, link: `/customers/${id}` },
        counts: o.counts,
        ticketsByStatusCategory: o.ticketsByStatusCategory,
        openByPriority: o.ticketsByPriority.map((p) => ({ priority: p.label, count: p.count })),
        recentTickets: (o.recentTickets as { id: string; number: string; title: string; statusLabel: string; priorityLabel: string | null; createdAt: string }[]).slice(0, 8).map((t) => ({ number: t.number, title: t.title, status: t.statusLabel, priority: t.priorityLabel, createdAt: iso(t.createdAt), link: ticketLink(ctx, t.id) })),
        contracts: o.contracts.map((c) => ({ number: c.number, name: c.name, status: c.status, type: c.typeLabel, startDate: c.startDate, endDate: c.endDate, daysToExpiry: c.daysToExpiry, link: `/contracts/${c.id}` })),
        entitlements: o.entitlements.map((e) => ({ name: e.name, unit: e.unit, contract: e.contractNumber, period: e.utilization.period, quantity: e.utilization.quantity, used: e.utilization.used, remaining: e.utilization.remaining, pct: e.utilization.pct, overThreshold: e.utilization.overThreshold, exhausted: e.utilization.exhausted })),
        sla30d: o.sla30d,
        upcomingVisits: o.upcomingVisits.map((v) => ({ number: v.number, title: v.title, status: v.status, scheduledStart: iso(v.scheduledStart), engineer: v.engineerName, site: v.siteName })),
        upcomingPm: o.upcomingPm.map((p) => ({ program: p.programName, plannedDate: p.plannedDate, scheduledDate: p.scheduledDate, status: p.status, site: p.siteName })),
      };
    },
    summary: (input) => `Read customer overview for ${input.customer}`,
  }),

  define({
    name: 'customer_sites_contacts',
    toolset: 'customers',
    description: 'Sites and contacts of a customer, including the escalation contacts.',
    inputSchema: z.object({ customer: z.string().max(200), includeInactive: z.boolean().optional() }),
    requires: ['customers:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const id = (await resolveCustomerId(ctx, input.customer, true))!;
      const name = await customerName(ctx, id);
      const [sites, contacts, escalation] = await Promise.all([listSites(ctx, id, !!input.includeInactive), listContacts(ctx, id, !!input.includeInactive), escalationContacts(ctx, id)]);
      return {
        customer: name,
        link: `/customers/${id}`,
        sites: (sites as unknown as Record<string, unknown>[]).slice(0, 40).map((s) => pick(s, ['id', 'code', 'name', 'isPrimary', 'isActive', 'city', 'country', 'timezone', 'address'])),
        contacts: (contacts as unknown as Record<string, unknown>[]).slice(0, 40).map((c) => pick(c, ['id', 'name', 'title', 'email', 'phone', 'mobile', 'isPrimary', 'isActive', 'siteName', 'role'])),
        escalation: (escalation as unknown as Record<string, unknown>[]).slice(0, 12).map((c) => pick(c, ['level', 'name', 'title', 'email', 'phone', 'mobile', 'contactName', 'userName'])),
      };
    },
    summary: (input, result) => `Read ${(result as { sites: unknown[] }).sites.length} sites and ${(result as { contacts: unknown[] }).contacts.length} contacts of ${input.customer}`,
  }),
];
