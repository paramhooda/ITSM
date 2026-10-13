import { sql, eq, and, inArray, lte } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { ticketListPath, portalTicketListPath, complianceTone, type TicketListLink } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import type { BriefingDoor, BriefingFacts, BriefingItem, BriefingKpi, BriefingRole, BriefingSection } from '@/db/schema/briefings';
import { listTickets } from '@/modules/tickets/list';
import { listMajor } from '@/modules/tickets/major';
import { isCustomerUser } from '@/modules/tickets/common';
import { slaCompliance } from '@/modules/sla/policies';
import { expiringContracts } from '@/modules/contracts/service';
import { entitlementSummary } from '@/modules/contracts/entitlements';
import { buildDigest } from '@/modules/ai/digest';
import { listQuery } from '@/modules/ai/helpers';
import { socCond } from '@/modules/dashboards/common';
import { customer as customerDashboard } from '@/modules/dashboards/service';
import { listPortalTickets } from '@/modules/portal/service';
import { ticketListQuery as portalListQuery } from '@/modules/portal/schemas';
import { resolutionCompliance } from '@/modules/sla/compliance';
import { toDay, addDays } from '@/modules/reports/dates';
import { countForLink, countForLinkByCustomer, countDueWithin, door, figure } from './doors';

/**
 * What each briefing is made of. Every definition reads through the person's
 * own context, so row-level security, the SOC fence and the customer scope
 * apply exactly as on their dashboard; the figures are exact and the model
 * only phrases them.
 *
 * Counts come first and rows second: a figure that appears in a sentence and
 * in a KPI or a section door is counted once through `doors.ts` (the list's
 * own predicate behind the link it carries) and the sentence is written from
 * that value; the list functions supply item rows only. A count with no list
 * predicate (due in 24 hours, escalated, unhappy, the compliance percentage,
 * approvals, visits) is a figure: a value and no link.
 */

export type BriefingAudience = 'staff' | 'customer';

export interface BriefingDefinition {
  key: BriefingRole;
  label: string;
  description: string;
  audience: BriefingAudience;
  /** May this person receive this briefing? */
  allowed(ctx: Ctx): boolean;
  build(ctx: Ctx, opts: { day: string; timezone: string; now: Date }): Promise<Pick<BriefingFacts, 'headline' | 'kpis' | 'sections'>>;
}

type Row = Awaited<ReturnType<typeof listTickets>>['items'][number];
type PortalRow = Awaited<ReturnType<typeof listPortalTickets>>['items'][number];
const DAY = 86_400_000;
const n = (v: unknown) => Number(v ?? 0);
const plural = (count: number, word: string, pluralWord = `${word}s`) => `${count} ${count === 1 ? word : pluralWord}`;
const are = (count: number) => (count === 1 ? 'is' : 'are');
const have = (count: number) => (count === 1 ? 'has' : 'have');
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** A timezone luxon accepts, UTC otherwise. */
export const zoneOf = (tz: string | null | undefined) => (tz && DateTime.local().setZone(tz).isValid ? tz : 'UTC');
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** A moment printed in the person's own zone, with the zone named, for the email line; a day (YYYY-MM-DD, a date column) is a day everywhere and is printed as given. */
export const fmtIn = (d: Date | string | null | undefined, timezone: string) => {
  if (!d) return null;
  if (typeof d === 'string' && DAY_ONLY.test(d)) return d;
  return DateTime.fromJSDate(new Date(d), { zone: zoneOf(timezone) }).toFormat('yyyy-LL-dd HH:mm ZZZZ');
};

