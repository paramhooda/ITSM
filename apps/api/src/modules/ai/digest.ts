import { sql, eq, and } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { NotFoundError } from '@/core/errors';
import { listTickets } from '@/modules/tickets/list';
import { listMajor } from '@/modules/tickets/major';
import { calendar as changeCalendar } from '@/modules/changes/service';
import { whoIsOnCall, userMap } from '@/modules/oncall/service';
import type { HandoverFacts } from '@/db/schema/handover';
import { listQuery } from './helpers';

/**
 * The operations digest behind shift handovers and daily briefings: exact
 * counts and the short lists behind them for one team, read through the
 * caller's context so row-level security and the SOC fence apply. Everything
 * here is deterministic; the model only phrases it.
 */

export interface DigestOptions {
  teamId: string;
  /** The window the digest reports movement for (tickets opened and resolved); defaults to the last 12 hours. */
  from?: Date;
  to?: Date;
  /** When the incoming shift starts, for the "on call next" line; defaults to `to`. */
  nextAt?: Date;
  /** Rows per list (default 8). */
  limit?: number;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

async function priorityIds(ctx: Ctx, levels: number[]) {
  const rows = await ctx.tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'ticket_priority'), sql`${schema.configOptions.level} = ANY(ARRAY[${sql.join(levels.map((l) => sql`${l}::int`), sql`, `)}])`));
  return rows.map((r) => r.id);
}

async function statusIdsByKey(ctx: Ctx, keys: string[]) {
  const rows = await ctx.tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'ticket_status'), sql`${schema.configOptions.key} = ANY(ARRAY[${sql.join(keys.map((k) => sql`${k}`), sql`, `)}])`));
  return rows.map((r) => r.id);
}

type Row = Awaited<ReturnType<typeof listTickets>>['items'][number];
const compact = (t: Row): HandoverFacts['tickets'][number]['items'][number] => ({ id: t.id, number: t.number, title: t.title, priority: t.priority?.label ?? null, status: t.status?.label ?? null, customer: t.customerName ?? null, assignee: t.assigneeName ?? null, slaDueAt: iso(t.dueAt), breachRisk: t.breachRisk?.level ?? null });

export async function buildDigest(ctx: Ctx, opts: DigestOptions): Promise<HandoverFacts> {
  const [team] = await ctx.tx.select({ id: schema.teams.id, name: schema.teams.name }).from(schema.teams).where(eq(schema.teams.id, opts.teamId)).limit(1);
  if (!team) throw new NotFoundError('Team');
  const to = opts.to ?? new Date();
  const from = opts.from ?? new Date(to.getTime() - 12 * 3_600_000);
  const limit = opts.limit ?? 8;
  const base = { teamId: team.id, open: true, page: 1, pageSize: limit } as const;
  // one client per transaction: the lists run one after another
  const p12 = await priorityIds(ctx, [1, 2]);
  const awaiting = await statusIdsByKey(ctx, ['pending_customer']);
  const all = await listTickets(ctx, listQuery({ ...base, pageSize: 1 }));
  const p1p2 = p12.length ? await listTickets(ctx, listQuery({ ...base, priorityId: p12.join(','), sort: 'priority', order: 'asc' })) : { items: [] as Row[], total: 0 };
  const breached = await listTickets(ctx, listQuery({ ...base, slaState: 'breached', sort: 'dueAt', order: 'asc' }));
  const atRisk = await listTickets(ctx, listQuery({ ...base, slaState: 'at_risk', sort: 'dueAt', order: 'asc' }));
  const highRisk = await listTickets(ctx, listQuery({ ...base, breachRisk: 'high', sort: 'dueAt', order: 'asc' }));
  const unassigned = await listTickets(ctx, listQuery({ ...base, unassigned: true, sort: 'priority', order: 'asc' }));
  const awaitingCustomer = awaiting.length ? await listTickets(ctx, listQuery({ ...base, statusId: awaiting.join(','), sort: 'updatedAt', order: 'asc' })) : { items: [] as Row[], total: 0 };
  const major = await listMajor(ctx, { status: 'active', pageSize: 20 });
  const changes = await changeCalendar(ctx, { from: to, to: new Date(to.getTime() + 12 * 3_600_000), blackouts: false });
  const movement = await ctx.tx.execute(sql`
    SELECT count(*) FILTER (WHERE created_at >= ${from} AND created_at < ${to})::int AS opened,
           count(*) FILTER (WHERE resolved_at >= ${from} AND resolved_at < ${to})::int AS resolved
    FROM tickets WHERE assigned_team_id = ${team.id}::uuid`);
  const moved = (movement.rows[0] ?? { opened: 0, resolved: 0 }) as { opened: number; resolved: number };
  const nowEntries = await whoIsOnCall(ctx.tx, team.id, to);
  const nextAt = opts.nextAt ?? to;
  const nextEntries = nextAt.getTime() === to.getTime() ? nowEntries : await whoIsOnCall(ctx.tx, team.id, nextAt);
  const names = await userMap(ctx.tx, [...nowEntries.map((e) => e.userId), ...nextEntries.map((e) => e.userId)]);
  const person = (e: (typeof nowEntries)[number]) => (e.userId && names.get(e.userId) ? { userId: e.userId, name: names.get(e.userId)!.name, rota: e.rotaName } : null);
  // tickets at risk: the SLA engine's warning plus the breach-risk forecast, without duplicates
  const riskItems = [...atRisk.items, ...highRisk.items.filter((t) => !atRisk.items.some((a) => a.id === t.id))].slice(0, limit);
  const riskTotal = atRisk.total + highRisk.items.filter((t) => !atRisk.items.some((a) => a.id === t.id)).length;
  return {
    generatedAt: to.toISOString(),
    team,
    window: { from: from.toISOString(), to: to.toISOString() },
    counts: { open: all.total, p1p2: p1p2.total, breached: breached.total, atRisk: riskTotal, unassigned: unassigned.total, awaitingCustomer: awaitingCustomer.total, major: major.summary.active, changesNext: changes.counts.changes, openedInShift: Number(moved.opened ?? 0), resolvedInShift: Number(moved.resolved ?? 0) },
    tickets: [
      { key: 'p1p2', title: 'Open P1 and P2', items: p1p2.items.map(compact) },
      { key: 'breached', title: 'SLA breached', items: breached.items.map(compact) },
      { key: 'atRisk', title: 'SLA at risk', items: riskItems.map(compact) },
      { key: 'awaitingCustomer', title: 'Waiting on the customer', items: awaitingCustomer.items.map(compact) },
      { key: 'unassigned', title: 'Unassigned', items: unassigned.items.map(compact) },
    ],
    major: major.items.map((m) => ({ id: m.ticketId, number: m.number, title: m.title, status: m.status, customer: m.customerName ?? null, commander: m.commanderName ?? null, nextUpdateAt: iso(m.nextUpdateDueAt) })),
    changes: changes.items.slice(0, 20).map((c) => ({ id: c.ticketId, number: c.number, title: c.title, customer: c.customerName ?? null, scheduledStart: iso(c.scheduledStart), scheduledEnd: iso(c.scheduledEnd), changeType: c.changeType ?? null })),
    onCall: {
      now: nowEntries.map((e) => person(e)).filter((x): x is NonNullable<typeof x> => !!x).map((x) => ({ ...x, until: iso(nowEntries.find((e) => e.userId === x.userId)?.until ?? null) })),
      next: nextEntries.map((e) => person(e)).filter((x): x is NonNullable<typeof x> => !!x).map((x) => ({ ...x, from: nextAt.toISOString() })),
    },
  };
}

