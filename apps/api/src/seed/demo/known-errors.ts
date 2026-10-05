import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { adminCtx, customer, user, type DemoState } from './state';
import { addDays, maxDate, minDate } from './rng';
import { PROBLEM_TEMPLATES } from './ticket-templates';

/**
 * Known error database on top of the demo problems: every problem the ticket
 * phase flagged as a known error gets a lifecycle status, an identification
 * date, a permanent-fix change where one exists for the customer, and the
 * customer-facing wording of its template; about six in ten are published to
 * the portal, always including the first active known error (or the first at
 * all) of the customers whose portal logins the demo advertises.
 */
const PORTAL_DEMO_CUSTOMERS = ['abc', 'meridian', 'northwind'];

export async function seedKnownErrors(state: DemoState, tx: Tx) {
  const { rng, now } = state;
  const flagged = (await tx.execute(sql`SELECT ticket_id AS "ticketId" FROM problem_details WHERE is_known_error`)).rows as { ticketId: string }[];
  const byId = new Map([...state.tickets.values()].map((t) => [t.id, t]));
  const entries = flagged
    .map((r) => byId.get(r.ticketId))
    .filter((t): t is NonNullable<typeof t> => !!t)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const changes = [...state.tickets.values()].filter((t) => t.type === 'change');
  const firstOf = new Map<string, string>();
  for (const t of entries) if (!t.resolvedAt && !firstOf.has(t.customerKey)) firstOf.set(t.customerKey, t.id);
  for (const t of entries) if (!firstOf.has(t.customerKey)) firstOf.set(t.customerKey, t.id);
  const publisher = user(state, 'rajesh').id;
  const ctx = adminCtx(state, tx);
  let published = 0;
  for (const t of entries) {
    const tpl = PROBLEM_TEMPLATES.find((p) => p.key === t.templateKey);
    let keStatus = 'open';
    let fixChangeId: string | null = null;
    if (t.resolvedAt) keStatus = 'resolved';
    else {
      // The newest open change of the same customer delivers the fix (a closed change would contradict "fix in progress");
      // without one the known error stays open with its workaround.
      const own = changes.filter((c) => c.customerKey === t.customerKey).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const fix = own.find((c) => c.open && c.categoryKey === t.categoryKey) ?? own.find((c) => c.open);
      if (fix) {
        keStatus = 'fix_in_progress';
        fixChangeId = fix.id;
      }
    }
    // The status date never precedes the identification date, and a resolved problem was identified before it was resolved.
    const statusAgoDays = t.resolvedAt ? 0 : rng.int(1, 20);
    const identifiedAt = minDate(addDays(t.createdAt, rng.int(2, 9)), t.resolvedAt ?? now);
    const keStatusAt = t.resolvedAt ?? maxDate(identifiedAt, addDays(now, -statusAgoDays));
    const mustPublish = PORTAL_DEMO_CUSTOMERS.includes(t.customerKey) && firstOf.get(t.customerKey) === t.id;
    const publish = mustPublish || rng.chance(0.6);
    const publishedAt = publish ? minDate(addDays(identifiedAt, rng.int(0, 2)), now) : null;
    await tx.execute(sql`
      UPDATE problem_details
      SET ke_status = ${keStatus}, ke_status_at = ${keStatusAt}, ke_identified_at = ${identifiedAt}, fix_change_id = ${fixChangeId}::uuid,
          portal_visible = ${publish}, customer_summary = ${tpl?.customerSummary ?? null}, customer_workaround = ${tpl?.customerWorkaround ?? null},
          published_at = ${publishedAt}, published_by = ${publish ? publisher : null}::uuid, updated_at = ${publishedAt ?? keStatusAt}
      WHERE ticket_id = ${t.id}::uuid`);
    if (publish) {
      published++;
      await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'known_error.publish', customerId: customer(state, t.customerKey).id, metadata: { first: true, notified: 0, demo: true } });
    }
  }
  state.counts.knownErrors = entries.length;
  state.counts.knownErrorsPublished = published;
}
