import { sql, eq, and, inArray } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import type { BriefingFacts, BriefingItem, BriefingRole, BriefingSection } from '@/db/schema/briefings';
import { listTickets } from '@/modules/tickets/list';
import { listMajor } from '@/modules/tickets/major';
import { slaCompliance } from '@/modules/sla/policies';
import { expiringContracts } from '@/modules/contracts/service';
import { entitlementSummary } from '@/modules/contracts/entitlements';
import { buildDigest } from '@/modules/ai/digest';
import { listQuery } from '@/modules/ai/helpers';
import { BREACHED } from '@/modules/dashboards/common';

/**
 * What each role's morning briefing is made of. Every definition reads
 * through the person's own context, so row-level security, the SOC fence and
 * the customer scope apply exactly as on their dashboard; the figures are
 * exact and the model only phrases them.
 */

export interface BriefingDefinition {
  key: BriefingRole;
  label: string;
  description: string;
  /** May this person receive this briefing? */
  allowed(ctx: Ctx): boolean;
  build(ctx: Ctx, opts: { day: string; timezone: string; now: Date }): Promise<Pick<BriefingFacts, 'headline' | 'sections'>>;
}

type Row = Awaited<ReturnType<typeof listTickets>>['items'][number];
const DAY = 86_400_000;
const fmt = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null);
const n = (v: unknown) => Number(v ?? 0);
const plural = (count: number, word: string, pluralWord = `${word}s`) => `${count} ${count === 1 ? word : pluralWord}`;

const ticketItem = (t: Row, extra?: string | null): BriefingItem => ({
  ref: t.number,
  title: t.title,
  meta: [t.priority?.label, t.customerName, t.assigneeName ?? 'unassigned', t.dueAt ? `due ${fmt(t.dueAt)}` : null, t.breachRisk ? `${t.breachRisk.level} breach risk` : null, extra].filter(Boolean).join(' · '),
  link: `/tickets/${t.id}`,
});

const section = (key: string, title: string, items: BriefingItem[], summary?: string | null): BriefingSection => ({ key, title, summary: summary ?? null, items });

// ---------------------------------------------------------------- engineer

const engineer: BriefingDefinition = {
  key: 'engineer',
  label: 'Engineer',
  description: 'Your queue: what is due next, what is breached or likely to breach, and what sits unassigned in your team.',
  allowed: () => true,
  async build(ctx, { now }) {
    const mine = await listTickets(ctx, listQuery({ mine: true, open: true, sort: 'dueAt', order: 'asc', pageSize: 12 }));
    const soon = mine.items.filter((t) => t.dueAt && new Date(t.dueAt).getTime() - now.getTime() < DAY);
    const breached = await listTickets(ctx, listQuery({ mine: true, open: true, slaState: 'breached', sort: 'dueAt', order: 'asc', pageSize: 6 }));
    const risky = await listTickets(ctx, listQuery({ mine: true, open: true, breachRisk: 'high', sort: 'dueAt', order: 'asc', pageSize: 6 }));
    const team = ctx.user.teams[0] ?? null;
    const unassigned = team ? await listTickets(ctx, listQuery({ teamId: team.id, open: true, unassigned: true, sort: 'priority', order: 'asc', pageSize: 6 })) : null;
    const awaiting = await listTickets(ctx, listQuery({ mine: true, open: true, sentiment: 'unhappy', pageSize: 4 }));
    const riskyOnly = risky.items.filter((t) => !breached.items.some((b) => b.id === t.id));
    const headline = [
      `You have ${plural(mine.total, 'open ticket')}, ${plural(soon.length, 'due')} in the next 24 hours and ${breached.total} with a breached SLA.`,
      ...(riskyOnly.length ? [`${plural(riskyOnly.length, 'ticket')} of yours ${riskyOnly.length === 1 ? 'is' : 'are'} likely to breach without attention.`] : []),
      ...(unassigned && team ? [`${plural(unassigned.total, 'ticket')} in ${team.name} ${unassigned.total === 1 ? 'has' : 'have'} no owner.`] : []),
      ...(awaiting.total ? [`${plural(awaiting.total, 'customer')} on your tickets sounded unhappy in their last message.`] : []),
    ];
    return {
      headline,
      sections: [
        section('due', 'Due next', soon.slice(0, 8).map((t) => ticketItem(t)), soon.length ? null : 'Nothing of yours is due in the next 24 hours.'),
        section('breached', 'Breached or likely to breach', [...breached.items, ...riskyOnly].slice(0, 8).map((t) => ticketItem(t)), breached.total + riskyOnly.length ? null : 'No SLA of yours is breached or at high risk.'),
        ...(unassigned && team ? [section('unassigned', `Unassigned in ${team.name}`, unassigned.items.map((t) => ticketItem(t)), unassigned.total ? null : 'Everything in the team queue has an owner.')] : []),
        ...(awaiting.total ? [section('unhappy', 'Customers who sounded unhappy', awaiting.items.map((t) => ticketItem(t, t.lastSentiment?.sentiment ?? null)))] : []),
      ],
    };
  },
};