const line = (t: HandoverFacts['tickets'][number]['items'][number]) => `- **${t.number}** ${t.title}${t.priority ? ` (${t.priority}` : ''}${t.customer ? `${t.priority ? ', ' : ' ('}${t.customer}` : ''}${t.priority || t.customer ? ')' : ''}${t.assignee ? ` — ${t.assignee}` : ' — unassigned'}${t.slaDueAt ? `, due ${t.slaDueAt.slice(0, 16).replace('T', ' ')} UTC` : ''}`;

/** The handover note without a model: the same headings, the facts as bullets. */
export function renderHandover(facts: HandoverFacts, notes?: string | null): string {
  const c = facts.counts;
  const lists = Object.fromEntries(facts.tickets.map((t) => [t.key, t]));
  const watch = [...(lists.p1p2?.items ?? []), ...(lists.breached?.items ?? []).filter((t) => !lists.p1p2?.items.some((p) => p.id === t.id)), ...(lists.atRisk?.items ?? []).filter((t) => !lists.p1p2?.items.some((p) => p.id === t.id) && !lists.breached?.items.some((p) => p.id === t.id))].slice(0, 5);
  const fmt = (d: string | null) => (d ? `${d.slice(0, 16).replace('T', ' ')} UTC` : 'n/a');
  const out: string[] = [];
  out.push('## Watch first');
  out.push(watch.length ? watch.map(line).join('\n') : '- Nothing urgent is open for the team.');
  out.push('', '## Open and at risk');
  out.push(`- ${c.open} open ticket${c.open === 1 ? '' : 's'}: ${c.p1p2} P1/P2, ${c.breached} with a breached SLA, ${c.atRisk} at risk, ${c.unassigned} unassigned, ${c.awaitingCustomer} waiting on the customer.`);
  out.push(`- During the shift ${c.openedInShift} ticket${c.openedInShift === 1 ? ' was' : 's were'} opened and ${c.resolvedInShift} resolved.`);
  for (const key of ['awaitingCustomer', 'unassigned'] as const) {
    const l = lists[key];
    if (l?.items.length) out.push(`- ${l.title}: ${l.items.slice(0, 5).map((t) => t.number).join(', ')}${l.items.length > 5 ? ' …' : ''}`);
  }
  out.push('', '## Major incidents');
  out.push(facts.major.length ? facts.major.map((m) => `- **${m.number}** ${m.title}${m.customer ? ` (${m.customer})` : ''}${m.commander ? `, commander ${m.commander}` : ''}${m.nextUpdateAt ? `, next update due ${fmt(m.nextUpdateAt)}` : ''}`).join('\n') : 'None');
  out.push('', '## Scheduled next');
  out.push(facts.changes.length ? facts.changes.map((ch) => `- **${ch.number}** ${ch.title}${ch.customer ? ` (${ch.customer})` : ''}: ${fmt(ch.scheduledStart)} to ${fmt(ch.scheduledEnd)}${ch.changeType ? `, ${ch.changeType}` : ''}`).join('\n') : 'Nothing scheduled in the next 12 hours');
  out.push('', '## On call');
  out.push(facts.onCall.now.length ? `- Now: ${facts.onCall.now.map((p) => `${p.name}${p.rota ? ` (${p.rota})` : ''}${p.until ? ` until ${fmt(p.until)}` : ''}`).join('; ')}` : '- Now: nobody is on a rota for this team.');
  if (facts.onCall.next.length) out.push(`- Next: ${facts.onCall.next.map((p) => `${p.name}${p.rota ? ` (${p.rota})` : ''}`).join('; ')}`);
  out.push('', '## Notes');
  out.push(notes?.trim() ? notes.trim() : 'None');
  return out.join('\n');
}
