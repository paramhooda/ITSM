import { z } from 'zod';
import { listMajor, getMajor, declareMajor, demoteMajor, updateMajor, postMajorUpdate, addChild, type MajorPatch } from '@/modules/tickets/major';
import { define, type PreviewDetail } from './types';
import { ticketRef } from './core';
import { ticketLink, iso, trunc, resolveTicket, resolveCustomerId, resolveEngineer, resolveTeam } from '../helpers';
import { onCallNow, listPolicies } from '@/modules/oncall/service';
import { pageTicket, listPages } from '@/modules/oncall/paging';
import { createAnnouncement } from '@/modules/status/service';
import { digest as handoverDigest, list as listHandovers } from '@/modules/handover/service';

/** Major incident tools: the bridge, the commander, stakeholder updates (outbound) and the post-incident review. */

const short = (t: { number: string; title: string }) => `${t.number} ("${t.title.slice(0, 80)}")`;

const majorRef = ticketRef.describe('The major incident ticket (number such as INC-000123, or id)');

export const INCIDENT: ReturnType<typeof define>[] = [
  define({
    name: 'major_incidents',
    toolset: 'incident',
    description: 'Major incidents in progress (or recently resolved): bridge, commander, last and next stakeholder update, child incidents. Use for "any major incidents?", "what is on the bridge", "is the MI update overdue".',
    inputSchema: z.object({ status: z.enum(['active', 'resolved', 'review_done', 'all']).optional().describe('Defaults to active'), customer: z.string().max(200).optional() }),
    requires: ['tickets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const customerId = input.customer ? await resolveCustomerId(ctx, input.customer, false) : null;
      const res = await listMajor(ctx, { status: input.status ?? 'active', customerId: customerId ?? undefined, pageSize: 20 });
      return {
        summary: res.summary,
        facts: [`${res.summary.active} active major incident(s), ${res.summary.overdue} with an overdue stakeholder update, ${res.summary.awaitingReview} awaiting a post-incident review`],
        items: res.items.map((m) => ({ number: m.number, title: m.title, customer: m.customerName, status: m.status, ticketStatus: m.ticketStatus?.label ?? null, priority: m.priority?.label ?? null, declaredAt: iso(m.declaredAt), commander: m.commanderName, commsLead: m.commsLeadName, lastUpdateAt: iso(m.lastUpdateAt), nextUpdateDueAt: iso(m.nextUpdateDueAt), updateOverdue: m.overdue, stakeholderUpdates: m.updatesCount, childIncidents: m.childrenCount, bridge: m.bridgeUrl, link: ticketLink(ctx, m.ticketId) })),
      };
    },
    summary: (input, result) => `Listed ${(result as { items: unknown[] }).items.length} ${input.status ?? 'active'} major incident(s)`,
  }),

  define({
    name: 'major_incident_detail',
    toolset: 'incident',
    description: 'One major incident in full: declaration, commander and communications lead, bridge, update cadence and overdue state, the stakeholder update log, child incidents and the post-incident review.',
    inputSchema: z.object({ ticket: majorRef }),
    requires: ['tickets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const m = await getMajor(ctx, t.id);
      if (!m.record) return { ticket: t.number, title: t.title, isMajor: false, link: ticketLink(ctx, t.id), message: 'This ticket has never been declared a major incident' };
      const r = m.record;
      return {
        ticket: t.number,
        title: t.title,
        isMajor: t.isMajor,
        link: ticketLink(ctx, t.id),
        record: {
          status: r.status,
          declaredAt: iso(r.declaredAt),
          declaredBy: r.declaredByName,
          commander: r.commanderName,
          commsLead: r.commsLeadName,
          bridgeUrl: r.bridgeUrl,
          bridgeNotes: trunc(r.bridgeNotes, 800),
          updateIntervalMinutes: r.updateIntervalMinutes,
          lastUpdateAt: iso(r.lastUpdateAt),
          nextUpdateDueAt: iso(r.nextUpdateDueAt),
          updateOverdue: r.overdue,
          portalBanner: r.portalBanner,
          resolvedAt: iso(r.resolvedAt),
          review: { completedAt: iso(r.pirCompletedAt), whatHappened: trunc(r.pirWhatHappened, 800), impact: trunc(r.pirImpact, 600), rootCause: trunc(r.pirRootCause, 600), actions: r.pirActions.slice(0, 10).map((a) => { const x = a as unknown as Record<string, unknown>; return { action: String(x.action ?? x.title ?? ''), owner: a.ownerName ?? null, status: x.status ?? null, dueDate: x.dueDate ?? null }; }) },
        },
        updates: m.updates.slice(0, 6).map((u) => ({ at: iso(u.createdAt), kind: u.kind, by: u.authorName, body: trunc(u.body, 600), sentCount: u.sentCount })),
        children: m.children.map((c) => ({ number: c.number, title: c.title, status: c.status, priority: c.priority, link: ticketLink(ctx, c.id) })),
      };
    },
    summary: (input) => `Read major incident ${input.ticket}`,
  }),

  define({
    name: 'declare_major',
    toolset: 'incident',
    description: 'Declare an incident a major incident: opens the bridge programme (commander, communications lead, stakeholder update cadence, optional portal banner). Use only on explicit instruction naming the ticket.',
    inputSchema: z.object({ ticket: ticketRef, reason: z.string().max(1000).optional(), bridgeUrl: z.string().max(500).optional(), commander: z.string().max(200).optional().describe('Engineer name or email'), commsLead: z.string().max(200).optional(), updateIntervalMinutes: z.number().int().min(5).max(1440).optional(), portalBanner: z.boolean().optional() }),
    requires: ['tickets:major'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const [commander, commsLead] = await Promise.all([resolveEngineer(ctx, input.commander), resolveEngineer(ctx, input.commsLead)]);
      const m = await declareMajor(ctx, t.id, { reason: input.reason ?? null, bridgeUrl: input.bridgeUrl ?? null, commanderUserId: commander?.id ?? null, commsLeadUserId: commsLead?.id ?? null, updateIntervalMinutes: input.updateIntervalMinutes, portalBanner: input.portalBanner });
      return { ticket: t.number, status: m.record?.status ?? 'active', declaredAt: iso(m.record?.declaredAt), nextUpdateDueAt: iso(m.record?.nextUpdateDueAt), link: ticketLink(ctx, t.id) };
    },
    summary: (input) => `Declared ${input.ticket} a major incident`,
    preview: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const [commander, commsLead] = await Promise.all([resolveEngineer(ctx, input.commander), resolveEngineer(ctx, input.commsLead)]);
      const parts = [commander ? `${commander.name} as commander` : null, commsLead ? `${commsLead.name} as communications lead` : null, input.updateIntervalMinutes ? `updates every ${input.updateIntervalMinutes} min` : null, input.portalBanner ? 'a portal banner' : null].filter(Boolean);
      return `Declare ${short(t)} a major incident${parts.length ? ` with ${parts.join(', ')}` : ''}${input.reason ? ` (reason: ${input.reason.slice(0, 120)})` : ''}; the usual roles are notified`;
    },
  }),

  define({
    name: 'demote_major',
    toolset: 'incident',
    description: 'Mark a ticket as no longer a major incident (the record stays for the audit trail; the banner and the update cadence stop).',
    inputSchema: z.object({ ticket: majorRef, reason: z.string().max(1000).optional() }),
    requires: ['tickets:major'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      await demoteMajor(ctx, t.id, { reason: input.reason ?? null });
      return { ticket: t.number, isMajor: false, link: ticketLink(ctx, t.id) };
    },
    summary: (input) => `${input.ticket} is no longer a major incident`,
    preview: async (ctx, input) => `Mark ${short(await resolveTicket(ctx, input.ticket))} as no longer a major incident${input.reason ? ` (${input.reason.slice(0, 120)})` : ''}`,
  }),

  define({
    name: 'update_major',
    toolset: 'incident',
    description: 'Change the major incident programme: bridge link or notes, commander, communications lead, update interval, portal banner, the record status (active, resolved, review_done) or the post-incident review text.',
    inputSchema: z.object({
      ticket: majorRef,
      bridgeUrl: z.string().max(500).nullable().optional(),
      bridgeNotes: z.string().max(4000).nullable().optional(),
      commander: z.string().max(200).optional(),
      commsLead: z.string().max(200).optional(),
      updateIntervalMinutes: z.number().int().min(5).max(1440).optional(),
      portalBanner: z.boolean().optional(),
      status: z.enum(['active', 'resolved', 'review_done']).optional(),
      pirWhatHappened: z.string().max(8000).optional(),
      pirImpact: z.string().max(4000).optional(),
      pirRootCause: z.string().max(4000).optional(),
    }),
    requires: ['tickets:major'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const { patch } = await majorPatch(ctx, input);
      const m = await updateMajor(ctx, t.id, patch);
      return { ticket: t.number, status: m.record?.status ?? null, changed: Object.keys(patch), link: ticketLink(ctx, t.id) };
    },
    summary: (input, result) => `Updated major incident ${input.ticket} (${((result as { changed?: string[] }).changed ?? []).join(', ')})`,
    preview: async (ctx, input): Promise<PreviewDetail> => {
      const t = await resolveTicket(ctx, input.ticket);
      const { lines } = await majorPatch(ctx, input);
      if (!lines.length) return { text: `No change requested for ${short(t)}`, lines };
      return { text: `Update major incident ${short(t)}: ${lines.join('; ')}`, lines };
    },
  }),

  define({
    name: 'post_major_update',
    toolset: 'incident',
    description: 'Send a stakeholder update for a major incident. It is written to the ticket and delivered by email, in-app and WhatsApp to the requester, watchers, customer contacts and the account manager, so the wording must be final and approved by the user.',
    inputSchema: z.object({ ticket: majorRef, body: z.string().min(10).max(4000), portalBanner: z.boolean().optional().describe('Also show the update as a portal banner') }),
    requires: ['tickets:major'],
    portal: null,
    action: true,
    tier: 'outbound',
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const u = await postMajorUpdate(ctx, t.id, { body: input.body, kind: 'stakeholder', portalBanner: input.portalBanner });
      return { ticket: t.number, updateId: u.id, sentCount: u.sentCount, link: ticketLink(ctx, t.id) };
    },
    summary: (input, result) => `Sent a stakeholder update on ${input.ticket} to ${(result as { sentCount: number }).sentCount} recipient(s)`,
    preview: async (ctx, input) => `Send a stakeholder update on ${short(await resolveTicket(ctx, input.ticket))} by email, in-app and WhatsApp to the requester, watchers, customer contacts and account manager${input.portalBanner ? ', and show it as a portal banner' : ''}: "${trunc(input.body.replace(/\s+/g, ' '), 200)}"`,
  }),

  define({
    name: 'add_bridge_note',
    toolset: 'incident',
    description: 'Add an internal bridge note to a major incident log (staff only, nothing is sent to the customer).',
    inputSchema: z.object({ ticket: majorRef, body: z.string().min(3).max(4000) }),
    requires: ['tickets:major'],
    portal: null,
    action: true,
    tier: 'write_low',
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const u = await postMajorUpdate(ctx, t.id, { body: input.body, kind: 'internal' });
      return { ticket: t.number, updateId: u.id, link: ticketLink(ctx, t.id) };
    },
    summary: (input) => `Added a bridge note to ${input.ticket}`,
    preview: async (ctx, input) => `Add an internal bridge note to ${short(await resolveTicket(ctx, input.ticket))}: "${trunc(input.body.replace(/\s+/g, ' '), 160)}"`,
  }),

  define({
    name: 'add_major_child',
    toolset: 'incident',
    description: 'Link another incident as a child of a major incident (so its updates and resolution follow the parent).',
    inputSchema: z.object({ ticket: majorRef, child: ticketRef.describe('The incident to attach as a child') }),
    requires: ['tickets:major'],
    portal: null,
    action: true,
    tier: 'write_low',
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const [t, child] = await Promise.all([resolveTicket(ctx, input.ticket), resolveTicket(ctx, input.child)]);
      const m = await addChild(ctx, t.id, { ticketId: child.id });
      return { ticket: t.number, child: child.number, children: m.children.length, link: ticketLink(ctx, t.id) };
    },
    summary: (input) => `Attached ${input.child} as a child of ${input.ticket}`,
    preview: async (ctx, input) => {
      const [t, child] = await Promise.all([resolveTicket(ctx, input.ticket), resolveTicket(ctx, input.child)]);
      return `Attach ${short(child)} as a child of major incident ${t.number}`;
    },
  }),
  define({
    name: 'create_announcement',
    toolset: 'incident',
    description: 'Publish an announcement banner: info, planned maintenance or an outage notice, shown above every page to its audience (everyone, customers only or staff only), optionally for one customer and inside a time window, and on the customer status page. Customers read it as written, so the wording must be final and approved by the user.',
    inputSchema: z.object({
      title: z.string().min(3).max(200),
      body: z.string().min(10).max(5000),
      type: z.enum(['info', 'maintenance', 'outage']).optional().describe('Defaults to info'),
      audience: z.enum(['all', 'customers', 'staff']).optional().describe('Defaults to all'),
      customer: z.string().max(200).optional().describe('Customer name, code or id when the announcement is for one organisation; omit for every customer'),
      ticket: ticketRef.optional().describe('The incident, change or maintenance it is about'),
      endsAt: z.string().max(40).optional().describe('ISO time when the banner should come down; omit to leave it up until someone ends it'),
    }),
    requires: ['announcements:manage'],
    portal: null,
    action: true,
    tier: 'outbound',
    invalidates: ['announcements'],
    run: async (ctx, input) => {
      const customerId = input.customer ? await resolveCustomerId(ctx, input.customer, true) : undefined;
      const t = input.ticket ? await resolveTicket(ctx, input.ticket) : null;
      const endsAt = input.endsAt ? new Date(input.endsAt) : null;
      const a = await createAnnouncement(ctx, { title: input.title, body: input.body, type: input.type ?? 'info', audience: input.audience ?? 'all', customerIds: customerId ? [customerId] : [], endsAt: endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt : null, sourceTicketId: t?.id ?? null });
      return { id: a.id, title: a.title, type: a.type, audience: a.audience, customers: customerId ? 1 : 'all', endsAt: iso(a.endsAt), link: '/operations/announcements' };
    },
    summary: (input) => `Published the ${input.type ?? 'info'} announcement "${trunc(input.title, 60)}"`,
    preview: async (ctx, input): Promise<PreviewDetail> => {
      const customerId = input.customer ? await resolveCustomerId(ctx, input.customer, true) : undefined;
      const t = input.ticket ? await resolveTicket(ctx, input.ticket) : null;
      const who = { all: 'everyone (customers and staff)', customers: 'customers only', staff: 'staff only' }[input.audience ?? 'all'];
      const lines = [`Title: ${input.title}`, `Body: ${trunc(input.body.replace(/\s+/g, ' '), 240)}`];
      if (t) lines.push(`About: ${short(t)}`);
      if (input.endsAt) lines.push(`Comes down: ${input.endsAt}`);
      return { text: `Publish a ${input.type ?? 'info'} announcement to ${who}${customerId ? ` for the customer ${input.customer}` : ''}; it appears above every page for them at once`, lines };
    },
  }),
];