// ---------------------------------------------------------------- operations managers (NOC, SOC)

async function silentIntegrations(ctx: Ctx, now: Date, kinds: string[] | null): Promise<BriefingItem[]> {
  const cutoff = new Date(now.getTime() - DAY);
  const rows = await ctx.tx
    .select({ id: schema.integrations.id, name: schema.integrations.name, type: schema.integrations.integrationType, lastEventAt: schema.integrations.lastEventAt })
    .from(schema.integrations)
    .where(and(eq(schema.integrations.isActive, true), ...(kinds ? [inArray(schema.integrations.integrationType, kinds)] : []), sql`(${schema.integrations.lastEventAt} IS NULL OR ${schema.integrations.lastEventAt} < ${cutoff})`))
    .limit(10);
  return rows.map((r) => ({ ref: r.name, title: r.lastEventAt ? `no events since ${fmt(r.lastEventAt)}` : 'never sent an event', meta: r.type, link: `/admin/integrations/${r.id}` }));
}

function operationsManager(key: 'noc_manager' | 'soc_manager', label: string, teamType: 'noc' | 'soc', kinds: string[] | null): BriefingDefinition {
  return {
    key,
    label,
    description: `${teamType.toUpperCase()} picture: every team's open, breached and at-risk work, major incidents, who is on call and integrations that went quiet.`,
    allowed: (ctx) => ctx.can(`dashboards:${teamType}`) && (teamType === 'noc' || ctx.can('soc:read')),
    async build(ctx, { now }) {
      const own = ctx.user.teams.map((t) => t.id);
      const teams = await ctx.tx.select({ id: schema.teams.id, name: schema.teams.name }).from(schema.teams).where(and(eq(schema.teams.isActive, true), own.length ? inArray(schema.teams.id, own) : eq(schema.teams.teamType, teamType))).orderBy(schema.teams.name).limit(3);
      const sections: BriefingSection[] = [];
      const totals = { open: 0, p1p2: 0, breached: 0, atRisk: 0, unassigned: 0 };
      const major = new Map<string, BriefingItem>();
      const onCall: string[] = [];
      for (const team of teams) {
        // one client per transaction: teams one after another
        const d = await buildDigest(ctx, { teamId: team.id, from: new Date(now.getTime() - DAY), to: now, limit: 6 });
        totals.open += d.counts.open;
        totals.p1p2 += d.counts.p1p2;
        totals.breached += d.counts.breached;
        totals.atRisk += d.counts.atRisk;
        totals.unassigned += d.counts.unassigned;
        for (const m of d.major) major.set(m.id, { ref: m.number, title: m.title, meta: [m.customer, m.commander ? `commander ${m.commander}` : null, m.nextUpdateAt ? `next update ${fmt(m.nextUpdateAt)}` : null].filter(Boolean).join(' · '), link: `/tickets/${m.id}?tab=major` });
        if (d.onCall.now.length) onCall.push(`${team.name}: ${d.onCall.now.map((p) => p.name).join(', ')}`);
        const watch = [...(d.tickets.find((l) => l.key === 'p1p2')?.items ?? []), ...(d.tickets.find((l) => l.key === 'breached')?.items ?? []), ...(d.tickets.find((l) => l.key === 'unassigned')?.items ?? [])];
        const seen = new Set<string>();
        const items = watch.filter((t) => !seen.has(t.id) && seen.add(t.id)).slice(0, 8).map((t) => ({ ref: t.number, title: t.title, meta: [t.priority, t.customer, t.assignee ?? 'unassigned', t.breachRisk ? `${t.breachRisk} breach risk` : null].filter(Boolean).join(' · '), link: `/tickets/${t.id}` }));
        sections.push(section(`team:${team.id}`, team.name, items, `${d.counts.open} open, ${d.counts.p1p2} P1/P2, ${d.counts.breached} breached, ${d.counts.atRisk} at risk, ${d.counts.unassigned} unassigned; ${d.counts.openedInShift} opened and ${d.counts.resolvedInShift} resolved in the last 24 hours.`));
      }
      const silent = await silentIntegrations(ctx, now, kinds);
      const headline = [
        teams.length ? `Across ${teams.map((t) => t.name).join(', ')}: ${plural(totals.open, 'open ticket')}, ${totals.p1p2} P1/P2, ${totals.breached} breached, ${totals.atRisk} at risk, ${totals.unassigned} unassigned.` : `No active ${teamType.toUpperCase()} team is set up yet.`,
        major.size ? `${plural(major.size, 'major incident')} ${major.size === 1 ? 'is' : 'are'} active.` : 'No major incident is active.',
        ...(onCall.length ? [`On call now: ${onCall.join('; ')}.`] : []),
        ...(silent.length ? [`${plural(silent.length, 'integration')} sent nothing in the last 24 hours.`] : []),
      ];
      return {
        headline,
        sections: [
          ...(major.size ? [section('major', 'Major incidents', [...major.values()])] : []),
          ...sections,
          ...(silent.length ? [section('silent', 'Integrations that went quiet', silent)] : []),
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
  allowed: (ctx) => ctx.can('dashboards:management'),
  async build(ctx, { now }) {
    const from = new Date(now.getTime() - 7 * DAY);
    const compliance = await slaCompliance(ctx, { from: from.toISOString(), to: now.toISOString(), groupBy: 'priority' });
    const escalated = (await ctx.tx.execute(sql`
      SELECT t.id, t.number, t.title, t.escalation_level, cu.name AS customer, pr.label AS priority, u.name AS assignee
      FROM tickets t LEFT JOIN customers cu ON cu.id = t.customer_id LEFT JOIN config_options pr ON pr.id = t.priority_id LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.escalation_level > 0 AND t.status_id IN (SELECT id FROM config_options WHERE type = 'ticket_status' AND status_category IN ('new', 'open', 'pending'))
        ${ctx.can('soc:read') ? sql`` : sql`AND t.domain <> 'soc'`}
      ORDER BY t.escalation_level DESC, t.created_at ASC LIMIT 8`)).rows as { id: string; number: string; title: string; escalation_level: number; customer: string | null; priority: string | null; assignee: string | null }[];
    const [esc] = (await ctx.tx.execute(sql`SELECT count(*)::int AS n FROM tickets t WHERE t.escalation_level > 0 AND t.status_id IN (SELECT id FROM config_options WHERE type = 'ticket_status' AND status_category IN ('new', 'open', 'pending')) ${ctx.can('soc:read') ? sql`` : sql`AND t.domain <> 'soc'`}`)).rows as { n: number }[];
    const risky = await listTickets(ctx, listQuery({ open: true, breachRisk: 'high', sort: 'dueAt', order: 'asc', pageSize: 8 }));
    const major = await listMajor(ctx, { status: 'active', pageSize: 10 });
    const unhappy = await listTickets(ctx, listQuery({ open: true, sentiment: 'unhappy', sort: 'updatedAt', order: 'desc', pageSize: 6 }));
    const pct = compliance.totals.compliancePct;
    const worst = [...compliance.groups].filter((g) => g.compliancePct !== null).sort((a, b) => (a.compliancePct ?? 0) - (b.compliancePct ?? 0))[0];
    const headline = [
      `SLA compliance over the last 7 days is ${pct === null ? 'not measurable yet' : `${pct}%`} (${compliance.totals.met} met, ${compliance.totals.breached} breached)${worst ? `; lowest ${worst.label} at ${worst.compliancePct}%` : ''}.`,
      `${plural(n(esc?.n), 'ticket')} ${n(esc?.n) === 1 ? 'is' : 'are'} escalated and ${plural(risky.total, 'ticket')} ${risky.total === 1 ? 'is' : 'are'} likely to breach.`,
      major.summary.active ? `${plural(major.summary.active, 'major incident')} ${major.summary.active === 1 ? 'is' : 'are'} active${major.summary.overdue ? `, ${major.summary.overdue} with an overdue stakeholder update` : ''}.` : 'No major incident is active.',
      ...(unhappy.total ? [`${plural(unhappy.total, 'customer')} sounded unhappy in their last message.`] : []),
    ];
    return {
      headline,
      sections: [
        section('sla', 'SLA by priority (7 days)', compliance.groups.map((g) => ({ ref: g.label, title: g.compliancePct === null ? 'no completed clocks' : `${g.compliancePct}% compliance`, meta: `${g.met} met · ${g.breached} breached`, link: '/reports?report=sla_performance' }))),
        section('escalated', 'Escalated', escalated.map((t) => ({ ref: t.number, title: t.title, meta: [`level ${t.escalation_level}`, t.priority, t.customer, t.assignee ?? 'unassigned'].filter(Boolean).join(' · '), link: `/tickets/${t.id}` })), n(esc?.n) ? null : 'No open ticket is escalated.'),
        section('risk', 'Likely to breach', risky.items.map((t) => ticketItem(t)), risky.total ? null : 'No open ticket is at high risk of breaching.'),
        ...(major.items.length ? [section('major', 'Major incidents', major.items.map((m) => ({ ref: m.number, title: m.title, meta: [m.customerName, m.commanderName ? `commander ${m.commanderName}` : null, m.overdue ? 'update overdue' : m.nextUpdateDueAt ? `next update ${fmt(m.nextUpdateDueAt)}` : null].filter(Boolean).join(' · '), link: `/tickets/${m.ticketId}?tab=major` })))] : []),
        ...(unhappy.total ? [section('unhappy', 'Customers who sounded unhappy', unhappy.items.map((t) => ticketItem(t, t.lastSentiment?.sentiment ?? null)))] : []),
      ],
    };
  },
};

// ---------------------------------------------------------------- account manager

const accountManager: BriefingDefinition = {
  key: 'account_manager',
  label: 'Account manager',
  description: 'Your customers: open and breached tickets, P1/P2 in progress, contracts ending soon, entitlements running out and out-of-scope work this week.',
  allowed: (ctx) => ctx.can('customers:read'),
  async build(ctx, { now }) {
    const customers = await ctx.tx.select({ id: schema.customers.id, code: schema.customers.code, name: schema.customers.name }).from(schema.customers).where(and(eq(schema.customers.accountManagerId, ctx.user.id), eq(schema.customers.isActive, true))).orderBy(schema.customers.name).limit(50);
    if (!customers.length) return { headline: ['No active customer lists you as its account manager; ask an administrator to set it on the customer record.'], sections: [] };
    const ids = customers.map((c) => c.id);
    const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
    const openStatus = sql`(SELECT id FROM config_options WHERE type = 'ticket_status' AND status_category IN ('new', 'open', 'pending'))`;
    const weekAgo = new Date(now.getTime() - 7 * DAY);
    const perCustomer = (await ctx.tx.execute(sql`
      SELECT t.customer_id,
        count(*) FILTER (WHERE t.status_id IN ${openStatus})::int AS open,
        count(*) FILTER (WHERE t.status_id IN ${openStatus} AND ${BREACHED})::int AS breached,
        count(*) FILTER (WHERE t.scope_status = 'out_of_scope' AND t.created_at >= ${weekAgo})::int AS out_of_scope,
        count(*) FILTER (WHERE t.last_sentiment IN ('negative', 'angry') AND t.status_id IN ${openStatus})::int AS unhappy
      FROM tickets t WHERE t.customer_id IN (${idList}) ${ctx.can('soc:read') ? sql`` : sql`AND t.domain <> 'soc'`} GROUP BY t.customer_id`)).rows as { customer_id: string; open: number; breached: number; out_of_scope: number; unhappy: number }[];
    const stats = new Map(perCustomer.map((r) => [r.customer_id, r]));
    const p1p2 = (await ctx.tx.execute(sql`
      SELECT t.id, t.number, t.title, cu.name AS customer, pr.label AS priority, u.name AS assignee, t.due_at
      FROM tickets t JOIN customers cu ON cu.id = t.customer_id LEFT JOIN config_options pr ON pr.id = t.priority_id LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.customer_id IN (${idList}) AND t.status_id IN ${openStatus} AND pr.level <= 2 ${ctx.can('soc:read') ? sql`` : sql`AND t.domain <> 'soc'`}
      ORDER BY pr.level, t.created_at LIMIT 8`)).rows as { id: string; number: string; title: string; customer: string; priority: string | null; assignee: string | null; due_at: Date | null }[];
    const canContracts = ctx.can('contracts:read');
    const expiring = canContracts ? (await expiringContracts(ctx, 60)).items.filter((c) => ids.includes(c.customerId)).slice(0, 8) : [];
    const ents = canContracts ? (await entitlementSummary(ctx, undefined, 500)).items.filter((e) => ids.includes(e.customerId) && (e.utilization.overThreshold || e.utilization.exhausted)).slice(0, 8) : [];
    const totals = customers.reduce((a, c) => { const s = stats.get(c.id); return { open: a.open + n(s?.open), breached: a.breached + n(s?.breached), oos: a.oos + n(s?.out_of_scope), unhappy: a.unhappy + n(s?.unhappy) }; }, { open: 0, breached: 0, oos: 0, unhappy: 0 });
    const names = new Map(customers.map((c) => [c.id, c.name]));
    const headline = [
      `Your ${plural(customers.length, 'customer')} ${customers.length === 1 ? 'has' : 'have'} ${plural(totals.open, 'open ticket')}, ${totals.breached} with a breached SLA and ${p1p2.length} P1/P2 in progress.`,
      ...(expiring.length ? [`${plural(expiring.length, 'contract')} end${expiring.length === 1 ? 's' : ''} within 60 days${expiring[0] ? `, first ${expiring[0].number} (${names.get(expiring[0].customerId) ?? ''}) on ${String(expiring[0].endDate).slice(0, 10)}` : ''}.`] : []),
      ...(ents.length ? [`${plural(ents.length, 'entitlement')} ${ents.length === 1 ? 'is' : 'are'} over the warning threshold or exhausted.`] : []),
      ...(totals.oos ? [`${plural(totals.oos, 'out-of-scope request')} came in this week.`] : []),
      ...(totals.unhappy ? [`${plural(totals.unhappy, 'open ticket')} ${totals.unhappy === 1 ? 'has' : 'have'} a customer who sounded unhappy.`] : []),
    ];
    return {
      headline,
      sections: [
        section('customers', 'Your customers', customers.map((c) => { const s = stats.get(c.id); return { ref: c.code, title: c.name, meta: `${n(s?.open)} open · ${n(s?.breached)} breached · ${n(s?.out_of_scope)} out of scope this week${n(s?.unhappy) ? ` · ${n(s?.unhappy)} unhappy` : ''}`, link: `/customers/${c.id}` }; })),
        section('p1p2', 'P1 and P2 in progress', p1p2.map((t) => ({ ref: t.number, title: t.title, meta: [t.priority, t.customer, t.assignee ?? 'unassigned', t.due_at ? `due ${fmt(t.due_at)}` : null].filter(Boolean).join(' · '), link: `/tickets/${t.id}` })), p1p2.length ? null : 'No P1 or P2 is open at your customers.'),
        ...(canContracts ? [section('contracts', 'Contracts ending within 60 days', expiring.map((c) => ({ ref: c.number, title: c.name, meta: `${names.get(c.customerId) ?? c.customerName ?? ''} · ends ${String(c.endDate).slice(0, 10)}`, link: `/contracts/${c.id}` })), expiring.length ? null : 'No contract of yours ends within 60 days.')] : []),
        ...(ents.length ? [section('entitlements', 'Entitlements running out', ents.map((e) => ({ ref: e.name, title: `${e.utilization.used} of ${e.utilization.quantity} ${e.unit} used (${e.utilization.pct}%)`, meta: `${names.get(e.customerId) ?? ''} · ${e.contractNumber}`, link: `/contracts/${e.contractId}` })))] : []),
      ],
    };
  },
};

export const BRIEFING_DEFINITIONS: BriefingDefinition[] = [engineer, operationsManager('noc_manager', 'NOC manager', 'noc', null), operationsManager('soc_manager', 'SOC manager', 'soc', null), serviceManager, accountManager];
export const BRIEFING_ROLES = BRIEFING_DEFINITIONS.map((d) => d.key) as BriefingRole[];
export const briefingDefinition = (key: string) => BRIEFING_DEFINITIONS.find((d) => d.key === key) ?? null;

/** The role a person's briefing takes when they have not chosen one: the most senior matching role, engineers otherwise. */
export function detectRole(ctx: Ctx): BriefingRole {
  const keys = new Set(ctx.user.roles.map((r) => r.key));
  const pick = (role: BriefingRole) => briefingDefinition(role)!.allowed(ctx);
  if (keys.has('account_manager') && pick('account_manager')) return 'account_manager';
  if ((keys.has('service_manager') || keys.has('management') || keys.has('admin')) && pick('service_manager')) return 'service_manager';
  if (keys.has('soc_manager') && pick('soc_manager')) return 'soc_manager';
  if (keys.has('noc_manager') && pick('noc_manager')) return 'noc_manager';
  return 'engineer';
}
