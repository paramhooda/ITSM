import { z } from 'zod';
import type { Ctx } from '@/core/context';
import { ValidationError } from '@/core/errors';
import { ticketBoard, taskBoard, handoverPanel, listNotes, createNote, type BoardLane, type HandoverPanel, type TicketCard, type TaskCard } from '@/modules/boards/service';
import { define } from './types';
import { ticketLink, iso, trunc, resolveTeam, resolveEngineer } from '../helpers';

/**
 * Task board tools: the user's own board (lanes, breached and due-soon
 * counts, the WIP limit, the team's latest handover and their sticky notes),
 * a team's board with every engineer's load against the WIP limit, and a
 * sticky note added on request. Staff only; nothing here calls the model.
 */

const boardKind = z.enum(['tickets', 'tasks']);

const laneText = (lanes: BoardLane[]) => lanes.filter((l) => l.count > 0).map((l) => `${l.count} ${l.label.toLowerCase()}`).join(', ') || 'nothing in any lane';
const breachedOf = (lanes: BoardLane[]) => lanes.reduce((s, l) => s + l.breached, 0);
const plural = (n: number, word: string) => `${n} ${word}(s)`;

function ticketCards(ctx: Ctx, cards: TicketCard[], lanes: BoardLane[], limit: number) {
  const label = new Map(lanes.map((l) => [l.key, l.label]));
  return cards.slice(0, limit).map((c) => ({ number: c.number, title: trunc(c.title, 80), lane: label.get(c.lane) ?? c.lane, priority: c.priority?.label ?? null, customer: c.customerName, due: iso(c.sla?.dueAt ?? c.dueAt), slaState: c.sla?.state ?? null, breached: !!c.sla?.breached, link: ticketLink(ctx, c.id) }));
}

function taskCards(ctx: Ctx, cards: TaskCard[], lanes: BoardLane[], limit: number) {
  const label = new Map(lanes.map((l) => [l.key, l.label]));
  return cards.slice(0, limit).map((c) => ({ ticket: c.ticketNumber, task: trunc(c.title, 80), lane: label.get(c.lane) ?? c.lane, priority: c.ticketPriority?.label ?? null, customer: c.customerName, due: iso(c.dueAt), overdue: c.overdue, link: ticketLink(ctx, c.ticketId) }));
}

/** The handover picture for the panel's team, or null when the team has no panel (inactive, unknown). */
async function panelFor(ctx: Ctx, teamId: string | null): Promise<HandoverPanel | null> {
  if (!teamId) return null;
  try {
    return await handoverPanel(ctx, teamId);
  } catch {
    return null;
  }
}

const handoverView = (p: HandoverPanel | null) =>
  p
    ? {
        team: p.team.name,
        shift: p.current ? `${p.current.name} (ends ${p.current.endsAt})` : null,
        nextShift: p.next ? `${p.next.name} (starts ${p.next.startsAt})` : null,
        status: p.latest?.status ?? null,
        shiftDate: p.latest?.shiftDate ?? null,
        author: p.latest?.authorName ?? null,
        publishedAt: iso(p.latest?.publishedAt),
        acknowledgedBy: p.latest?.acknowledgedByName ?? null,
        acknowledgedAt: iso(p.latest?.acknowledgedAt),
        unacknowledged: p.unacknowledged,
        canAcknowledge: p.canAcknowledge,
        notes: p.latest?.watchFirst ?? null,
        link: p.latest ? `/operations/handover?team=${p.team.id}&handover=${p.latest.id}` : `/operations/handover?team=${p.team.id}`,
      }
    : null;

function handoverFact(p: HandoverPanel | null): string | null {
  if (!p) return null;
  const l = p.latest;
  if (!l) return `Latest ${p.team.name} handover: none written yet`;
  const head = `Latest ${p.team.name} handover: ${l.shiftDate}${l.shiftName ? ` ${l.shiftName}` : ''} by ${l.authorName ?? 'unknown'}`;
  if (l.status === 'acknowledged') return `${head}, acknowledged by ${l.acknowledgedByName ?? 'someone'}${l.acknowledgedAt ? ` at ${l.acknowledgedAt.toISOString()}` : ''}`;
  if (l.status === 'final') return `${head}, published, not yet acknowledged`;
  return `${head}, still a draft`;
}

const wipFact = (open: number, limit: number) => (limit > 0 ? `You are ${open > limit ? 'over' : 'within'} the WIP limit (${open} open of ${limit})` : null);