/** Picks an escalation policy by name or id (exact name first), or null when none is given. */
async function resolvePolicy(ctx: Parameters<typeof listPolicies>[0], ref?: string | null) {
  const r = ref?.trim();
  if (!r) return null;
  const all = await listPolicies(ctx);
  const exact = all.filter((p) => p.id === r || p.name.toLowerCase() === r.toLowerCase());
  const loose = exact.length ? exact : all.filter((p) => p.name.toLowerCase().includes(r.toLowerCase()));
  if (loose.length === 1) return loose[0]!;
  if (!loose.length) throw new Error(`No escalation policy matching "${r}"; the policies are: ${all.map((p) => p.name).join(', ') || 'none'}`);
  throw new Error(`Policy "${r}" is ambiguous: ${loose.map((p) => p.name).join(', ')}`);
}

INCIDENT.push(
  define({
    name: 'who_is_on_call',
    toolset: 'incident',
    description: 'Who is on call right now (or at a given time) for a team or for every team with a rota: the person per rota, whether cover (an override) applies, when their cover ends, the team manager and the default escalation policy. Use for "who is on call", "who do I wake for the NOC", "is anyone covering tonight".',
    inputSchema: z.object({ team: z.string().max(200).optional().describe('Team name or key; omit for every team with a rota'), at: z.string().max(40).optional().describe('ISO date-time; defaults to now') }),
    requires: ['oncall:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const team = await resolveTeam(ctx, input.team);
      const at = input.at ? new Date(input.at) : new Date();
      if (Number.isNaN(at.getTime())) throw new Error('The time must be an ISO date-time');
      const res = await onCallNow(ctx, { teamId: team?.id ?? null, at });
      const people = res.teams.flatMap((t) => t.rotas.filter((r) => r.user).map((r) => `${r.user!.name} (${t.name}, ${r.name}${r.override ? ', cover' : ''})`));
      return {
        at: iso(at),
        facts: [`${people.length} person(s) on call${team ? ` for ${team.name}` : ''} at ${iso(at)}: ${people.join('; ') || 'nobody'}`],
        teams: res.teams.map((t) => ({ team: t.name, type: t.teamType, manager: t.managerName, escalationPolicy: t.escalationPolicyName, rotas: t.rotas.map((r) => ({ rota: r.name, timezone: r.timezone, onCall: r.user ? { name: r.user.name, email: r.user.email, phone: r.user.phone } : null, cover: r.override ? { reason: r.override.reason } : null, until: iso(r.until) })) })),
        link: '/operations/on-call',
      };
    },
    summary: (input, result) => `Checked who is on call${input.team ? ` for ${input.team}` : ''} (${(result as { teams: unknown[] }).teams.length} team(s))`,
  }),

  define({
    name: 'shift_handover',
    toolset: 'incident',
    description: "A team's shift handover picture: the live digest (open tickets, P1/P2, breached and at-risk SLAs, unassigned, waiting on the customer, active major incidents, changes in the next 12 hours, on call now and next) and the latest published handover note with its author and whether the incoming shift acknowledged it. Use for \"what should the night shift watch\", \"was the handover done\", \"what did the day shift leave for the NOC\".",
    inputSchema: z.object({ team: z.string().max(200).describe('Team name or key (NOC, SOC, service desk)') }),
    requires: ['tickets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const team = await resolveTeam(ctx, input.team);
      if (!team) throw new Error(`No team matches "${input.team}"`);
      const d = await handoverDigest(ctx, team.id);
      const latest = (await listHandovers(ctx, { teamId: team.id, status: 'all', page: 1, pageSize: 1 })).items[0] ?? null;
      const c = d.counts;
      const facts = [
        `${team.name}: ${c.open} open ticket(s), ${c.p1p2} P1/P2, ${c.breached} with a breached SLA, ${c.atRisk} at risk, ${c.unassigned} unassigned, ${c.awaitingCustomer} waiting on the customer, ${c.major} active major incident(s), ${c.changesNext} change(s) in the next 12 hours; ${c.openedInShift} opened and ${c.resolvedInShift} resolved since ${d.window.from.slice(0, 16).replace('T', ' ')} UTC`,
        `On call now: ${d.onCall.now.map((p) => `${p.name}${p.rota ? ` (${p.rota})` : ''}`).join('; ') || 'nobody on a rota'}; next: ${d.onCall.next.map((p) => p.name).join('; ') || 'nobody on a rota'}`,
        latest ? `Latest handover: ${latest.shiftDate}${latest.shiftName ? ` ${latest.shiftName}` : ''} by ${latest.authorName ?? 'unknown'}, ${latest.status === 'acknowledged' ? `acknowledged by ${latest.acknowledgedByName ?? 'someone'}` : latest.status === 'final' ? 'published, not yet acknowledged' : 'still a draft'}` : 'No handover has been written for this team yet',
      ];
      return {
        team: { id: team.id, name: team.name },
        counts: c,
        lists: d.tickets.map((l) => ({ title: l.title, items: l.items.map((t) => ({ number: t.number, title: t.title, priority: t.priority, status: t.status, customer: t.customer, assignee: t.assignee, slaDueAt: t.slaDueAt, breachRisk: t.breachRisk, link: ticketLink(ctx, t.id) })) })),
        major: d.major.map((m) => ({ number: m.number, title: m.title, customer: m.customer, commander: m.commander, nextUpdateAt: m.nextUpdateAt, link: ticketLink(ctx, m.id) })),
        changes: d.changes.map((ch) => ({ number: ch.number, title: ch.title, customer: ch.customer, scheduledStart: ch.scheduledStart, scheduledEnd: ch.scheduledEnd, link: ticketLink(ctx, ch.id) })),
        onCall: d.onCall,
        latestHandover: latest ? { id: latest.id, shiftDate: latest.shiftDate, shift: latest.shiftName, author: latest.authorName, status: latest.status, publishedAt: iso(latest.publishedAt), acknowledgedBy: latest.acknowledgedByName, acknowledgedAt: iso(latest.acknowledgedAt), body: trunc(latest.body, 3000) } : null,
        facts,
        link: `/operations/handover?team=${team.id}`,
      };
    },
    summary: (input, result) => `Read the shift handover picture for ${input.team} (${(result as { counts: { open: number } }).counts.open} open)`,
  }),

  define({
    name: 'page_on_call',
    toolset: 'incident',
    description: 'Page someone for a ticket through an escalation policy: the first step is notified (email, in-app, WhatsApp as the policy says) and the platform escalates step by step until someone acknowledges. Uses the assigned team\'s default policy unless a policy is named. Use only on explicit instruction naming the ticket.',
    inputSchema: z.object({ ticket: ticketRef, policy: z.string().max(200).optional().describe('Escalation policy name; defaults to the assigned team\'s policy'), reason: z.string().max(500).optional().describe('One line the person reads first') }),
    requires: ['tickets:escalate'],
    portal: null,
    action: true,
    invalidates: ['tickets'],
    run: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const policy = await resolvePolicy(ctx, input.policy);
      const page = await pageTicket(ctx, t.id, { policyId: policy?.id ?? null, reason: input.reason ?? null, source: 'ai' });
      return { ticket: t.number, pageId: page.id, status: page.status, step: page.step + 1, steps: page.steps, target: page.targetName ?? page.targetTeamName, channels: page.channels, expiresAt: iso(page.expiresAt), link: ticketLink(ctx, t.id) };
    },
    summary: (input, result) => `Paged ${(result as { target: string | null }).target ?? 'the team'} for ${input.ticket}`,
    preview: async (ctx, input) => {
      const t = await resolveTicket(ctx, input.ticket);
      const policy = await resolvePolicy(ctx, input.policy);
      const open = await listPages(ctx, { ticketId: t.id, status: 'open', limit: 1 });
      if (open.items.length) return `A page is already in progress for ${short(t)} (step ${open.items[0]!.step + 1}, waiting for ${open.items[0]!.targetName ?? 'the team'}); nothing to do`;
      const first = policy?.steps[0];
      const who = first ? (first.target === 'oncall' ? 'whoever is on call' : first.target === 'user' ? (first.userName ?? 'a named person') : first.target === 'team' ? 'every member of the team' : 'the team manager') : 'the first step of the team\'s default policy';
      return `Page ${who} for ${short(t)} through "${policy?.name ?? 'the assigned team\'s default policy'}"${first ? ` by ${first.channels.join(', ')}, escalating after ${first.timeoutMinutes} min without an acknowledgement` : ''}${input.reason ? ` (reason: ${input.reason.slice(0, 120)})` : ''}`;
    },
  }),
);

