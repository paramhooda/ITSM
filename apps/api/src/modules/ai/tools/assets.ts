import { z } from 'zod';
import { ASSET_LIFECYCLE } from '@itsm/shared';
import { listAssetsMin, expiringAssets, getAsset, assetSummary, changeLifecycle, allowedLifecycleTransitions } from '@/modules/assets/service';
import { portalAssets, portalAssetsOverview } from '@/modules/portal/service';
import { define } from './types';
import { isCustomerUser, ticketLink, iso, resolveCustomerId, resolveAsset, forCustomer } from '../helpers';

/** Asset tools: inventory, coverage (warranty, AMC) and lifecycle. */

const assetLink = (ctx: Parameters<typeof isCustomerUser>[0], id: string) => (isCustomerUser(ctx) ? '/portal/assets/inventory' : `/assets/${id}`);
const assetRef = z.string().max(200).describe('Asset tag, serial number, name or id');

export const ASSETS: ReturnType<typeof define>[] = [
  define({
    name: 'list_assets',
    toolset: 'assets',
    description: 'Assets by customer / search text, or assets whose warranty or AMC expires within N days.',
    inputSchema: z.object({ customer: z.string().max(200).optional(), q: z.string().max(200).optional(), expiring: z.enum(['warranty', 'amc']).optional(), expiringWithinDays: z.number().int().min(0).max(3650).optional(), limit: z.number().int().min(1).max(30).optional() }),
    requires: ['assets:read'],
    portal: ['portal:assets'],
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      if (isCustomerUser(ctx)) {
        const res = await portalAssets(ctx, { page: 1, pageSize: input.limit ?? 20, q: input.q, ...(input.expiring === 'warranty' ? { warrantyExpiringDays: input.expiringWithinDays ?? 90 } : input.expiring === 'amc' ? { amcExpiringDays: input.expiringWithinDays ?? 90 } : {}) } as never);
        const items = res.items as unknown as { id: string; tag: string; name: string; siteName?: string | null; model?: string | null; serialNumber?: string | null; warrantyEnd?: string | null; amcEnd?: string | null; lifecycleStage?: string }[];
        return { total: res.total, facts: [`${res.total} asset(s)${input.q ? ` matching "${input.q}"` : ''}${input.expiring ? ` with ${input.expiring} expiring within ${input.expiringWithinDays ?? 90} days` : ''}`], items: items.map((a) => ({ tag: a.tag, name: a.name, site: a.siteName ?? null, model: a.model ?? null, serialNumber: a.serialNumber ?? null, warrantyEnd: a.warrantyEnd ?? null, amcEnd: a.amcEnd ?? null, lifecycle: a.lifecycleStage ?? null, link: '/portal/assets/inventory' })) };
      }
      if (input.expiring) {
        const res = await expiringAssets(ctx, { days: input.expiringWithinDays ?? 90, kind: input.expiring, customerId, limit: input.limit ?? 20 });
        return { kind: res.kind, days: res.days, facts: [`${res.items.length} asset(s) with ${res.kind} expiring within ${res.days} days${await forCustomer(ctx, customerId)}`], items: res.items.map((a) => ({ tag: a.tag, name: a.name, customer: a.customerName, site: a.siteName, model: a.model, serialNumber: a.serialNumber, warrantyEnd: a.warrantyEnd, amcEnd: a.amcEnd, lifecycle: a.lifecycleStage, coverage: a.coverage.status, link: `/assets/${a.id}` })) };
      }
      const res = await listAssetsMin(ctx, { page: 1, pageSize: input.limit ?? 20, q: input.q, customerId } as never);
      return { total: res.total, facts: [`${res.total} asset(s)${input.q ? ` matching "${input.q}"` : ''}${await forCustomer(ctx, customerId)}`], items: res.items.map((a) => ({ tag: a.tag, name: a.name, serialNumber: a.serialNumber, link: `/assets/${a.id}` })) };
    },
    summary: (input, result) => `Listed ${(result as { items: unknown[] }).items.length} assets${input.expiring ? ` with ${input.expiring} expiring` : ''}`,
  }),

  define({
    name: 'get_asset',
    toolset: 'assets',
    description: 'One asset by tag, serial number or name: model, location, lifecycle, warranty and AMC coverage, linked CI and contract, open tickets.',
    inputSchema: z.object({ asset: assetRef, customer: z.string().max(200).optional() }),
    requires: ['assets:read'],
    portal: ['portal:assets'],
    action: false,
    run: async (ctx, input) => {
      const hit = await resolveAsset(ctx, input.asset, await resolveCustomerId(ctx, input.customer));
      const a = (await getAsset(ctx, hit.id)) as unknown as Record<string, unknown> & { id: string; tag: string; name: string; warranty: { status: string }; amc: { status: string }; eol: { status: string }; ci: { name: string; hostname: string | null; status: string } | null; amcContract: { number: string; endDate: string; status: string } | null; openTickets: { id: string; number: string; title: string; status: string }[] };
      const portal = isCustomerUser(ctx);
      return {
        tag: a.tag,
        name: a.name,
        customer: a.customerName ?? null,
        site: a.siteName ?? null,
        category: a.categoryLabel ?? null,
        status: a.statusLabel ?? null,
        lifecycle: a.lifecycleStage ?? null,
        manufacturer: a.manufacturer ?? null,
        model: a.model ?? null,
        serialNumber: a.serialNumber ?? null,
        location: a.location ?? null,
        purchaseDate: a.purchaseDate ?? null,
        warranty: { end: a.warrantyEnd ?? null, provider: a.warrantyProvider ?? null, status: a.warranty.status },
        amc: { end: a.amcEnd ?? null, status: a.amc.status, contract: a.amcContract ? { number: a.amcContract.number, endDate: a.amcContract.endDate, status: a.amcContract.status } : null },
        endOfLife: { date: a.eolDate ?? null, status: a.eol.status },
        ci: a.ci ? { name: a.ci.name, hostname: a.ci.hostname, status: a.ci.status } : null,
        openTickets: a.openTickets.slice(0, 10).map((t) => ({ number: t.number, title: t.title, status: t.status, link: ticketLink(ctx, t.id) })),
        ...(portal ? {} : { notes: a.notes ?? null }),
        link: assetLink(ctx, a.id),
      };
    },
    summary: (input, result) => `Read asset ${(result as { tag: string }).tag ?? input.asset}`,
  }),

  define({
    name: 'asset_summary',
    toolset: 'assets',
    description: 'Asset inventory figures: totals by category, status and lifecycle; warranty and AMC expiring within 90 days or expired; assets in repair; assets linked to a CI.',
    inputSchema: z.object({ customer: z.string().max(200).optional() }),
    requires: ['assets:read'],
    portal: ['portal:assets'],
    action: false,
    run: async (ctx, input) => {
      if (isCustomerUser(ctx)) {
        const o = await portalAssetsOverview(ctx);
        return { total: o.total, byCategory: o.byCategory, byLifecycle: o.byLifecycle, bySite: o.bySite, warranty: o.warranty, amc: o.amc, facts: [`${o.total} asset(s) in the inventory`], link: '/portal/assets' };
      }
      const customerId = await resolveCustomerId(ctx, input.customer);
      const s = await assetSummary(ctx, customerId);
      const scope = await forCustomer(ctx, customerId);
      return { ...s, customer: scope.replace(/^ for /, '') || null, facts: [`${s.total} asset(s)${scope}: ${s.warrantyExpiring90} with warranty expiring within 90 days, ${s.warrantyExpired} with warranty expired, ${s.amcExpiring90} with AMC expiring within 90 days, ${s.amcExpired} with AMC expired, ${s.inRepair} in repair`], link: '/assets' };
    },
    summary: (_i, result) => `Read the asset summary${(result as { customer?: string | null }).customer ? ` for ${(result as { customer: string }).customer}` : ''}`,
  }),

  define({
    name: 'change_asset_lifecycle',
    toolset: 'assets',
    description: 'Move an asset to another lifecycle stage (ordered, in_stock, deployed, in_repair, retired, disposed); only allowed transitions apply.',
    inputSchema: z.object({ asset: assetRef, stage: z.enum(ASSET_LIFECYCLE), notes: z.string().max(1000).optional(), customer: z.string().max(200).optional() }),
    requires: ['assets:manage'],
    portal: null,
    action: true,
    invalidates: ['assets'],
    run: async (ctx, input) => {
      const hit = await resolveAsset(ctx, input.asset, await resolveCustomerId(ctx, input.customer));
      const a = (await changeLifecycle(ctx, hit.id, input.stage, input.notes)) as unknown as { id: string; tag: string; lifecycleStage: string };
      return { tag: a.tag, lifecycle: a.lifecycleStage, link: `/assets/${a.id}` };
    },
    summary: (input, result) => `Moved asset ${(result as { tag: string }).tag ?? input.asset} to ${input.stage}`,
    preview: async (ctx, input) => {
      const hit = await resolveAsset(ctx, input.asset, await resolveCustomerId(ctx, input.customer));
      const allowed = allowedLifecycleTransitions(hit.lifecycleStage);
      if (hit.lifecycleStage !== input.stage && !allowed.includes(input.stage)) return `Asset ${hit.tag} is ${hit.lifecycleStage.replace('_', ' ')} and can only move to: ${allowed.join(', ') || 'nothing'}; ${input.stage} is not allowed`;
      return `Move asset ${hit.tag} (${hit.name}) from ${hit.lifecycleStage.replace('_', ' ')} to ${input.stage.replace('_', ' ')}${input.notes ? ` (${input.notes.slice(0, 100)})` : ''}`;
    },
  }),
];