export const BOARDS: ReturnType<typeof define>[] = [
  define({
    name: 'my_board',
    toolset: 'tickets',
    description: 'The user\'s own task board: their open tickets by status lane (or their tasks by lane), SLA-breached and due-soon counts, whether they are over the WIP limit, the latest published handover of their team with its acknowledgement, and their sticky notes. Use for "what\'s on my board", "what should I pick up next", "did anyone acknowledge the handover", "what did I note for the shift".',
    inputSchema: z.object({
      board: boardKind.optional().describe('tickets (default) or tasks'),
      team: z.string().max(200).optional().describe('Team name or key for the handover panel; defaults to the user\'s first team'),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    requires: ['tickets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const board = input.board ?? 'tickets';
      const limit = input.limit ?? 12;
      const team = input.team ? await resolveTeam(ctx, input.team) : (ctx.user.teams[0] ?? null);
      const panel = await panelFor(ctx, team?.id ?? null);
      const notes = (await listNotes(ctx, { board, includeDone: undefined })).items.slice(0, 10).map((n) => ({ body: n.body, color: n.color, pinned: n.pinned, done: n.done }));
      const facts: string[] = [];
      let total: number;
      let lanes: BoardLane[];
      let cards: unknown[];
      let breached: number;
      let soon: number;
      let overLimit = false;
      if (board === 'tickets') {
        const b = await ticketBoard(ctx, { scope: 'mine', lanes: 'status', includeClosed: undefined });
        total = b.total;
        lanes = b.lanes;
        breached = breachedOf(b.lanes);
        soon = b.dueSoon;
        const open = b.lanes.reduce((s, l) => s + l.open, 0);
        overLimit = b.settings.wipDefaultLimit > 0 && open > b.settings.wipDefaultLimit;
        cards = ticketCards(ctx, b.cards, b.lanes, limit);
        facts.push(`${plural(total, 'ticket')} on your board: ${laneText(b.lanes)}; ${breached} with a breached SLA, ${soon} due within 4 hours`);
        const wip = wipFact(open, b.settings.wipDefaultLimit);
        if (wip) facts.push(wip);
      } else {
        const b = await taskBoard(ctx, { scope: 'mine', lanes: 'status', due: 'any', includeDone: undefined });
        total = b.total;
        lanes = b.lanes;
        breached = breachedOf(b.lanes);
        soon = b.dueSoon;
        const overdue = b.overdue;
        cards = taskCards(ctx, b.cards, b.lanes, limit);
        facts.push(`${plural(total, 'task')} on your board: ${laneText(b.lanes)}; ${overdue} overdue, ${soon} due within 4 hours, ${breached} on a ticket with a breached SLA`);
      }
      const hf = handoverFact(panel);
      if (hf) facts.push(hf);
      facts.push(`${plural(notes.length, 'sticky note')}, ${notes.filter((n) => n.pinned).length} pinned`);
      return {
        board,
        total,
        lanes: lanes.map((l) => ({ label: l.label, count: l.count, breached: l.breached })),
        cards,
        breached,
        dueWithin4h: soon,
        overLimit,
        handover: handoverView(panel),
        notes,
        link: `/tickets/boards?board=${board}&scope=mine`,
        facts,
      };
    },
    summary: (input, result) => `Read my ${input.board ?? 'tickets'} board (${(result as { total: number }).total} cards)`,
  }),

  define({
    name: 'team_board',
    toolset: 'tickets',
    description: 'A team\'s task board: lanes by status or by engineer with the count in each, every engineer\'s open tickets against the WIP limit, breached SLAs per lane, and the team\'s shift handover status. Use for "how loaded is the NOC", "who is over their WIP limit", "how many tickets are pending customer for the service desk", "what does Priya have on her board".',
    inputSchema: z.object({
      team: z.string().max(200).describe('Team name or key'),
      board: boardKind.optional().describe('tickets (default) or tasks'),
      lanes: z.enum(['status', 'assignee']).optional().describe('Lanes by status (default) or by engineer'),
      engineer: z.string().max(200).optional().describe('Narrow to one engineer ("me" allowed)'),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    requires: ['tickets:read'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const team = await resolveTeam(ctx, input.team);
      if (!team) throw new ValidationError('Team is required');
      const engineer = await resolveEngineer(ctx, input.engineer);
      const board = input.board ?? 'tickets';
      const lanesBy = input.lanes ?? 'status';
      const limit = input.limit ?? 12;
      const scope = engineer ? ({ scope: 'assignee', assigneeId: engineer.id } as const) : ({ scope: 'team', teamId: team.id } as const);
      const panel = await panelFor(ctx, team.id);
      const facts: string[] = [];
      let total: number;
      let lanes: BoardLane[];
      let people: BoardLane[];
      let cards: unknown[];
      let limitWip: number;
      if (board === 'tickets') {
        const b = await ticketBoard(ctx, { ...scope, lanes: lanesBy, includeClosed: undefined });
        const byPerson = lanesBy === 'assignee' ? b : await ticketBoard(ctx, { ...scope, lanes: 'assignee', includeClosed: undefined });
        total = b.total;
        lanes = b.lanes;
        people = byPerson.lanes;
        limitWip = b.settings.wipDefaultLimit;
        cards = ticketCards(ctx, b.cards, b.lanes, limit);
        const unassigned = byPerson.lanes.find((l) => l.key === 'unassigned')?.count ?? 0;
        facts.push(`${team.name}${engineer ? ` (${engineer.name})` : ''}: ${plural(total, 'ticket')} on the board — ${laneText(b.lanes)}; ${breachedOf(b.lanes)} with a breached SLA; ${unassigned} unassigned`);
      } else {
        const b = await taskBoard(ctx, { ...scope, lanes: lanesBy, due: 'any', includeDone: undefined });
        const byPerson = lanesBy === 'assignee' ? b : await taskBoard(ctx, { ...scope, lanes: 'assignee', due: 'any', includeDone: undefined });
        total = b.total;
        lanes = b.lanes;
        people = byPerson.lanes;
        limitWip = b.settings.wipDefaultLimit;
        cards = taskCards(ctx, b.cards, b.lanes, limit);
        const unassigned = byPerson.lanes.find((l) => l.key === 'unassigned')?.count ?? 0;
        facts.push(`${team.name}${engineer ? ` (${engineer.name})` : ''}: ${plural(total, 'task')} on the board — ${laneText(b.lanes)}; ${b.overdue} overdue; ${unassigned} unassigned`);
      }
      const engineers = people.filter((l) => l.key !== 'unassigned').map((l) => ({ name: l.label, open: l.open, breached: l.breached, limit: l.limit, over: l.over }));
      const over = engineers.filter((e) => e.over);
      if (limitWip > 0) facts.push(over.length ? `Over the WIP limit (${limitWip}): ${over.map((e) => `${e.name} (${e.open})`).join(', ')}` : `Nobody is over the WIP limit of ${limitWip}`);
      const hf = handoverFact(panel);
      if (hf) facts.push(hf);
      const link = engineer ? `/tickets/boards?board=${board}&scope=assignee&assigneeId=${engineer.id}&lanes=${lanesBy}` : `/tickets/boards?board=${board}&scope=team&teamId=${team.id}&lanes=${lanesBy}`;
      return {
        team: team.name,
        engineer: engineer?.name ?? null,
        board,
        total,
        lanes: lanes.map((l) => ({ label: l.label, count: l.count, open: l.open, breached: l.breached, limit: l.limit, over: l.over })),
        engineers,
        overCount: over.length,
        cards,
        handover: handoverView(panel),
        link,
        facts,
      };
    },
    summary: (input, result) => `Read the ${input.team} board (${(result as { total: number }).total} cards, ${(result as { overCount: number }).overCount} over the WIP limit)`,
  }),

  define({
    name: 'add_board_note',
    toolset: 'tickets',
    description: 'Add a sticky note to the user\'s own task board for the shift (optionally pinned, on the tickets or the tasks board). Use for "note on my board that the vendor calls back at four", "pin a reminder to check the backup job".',
    inputSchema: z.object({
      body: z.string().min(1).max(2000),
      board: boardKind.optional().describe('tickets (default) or tasks'),
      pinned: z.boolean().optional(),
      color: z.enum(['amber', 'blue', 'green', 'rose', 'slate']).optional(),
    }),
    requires: ['tickets:read'],
    portal: null,
    action: true,
    tier: 'write_low',
    invalidates: ['boards'],
    preview: async (_ctx, input) => `Add a ${input.pinned ? 'pinned ' : ''}sticky note to your ${input.board ?? 'tickets'} board: "${trunc(input.body.replace(/\s+/g, ' '), 120)}"`,
    run: async (ctx, input) => {
      const board = input.board ?? 'tickets';
      const note = await createNote(ctx, { board, body: input.body, color: input.color ?? 'amber', pinned: input.pinned ?? false, teamId: null });
      return { added: true, noteId: note.id, body: note.body, pinned: note.pinned, link: `/tickets/boards?board=${board}&scope=mine&panel=notes`, facts: [`Sticky note added to your ${board} board${note.pinned ? ' (pinned)' : ''}`] };
    },
    summary: (input) => `Added a sticky note "${trunc(input.body, 50)}" to my board`,
  }),
];
