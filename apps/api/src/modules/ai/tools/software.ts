import { z } from 'zod';
import { COMPLIANCE_POSITIONS, LICENCE_METRICS, LICENCE_TERMS } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { NotFoundError, ValidationError } from '@/core/errors';
import { listProducts, listCompliance, listRenewals, getLicence, createLicence, createInstallation, loadSoftwareSettings, titleOf, type CompliancePosition } from '@/modules/software/service';
import { positionLabel } from '@/modules/software/compliance';
import { todayStr, addDays } from '@/core/overview';
import { portalSoftware, portalSoftwareLicences, type PortalPosition } from '@/modules/portal/service';
import type { ProductListQuery } from '@/modules/software/schemas';
import { define } from './types';
import { isCustomerUser, iso, resolveCustomerId, resolveContract, resolveCi, resolveAsset, resolveSoftwareProduct, resolveLicence, forCustomer, customerName } from '../helpers';

/**
 * Software asset tools: the titles a customer runs, the licence position per
 * title (installed against entitled), the licences ending or renewing soon,
 * one licence, and recording a licence or an installation after a preview.
 * Customer administrators (portal:software) go through the portal projections,
 * which pin their organisation and carry no cost, key or paperwork.
 */

const PORTAL_LINK = '/portal/assets/software';
const titleLink = (ctx: Ctx, id: string, customerId?: string | null) => (isCustomerUser(ctx) ? PORTAL_LINK : `/assets/software/titles/${id}${customerId ? `?customerId=${customerId}` : ''}`);
const licenceLink = (ctx: Ctx, id: string) => (isCustomerUser(ctx) ? PORTAL_LINK : `/assets/software/licences/${id}`);
const complianceLink = (customerId?: string | null) => `/assets/software/compliance${customerId ? `?customerId=${customerId}` : ''}`;
const plural = (n: number, word: string) => `${n} ${word}(s)`;
const matches = (p: { publisher: string; name: string; versionFamily: string | null }, needle: string) => `${p.publisher} ${p.name} ${p.versionFamily ?? ''}`.toLowerCase().includes(needle.trim().toLowerCase());
const fullTitle = (p: { publisher: string; name: string; versionFamily: string | null }) => titleOf(p);

async function noticeHorizon(ctx: Ctx) {
  const settings = await loadSoftwareSettings(ctx.tx);
  const maxNotice = Math.max(0, ...settings.noticeDays);
  return { maxNotice, horizon: addDays(todayStr(), maxNotice) };
}

const positionItem = (ctx: Ctx, p: CompliancePosition | (PortalPosition & { customerId?: string; customerName?: string })) => ({
  customer: 'customerName' in p ? p.customerName ?? null : null,
  title: fullTitle(p),
  metric: p.metric,
  installed: p.installed,
  entitled: p.entitled,
  unused: p.unused,
  utilisationPct: p.utilisationPct,
  position: p.position,
  nextEndDate: p.nextEndDate,
  link: titleLink(ctx, p.productId, 'customerId' in p ? p.customerId : null),
});

function complianceFacts(items: { position: string; nextEndDate: string | null }[], total: number, scope: string, horizon: string, maxNotice: number) {
  const over = items.filter((i) => i.position === 'over_deployed').length;
  const unl = items.filter((i) => i.position === 'unlicensed').length;
  const under = items.filter((i) => i.position === 'under_deployed').length;
  const expiring = items.filter((i) => i.nextEndDate && i.nextEndDate <= horizon).length;
  return [`${plural(total, 'title')}${scope}: ${over} over-deployed, ${unl} unlicensed, ${under} under-deployed (unused seats), ${expiring} with a licence ending within ${maxNotice} days`];
}

