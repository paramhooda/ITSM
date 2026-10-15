import { eq, and, sql, isNull, inArray, desc, asc } from 'drizzle-orm';
import type { WaitingOn } from '@itsm/shared';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import { logger } from '@/core/logger';

/**
 * Upgrades applied by the seed on every start, never by migration SQL, so an
 * installation that predates a rule loses nothing. Each one is idempotent:
 * an option upgrade touches only a system row that still holds the old seed
 * value and stamps the row (`metadata.upgrades`) so it is applied exactly once
 * and an administrator's later edit survives; a ticket upgrade touches only
 * rows still NULL on the column it fills.
 */

/** The stamp an option upgrade leaves in `metadata.upgrades` so it never runs twice on the same row. */
const stamped = (name: string) => sql`NOT (coalesce(${schema.configOptions.metadata} -> 'upgrades', '[]'::jsonb) ? ${name}::text)`;
const stamp = (name: string) => sql`jsonb_set(coalesce(${schema.configOptions.metadata}, '{}'::jsonb), '{upgrades}', coalesce(${schema.configOptions.metadata} -> 'upgrades', '[]'::jsonb) || to_jsonb(${name}::text))`;

/** Option rows whose seed value changed: applied once per row (the stamp), so a later edit by an administrator is kept. */
export const OPTION_UPGRADES: { type: string; key: string; why: string; apply: (tx: Tx) => Promise<number> }[] = [
  {
    type: 'ticket_status',
    key: 'pending_change',
    why: 'a scheduled change is a wait the customer agreed to: the resolution and restoration clocks pause',
    apply: async (tx) => {
      const rows = await tx
        .update(schema.configOptions)
        .set({ pausesSla: true, metadata: stamp('pending_change_pauses') })
        .where(and(eq(schema.configOptions.type, 'ticket_status'), eq(schema.configOptions.key, 'pending_change'), eq(schema.configOptions.isSystem, true), stamped('pending_change_pauses')))
        .returning({ id: schema.configOptions.id });
      return rows.length;
    },
  },
  {
    type: 'ticket_status',
    key: 'review',
    why: 'a post-implementation review is a stage of the change, not a wait on anyone',
    apply: async (tx) => {
      const rows = await tx
        .update(schema.configOptions)
        .set({ metadata: sql`coalesce(${schema.configOptions.metadata}, '{}'::jsonb) || '{"wait": false}'::jsonb` })
        .where(and(eq(schema.configOptions.type, 'ticket_status'), eq(schema.configOptions.key, 'review'), eq(schema.configOptions.isSystem, true), sql`NOT (coalesce(${schema.configOptions.metadata}, '{}'::jsonb) ? 'wait')`))
        .returning({ id: schema.configOptions.id });
      return rows.length;
    },
  },
  {
    type: 'ticket_status',
    key: 'awaiting_approval',
    why: 'an approval is a lifecycle step on every ticket type, not only requests and changes',
    apply: async (tx) => {
      const rows = await tx
        .update(schema.configOptions)
        .set({ appliesTo: [], metadata: stamp('awaiting_approval_all_types') })
        .where(and(eq(schema.configOptions.type, 'ticket_status'), eq(schema.configOptions.key, 'awaiting_approval'), eq(schema.configOptions.isSystem, true), sql`${schema.configOptions.appliesTo} = ARRAY['request','change']::text[]`, stamped('awaiting_approval_all_types')))
        .returning({ id: schema.configOptions.id });
      return rows.length;
    },
  },
];

export async function applyOptionUpgrades(tx: Tx) {
  for (const u of OPTION_UPGRADES) {
    const n = await u.apply(tx);
    if (n) logger.info({ type: u.type, key: u.key, rows: n }, `option upgrade: ${u.why}`);
  }
}

