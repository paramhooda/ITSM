import { eq, and, inArray, lte, sql } from 'drizzle-orm';
import { registerProcessor, registerSchedule } from '../workers';
import { withSystem, schema } from '@/db/client';
import { logger } from '@/core/logger';
import { systemCtx } from '@/modules/tickets/common';
import { claimMilestone, todayStr, addDays } from '@/modules/contracts/common';
import { generateOccurrences, notifyPm, OPEN_PM_STATUSES } from '@/modules/pm/service';

const O = schema.pmOccurrences;
const P = schema.pmPrograms;

/** Phase 1: keep a rolling 12-month horizon of planned occurrences for every active program. */
export async function generateAllOccurrences(now = new Date()) {
  const programs = await withSystem((tx) => tx.select().from(P).where(eq(P.isActive, true)));
  let created = 0;
  for (const program of programs) {
    const r = await withSystem((tx) => generateOccurrences(tx, program, 12, now));
    created += r.created;
  }
  return { programs: programs.length, created };
}

/**
 * Has the "due" notification already gone out? With a contract we use the
 * contract_notifications milestone table; without one we look for the audit
 * row this job writes after notifying.
 */
async function claimDue(tx: Parameters<Parameters<typeof withSystem>[0]>[0], occ: { id: string; customerId: string }, program: { contractId: string | null }) {
  if (program.contractId) return claimMilestone(tx, program.contractId, occ.customerId, `pm:${occ.id}:due`);
  const res = await tx.execute(sql`SELECT 1 FROM audit_log WHERE entity_type = 'pm_occurrence' AND entity_id = ${occ.id}::uuid AND action = 'due_notified' LIMIT 1`);
  return res.rows.length === 0;
}

/** Phase 2: planned occurrences inside the program's lead window that nobody has scheduled yet → `pm.due` (once). */
export async function sendDueNotifications(now = new Date()) {
  const today = todayStr(now);
  const rows = await withSystem((tx) =>
    tx
      .select({ occ: O, program: P })
      .from(O)
      .innerJoin(P, eq(P.id, O.programId))
      .where(and(eq(O.status, 'planned'), eq(P.isActive, true), sql`${O.plannedDate} <= ${today}::date + ${P.leadDays}`)),
  );
  let sent = 0;
  for (const { occ, program } of rows) {
    await withSystem(async (tx) => {
      if (!(await claimDue(tx, occ, program))) return;
      const ctx = systemCtx(tx, 'pm-scheduler');
      await notifyPm(ctx, 'pm.due', occ, program, { leadDays: program.leadDays });
      await ctx.audit({ entityType: 'pm_occurrence', entityId: occ.id, entityLabel: `${program.name} ${occ.plannedDate}`, action: 'due_notified', customerId: occ.customerId, metadata: { programId: program.id, plannedDate: occ.plannedDate, leadDays: program.leadDays } });
      sent++;
    });
  }
  return { candidates: rows.length, sent };
}

/**
 * Phase 3: open occurrences (planned / scheduled / rescheduled) whose effective
 * date + grace days is in the past become `missed` (+ `pm.missed`). An
 * occurrence whose linked visit is already on site is left alone.
 */
export async function markMissed(now = new Date()) {
  const today = todayStr(now);
  const rows = await withSystem((tx) =>
    tx
      .select({ occ: O, program: P, visitStatus: schema.fieldVisits.status })
      .from(O)
      .innerJoin(P, eq(P.id, O.programId))
      .leftJoin(schema.fieldVisits, eq(schema.fieldVisits.id, O.fieldVisitId))
      .where(and(inArray(O.status, OPEN_PM_STATUSES), sql`coalesce(${O.scheduledDate}, ${O.plannedDate}) + ${P.graceDays} < ${today}::date`, lte(O.plannedDate, today))),
  );
  let missed = 0;
  for (const { occ, program, visitStatus } of rows) {
    if (visitStatus === 'in_progress') continue;
    await withSystem(async (tx) => {
      const [fresh] = await tx.select({ status: O.status }).from(O).where(eq(O.id, occ.id)).limit(1);
      if (!fresh || !OPEN_PM_STATUSES.includes(fresh.status)) return;
      const values = { status: 'missed', notes: [occ.notes, `[${today}] Marked missed: ${occ.scheduledDate ?? occ.plannedDate} + ${program.graceDays} grace days passed.`].filter(Boolean).join('\n'), updatedAt: now };
      await tx.update(O).set(values).where(eq(O.id, occ.id));
      const ctx = systemCtx(tx, 'pm-scheduler');
      await ctx.audit({ entityType: 'pm_occurrence', entityId: occ.id, entityLabel: `${program.name} ${occ.plannedDate}`, action: 'missed', customerId: occ.customerId, changes: { status: { old: occ.status, new: 'missed' } }, metadata: { programId: program.id, plannedDate: occ.plannedDate, scheduledDate: occ.scheduledDate, graceDays: program.graceDays, deadline: addDays(occ.scheduledDate ?? occ.plannedDate, program.graceDays) } });
      await notifyPm(ctx, 'pm.missed', { ...occ, status: 'missed' }, program, { graceDays: program.graceDays });
      missed++;
    });
  }
  return { candidates: rows.length, missed };
}

/** The daily 05:30 run (also callable from tests / an admin action). */
export async function runPmDaily(now = new Date()) {
  const generated = await generateAllOccurrences(now);
  const due = await sendDueNotifications(now);
  const missed = await markMissed(now);
  const stats = { programs: generated.programs, occurrencesGenerated: generated.created, dueCandidates: due.candidates, dueSent: due.sent, missedCandidates: missed.candidates, missed: missed.missed };
  logger.info(stats, 'pm scheduler run complete');
  return stats;
}

registerSchedule({ queue: 'maintenance', jobName: 'pm-scheduler', pattern: '30 5 * * *' });
registerProcessor({ queue: 'maintenance', jobName: 'pm-scheduler', processor: async () => runPmDaily() });