type MajorInput = { bridgeUrl?: string | null; bridgeNotes?: string | null; commander?: string; commsLead?: string; updateIntervalMinutes?: number; portalBanner?: boolean; status?: 'active' | 'resolved' | 'review_done'; pirWhatHappened?: string; pirImpact?: string; pirRootCause?: string };
async function majorPatch(ctx: Parameters<typeof resolveEngineer>[0], input: MajorInput): Promise<{ patch: MajorPatch; lines: string[] }> {
  const patch: MajorPatch = {};
  const lines: string[] = [];
  if (input.bridgeUrl !== undefined) { patch.bridgeUrl = input.bridgeUrl; lines.push(input.bridgeUrl ? `bridge → ${input.bridgeUrl.slice(0, 80)}` : 'bridge link removed'); }
  if (input.bridgeNotes !== undefined) { patch.bridgeNotes = input.bridgeNotes; lines.push('bridge notes updated'); }
  if (input.commander) { const u = (await resolveEngineer(ctx, input.commander))!; patch.commanderUserId = u.id; lines.push(`commander → ${u.name}`); }
  if (input.commsLead) { const u = (await resolveEngineer(ctx, input.commsLead))!; patch.commsLeadUserId = u.id; lines.push(`communications lead → ${u.name}`); }
  if (input.updateIntervalMinutes !== undefined) { patch.updateIntervalMinutes = input.updateIntervalMinutes; lines.push(`stakeholder updates every ${input.updateIntervalMinutes} min`); }
  if (input.portalBanner !== undefined) { patch.portalBanner = input.portalBanner; lines.push(input.portalBanner ? 'portal banner on' : 'portal banner off'); }
  if (input.status) { patch.status = input.status; lines.push(`status → ${input.status.replace('_', ' ')}`); }
  if (input.pirWhatHappened !== undefined) { patch.pirWhatHappened = input.pirWhatHappened; lines.push('review: what happened'); }
  if (input.pirImpact !== undefined) { patch.pirImpact = input.pirImpact; lines.push('review: impact'); }
  if (input.pirRootCause !== undefined) { patch.pirRootCause = input.pirRootCause; lines.push('review: root cause'); }
  return { patch, lines };
}
