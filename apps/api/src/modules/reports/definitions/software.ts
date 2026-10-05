import { sql } from 'drizzle-orm';
import { COMPLIANCE_POSITIONS, INSTALL_SOURCES } from '@itsm/shared';
import { registerReport, isCustomerUser, type ReportResult } from '../registry';
import { rows, customerCond, limitSql, col, numParam, listParam, strParam, boolParam, inUuids, customerParam } from './helpers';
import { complianceFor, positionLabel } from '@/modules/software/compliance';
import { loadSoftwareSettings } from '@/modules/software/settings';
import { licenceStatus, titleOf as productTitle } from '@/modules/software/service';
import { todayStr, addDays } from '@/core/overview';

/**
 * Software as reports: the installation inventory (where every title is
 * installed) and the licence compliance position per customer and title with
 * the licences behind it. Portal users are pinned to their organisation by the
 * registry and never see the cost column. The compliance summary tile labels
 * are read by name by the review pack: keep them.
 */

const groupCount = (list: Record<string, unknown>[], key: string, fallback = 'Unspecified') => {
  const m = new Map<string, number>();
  for (const r of list) m.set(String(r[key] ?? fallback), (m.get(String(r[key] ?? fallback)) ?? 0) + 1);
  return [...m].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
};
const titleOf = (r: { publisher: unknown; product: unknown; version_family: unknown }) => productTitle({ publisher: String(r.publisher ?? ''), name: String(r.product ?? ''), versionFamily: r.version_family ? String(r.version_family) : null });

// ---------------------------------------------------------------- software_inventory
registerReport({
  key: 'software_inventory',
  name: 'Software inventory',
  description: 'Every recorded software installation with its title, version, host, user, source and when it was last seen; flags stale installations.',
  category: 'assets',
  permissions: ['reports:run', 'software:read'],
  portal: true,
  parameters: [
    customerParam,
    { key: 'categoryIds', label: 'Category', type: 'multiselect', optionType: 'software_category' },
    { key: 'publisher', label: 'Publisher', type: 'text' },
    { key: 'source', label: 'Source', type: 'select', options: INSTALL_SOURCES.map((s) => ({ value: s, label: s })) },
    { key: 'includeUnlinked', label: 'Include installations without a CI or asset', type: 'boolean', default: true },
  ],
  async run(ctx, p): Promise<ReportResult> {
    // canRunReport only checks portal:reports for customer users; the software pages themselves need portal:software.
    if (isCustomerUser(ctx)) ctx.require('portal:software', ctx.user.customerId);
    const settings = await loadSoftwareSettings(ctx.tx);
    const publisher = strParam(p, 'publisher');
    const source = strParam(p, 'source');
    const includeUnlinked = boolParam(p, 'includeUnlinked', true);
    const list = await rows<Record<string, unknown>>(ctx, sql`
      SELECT i.id, i.ci_id, i.asset_id, pr.publisher, pr.name AS product, pr.version_family, i.version, i.edition, cat.label AS category, cu.name AS customer,
        coalesce(ci.name, a.tag, i.host_name) AS host, coalesce(cs.name, asit.name) AS site, i.assigned_user, i.cores, i.source, i.installed_at, i.last_seen_at,
        (i.source <> 'manual' AND i.last_seen_at < now() - make_interval(days => ${settings.staleInstallDays}::int)) AS stale
      FROM software_installations i
      JOIN software_products pr ON pr.id = i.product_id
      LEFT JOIN customers cu ON cu.id = i.customer_id
      LEFT JOIN cis ci ON ci.id = i.ci_id
      LEFT JOIN assets a ON a.id = i.asset_id
      LEFT JOIN sites cs ON cs.id = ci.site_id
      LEFT JOIN sites asit ON asit.id = a.site_id
      LEFT JOIN config_options cat ON cat.id = pr.category_id
      WHERE true ${customerCond(p.customerId, sql`i.customer_id`)} ${inUuids(sql`pr.category_id`, listParam(p, 'categoryIds'))}
        ${publisher ? sql`AND pr.publisher ILIKE ${`%${publisher}%`}` : sql``} ${source ? sql`AND i.source = ${source}` : sql``}
        ${includeUnlinked ? sql`` : sql`AND (i.ci_id IS NOT NULL OR i.asset_id IS NOT NULL)`}
      ORDER BY cu.name, pr.publisher, pr.name, host ${limitSql()}`);
    const hosts = new Set(list.map((r) => `${r.customer}:${r.host ?? ''}`).filter((h) => !h.endsWith(':')));
    const byTitle = new Map<string, { title: string; installations: number; hosts: Set<string> }>();
    for (const r of list) {
      const t = titleOf(r as { publisher: unknown; product: unknown; version_family: unknown });
      const e = byTitle.get(t) ?? { title: t, installations: 0, hosts: new Set<string>() };
      e.installations++;
      if (r.host) e.hosts.add(`${r.customer}:${r.host}`);
      byTitle.set(t, e);
    }
    return {
      columns: [col('publisher', 'Publisher'), col('product', 'Product'), col('version_family', 'Version family'), col('version', 'Version'), col('edition', 'Edition'), col('category', 'Category'), col('customer', 'Customer'), col('host', 'Host'), col('site', 'Site'), col('assigned_user', 'User'), col('cores', 'Cores', 'number'), col('source', 'Source'), col('installed_at', 'Installed', 'date'), col('last_seen_at', 'Last seen', 'datetime'), col('stale', 'Stale', 'boolean')],
      rows: list,
      summary: [
        { label: 'Installations', value: list.length },
        { label: 'Titles', value: byTitle.size },
        { label: 'Hosts', value: hosts.size },
        { label: 'Stale', value: list.filter((r) => r.stale === true).length, hint: `not seen for ${settings.staleInstallDays} days` },
        { label: 'Unlinked', value: list.filter((r) => !r.ci_id && !r.asset_id).length, hint: 'no CI or asset' },
      ],
      charts: [
        { type: 'bar', title: 'Installations by publisher', data: groupCount(list, 'publisher').slice(0, 12), x: 'label', y: 'count' },
        { type: 'bar', title: 'Installations by category', data: groupCount(list, 'category', 'Uncategorised'), x: 'label', y: 'count' },
      ],
      sections: [{ title: 'By title', columns: [col('title', 'Title'), col('installations', 'Installations', 'number'), col('hosts', 'Hosts', 'number')], rows: [...byTitle.values()].sort((a, b) => b.installations - a.installations).slice(0, 50).map((e) => ({ title: e.title, installations: e.installations, hosts: e.hosts.size })) }],
    };
  },
});

