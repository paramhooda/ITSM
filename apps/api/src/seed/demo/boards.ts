import { inArray, sql } from 'drizzle-orm';
import { schema, type Tx } from '@/db/client';
import * as handover from '@/modules/handover/service';
import { createTask } from '@/modules/tickets/activity';
import { ctxFor, principalOf, user, type DemoState } from './state';
import { addMinutes, isoDate } from './rng';

/**
 * Task boards: the shift handovers the board panel shows (a NOC note by the
 * NOC manager for the shift running now, acknowledged by the incoming
 * engineer; a SOC note published and still waiting), nine personal sticky
 * notes spread over the last six hours, and enough open tasks on open NOC
 * incidents for the task board to show every lane and the overdue state.
 * Handovers go through the real service so the audit trail and the outbox
 * rows look like production (the extras phase purges the notifications it
 * queues); notes and the task variety are written directly.
 */

type WatchTicket = { id: string; number: string; title: string };

const TASK_TITLES = ['Confirm with the customer that service is restored', 'Collect logs for the RCA', 'Schedule the firmware upgrade', 'Verify the monitoring sensor after the fix', 'Update the runbook with the workaround', 'Raise the vendor RMA'];

async function watchFirst(tx: Tx, domain: 'noc' | 'soc'): Promise<WatchTicket[]> {
  const res = await tx.execute(sql`
    SELECT t.id, t.number, t.title
    FROM tickets t
    JOIN config_options st ON st.id = t.status_id
    JOIN config_options pr ON pr.id = t.priority_id
    WHERE t.domain = ${domain} AND t.type = 'incident' AND pr.key IN ('p1', 'p2') AND st.status_category IN ('new', 'open', 'pending')
    ORDER BY t.created_at DESC
    LIMIT 2`);
  return res.rows as WatchTicket[];
}

const bullets = (items: WatchTicket[], fallback: string) => (items.length ? items.map((t) => `- ${t.number} ${t.title}`).join('\n') : fallback);

function nocBody(watch: WatchTicket[], onCall: string): string {
  return [
    '## Watch first',
    bullets(watch, '- Nothing above P3 is open; keep an eye on the monitoring queue.'),
    '',
    '## Open and at risk',
    '- WAN and firewall tickets are the ones closest to their resolution clocks; the ISP has a case open on the Apex link.',
    '- Two pending-vendor tickets are waiting on RMA confirmation; chase if nothing arrives by 10:00.',
    '',
    '## Major incidents',
    'None on the bridge at handover.',
    '',
    '## Scheduled next',
    '- Core switch firmware upgrade window opens at 22:00 IST; the change is approved and the implementer is briefed.',
    '',
    '## On call',
    `${onCall} is on call for the NOC through the night; escalate P1s to the NOC manager.`,
    '',
    '## Notes',
    'Vendor callback expected at 16:00 about the Meridian firewall RMA. Leave the storage alert threshold as it is until the review tomorrow.',
  ].join('\n');
}

function socBody(watch: WatchTicket[]): string {
  return [
    '## Watch first',
    bullets(watch, '- No open P1/P2 security incidents; review the overnight SIEM queue first.'),
    '',
    '## Open and at risk',
    '- The phishing campaign tickets are contained; the credential resets are confirmed for every affected mailbox.',
    '',
    '## Major incidents',
    'None.',
    '',
    '## Scheduled next',
    '- EDR policy update rolls out to the pilot group at 09:00; expect a few false positives on the build servers.',
    '',
    '## On call',
    'SOC L2 covers the night; the SOC manager is reachable for anything customer-facing.',
    '',
    '## Notes',
    'The VPN gateway SIEM rule still fires on the backup job; tuning is scheduled with the night analyst.',
  ].join('\n');
}