/** The email line of an item, built from its typed fields so the two never disagree; times in the person's timezone. */
export function metaOf(item: BriefingItem, timezone: string, opts: { owner?: boolean; extra?: (string | null | undefined)[] } = {}): string | null {
  const parts = [
    item.priority?.label,
    item.customer,
    opts.owner ? item.assignee ?? 'unassigned' : null,
    item.status,
    item.dueAt ? `due ${fmtIn(item.dueAt, timezone)}` : null,
    item.when ? fmtIn(item.when, timezone) : null,
    item.breachRisk ? `${item.breachRisk} breach risk` : null,
    item.sentiment,
    ...(opts.extra ?? []),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

const withMeta = (item: BriefingItem, timezone: string, opts?: { owner?: boolean; extra?: (string | null | undefined)[] }): BriefingItem => ({ ...item, meta: metaOf(item, timezone, opts) });

/** A staff ticket row as a typed item (owner shown, breach risk and mood included). */
const ticketItem = (t: Row, timezone: string, extra?: string | null): BriefingItem =>
  withMeta({ ref: t.number, title: t.title, link: `/tickets/${t.id}`, kind: 'ticket', priority: t.priority ? { key: t.priority.key, label: t.priority.label, color: t.priority.color } : null, customer: t.customerName ?? null, assignee: t.assigneeName ?? null, team: t.teamName ?? null, dueAt: iso(t.dueAt), breachRisk: t.breachRisk?.level ?? null, sentiment: t.lastSentiment?.sentiment ?? null, status: t.status?.label ?? null }, timezone, { owner: true, extra: [extra] });

/** A portal ticket row as a typed item: never an owner, a team, a risk or a mood. */
const portalTicketItem = (t: PortalRow, timezone: string): BriefingItem =>
  withMeta({ ref: t.number, title: t.title, link: `/portal/tickets/${t.id}`, kind: 'ticket', priority: t.priority ? { key: t.priority.key, label: t.priority.label, color: t.priority.color } : null, customer: null, assignee: null, team: null, dueAt: iso(t.dueAt), breachRisk: null, sentiment: null, status: t.status?.label ?? null }, timezone);

const section = (key: string, title: string, items: BriefingItem[], summary: string | null, doors: BriefingDoor[] = []): BriefingSection => ({ key, title, summary, doors, items });
const kpi = (key: string, label: string, value: number | string, extra: Partial<Pick<BriefingKpi, 'tone' | 'href' | 'hint'>> = {}): BriefingKpi => ({ key, label, value, tone: extra.tone ?? null, href: extra.href ?? null, hint: extra.hint ?? null });
const warnIf = (v: number): BriefingKpi['tone'] => (v > 0 ? 'warn' : null);
const badOrGood = (v: number): BriefingKpi['tone'] => (v > 0 ? 'bad' : 'good');
const toneOfCompliance = (pct: number | null): BriefingKpi['tone'] => {
  const t = complianceTone(pct);
  return t === 'good' ? 'good' : t === 'warning' ? 'warn' : t === 'critical' ? 'bad' : null;
};
const pctText = (pct: number | null) => (pct === null ? 'not measurable yet' : `${pct}%`);

/** The staff door for a link: the count (the list's own predicate) and the path the number opens. */
async function staffDoor(ctx: Ctx, label: string, link: TicketListLink): Promise<BriefingDoor> {
  return door(label, await countForLink(ctx, link), ticketListPath(link));
}

// ---------------------------------------------------------------- engineer

const engineer: BriefingDefinition = {
  key: 'engineer',
  label: 'Engineer',
  description: 'Your queue: what is due next, what is breached or likely to breach, and what sits unassigned in your team.',
  audience: 'staff',
  allowed: (ctx) => !isCustomerUser(ctx),
  async build(ctx, { now, timezone }) {
    const team = ctx.user.teams[0] ?? null;
    // Counts first, through the doors: the sentences below quote these values.
    const open = await staffDoor(ctx, 'Open', { assignee: 'me', status: 'open' });
    const breached = await staffDoor(ctx, 'Breached', { assignee: 'me', sla: 'breached' });
    const likely = await staffDoor(ctx, 'Likely to breach', { assignee: 'me', breachRisk: 'high', status: 'open' });
    const unassigned = team ? await staffDoor(ctx, `Unassigned in ${team.name}`, { teamId: team.id, assignee: 'unassigned', status: 'open' }) : null;
    const due24 = figure('Due in 24 hours', await countDueWithin(ctx, { assignee: 'me', status: 'open' }, 24, now));
    // Rows second: the pages behind the counts.
    const mine = await listTickets(ctx, listQuery({ mine: true, open: true, sort: 'dueAt', order: 'asc', pageSize: 12 }));
    const soon = mine.items.filter((t) => t.dueAt && new Date(t.dueAt).getTime() >= now.getTime() && new Date(t.dueAt).getTime() - now.getTime() < DAY);
    const breachedRows = await listTickets(ctx, listQuery({ mine: true, open: true, slaState: 'breached', sort: 'dueAt', order: 'asc', pageSize: 6 }));
    const riskyRows = await listTickets(ctx, listQuery({ mine: true, open: true, breachRisk: 'high', sort: 'dueAt', order: 'asc', pageSize: 6 }));
    const unassignedRows = team ? await listTickets(ctx, listQuery({ teamId: team.id, open: true, unassigned: true, sort: 'priority', order: 'asc', pageSize: 6 })) : null;
    const awaiting = await listTickets(ctx, listQuery({ mine: true, open: true, sentiment: 'unhappy', pageSize: 4 }));
    const unhappy = figure('Unhappy', awaiting.total);
    const riskyOnly = riskyRows.items.filter((t) => !breachedRows.items.some((b) => b.id === t.id));
    const headline = [
      `You have ${plural(open.value, 'open ticket')}, ${due24.value} due in the next 24 hours and ${breached.value} with a breached SLA.`,
      ...(likely.value ? [`${plural(likely.value, 'ticket')} of yours ${are(likely.value)} likely to breach.`] : []),
      ...(unassigned && team ? [`${plural(unassigned.value, 'ticket')} in ${team.name} ${have(unassigned.value)} no owner.`] : []),
      ...(unhappy.value ? [`${plural(unhappy.value, 'customer')} on your tickets sounded unhappy in their last message.`] : []),
    ];
    const kpis: BriefingKpi[] = [
      kpi('open', open.label, open.value, { href: open.href }),
      kpi('due24', due24.label, due24.value, { tone: warnIf(due24.value) }),
      kpi('breached', breached.label, breached.value, { tone: badOrGood(breached.value), href: breached.href }),
      kpi('likely', likely.label, likely.value, { tone: warnIf(likely.value), href: likely.href }),
      ...(unassigned ? [kpi('unassigned', unassigned.label, unassigned.value, { tone: warnIf(unassigned.value), href: unassigned.href })] : []),
      ...(unhappy.value ? [kpi('unhappy', unhappy.label, unhappy.value, { tone: 'bad' })] : []),
    ];
    return {
      headline,
      kpis,
      sections: [
        section('due', 'Due next', soon.slice(0, 8).map((t) => ticketItem(t, timezone)), due24.value ? `${plural(due24.value, 'ticket')} of yours ${are(due24.value)} due in the next 24 hours.` : 'Nothing of yours is due in the next 24 hours.', [open]),
        section('breached', 'Breached or likely to breach', [...breachedRows.items, ...riskyOnly].slice(0, 8).map((t) => ticketItem(t, timezone)), breached.value + likely.value ? `${breached.value} breached and ${likely.value} likely to breach.` : 'No SLA of yours is breached or at high risk.', [breached, likely]),
        ...(unassigned && team && unassignedRows ? [section('unassigned', `Unassigned in ${team.name}`, unassignedRows.items.map((t) => ticketItem(t, timezone)), unassigned.value ? `${plural(unassigned.value, 'ticket')} in ${team.name} ${have(unassigned.value)} no owner.` : 'Everything in the team queue has an owner.', [unassigned])] : []),
        ...(unhappy.value ? [section('unhappy', 'Customers who sounded unhappy', awaiting.items.map((t) => ticketItem(t, timezone, t.lastSentiment?.sentiment ?? null)), `${plural(unhappy.value, 'customer')} sounded unhappy in their last message.`, [unhappy])] : []),
      ],
    };
  },
};

// ---------------------------------------------------------------- operations managers (NOC, SOC)

async function silentIntegrations(ctx: Ctx, now: Date, timezone: string, kinds: string[] | null): Promise<BriefingItem[]> {
  const cutoff = new Date(now.getTime() - DAY);
  const rows = await ctx.tx
    .select({ id: schema.integrations.id, name: schema.integrations.name, type: schema.integrations.integrationType, lastEventAt: schema.integrations.lastEventAt })
    .from(schema.integrations)
    .where(and(eq(schema.integrations.isActive, true), ...(kinds ? [inArray(schema.integrations.integrationType, kinds)] : []), sql`(${schema.integrations.lastEventAt} IS NULL OR ${schema.integrations.lastEventAt} < ${cutoff})`))
    .limit(10);
  return rows.map((r) => ({ ref: r.name, title: r.lastEventAt ? `no events since ${fmtIn(r.lastEventAt, timezone)}` : 'never sent an event', meta: r.type, link: `/admin/integrations/${r.id}`, kind: 'integration', when: iso(r.lastEventAt) }));
}

/** Active major incidents as items (rows only; the count is the Major door). */
async function majorItems(ctx: Ctx, timezone: string): Promise<{ items: BriefingItem[]; overdue: number }> {
  const major = await listMajor(ctx, { status: 'active', pageSize: 10 });
  return {
    overdue: major.summary.overdue,
    items: major.items.map((m) => withMeta({ ref: m.number, title: m.title, link: `/tickets/${m.ticketId}?tab=major`, kind: 'ticket', priority: m.priority ? { key: m.priority.key, label: m.priority.label, color: m.priority.color } : null, customer: m.customerName ?? null, assignee: m.commanderName ?? null, status: 'major incident' }, timezone, { extra: [m.commanderName ? `commander ${m.commanderName}` : null, m.overdue ? 'update overdue' : m.nextUpdateDueAt ? `next update ${fmtIn(m.nextUpdateDueAt, timezone)}` : null] })),
  };
}

function operationsManager(key: 'noc_manager' | 'soc_manager', label: string, teamType: 'noc' | 'soc', kinds: string[] | null): BriefingDefinition {
  return {
    key,
    label,
    description: `${teamType.toUpperCase()} picture: every team's open, breached and at-risk work, major incidents, who is on call and integrations that went quiet.`,
    audience: 'staff',
    allowed: (ctx) => !isCustomerUser(ctx) && ctx.can(`dashboards:${teamType}`) && (teamType === 'noc' || ctx.can('soc:read')),
    async build(ctx, { now, timezone }) {
      const own = ctx.user.teams.map((t) => t.id);
      const teams = await ctx.tx.select({ id: schema.teams.id, name: schema.teams.name }).from(schema.teams).where(and(eq(schema.teams.isActive, true), own.length ? inArray(schema.teams.id, own) : eq(schema.teams.teamType, teamType))).orderBy(schema.teams.name).limit(3);
      const ids = teams.map((t) => t.id);
      const sections: BriefingSection[] = [];
      let p1p2 = 0;
      const onCall: { team: string; names: string[] }[] = [];
      for (const team of teams) {
        // Counts first: the team is the scope (no domain key), the four doors the team section carries.
        const open = await staffDoor(ctx, 'Open', { teamId: team.id, status: 'open' });
        const breached = await staffDoor(ctx, 'Breached', { teamId: team.id, sla: 'breached' });
        const atRisk = await staffDoor(ctx, 'At risk', { teamId: team.id, sla: 'at_risk' });
        const unassigned = await staffDoor(ctx, 'Unassigned', { teamId: team.id, assignee: 'unassigned', status: 'open' });
        // Rows second (one client per transaction: teams one after another); the digest's own counts are figures only.
        const d = await buildDigest(ctx, { teamId: team.id, from: new Date(now.getTime() - DAY), to: now, limit: 6 });
        p1p2 += d.counts.p1p2;
        if (d.onCall.now.length) onCall.push({ team: team.name, names: d.onCall.now.map((p) => p.name) });
        const watch = [...(d.tickets.find((l) => l.key === 'p1p2')?.items ?? []), ...(d.tickets.find((l) => l.key === 'breached')?.items ?? []), ...(d.tickets.find((l) => l.key === 'unassigned')?.items ?? [])];
        const seen = new Set<string>();
        const items = watch.filter((t) => !seen.has(t.id) && seen.add(t.id)).slice(0, 8).map((t) => withMeta({ ref: t.number, title: t.title, link: `/tickets/${t.id}`, kind: 'ticket', priority: t.priority ? { key: null, label: t.priority, color: null } : null, customer: t.customer, assignee: t.assignee, team: team.name, dueAt: t.slaDueAt, breachRisk: (t.breachRisk as BriefingItem['breachRisk']) ?? null, status: t.status }, timezone, { owner: true }));
        sections.push(section(`team:${team.id}`, team.name, items, `${open.value} open, ${d.counts.p1p2} P1/P2, ${breached.value} breached, ${atRisk.value} at risk, ${unassigned.value} unassigned; ${d.counts.openedInShift} opened and ${d.counts.resolvedInShift} resolved in the last 24 hours.`, [open, breached, atRisk, unassigned]));
      }
      // Across the teams: the same four links with every team id, counted once each.
      const across = ids.length
        ? {
            open: await staffDoor(ctx, 'Open', { teamId: ids, status: 'open' }),
            breached: await staffDoor(ctx, 'Breached', { teamId: ids, sla: 'breached' }),
            atRisk: await staffDoor(ctx, 'At risk', { teamId: ids, sla: 'at_risk' }),
            unassigned: await staffDoor(ctx, 'Unassigned', { teamId: ids, assignee: 'unassigned', status: 'open' }),
          }
        : null;
      const major = await staffDoor(ctx, 'Major', { isMajor: true, status: 'open' });
      const majors = await majorItems(ctx, timezone);
      const silent = await silentIntegrations(ctx, now, timezone, kinds);
      const onCallCount = onCall.reduce((a, t) => a + t.names.length, 0);
      const onCallText = onCall.map((t) => `${t.team}: ${t.names.join(', ')}`).join('; ');
      const headline = [
        across ? `Across ${teams.map((t) => t.name).join(', ')}: ${plural(across.open.value, 'open ticket')}, ${p1p2} P1/P2, ${across.breached.value} breached, ${across.atRisk.value} at risk, ${across.unassigned.value} unassigned.` : `No active ${teamType.toUpperCase()} team is set up yet.`,
        major.value ? `${plural(major.value, 'major incident')} open.` : 'No major incident is open.',
        ...(onCall.length ? [`On call now: ${onCallText}.`] : []),
        ...(silent.length ? [`${plural(silent.length, 'integration')} sent nothing in the last 24 hours.`] : []),
      ];
      const kpis: BriefingKpi[] = [
        ...(across
          ? [
              kpi('open', 'Open', across.open.value, { href: across.open.href }),
              kpi('p1p2', 'P1/P2', p1p2, { tone: warnIf(p1p2) }),
              kpi('breached', 'Breached', across.breached.value, { tone: badOrGood(across.breached.value), href: across.breached.href }),
              kpi('atRisk', 'At risk', across.atRisk.value, { tone: warnIf(across.atRisk.value), href: across.atRisk.href }),
              kpi('unassigned', 'Unassigned', across.unassigned.value, { tone: warnIf(across.unassigned.value), href: across.unassigned.href }),
            ]
          : []),
        kpi('major', 'Major', major.value, { tone: badOrGood(major.value), href: major.href }),
        kpi('onCall', 'On call', onCallCount, { tone: onCallCount ? null : 'warn', hint: onCall.length ? onCallText : 'Nobody is on call now' }),
        ...(silent.length ? [kpi('silent', 'Quiet integrations', silent.length, { tone: 'warn' })] : []),
      ];
      return {
        headline,
        kpis,
        sections: [
          ...(major.value || majors.items.length ? [section('major', 'Major incidents', majors.items, `${plural(major.value, 'major incident')} open${majors.overdue ? `, ${majors.overdue} with an overdue stakeholder update` : ''}.`, [major])] : []),
          ...sections,
          ...(silent.length ? [section('silent', 'Integrations that went quiet', silent, `${plural(silent.length, 'integration')} sent nothing in the last 24 hours.`, [figure('Quiet', silent.length)])] : []),
        ],
      };
    },
  };
}

// ---------------------------------------------------------------- service manager

const serviceManager: BriefingDefinition = {
  key: 'service_manager',
  label: 'Service manager',
  description: 'SLA compliance for the last seven days, escalated tickets, the ones likely to breach, major incidents and customers who sounded unhappy.',
  audience: 'staff',
  allowed: (ctx) => !isCustomerUser(ctx) && ctx.can('dashboards:management'),
  async build(ctx, { now, timezone }) {
    const from = new Date(now.getTime() - 7 * DAY);
    // The headline is the dashboards' figure (resolution clocks that ended in the last 7 whole days, the caller's security fence);
    // the per-priority section keeps the policy tables' definition (clocks started in the period, every metric) and says so.
    const today = toDay(now);
    const window = { from: addDays(today, -6), to: today };
    const resolution = await resolutionCompliance(ctx, { ...window, fence: socCond(ctx) });
    const compliance = await slaCompliance(ctx, { from: from.toISOString(), to: now.toISOString(), groupBy: 'priority' });
    const met = door('Met', resolution.met, ticketListPath({ status: 'any', slaOutcome: 'met', slaEndedFrom: window.from, slaEndedTo: window.to }));
    const breached = door('Breached', resolution.breached, ticketListPath({ status: 'any', slaOutcome: 'breached', slaEndedFrom: window.from, slaEndedTo: window.to }));
    // Counts first through the doors; the escalated and unhappy figures over every row.
    const likely = await staffDoor(ctx, 'Likely to breach', { breachRisk: 'high', status: 'open' });
    const major = await staffDoor(ctx, 'Major', { isMajor: true, status: 'open' });
    const [esc] = (await ctx.tx.execute(sql`SELECT count(*)::int AS n FROM tickets t WHERE t.escalation_level > 0 AND t.status_id IN (SELECT id FROM config_options WHERE type = 'ticket_status' AND status_category IN ('new', 'open', 'pending')) ${ctx.can('soc:read') ? sql`` : sql`AND t.domain <> 'soc'`}`)).rows as { n: number }[];
    const escalated = figure('Escalated', n(esc?.n));
    // Rows second.
    const escalatedRows = (await ctx.tx.execute(sql`
      SELECT t.id, t.number, t.title, t.escalation_level, cu.name AS customer, pr.key AS priority_key, pr.label AS priority, pr.color AS priority_color, u.name AS assignee, t.due_at
      FROM tickets t LEFT JOIN customers cu ON cu.id = t.customer_id LEFT JOIN config_options pr ON pr.id = t.priority_id LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.escalation_level > 0 AND t.status_id IN (SELECT id FROM config_options WHERE type = 'ticket_status' AND status_category IN ('new', 'open', 'pending'))
        ${ctx.can('soc:read') ? sql`` : sql`AND t.domain <> 'soc'`}
      ORDER BY t.escalation_level DESC, t.created_at ASC LIMIT 8`)).rows as { id: string; number: string; title: string; escalation_level: number; customer: string | null; priority_key: string | null; priority: string | null; priority_color: string | null; assignee: string | null; due_at: Date | null }[];
    const risky = await listTickets(ctx, listQuery({ open: true, breachRisk: 'high', sort: 'dueAt', order: 'asc', pageSize: 8 }));
    const majors = await majorItems(ctx, timezone);
    const unhappyRows = await listTickets(ctx, listQuery({ open: true, sentiment: 'unhappy', sort: 'updatedAt', order: 'desc', pageSize: 6 }));
    const unhappy = figure('Unhappy', unhappyRows.total);
    const pct = resolution.compliancePct;
    const worst = [...compliance.groups].filter((g) => g.compliancePct !== null).sort((a, b) => (a.compliancePct ?? 0) - (b.compliancePct ?? 0))[0];
    const headline = [
      `Resolution SLA compliance over the last 7 days is ${pctText(pct)} (${resolution.met} met, ${resolution.breached} breached, clocks that ended in the period)${worst ? `; lowest by clocks started: ${worst.label} at ${worst.compliancePct}%` : ''}.`,
      `${plural(escalated.value, 'ticket')} ${are(escalated.value)} escalated and ${plural(likely.value, 'ticket')} ${are(likely.value)} likely to breach.`,
      major.value ? `${plural(major.value, 'major incident')} open${majors.overdue ? `, ${majors.overdue} with an overdue stakeholder update` : ''}.` : 'No major incident is open.',
      ...(unhappy.value ? [`${plural(unhappy.value, 'customer')} sounded unhappy in their last message.`] : []),
    ];
    const kpis: BriefingKpi[] = [
      kpi('sla', 'SLA compliance · 7d', pct === null ? 'n/a' : `${pct}%`, { tone: toneOfCompliance(pct), hint: `${resolution.met} met · ${resolution.breached} breached` }),
      kpi('escalated', 'Escalated', escalated.value, { tone: warnIf(escalated.value) }),
      kpi('likely', 'Likely to breach', likely.value, { tone: warnIf(likely.value), href: likely.href }),
      kpi('major', 'Major', major.value, { tone: badOrGood(major.value), href: major.href }),
      kpi('unhappy', 'Unhappy', unhappy.value, { tone: unhappy.value ? 'bad' : null }),
    ];
    return {
      headline,
      kpis,
      sections: [
        section('sla', 'SLA by priority (7 days, clocks started in the period, every metric)', compliance.groups.map((g) => ({ ref: g.label, title: g.compliancePct === null ? 'no completed clocks' : `${g.compliancePct}% compliance`, meta: `${g.met} met · ${g.breached} breached`, link: '/reports?report=sla_performance', kind: 'sla' as const })), `Resolution SLA compliance over the last 7 days is ${pctText(pct)}: ${resolution.met} met, ${resolution.breached} breached.`, [met, breached]),
        section('escalated', 'Escalated', escalatedRows.map((t) => withMeta({ ref: t.number, title: t.title, link: `/tickets/${t.id}`, kind: 'ticket', priority: t.priority ? { key: t.priority_key, label: t.priority, color: t.priority_color } : null, customer: t.customer, assignee: t.assignee, dueAt: iso(t.due_at), status: `level ${t.escalation_level}` }, timezone, { owner: true })), escalated.value ? `${plural(escalated.value, 'open ticket')} ${are(escalated.value)} escalated.` : 'No open ticket is escalated.', [escalated]),
        section('risk', 'Likely to breach', risky.items.map((t) => ticketItem(t, timezone)), likely.value ? `${plural(likely.value, 'open ticket')} ${are(likely.value)} at high risk of breaching.` : 'No open ticket is at high risk of breaching.', [likely]),
        ...(major.value || majors.items.length ? [section('major', 'Major incidents', majors.items, `${plural(major.value, 'major incident')} open${majors.overdue ? `, ${majors.overdue} with an overdue stakeholder update` : ''}.`, [major])] : []),
        ...(unhappy.value ? [section('unhappy', 'Customers who sounded unhappy', unhappyRows.items.map((t) => ticketItem(t, timezone, t.lastSentiment?.sentiment ?? null)), `${plural(unhappy.value, 'customer')} sounded unhappy in their last message.`, [unhappy])] : []),
      ],
    };
  },
};

// ---------------------------------------------------------------- account manager

const accountManager: BriefingDefinition = {
  key: 'account_manager',
  label: 'Account manager',
  description: 'Your customers: open and breached tickets, P1/P2 in progress, contracts ending soon, entitlements running out and out-of-scope work this week.',
  audience: 'staff',
  allowed: (ctx) => !isCustomerUser(ctx) && ctx.can('customers:read'),
  async build(ctx, { now, timezone }) {
    const customers = await ctx.tx.select({ id: schema.customers.id, code: schema.customers.code, name: schema.customers.name }).from(schema.customers).where(and(eq(schema.customers.accountManagerId, ctx.user.id), eq(schema.customers.isActive, true))).orderBy(schema.customers.name).limit(50);
    if (!customers.length) return { headline: ['No active customer lists you as its account manager; ask an administrator to set it on the customer record.'], kpis: [kpi('customers', 'Customers', 0)], sections: [] };
    const ids = customers.map((c) => c.id);
    const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
    const openStatus = sql`(SELECT id FROM config_options WHERE type = 'ticket_status' AND status_category IN ('new', 'open', 'pending'))`;
    const weekAgo = new Date(now.getTime() - 7 * DAY);
    // Counts first: the per-customer doors by the list's own predicate, grouped (two statements, three with P1/P2), never a count per customer.
    const p12 = (await ctx.tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'ticket_priority'), lte(schema.configOptions.level, 2))).orderBy(schema.configOptions.level)).map((r) => r.id);
    const openBy = await countForLinkByCustomer(ctx, { status: 'open' }, ids);
    const breachedBy = await countForLinkByCustomer(ctx, { sla: 'breached' }, ids);
    const p1p2By = p12.length ? await countForLinkByCustomer(ctx, { priorityIds: p12, status: 'open' }, ids) : new Map<string, number>();
    // The figures with no list predicate: out of scope this week and unhappy, grouped the same way.
    const perCustomer = (await ctx.tx.execute(sql`
      SELECT t.customer_id,
        count(*) FILTER (WHERE t.scope_status = 'out_of_scope' AND t.created_at >= ${weekAgo})::int AS out_of_scope,
        count(*) FILTER (WHERE t.last_sentiment IN ('negative', 'angry') AND t.status_id IN ${openStatus})::int AS unhappy
      FROM tickets t WHERE t.customer_id IN (${idList}) ${ctx.can('soc:read') ? sql`` : sql`AND t.domain <> 'soc'`} GROUP BY t.customer_id`)).rows as { customer_id: string; out_of_scope: number; unhappy: number }[];
    const stats = new Map(perCustomer.map((r) => [r.customer_id, r]));
    // Rows second.
    const p1p2Rows = (await ctx.tx.execute(sql`
      SELECT t.id, t.number, t.title, cu.name AS customer, pr.key AS priority_key, pr.label AS priority, pr.color AS priority_color, u.name AS assignee, t.due_at
      FROM tickets t JOIN customers cu ON cu.id = t.customer_id LEFT JOIN config_options pr ON pr.id = t.priority_id LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.customer_id IN (${idList}) AND t.status_id IN ${openStatus} AND pr.level <= 2 ${ctx.can('soc:read') ? sql`` : sql`AND t.domain <> 'soc'`}
      ORDER BY pr.level, t.created_at LIMIT 8`)).rows as { id: string; number: string; title: string; customer: string; priority_key: string | null; priority: string | null; priority_color: string | null; assignee: string | null; due_at: Date | null }[];
    const canContracts = ctx.can('contracts:read');
    const expiring = canContracts ? (await expiringContracts(ctx, 60)).items.filter((c) => ids.includes(c.customerId)).slice(0, 8) : [];
    const ents = canContracts ? (await entitlementSummary(ctx, undefined, 500)).items.filter((e) => ids.includes(e.customerId) && (e.utilization.overThreshold || e.utilization.exhausted)).slice(0, 8) : [];
    const sum = (m: Map<string, number>) => ids.reduce((a, id) => a + (m.get(id) ?? 0), 0);
    const totals = { open: sum(openBy), breached: sum(breachedBy), p1p2: sum(p1p2By), oos: customers.reduce((a, c) => a + n(stats.get(c.id)?.out_of_scope), 0), unhappy: customers.reduce((a, c) => a + n(stats.get(c.id)?.unhappy), 0) };
    const names = new Map(customers.map((c) => [c.id, c.name]));
    const headline = [
      `Your ${plural(customers.length, 'customer')} ${have(customers.length)} ${plural(totals.open, 'open ticket')}, ${totals.breached} with a breached SLA and ${totals.p1p2} P1/P2 in progress.`,
      ...(expiring.length ? [`${plural(expiring.length, 'contract')} end${expiring.length === 1 ? 's' : ''} within 60 days${expiring[0] ? `, first ${expiring[0].number} (${names.get(expiring[0].customerId) ?? ''}) on ${String(expiring[0].endDate).slice(0, 10)}` : ''}.`] : []),
      ...(ents.length ? [`${plural(ents.length, 'entitlement')} ${are(ents.length)} over the warning threshold or exhausted.`] : []),
      ...(totals.oos ? [`${plural(totals.oos, 'out-of-scope request')} came in this week.`] : []),
      ...(totals.unhappy ? [`${plural(totals.unhappy, 'open ticket')} ${have(totals.unhappy)} a customer who sounded unhappy.`] : []),
    ];
    // The customer id is single on the list link, so the totals across customers are figures: the sums of the row doors.
    const kpis: BriefingKpi[] = [
      kpi('customers', 'Customers', customers.length),
      kpi('open', 'Open', totals.open),
      kpi('breached', 'Breached', totals.breached, { tone: badOrGood(totals.breached) }),
      kpi('p1p2', 'P1/P2', totals.p1p2, { tone: warnIf(totals.p1p2) }),
      ...(canContracts ? [kpi('contracts', 'Contracts ending', expiring.length, { tone: warnIf(expiring.length), hint: 'within 60 days' }), kpi('entitlements', 'Entitlements', ents.length, { tone: warnIf(ents.length), hint: 'over the threshold or exhausted' })] : []),
    ];
    const customerRow = (c: (typeof customers)[number]): BriefingItem => {
      const s = stats.get(c.id);
      const open = openBy.get(c.id) ?? 0;
      const breached = breachedBy.get(c.id) ?? 0;
      const p1p2 = p1p2By.get(c.id) ?? 0;
      return {
        ref: c.code,
        title: c.name,
        meta: `${open} open · ${breached} breached · ${p1p2} P1/P2 · ${n(s?.out_of_scope)} out of scope this week${n(s?.unhappy) ? ` · ${n(s?.unhappy)} unhappy` : ''}`,
        link: `/customers/${c.id}`,
        kind: 'customer',
        customer: c.name,
        doors: [
          door('Open', open, ticketListPath({ customerId: c.id, status: 'open' })),
          door('Breached', breached, ticketListPath({ customerId: c.id, sla: 'breached' })),
          ...(p12.length ? [door('P1/P2', p1p2, ticketListPath({ customerId: c.id, priorityIds: p12, status: 'open' }))] : [figure('P1/P2', p1p2)]),
        ],
      };
    };
    return {
      headline,
      kpis,
      sections: [
        section('customers', 'Your customers', customers.map(customerRow), `${plural(customers.length, 'customer')}: ${totals.open} open, ${totals.breached} breached, ${totals.p1p2} P1/P2.`, [figure('Open', totals.open), figure('Breached', totals.breached)]),
        section('p1p2', 'P1 and P2 in progress', p1p2Rows.map((t) => withMeta({ ref: t.number, title: t.title, link: `/tickets/${t.id}`, kind: 'ticket', priority: t.priority ? { key: t.priority_key, label: t.priority, color: t.priority_color } : null, customer: t.customer, assignee: t.assignee, dueAt: iso(t.due_at) }, timezone, { owner: true })), totals.p1p2 ? `${totals.p1p2} P1/P2 ${are(totals.p1p2)} open at your customers.` : 'No P1 or P2 is open at your customers.', [figure('P1/P2', totals.p1p2)]),
        ...(canContracts ? [section('contracts', 'Contracts ending within 60 days', expiring.map((c) => ({ ref: c.number, title: c.name, meta: `${names.get(c.customerId) ?? c.customerName ?? ''} · ends ${String(c.endDate).slice(0, 10)}`, link: `/contracts/${c.id}`, kind: 'contract' as const, customer: names.get(c.customerId) ?? null, when: String(c.endDate).slice(0, 10) })), expiring.length ? `${plural(expiring.length, 'contract')} end${expiring.length === 1 ? 's' : ''} within 60 days.` : 'No contract of yours ends within 60 days.', [figure('Ending', expiring.length)])] : []),
        ...(ents.length ? [section('entitlements', 'Entitlements running out', ents.map((e) => ({ ref: e.name, title: `${e.utilization.used} of ${e.utilization.quantity} ${e.unit} used (${e.utilization.pct}%)`, meta: `${names.get(e.customerId) ?? ''} · ${e.contractNumber}`, link: `/contracts/${e.contractId}`, kind: 'entitlement' as const, customer: names.get(e.customerId) ?? null })), `${plural(ents.length, 'entitlement')} ${are(ents.length)} over the warning threshold or exhausted.`, [figure('Running out', ents.length)])] : []),
      ],
    };
  },
};