export const SOFTWARE: ReturnType<typeof define>[] = [
  define({
    name: 'software_inventory',
    toolset: 'assets',
    description: 'The software titles in use (installed or licensed) for a customer or across every customer, with installation counts, customers and licensed seats; search by title or publisher. Use for "what software does X run", "how many Office installs do we have", "which titles from this publisher are installed".',
    inputSchema: z.object({ customer: z.string().max(200).optional(), q: z.string().max(200).optional(), publisher: z.string().max(120).optional(), limit: z.number().int().min(1).max(30).optional() }),
    requires: ['software:read'],
    portal: ['portal:software'],
    action: false,
    run: async (ctx, input) => {
      const limit = input.limit ?? 20;
      if (isCustomerUser(ctx)) {
        const needle = `${input.q ?? ''}`.trim().toLowerCase();
        const pub = input.publisher?.trim().toLowerCase();
        const all = (await portalSoftware(ctx)).positions.filter((p) => (!needle || matches(p, needle)) && (!pub || p.publisher.toLowerCase().includes(pub)));
        const items = all.slice(0, limit).map((p) => ({ title: fullTitle(p), category: p.categoryLabel, licenceModel: null, installations: p.installed, customers: 1, licensedSeats: p.entitled, position: p.position, link: PORTAL_LINK }));
        return { total: all.length, items, facts: [`${plural(all.length, 'software title')} in use${needle ? ' matching the search' : ''}; ${plural(all.reduce((s, p) => s + p.installed, 0), 'installation')}`], link: PORTAL_LINK };
      }
      const customerId = await resolveCustomerId(ctx, input.customer);
      const res = await listProducts(ctx, { page: 1, pageSize: limit, inUseOnly: true, includeInactive: undefined, customerId, q: input.q, publisher: input.publisher, fields: 'full' } as ProductListQuery);
      type FullRow = { id: string; publisher: string; name: string; versionFamily: string | null; categoryLabel: string | null; licenceModel: string; installations: number; customers: number; licensedSeats: number; overDeployedCustomers: number };
      const items = (res.items as unknown as FullRow[]).map((p) => ({ title: fullTitle(p), category: p.categoryLabel ?? null, licenceModel: p.licenceModel, installations: Number(p.installations ?? 0), customers: Number(p.customers ?? 0), licensedSeats: Number(p.licensedSeats ?? 0), overDeployedCustomers: Number(p.overDeployedCustomers ?? 0), link: titleLink(ctx, p.id, customerId) }));
      const scope = await forCustomer(ctx, customerId);
      return { total: res.total, items, facts: [`${plural(res.total, 'software title')} in use${scope}${input.q ? ' matching the search' : ''}; ${plural(items.reduce((s, i) => s + i.installations, 0), 'installation')}`], link: customerId ? `/assets/software/titles?customerId=${customerId}&inUseOnly=true` : '/assets/software/titles?inUseOnly=true' };
    },
    summary: (_i, result) => `Listed ${(result as { items: unknown[] }).items.length} software titles`,
  }),

  define({
    name: 'software_compliance',
    toolset: 'assets',
    description: 'The licence position per title and customer: installed against entitled seats, with over-deployed, unlicensed, under-deployed (unused seats), compliant and unlimited positions and the next licence end date. Use for "which titles are over-deployed at X", "are we compliant on SQL Server", "where are we paying for unused seats".',
    inputSchema: z.object({ customer: z.string().max(200).optional(), product: z.string().max(200).optional(), position: z.enum(COMPLIANCE_POSITIONS).optional(), limit: z.number().int().min(1).max(40).optional() }),
    requires: ['software:read'],
    portal: ['portal:software'],
    action: false,
    run: async (ctx, input) => {
      const limit = input.limit ?? 20;
      const { maxNotice, horizon } = await noticeHorizon(ctx);
      if (isCustomerUser(ctx)) {
        let all = (await portalSoftware(ctx)).positions;
        if (input.product) {
          const hit = all.filter((p) => matches(p, input.product!));
          if (!hit.length) throw new NotFoundError('Software title', `No software title matching "${input.product}" is in use for your organisation`);
          all = hit;
        }
        if (input.position) all = all.filter((p) => p.position === input.position);
        return { total: all.length, items: all.slice(0, limit).map((p) => positionItem(ctx, p)), facts: complianceFacts(all, all.length, '', horizon, maxNotice), link: PORTAL_LINK };
      }
      const customerId = await resolveCustomerId(ctx, input.customer);
      const productId = input.product ? (await resolveSoftwareProduct(ctx, input.product, customerId)).id : undefined;
      const res = await listCompliance(ctx, { customerId, productId, position: input.position, page: 1, pageSize: limit, expiringOnly: undefined });
      const scope = await forCustomer(ctx, customerId);
      const facts = [`${plural(res.total, 'title')}${scope}: ${res.totals.over_deployed} over-deployed, ${res.totals.unlicensed} unlicensed, ${res.totals.under_deployed} under-deployed (unused seats), ${res.totals.expiring} with a licence ending within ${maxNotice} days`];
      return { total: res.total, items: res.items.map((p) => positionItem(ctx, p)), facts, link: complianceLink(customerId) };
    },
    summary: (input, result) => `Read the licence position of ${(result as { total: number }).total} title(s)${input.customer ? ` for ${input.customer}` : ''}`,
  }),

  define({
    name: 'licence_renewals',
    toolset: 'assets',
    description: 'Software licences ending or renewing within N days (default 90), expired ones first, with seats, end date, renewal date, status and contract. Use for "what licences renew this quarter", "which subscriptions have expired", "what ends in the next 30 days for X".',
    inputSchema: z.object({ customer: z.string().max(200).optional(), withinDays: z.number().int().min(1).max(730).optional(), limit: z.number().int().min(1).max(40).optional() }),
    requires: ['software:read'],
    portal: ['portal:software'],
    action: false,
    run: async (ctx, input) => {
      const days = input.withinDays ?? 90;
      const limit = input.limit ?? 20;
      const today = todayStr();
      const until = addDays(today, days);
      if (isCustomerUser(ctx)) {
        const res = await portalSoftwareLicences(ctx, { page: 1, pageSize: 500 });
        const due = res.items
          .filter((l) => (l.status === 'expiring' || l.status === 'expired' || l.status === 'active') && ((l.endDate && l.endDate <= until) || (l.renewalDate && l.renewalDate <= until)))
          .sort((a, b) => Number(b.status === 'expired') - Number(a.status === 'expired') || (a.endDate ?? a.renewalDate ?? '').localeCompare(b.endDate ?? b.renewalDate ?? ''));
        const expired = due.filter((l) => l.status === 'expired').length;
        return { days, total: due.length, items: due.slice(0, limit).map((l) => ({ licence: l.name, customer: null, title: fullTitle({ publisher: l.publisher, name: l.product, versionFamily: l.versionFamily }), seats: l.quantity, endDate: l.endDate, renewalDate: l.renewalDate, status: l.status, daysLeft: l.daysLeft, contract: l.contractNumber, link: PORTAL_LINK })), facts: [`${plural(due.length, 'licence')} ending or renewing within ${days} days, ${expired} already expired`], link: PORTAL_LINK };
      }
      const customerId = await resolveCustomerId(ctx, input.customer);
      const res = await listRenewals(ctx, { days, customerId, status: 'all', limit: 500 });
      const scope = await forCustomer(ctx, customerId);
      return { days, total: res.items.length, items: res.items.slice(0, limit).map((l) => ({ licence: l.name, customer: l.customerName, title: fullTitle({ publisher: l.productPublisher, name: l.productName, versionFamily: l.versionFamily }), seats: l.quantity, endDate: l.endDate, renewalDate: l.renewalDate, status: l.status, daysLeft: l.daysLeft, contract: l.contractNumber, link: licenceLink(ctx, l.id) })), facts: [`${plural(res.items.length, 'licence')} ending or renewing within ${days} days${scope}, ${res.expired} already expired`], link: `/assets/software/renewals?days=${days}${customerId ? `&customerId=${customerId}` : ''}` };
    },
    summary: (input, result) => `Listed ${(result as { total: number }).total} licence renewals within ${input.withinDays ?? 90} days`,
  }),

  define({
    name: 'get_licence',
    toolset: 'assets',
    description: 'One software licence by name or id: title, seats and metric, term, start, end and renewal dates, status, installed seats and position, contract and successor (plus cost, vendor and owner for staff). Use for "when does the Office licence end", "how many seats are on the vSphere licence".',
    inputSchema: z.object({ licence: z.string().max(200).describe('Licence name or id'), customer: z.string().max(200).optional() }),
    requires: ['software:read'],
    portal: ['portal:software'],
    action: false,
    run: async (ctx, input) => {
      const ref = input.licence.trim();
      if (isCustomerUser(ctx)) {
        const res = await portalSoftwareLicences(ctx, { page: 1, pageSize: 10, q: ref });
        const low = ref.toLowerCase();
        // The staff resolver's rule: the exact id or name, else the one licence whose name contains the reference. A row the
        // search matched only through the title's index is never returned as "the" licence.
        const byName = res.items.filter((x) => x.name.toLowerCase().includes(low));
        const l = res.items.find((x) => x.id === ref || x.name.toLowerCase() === low) ?? (byName.length === 1 ? byName[0] : undefined);
        if (!l) throw new NotFoundError('Licence', `No licence matching "${ref}" is visible to you${byName.length > 1 ? ` (${byName.length} licences have a similar name: ${byName.map((x) => x.name).join(', ')})` : ''}`);
        return { name: l.name, title: fullTitle({ publisher: l.publisher, name: l.product, versionFamily: l.versionFamily }), metric: l.metric, term: l.term, quantity: l.quantity, startDate: l.startDate, endDate: l.endDate, renewalDate: l.renewalDate, autoRenew: l.autoRenew, status: l.status, daysLeft: l.daysLeft, installed: l.installed, contract: l.contractNumber, facts: [`Licence "${l.name}": ${l.quantity} ${l.metric} seats, ${l.installed} installed, ends ${l.endDate ?? 'never'}`], link: PORTAL_LINK };
      }
      const hit = await resolveLicence(ctx, ref, await resolveCustomerId(ctx, input.customer));
      const l = await getLicence(ctx, hit.id);
      return {
        name: l.name,
        customer: l.customerName,
        title: fullTitle({ publisher: l.productPublisher, name: l.productName, versionFamily: l.versionFamily }),
        metric: l.metric,
        term: l.term,
        quantity: l.quantity,
        startDate: l.startDate,
        endDate: l.endDate,
        renewalDate: l.renewalDate,
        autoRenew: l.autoRenew,
        status: l.status,
        daysLeft: l.daysLeft,
        contract: l.contract ? { number: l.contract.number, status: l.contract.status, endDate: l.contract.endDate } : null,
        compliance: l.compliance ? { installed: l.compliance.installed, entitled: l.compliance.entitled, position: l.compliance.position } : null,
        successor: l.successor?.name ?? null,
        predecessor: l.predecessor?.name ?? null,
        cost: l.cost,
        currency: l.currency,
        vendor: l.vendor,
        poNumber: l.poNumber,
        owner: l.ownerName ?? null,
        notes: l.notes,
        renewedAt: iso(l.renewedAt),
        facts: [`Licence "${l.name}": ${l.quantity} ${l.metric} seats, ${l.installed} installed (${l.compliance ? positionLabel(l.compliance.position).toLowerCase() : 'no position'}), ends ${l.endDate ?? 'never'}`],
        link: licenceLink(ctx, l.id),
      };
    },
    summary: (input, result) => `Read licence ${(result as { name: string }).name ?? input.licence}`,
  }),

  define({
    name: 'record_licence',
    toolset: 'assets',
    description: 'Record a software licence a customer bought: title, seats, metric (per device, per user, per core, site), term, start and end dates, renewal date, contract and cost. Use for "record 50 Office seats for X ending next March".',
    inputSchema: z.object({
      customer: z.string().max(200),
      product: z.string().max(200).describe('Software title (publisher and name) or id'),
      name: z.string().max(200).optional(),
      quantity: z.number().min(0),
      metric: z.enum(LICENCE_METRICS).optional(),
      term: z.enum(LICENCE_TERMS).optional(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      renewalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      contract: z.string().max(100).optional().describe('Contract number'),
      cost: z.number().min(0).optional(),
      notes: z.string().max(2000).optional(),
    }),
    requires: ['software:manage'],
    portal: null,
    action: true,
    tier: 'write',
    invalidates: ['software'],
    preview: async (ctx, input) => {
      const r = await resolveLicenceInput(ctx, input);
      const span = r.startDate || r.endDate ? `, ${r.startDate ?? 'open start'} to ${r.endDate ?? 'no end date'}` : '';
      return `Record licence "${r.name}" for ${r.customer}: ${r.quantity} ${r.metric} seats of ${fullTitle(r.product)}${span}${r.renewalDate ? `, renewal ${r.renewalDate}` : ''}${r.contract ? `, contract ${r.contract.number}` : ''}${r.cost !== undefined ? `, cost ${r.cost}` : ''}`;
    },
    run: async (ctx, input) => {
      const r = await resolveLicenceInput(ctx, input);
      const l = await createLicence(ctx, { customerId: r.customerId, productId: r.product.id, contractId: r.contract?.id ?? null, name: r.name, metric: r.metric, term: r.term, quantity: r.quantity, startDate: r.startDate ?? null, endDate: r.endDate ?? null, renewalDate: r.renewalDate ?? null, cost: r.cost ?? null, notes: input.notes ?? null });
      return { id: l.id, name: l.name, customer: l.customerName, title: fullTitle(r.product), quantity: l.quantity, metric: l.metric, status: l.status, link: licenceLink(ctx, l.id), facts: [`Licence "${l.name}" recorded for ${l.customerName}: ${l.quantity} ${l.metric} seats`] };
    },
    summary: (input, result) => `Recorded licence ${(result as { name: string }).name ?? input.product}`,
  }),

  define({
    name: 'record_installation',
    toolset: 'assets',
    description: 'Record one software installation on a CI, an asset or for a user at a customer (title, version, cores). Use for "record SQL Server 2019 on the finance database server for X".',
    inputSchema: z.object({
      customer: z.string().max(200),
      product: z.string().max(200).describe('Software title (publisher and name) or id'),
      ci: z.string().max(200).optional().describe('CI name, hostname or id'),
      asset: z.string().max(200).optional().describe('Asset tag, serial or id'),
      user: z.string().max(200).optional().describe('The person the installation is for'),
      version: z.string().max(60).optional(),
      cores: z.number().int().min(1).max(4096).optional(),
    }),
    requires: ['software:manage'],
    portal: null,
    action: true,
    tier: 'write',
    invalidates: ['software'],
    preview: async (ctx, input) => {
      const r = await resolveInstallInput(ctx, input);
      return `Record ${fullTitle(r.product)}${input.version ? ` ${input.version}` : ''} on ${r.host} for ${r.customer}${input.cores ? ` (${input.cores} cores)` : ''}`;
    },
    run: async (ctx, input) => {
      const r = await resolveInstallInput(ctx, input);
      const row = await createInstallation(ctx, { customerId: r.customerId, productId: r.product.id, ciId: r.ciId, assetId: r.assetId, assignedUser: input.user ?? null, version: input.version ?? null, cores: input.cores ?? null, source: 'manual' });
      return { id: row.id, title: fullTitle(r.product), host: r.host, customer: r.customer, link: `/assets/software/installations?customerId=${r.customerId}&productId=${r.product.id}`, facts: [`${fullTitle(r.product)} recorded on ${r.host} for ${r.customer}`] };
    },
    summary: (input, result) => `Recorded ${(result as { title: string }).title ?? input.product} on ${(result as { host: string }).host ?? input.ci ?? input.asset ?? input.user}`,
  }),
];

async function resolveLicenceInput(ctx: Ctx, input: { customer: string; product: string; name?: string; quantity: number; metric?: string; term?: string; startDate?: string; endDate?: string; renewalDate?: string; contract?: string; cost?: number }) {
  const customerId = (await resolveCustomerId(ctx, input.customer, true))!;
  const customer = await customerName(ctx, customerId);
  const product = await resolveSoftwareProduct(ctx, input.product);
  const contract = input.contract ? await resolveContract(ctx, input.contract) : null;
  if (contract && contract.customerId !== customerId) throw new ValidationError(`Contract ${contract.number} belongs to another customer`);
  if (input.startDate && input.endDate && input.endDate < input.startDate) throw new ValidationError('The licence must end after it starts');
  const metric = (input.metric ?? (product.licenceModel === 'per_user' || product.licenceModel === 'subscription' ? 'per_user' : product.licenceModel === 'per_core' ? 'per_core' : 'per_device')) as (typeof LICENCE_METRICS)[number];
  const term = (input.term ?? (product.licenceModel === 'subscription' ? 'subscription' : 'perpetual')) as (typeof LICENCE_TERMS)[number];
  if (metric !== 'site' && !(input.quantity > 0)) throw new ValidationError('A licence needs at least one seat unless it is a site licence');
  const name = input.name?.trim() || `${product.name} (${input.quantity} ${metric.replace('_', ' ')})`;
  return { customerId, customer, product, contract, metric, term, name, quantity: input.quantity, startDate: input.startDate, endDate: input.endDate, renewalDate: input.renewalDate, cost: input.cost };
}

async function resolveInstallInput(ctx: Ctx, input: { customer: string; product: string; ci?: string; asset?: string; user?: string }) {
  const customerId = (await resolveCustomerId(ctx, input.customer, true))!;
  const customer = await customerName(ctx, customerId);
  const product = await resolveSoftwareProduct(ctx, input.product);
  if (!input.ci && !input.asset && !input.user) throw new ValidationError('An installation needs a CI, an asset or a user');
  const ci = input.ci ? await resolveCi(ctx, input.ci, customerId) : null;
  const asset = input.asset ? await resolveAsset(ctx, input.asset, customerId) : null;
  const host = ci ? ('name' in ci ? ci.name : input.ci!) : asset ? asset.tag : input.user!;
  return { customerId, customer, product, ciId: ci?.id ?? null, assetId: asset?.id ?? null, host };
}
