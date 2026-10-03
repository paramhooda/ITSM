import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { schema, type Tx } from '@/db/client';

/**
 * Transaction-level readers shared by the status module and the portal: the
 * announcements a person may see right now, and the major incidents a customer
 * is being told about. Row-level security (platform.sql) already limits the
 * announcement rows by audience and customer; the predicates here repeat that
 * so previews by staff stay honest.
 */

export type AnnouncementRow = typeof schema.announcements.$inferSelect;

export interface VisibleOpts {
  now?: Date;
  /** Staff see 'all' and 'staff'; customers see 'all' and 'customers'. */
  staff: boolean;
  /** Limit to announcements aimed at this organisation (or at everyone). */
  customerId?: string | null;
  limit?: number;
}

export const announcementShape = (r: AnnouncementRow, ticket?: { id: string; number: string; title: string } | null) => ({
  id: r.id,
  title: r.title,
  body: r.body,
  type: r.type as 'info' | 'maintenance' | 'outage',
  audience: r.audience as 'all' | 'customers' | 'staff',
  customerIds: r.customerIds,
  pinned: r.pinned,
  isActive: r.isActive,
  startsAt: r.startsAt,
  endsAt: r.endsAt,
  sourceTicket: ticket ?? null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
export type AnnouncementView = ReturnType<typeof announcementShape>;

/** Active announcements inside their window, pinned first, newest first. */
export async function visibleAnnouncements(tx: Tx, opts: VisibleOpts): Promise<AnnouncementView[]> {
  const a = schema.announcements;
  const t = schema.tickets;
  const now = opts.now ?? new Date();
  const conds = [eq(a.isActive, true), lte(a.startsAt, now), or(isNull(a.endsAt), gt(a.endsAt, now))!, inArray(a.audience, opts.staff ? ['all', 'staff'] : ['all', 'customers'])];
  if (opts.customerId) conds.push(sql`(cardinality(${a.customerIds}) = 0 OR ${a.customerIds} @> ARRAY[${opts.customerId}::uuid])`);
  const rows = await tx
    .select({ a, ticketId: t.id, ticketNumber: t.number, ticketTitle: t.title })
    .from(a)
    .leftJoin(t, eq(t.id, a.sourceTicketId))
    .where(and(...conds))
    .orderBy(desc(a.pinned), desc(a.startsAt))
    .limit(opts.limit ?? 20);
  return rows.map((r) => announcementShape(r.a, r.ticketId ? { id: r.ticketId, number: r.ticketNumber!, title: r.ticketTitle! } : null));
}

export interface MajorBanner {
  kind: 'major_incident';
  ticketId: string;
  number: string;
  title: string;
  declaredAt: Date;
  lastUpdateAt: Date | null;
  nextUpdateDueAt: Date | null;
  latestUpdate: { body: string; at: Date } | null;
}

/** Active major incidents the service desk chose to announce to this customer, with the latest stakeholder update. */
export async function majorIncidentBanners(tx: Tx, customerId: string, limit = 5): Promise<MajorBanner[]> {
  const m = schema.majorIncidents;
  const t = schema.tickets;
  const rows = await tx
    .select({ ticketId: m.ticketId, number: t.number, title: t.title, declaredAt: m.declaredAt, lastUpdateAt: m.lastUpdateAt, nextUpdateDueAt: m.nextUpdateDueAt })
    .from(m)
    .innerJoin(t, eq(t.id, m.ticketId))
    .where(and(eq(m.customerId, customerId), eq(m.status, 'active'), eq(m.portalBanner, true)))
    .orderBy(desc(m.declaredAt))
    .limit(limit);
  const items: MajorBanner[] = [];
  for (const r of rows) {
    const [latest] = await tx
      .select({ body: schema.majorIncidentUpdates.body, createdAt: schema.majorIncidentUpdates.createdAt })
      .from(schema.majorIncidentUpdates)
      .where(and(eq(schema.majorIncidentUpdates.ticketId, r.ticketId), eq(schema.majorIncidentUpdates.kind, 'stakeholder'), eq(schema.majorIncidentUpdates.portalBanner, true)))
      .orderBy(desc(schema.majorIncidentUpdates.createdAt))
      .limit(1);
    items.push({ kind: 'major_incident', ticketId: r.ticketId, number: r.number, title: r.title, declaredAt: r.declaredAt, lastUpdateAt: r.lastUpdateAt, nextUpdateDueAt: r.nextUpdateDueAt, latestUpdate: latest ? { body: latest.body, at: latest.createdAt } : null });
  }
  return items;
}