// ---------------------------------------------------------------- the customer organisation (portal)

/**
 * The brief a portal user gets about their own organisation. Every number is
 * the portal home's (`dashboards.customer`, the organisation pinned, nothing
 * staff-only) and every door opens the portal ticket list; items come from
 * the portal list and carry no owner, no team, no risk and no mood. Doors and
 * item rows exist only with `portal:tickets` (the list refuses without it);
 * the approval door only with `portal:approve`.
 */
const customerDef: BriefingDefinition = {
  key: 'customer',
  label: 'Your organisation',
  description: 'Open tickets, what waits on you, breached and at-risk tickets, service levels, what is scheduled, contracts and known issues for your organisation.',
  audience: 'customer',
  allowed: (ctx) => isCustomerUser(ctx) && !!ctx.user.customerId && ctx.can('portal:access', ctx.user.customerId),
  async build(ctx, { timezone }) {
    const customerId = ctx.user.customerId!;
    const d = await customerDashboard(ctx, { days: 7 });
    const canTickets = ctx.can('portal:tickets', customerId);
    const canApprove = ctx.can('portal:approve', customerId);
    const canContracts = ctx.can('portal:contracts', customerId);
    const canKedb = ctx.can('portal:kedb', customerId);
    const canStatus = ctx.can('portal:status', customerId);
    const days = d.period.days;
    // The portal door: the home's number with the portal list it opens, or a figure without the list permission.
    const pdoor = (label: string, value: number, link: TicketListLink): BriefingDoor => (canTickets ? door(label, value, portalTicketListPath(link)) : figure(label, value));
    const open = pdoor('Open', d.tickets.open, { status: 'open' });
    // One word with the home tile and the list chip: what waits on the organisation (a reply or an approval), door `waitingOn=customer`;
    // of them, those awaiting its approval narrow by the status (a figure when that status is not configured, never the Open list).
    const awaiting = pdoor('Waiting on you', d.tickets.waitingOnYou, { status: 'open', waitingOn: ['customer'] });
    const approval = canApprove ? (d.tickets.awaitingApprovalStatusId ? pdoor('Awaiting your approval', d.tickets.awaitingApproval, { status: 'open', waitingOn: ['customer'], statusIds: [d.tickets.awaitingApprovalStatusId] }) : figure('Awaiting your approval', d.tickets.awaitingApproval)) : null;
    const breached = pdoor('Breached', d.tickets.breached, { sla: 'breached' });
    const atRisk = pdoor('At risk', d.tickets.atRisk, { sla: 'at_risk' });
    const toRate = pdoor('To rate', d.csat.pending.count, { statusCategories: ['resolved', 'closed'], csat: 'pending' });
    const ended = (outcome: 'met' | 'breached'): TicketListLink => ({ status: 'any', slaOutcome: outcome, slaEndedFrom: d.period.from, slaEndedTo: d.period.to });
    const met = pdoor('Met', d.sla.met, ended('met'));
    const slaBreached = pdoor('Breached', d.sla.breached, ended('breached'));
    const pct = d.sla.compliancePct;
    // Rows second, through the portal list (the organisation pinned, the portal aliases).
    const awaitingRows = canTickets ? (await listPortalTickets(ctx, portalListQuery.parse({ waitingOn: 'customer', pageSize: 5 }))).items : [];
    const breachedRows = canTickets ? (await listPortalTickets(ctx, portalListQuery.parse({ slaState: 'breached', pageSize: 5 }))).items : [];
    const u = d.upcoming;
    const scheduled = [`${plural(u.counts.visits, 'visit')}`, `${plural(u.counts.maintenance, 'maintenance window')}`, ...(u.counts.changes !== null ? [`${plural(u.counts.changes, 'change')}`] : [])];
    const headline = [
      `Your organisation has ${plural(open.value, 'open ticket')}, ${awaiting.value} waiting on you and ${breached.value} with a breached SLA.`,
      `Resolution SLA compliance over the last ${days} days is ${pctText(pct)} (${met.value} met, ${slaBreached.value} breached).`,
      `Scheduled in the next ${u.horizonDays} days: ${scheduled.join(', ')}${approval ? `; ${plural(approval.value, 'approval')} wait${approval.value === 1 ? 's' : ''} on you` : ''}.`,
      ...(toRate.value ? [`${plural(toRate.value, 'resolved ticket')} ${are(toRate.value)} waiting for your rating.`] : []),
    ];
    const kpis: BriefingKpi[] = [
      kpi('open', open.label, open.value, { href: open.href }),
      kpi('awaiting', awaiting.label, awaiting.value, { tone: warnIf(awaiting.value), href: awaiting.href }),
      kpi('breached', breached.label, breached.value, { tone: badOrGood(breached.value), href: breached.href }),
      kpi('atRisk', atRisk.label, atRisk.value, { tone: warnIf(atRisk.value), href: atRisk.href }),
      kpi('sla', `SLA compliance · ${days}d`, pct === null ? 'n/a' : `${pct}%`, { tone: toneOfCompliance(pct), hint: `${met.value} met · ${slaBreached.value} breached` }),
      kpi('toRate', toRate.label, toRate.value, { tone: warnIf(toRate.value), href: toRate.href }),
    ];
    const upcomingItems: BriefingItem[] = [
      ...u.visits.slice(0, 5).map((v) => withMeta({ ref: v.number, title: v.title, link: `/portal/maintenance?visit=${v.id}`, kind: 'visit' as const, when: iso(v.scheduledStart), status: v.status, customer: v.site }, timezone)),
      ...u.maintenance.slice(0, 5).map((m) => withMeta({ ref: m.program, title: `Maintenance window`, link: `/portal/maintenance?occurrence=${m.id}`, kind: 'maintenance' as const, when: m.scheduledDate ?? m.plannedDate, status: m.status, customer: m.site }, timezone)),
      ...(u.changes ?? []).slice(0, 5).map((c) => withMeta({ ref: c.number, title: c.title, link: `/portal/tickets/${c.id}`, kind: 'change' as const, when: iso(c.scheduledStart), status: c.state ?? null }, timezone)),
      ...(u.approvals ?? []).slice(0, 5).map((a) => withMeta({ ref: a.ticket.number, title: a.ticket.title, link: '/portal/approvals', kind: 'approval' as const, status: a.stepName ?? null, when: iso(a.createdAt) }, timezone)),
    ];
    const contractsEnding = d.contracts.filter((c) => n(c.days_to_expiry) <= 60);
    const entsOver = d.entitlements.filter((e) => e.overThreshold || e.exhausted);
    return {
      headline,
      kpis,
      sections: [
        section('awaiting', 'Waiting on you', awaitingRows.map((t) => portalTicketItem(t, timezone)), awaiting.value || (approval && approval.value) ? `${plural(awaiting.value, 'ticket')} wait${awaiting.value === 1 ? 's' : ''} on your reply${approval ? ` and ${approval.value} on your approval` : ''}.` : 'Nothing waits on you.', [awaiting, ...(approval ? [approval] : [])]),
        section('breached', 'Breached or at risk', breachedRows.map((t) => portalTicketItem(t, timezone)), breached.value + atRisk.value ? `${breached.value} breached and ${atRisk.value} at risk.` : 'No open ticket of yours is breached or at risk.', [breached, atRisk]),
        section('sla', `Service levels, last ${days} days`, d.sla.byPriority.map((g) => ({ ref: g.label, title: g.compliancePct === null ? 'no completed clocks' : `${g.compliancePct}% compliance`, meta: `${g.met} met · ${g.breached} breached`, link: canContracts ? '/portal/services/sla' : null, kind: 'sla' as const })), `Resolution SLA compliance over the last ${days} days is ${pctText(pct)}: ${met.value} met, ${slaBreached.value} breached.`, [met, slaBreached]),
        section('upcoming', 'Scheduled', upcomingItems, `In the next ${u.horizonDays} days: ${scheduled.join(', ')}${approval ? `; ${plural(approval.value, 'approval')} waiting on you` : ''}.`, [figure('Visits', u.counts.visits), figure('Maintenance', u.counts.maintenance), ...(u.counts.changes !== null ? [figure('Changes', u.counts.changes)] : []), ...(approval ? [approval] : [])]),
        ...(d.announcements.length ? [section('announcements', 'Announcements', d.announcements.map((a) => ({ ref: a.type, title: a.title, meta: a.body ? String(a.body).slice(0, 160) : null, link: canStatus ? '/portal/status' : null, kind: 'announcement' as const, when: iso(a.startsAt) })), `${plural(d.announcements.length, 'announcement')} for your organisation.`, [figure('Announcements', d.announcements.length)])] : []),
        ...(canContracts
          ? [section('contracts', 'Contracts and entitlements', [
              ...contractsEnding.map((c) => ({ ref: String(c.number), title: String(c.name), meta: `ends ${String(c.end_date).slice(0, 10)} (${n(c.days_to_expiry)} days)`, link: '/portal/services/contracts', kind: 'contract' as const, when: String(c.end_date).slice(0, 10) })),
              ...entsOver.map((e) => ({ ref: e.name, title: `${e.used} of ${e.quantity} ${e.unit} used (${e.pct}%)`, meta: e.contractNumber, link: '/portal/services/contracts', kind: 'entitlement' as const })),
            ], `${plural(contractsEnding.length, 'contract')} end${contractsEnding.length === 1 ? 's' : ''} within 60 days and ${plural(entsOver.length, 'entitlement')} ${are(entsOver.length)} over the warning threshold or exhausted.`, [figure('Ending', contractsEnding.length), figure('Entitlements', entsOver.length)])]
          : []),
        ...(canKedb && d.knownErrors.published ? [section('knownErrors', 'Known issues with a workaround', d.knownErrors.items.map((k) => ({ ref: k.number, title: k.title, meta: k.keStatus, link: `/knowledge/known-errors/${k.id}`, kind: 'known_error' as const, status: k.keStatus })), `${plural(d.knownErrors.published, 'known issue')} published for your organisation.`, [figure('Published', d.knownErrors.published)])] : []),
      ],
    };
  },
};