// ---------------------------------------------------------------- licence_compliance
registerReport({
  key: 'licence_compliance',
  name: 'Licence compliance',
  description: 'Installed against entitled per customer and title (compliant, under-deployed, over-deployed, unlicensed, unlimited) with the licences behind each position and the seats ending soon.',
  category: 'assets',
  permissions: ['reports:run', 'software:read'],
  portal: true,
  parameters: [
    customerParam,
    { key: 'position', label: 'Position', type: 'select', options: COMPLIANCE_POSITIONS.map((s) => ({ value: s, label: positionLabel(s) })) },
    { key: 'expiringDays', label: 'Licences ending within (days)', type: 'number', default: 90 },
    { key: 'includeCompliant', label: 'Include compliant and unlimited titles', type: 'boolean', default: true },
  ],
  async run(ctx, p): Promise<ReportResult> {
    const customer = isCustomerUser(ctx);
    // canRunReport only checks portal:reports for customer users; the licence position needs portal:software.
    if (customer) ctx.require('portal:software', ctx.user.customerId);
    const days = numParam(p, 'expiringDays', 90, 0, 3650);
    const position = strParam(p, 'position');
    const includeCompliant = boolParam(p, 'includeCompliant', true);
    const settings = await loadSoftwareSettings(ctx.tx);
    const today = todayStr();
    const horizon = addDays(today, days);
    const customerId = customer ? ctx.user.customerId : p.customerId;
    let positions = await complianceFor(ctx, { customerId: customerId ?? undefined });
    if (position) positions = positions.filter((r) => r.position === position);
    if (!includeCompliant) positions = positions.filter((r) => r.position !== 'compliant' && r.position !== 'unlimited');
    const list = positions.map((r) => ({ customer: r.customerName, publisher: r.publisher, product: r.name, version_family: r.versionFamily, metric: r.metric, installed: r.installed, entitled: r.entitled, unused: r.unused, utilisation_pct: r.utilisationPct, position: positionLabel(r.position), position_key: r.position, licences_active: r.licencesActive, next_end_date: r.nextEndDate, expiring_seats: r.expiringSeats }));
    const licenceRows = await rows<Record<string, unknown>>(ctx, sql`
      SELECT l.id, l.name AS licence, cu.name AS customer, pr.publisher, pr.name AS product, pr.version_family, l.metric, l.quantity::float AS seats, l.start_date, l.end_date, l.renewal_date, c.number AS contract,
        l.is_active, l.successor_id, l.cost::float AS cost, l.currency
      FROM software_licences l JOIN software_products pr ON pr.id = l.product_id LEFT JOIN customers cu ON cu.id = l.customer_id LEFT JOIN contracts c ON c.id = l.contract_id
      WHERE true ${customerCond(customerId, sql`l.customer_id`)}
      ORDER BY cu.name, pr.publisher, pr.name, l.end_date NULLS LAST ${limitSql()}`);
    const licences = licenceRows.map((l) => {
      const status = licenceStatus({ isActive: l.is_active as boolean, successorId: (l.successor_id as string | null) ?? null, startDate: (l.start_date as string | null) ?? null, endDate: (l.end_date as string | null) ?? null }, settings.noticeDays, today);
      const row: Record<string, unknown> = { licence: l.licence, customer: l.customer, title: titleOf(l as { publisher: unknown; product: unknown; version_family: unknown }), metric: l.metric, seats: l.seats, start_date: l.start_date, end_date: l.end_date, renewal_date: l.renewal_date, contract: l.contract, status };
      if (!customer) row.cost = l.cost === null || l.cost === undefined ? null : `${l.currency ?? ''} ${Number(l.cost).toLocaleString('en-IN')}`.trim();
      return row;
    });
    const endingSoon = licences.filter((l) => (l.status === 'expiring' || l.status === 'active') && typeof l.end_date === 'string' && l.end_date >= today && l.end_date <= horizon).length;
    const count = (key: string) => list.filter((r) => r.position_key === key).length;
    return {
      columns: [col('customer', 'Customer'), col('publisher', 'Publisher'), col('product', 'Product'), col('version_family', 'Version family'), col('metric', 'Metric'), col('installed', 'Installed', 'number'), col('entitled', 'Entitled', 'number'), col('unused', 'Unused', 'number'), col('utilisation_pct', 'Utilisation', 'pct'), col('position', 'Position'), col('licences_active', 'Licences in term', 'number'), col('next_end_date', 'Next end date', 'date'), col('expiring_seats', 'Seats ending soon', 'number')],
      rows: list,
      summary: [
        { label: 'Titles', value: list.length },
        { label: 'Over-deployed', value: count('over_deployed') },
        { label: 'Unlicensed', value: count('unlicensed') },
        { label: 'Under-deployed', value: count('under_deployed'), hint: `below ${settings.unusedSeatPct}% of the seats used` },
        { label: `Licences ending (${days}d)`, value: endingSoon },
      ],
      charts: [
        { type: 'bar', title: 'Positions', data: COMPLIANCE_POSITIONS.map((k) => ({ label: positionLabel(k), count: count(k) })), x: 'label', y: 'count' },
        { type: 'bar', title: 'Top over-deployed titles', data: list.filter((r) => r.position_key === 'over_deployed' || r.position_key === 'unlicensed').map((r) => ({ label: `${r.publisher} ${r.product}${customerId ? '' : ` (${r.customer})`}`, over: r.installed - (r.entitled ?? 0) })).sort((a, b) => b.over - a.over).slice(0, 10), x: 'label', y: 'over', labels: { over: 'Installed above entitled' } },
      ],
      sections: [{ title: 'Licences', columns: [col('licence', 'Licence'), col('customer', 'Customer'), col('title', 'Title'), col('metric', 'Metric'), col('seats', 'Seats', 'number'), col('start_date', 'Start', 'date'), col('end_date', 'End', 'date'), col('renewal_date', 'Renewal', 'date'), col('contract', 'Contract'), col('status', 'Status'), ...(customer ? [] : [col('cost', 'Cost')])], rows: licences }],
    };
  },
});