const LEGACY_REASON = 'Set before reasons were recorded';
const CUSTOMER_ROLE_KEYS = ['customer_admin', 'customer_user', 'customer_approver'];
const PARTY_BY_KEY: Record<string, WaitingOn> = { pending_customer: 'customer', pending_vendor: 'vendor', pending_change: 'change', on_hold: 'agreement' };

/**
 * Backfills the pending block of tickets that entered a wait before reasons were recorded:
 * the party from the status key (an approval's party from its pending step's addressee), the
 * reason from the last customer-visible staff comment on or after the status change (else a
 * fixed sentence, not shown to the customer), and when the wait began. Only rows still NULL.
 */
export async function applyTicketUpgrades(tx: Tx) {
  const statuses = await tx
    .select({ id: schema.configOptions.id, key: schema.configOptions.key, metadata: schema.configOptions.metadata })
    .from(schema.configOptions)
    .where(and(eq(schema.configOptions.type, 'ticket_status'), eq(schema.configOptions.statusCategory, 'pending')));
  const waits = statuses.filter((s) => (s.metadata as { wait?: unknown } | null)?.wait !== false);
  if (!waits.length) return 0;
  const keyOf = new Map(waits.map((s) => [s.id, s.key]));
  const rows = await tx
    .select({ id: schema.tickets.id, statusId: schema.tickets.statusId, updatedAt: schema.tickets.updatedAt })
    .from(schema.tickets)
    .where(and(inArray(schema.tickets.statusId, waits.map((s) => s.id)), isNull(schema.tickets.pendingWaitingOn)));
  let n = 0;
  for (const t of rows) {
    const key = keyOf.get(t.statusId)!;
    let party: WaitingOn = PARTY_BY_KEY[key] ?? 'internal';
    if (key === 'awaiting_approval') {
      const [step] = await tx.select({ roleKey: schema.approvals.approverRoleKey, userId: schema.approvals.approverUserId }).from(schema.approvals).where(and(eq(schema.approvals.ticketId, t.id), eq(schema.approvals.status, 'pending'))).orderBy(asc(schema.approvals.step)).limit(1);
      party = 'internal';
      if (step?.roleKey && CUSTOMER_ROLE_KEYS.includes(step.roleKey)) party = 'customer';
      else if (step?.userId) {
        const [u] = await tx.select({ userType: schema.users.userType }).from(schema.users).where(eq(schema.users.id, step.userId)).limit(1);
        if (u?.userType === 'customer') party = 'customer';
      }
    }
    const [statusAct] = await tx
      .select({ createdAt: schema.ticketActivities.createdAt })
      .from(schema.ticketActivities)
      .where(and(eq(schema.ticketActivities.ticketId, t.id), eq(schema.ticketActivities.activityType, 'status')))
      .orderBy(desc(schema.ticketActivities.createdAt))
      .limit(1);
    const since = statusAct?.createdAt ?? t.updatedAt;
    const [comment] = await tx
      .select({ body: schema.ticketComments.body, authorId: schema.ticketComments.authorId })
      .from(schema.ticketComments)
      .innerJoin(schema.users, eq(schema.users.id, schema.ticketComments.authorId))
      .where(and(eq(schema.ticketComments.ticketId, t.id), eq(schema.ticketComments.isInternal, false), eq(schema.users.userType, 'msp'), sql`${schema.ticketComments.createdAt} >= ${since}::timestamptz - interval '1 minute'`))
      .orderBy(desc(schema.ticketComments.createdAt))
      .limit(1);
    await tx
      .update(schema.tickets)
      .set({ pendingWaitingOn: party, pendingReason: comment?.body.slice(0, 2000) ?? LEGACY_REASON, pendingReasonVisible: !!comment, pendingSetAt: since, pendingSetBy: null })
      .where(and(eq(schema.tickets.id, t.id), isNull(schema.tickets.pendingWaitingOn)));
    n++;
  }
  if (n) logger.info({ rows: n }, 'ticket upgrade: pending block backfilled for tickets already in a wait');
  return n;
}