export const BRIEFING_DEFINITIONS: BriefingDefinition[] = [engineer, operationsManager('noc_manager', 'NOC manager', 'noc', null), operationsManager('soc_manager', 'SOC manager', 'soc', null), serviceManager, accountManager, customerDef];
export const BRIEFING_ROLES = BRIEFING_DEFINITIONS.map((d) => d.key) as BriefingRole[];
export const briefingDefinition = (key: string) => BRIEFING_DEFINITIONS.find((d) => d.key === key) ?? null;

/** Which side of the portal fence the caller is on. */
export const audienceOf = (ctx: Ctx): BriefingAudience => (isCustomerUser(ctx) ? 'customer' : 'staff');
/** The definitions the caller's audience may be offered: a customer sees their organisation's brief only, staff never see it. */
export const definitionsFor = (ctx: Ctx): BriefingDefinition[] => BRIEFING_DEFINITIONS.filter((d) => d.audience === audienceOf(ctx));

/** The role a person's briefing takes when they have not chosen one: a customer's organisation, else the most senior matching role, engineers otherwise. */
export function detectRole(ctx: Ctx): BriefingRole {
  if (isCustomerUser(ctx)) return 'customer';
  const keys = new Set(ctx.user.roles.map((r) => r.key));
  const pick = (role: BriefingRole) => briefingDefinition(role)!.allowed(ctx);
  if (keys.has('account_manager') && pick('account_manager')) return 'account_manager';
  if ((keys.has('service_manager') || keys.has('management') || keys.has('admin')) && pick('service_manager')) return 'service_manager';
  if (keys.has('soc_manager') && pick('soc_manager')) return 'soc_manager';
  if (keys.has('noc_manager') && pick('noc_manager')) return 'noc_manager';
  return 'engineer';
}