export async function seedBoards(state: DemoState, tx: Tx) {
  const { refs, rng, now } = state;
  const rajesh = principalOf(state, 'rajesh');
  const priya = principalOf(state, 'priya');
  const sneha = principalOf(state, 'sneha');

  // ---- handovers: NOC published and acknowledged, SOC published and waiting
  const nocWatch = await watchFirst(tx, 'noc');
  const noc = await handover.create(ctxFor(state, tx, rajesh), { teamId: refs.team('noc'), body: nocBody(nocWatch, user(state, 'arjun').name), publish: true }, now);
  await handover.acknowledge(ctxFor(state, tx, priya), noc.id, 'Taken over, watching the WAN tickets first.');
  const socWatch = await watchFirst(tx, 'soc');
  await handover.create(ctxFor(state, tx, sneha), { teamId: refs.team('soc'), body: socBody(socWatch), publish: true }, now);
  state.counts.handovers = 2;

  // ---- sticky notes: personal, spread over the last six hours
  const shiftDate = isoDate(now);
  const ago = () => addMinutes(now, -rng.int(10, 360));
  const note = (key: string, body: string, extra: Partial<typeof schema.boardNotes.$inferInsert> = {}): typeof schema.boardNotes.$inferInsert => {
    const createdAt = ago();
    const row = { userId: user(state, key).id, teamId: null, board: 'tickets' as const, body, color: 'amber' as const, pinned: false, done: false, shiftDate, sortOrder: 0, createdAt, updatedAt: createdAt, ...extra };
    return row.done ? { ...row, doneAt: addMinutes(createdAt, 5) } : row;
  };
  const notes: (typeof schema.boardNotes.$inferInsert)[] = [
    note('rajesh', 'Vendor call 16:00 about the Meridian firewall RMA', { pinned: true }),
    note('rajesh', 'Check the ISP case on the Apex WAN link before the shift ends'),
    note('rajesh', 'Send the RCA draft to Ananya', { color: 'green', done: true }),
    note('priya', 'Night shift: core switch firmware upgrade window opens 22:00', { teamId: refs.team('noc'), color: 'blue' }),
    note('priya', 'Ask Arjun about the storage alert threshold', { color: 'slate' }),
    note('priya', 'Callback: Meridian plant IT at 15:30', { color: 'rose' }),
    note('sneha', 'Review the EDR exclusions list with Karan', { color: 'blue' }),
    note('sneha', 'SIEM rule tuning: false positives on the VPN gateway', { color: 'rose', pinned: true }),
    note('rohan', 'Follow up with HR on the onboarding laptop count', { board: 'tasks', color: 'green' }),
  ];
  await tx.insert(schema.boardNotes).values(notes);
  state.counts.boardNotes = notes.length;

  // ---- tasks: the ticket phase creates tasks for three templates only and completes them on resolution,
  //      so open NOC tasks may be scarce; top them up on open NOC incidents, two at least for Priya.
  const engineers = ['priya', 'arjun', 'deepak'] as const;
  const engineerIds = engineers.map((k) => user(state, k).id);
  const existing = (await tx.execute(sql`
    SELECT k.id, k.assignee_id AS "assigneeId"
    FROM ticket_tasks k
    JOIN tickets t ON t.id = k.ticket_id
    JOIN config_options st ON st.id = t.status_id
    WHERE k.status IN ('open', 'in_progress') AND st.status_category IN ('new', 'open', 'pending') AND k.assignee_id = ANY(ARRAY[${sql.join(engineerIds.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[])
    ORDER BY k.created_at`)).rows as { id: string; assigneeId: string }[];
  const priyaId = user(state, 'priya').id;
  const priyaExisting = existing.filter((t) => t.assigneeId === priyaId).length;
  const need = Math.max(6 - existing.length, 2 - priyaExisting, 0);
  const created: { id: string; assigneeId: string }[] = [];
  if (need > 0) {
    const incidents = (await tx.execute(sql`
      SELECT t.id
      FROM tickets t
      JOIN config_options st ON st.id = t.status_id
      WHERE t.domain = 'noc' AND t.type = 'incident' AND st.status_category IN ('new', 'open', 'pending')
      ORDER BY t.created_at DESC
      LIMIT 12`)).rows as { id: string }[];
    const ctx = ctxFor(state, tx, rajesh);
    for (let i = 0; i < need && incidents.length; i++) {
      const assigneeKey = i < 2 - priyaExisting ? 'priya' : engineers[i % engineers.length]!;
      const ticket = incidents[i % incidents.length]!;
      const task = await createTask(ctx, ticket.id, { title: TASK_TITLES[i % TASK_TITLES.length]!, assigneeId: user(state, assigneeKey).id, teamId: refs.team('noc'), sortOrder: i });
      created.push({ id: task.id, assigneeId: task.assigneeId ?? user(state, assigneeKey).id });
    }
  }
  // Priya's tasks first so her board shows every state the browser check looks for.
  const all = [...existing, ...created].sort((a, b) => Number(b.assigneeId === priyaId) - Number(a.assigneeId === priyaId));
  const inProgress = [all[0], all[2], all[4]].filter((t): t is NonNullable<typeof t> => !!t).map((t) => t.id);
  const overdue = [all[0], all[2]].filter((t): t is NonNullable<typeof t> => !!t).map((t) => t.id);
  const soon = all[1] ? [all[1].id] : [];
  if (inProgress.length) await tx.update(schema.ticketTasks).set({ status: 'in_progress', updatedAt: now }).where(inArray(schema.ticketTasks.id, inProgress));
  if (overdue.length) await tx.update(schema.ticketTasks).set({ dueAt: addMinutes(now, -rng.int(90, 600)) }).where(inArray(schema.ticketTasks.id, overdue));
  if (soon.length) await tx.update(schema.ticketTasks).set({ dueAt: addMinutes(now, 180) }).where(inArray(schema.ticketTasks.id, soon));
  state.counts.boardTasks = all.length;
}
