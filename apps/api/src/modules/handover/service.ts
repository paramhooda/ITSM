import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '@/core/context';
import { schema, type Tx } from '@/db/client';
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from '@/core/errors';
import { config } from '@/config';
import { queueNotification } from '@/modules/notifications/dispatch';
import { whoIsOnCall } from '@/modules/oncall/service';
import { buildDigest, renderHandover } from '@/modules/ai/digest';
import { llmJson, enabled as aiEnabled, asSteps, type Steps } from '@/modules/ai/service';
import { loadAiSettings, featureEnabled } from '@/modules/ai/guards';
import { HANDOVER_SYSTEM } from '@/modules/ai/prompt';
import type { HandoverFacts } from '@/db/schema/handover';
import { currentAndNext, previous, isTime, isValidZone, type ShiftInstance } from './shifts';

/**
 * Shift handover. Shifts belong to a team (edited by people with
 * oncall:manage); a handover is written by a member of the team (or anyone
 * with handover:write across teams) from the digest, published to the
 * incoming shift and acknowledged by someone other than its author. Reading
 * is open to staff with tickets:read; customer users never reach these rows.
 */

export type ShiftRow = typeof schema.teamShifts.$inferSelect;
export type HandoverRow = typeof schema.shiftHandovers.$inferSelect;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
export const shiftInput = z.object({
  teamId: z.string().uuid(),
  name: z.string().trim().min(1).max(60),
  startTime: time,
  endTime: time,
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5, 6, 7]),
  timezone: z.string().trim().max(64).default('UTC'),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  isActive: z.boolean().default(true),
});
export const shiftPatch = shiftInput.partial().omit({ teamId: true });
export const handoverInput = z.object({
  teamId: z.string().uuid(),
  shiftId: z.string().uuid().nullable().optional(),
  shiftDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  body: z.string().max(20_000).default(''),
  aiDraft: z.string().max(20_000).nullable().optional(),
  facts: z.unknown().optional(),
  publish: z.boolean().default(false),
});
export const handoverPatch = z.object({ body: z.string().max(20_000).optional(), shiftId: z.string().uuid().nullable().optional(), shiftDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
export const draftInput = z.object({ teamId: z.string().uuid(), notes: z.string().max(4000).optional() });
export const listQuerySchema = z.object({ teamId: z.string().uuid().optional(), status: z.enum(['draft', 'final', 'acknowledged', 'open', 'all']).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) });
const draftSchema = z.object({ body: z.string().trim().min(40).max(12_000) });

// ---------------------------------------------------------------- guards

function staffOnly(ctx: Ctx) {
  if (ctx.user.userType === 'customer') throw new ForbiddenError('Shift handovers are internal to the service provider');
}
const isMember = (ctx: Ctx, teamId: string) => ctx.user.teams.some((t) => t.id === teamId);

/** Writing for a team: a member with handover:write, or someone who manages on-call (and so every team's shifts). */
function requireWriter(ctx: Ctx, teamId: string) {
  staffOnly(ctx);
  ctx.require('handover:write');
  if (!isMember(ctx, teamId) && !ctx.can('oncall:manage')) throw new ForbiddenError('Only members of the team write its handovers');
}

async function loadTeam(tx: Tx, id: string) {
  const [team] = await tx.select({ id: schema.teams.id, key: schema.teams.key, name: schema.teams.name, teamType: schema.teams.teamType, isActive: schema.teams.isActive }).from(schema.teams).where(eq(schema.teams.id, id)).limit(1);
  if (!team) throw new NotFoundError('Team');
  return team;
}

// ---------------------------------------------------------------- shifts

export async function listShifts(ctx: Ctx, teamId?: string) {
  staffOnly(ctx);
  ctx.require('tickets:read');
  const where = teamId ? eq(schema.teamShifts.teamId, teamId) : undefined;
  const items = await ctx.tx.select().from(schema.teamShifts).where(where).orderBy(asc(schema.teamShifts.teamId), asc(schema.teamShifts.sortOrder), asc(schema.teamShifts.startTime));
  return { items };
}

function validateShift(input: { startTime?: string; endTime?: string; timezone?: string }) {
  if (input.startTime && !isTime(input.startTime)) throw new ValidationError('startTime must be HH:MM');
  if (input.endTime && !isTime(input.endTime)) throw new ValidationError('endTime must be HH:MM');
  if (input.timezone && !isValidZone(input.timezone)) throw new ValidationError(`Unknown timezone: ${input.timezone}`);
}

export async function createShift(ctx: Ctx, input: z.infer<typeof shiftInput>) {
  staffOnly(ctx);
  ctx.require('oncall:manage');
  validateShift(input);
  await loadTeam(ctx.tx, input.teamId);
  const [row] = await ctx.tx.insert(schema.teamShifts).values({ ...input, days: [...new Set(input.days)].sort() }).returning();
  await ctx.audit({ entityType: 'team_shift', entityId: row.id, entityLabel: row.name, action: 'create', metadata: { teamId: row.teamId, startTime: row.startTime, endTime: row.endTime, timezone: row.timezone } });
  return row;
}

export async function updateShift(ctx: Ctx, id: string, patch: z.infer<typeof shiftPatch>) {
  staffOnly(ctx);
  ctx.require('oncall:manage');
  validateShift(patch);
  const [before] = await ctx.tx.select().from(schema.teamShifts).where(eq(schema.teamShifts.id, id)).limit(1);
  if (!before) throw new NotFoundError('Shift');
  const [row] = await ctx.tx.update(schema.teamShifts).set({ ...patch, ...(patch.days ? { days: [...new Set(patch.days)].sort() } : {}), updatedAt: new Date() }).where(eq(schema.teamShifts.id, id)).returning();
  await ctx.audit({ entityType: 'team_shift', entityId: id, entityLabel: row.name, action: 'update', metadata: { teamId: row.teamId, patch } });
  return row;
}

export async function deleteShift(ctx: Ctx, id: string) {
  staffOnly(ctx);
  ctx.require('oncall:manage');
  const [row] = await ctx.tx.select().from(schema.teamShifts).where(eq(schema.teamShifts.id, id)).limit(1);
  if (!row) throw new NotFoundError('Shift');
  await ctx.tx.delete(schema.teamShifts).where(eq(schema.teamShifts.id, id));
  await ctx.audit({ entityType: 'team_shift', entityId: id, entityLabel: row.name, action: 'delete', metadata: { teamId: row.teamId } });
  return { ok: true as const };
}

// ---------------------------------------------------------------- teams overview

const shiftView = (i: ShiftInstance<ShiftRow> | null) => (i ? { ...i.shift, shiftDate: i.shiftDate, startsAt: i.startsAt, endsAt: i.endsAt } : null);

/** Every active team with its shifts, the shift running now and next, the latest handover and how many published ones await acknowledgement. */
export async function listTeams(ctx: Ctx, at = new Date()) {
  staffOnly(ctx);
  ctx.require('tickets:read');
  const teams = await ctx.tx.select({ id: schema.teams.id, key: schema.teams.key, name: schema.teams.name, teamType: schema.teams.teamType }).from(schema.teams).where(eq(schema.teams.isActive, true)).orderBy(asc(schema.teams.name));
  if (!teams.length) return { items: [] };
  const shifts = await ctx.tx.select().from(schema.teamShifts).where(and(inArray(schema.teamShifts.teamId, teams.map((t) => t.id)), eq(schema.teamShifts.isActive, true))).orderBy(asc(schema.teamShifts.sortOrder), asc(schema.teamShifts.startTime));
  const latest = await ctx.tx.execute(sql`
    SELECT DISTINCT ON (h.team_id) h.team_id, h.id, h.status, h.shift_date::text AS shift_date, h.published_at, h.acknowledged_at, s.name AS shift_name, u.name AS author_name
    FROM shift_handovers h LEFT JOIN team_shifts s ON s.id = h.shift_id LEFT JOIN users u ON u.id = h.author_id
    WHERE h.team_id = ANY(ARRAY[${sql.join(teams.map((t) => sql`${t.id}::uuid`), sql`, `)}]::uuid[])
    ORDER BY h.team_id, h.created_at DESC`);
  const pending = await ctx.tx.execute(sql`SELECT team_id, count(*)::int AS n FROM shift_handovers WHERE status = 'final' GROUP BY team_id`);
  const latestMap = new Map((latest.rows as { team_id: string; id: string; status: string; shift_date: string; published_at: Date | null; acknowledged_at: Date | null; shift_name: string | null; author_name: string | null }[]).map((r) => [r.team_id, r]));
  const pendingMap = new Map((pending.rows as { team_id: string; n: number }[]).map((r) => [r.team_id, Number(r.n)]));
  const canWriteAny = ctx.can('handover:write') && ctx.can('oncall:manage');
  const items = teams.map((t) => {
    const own = shifts.filter((s) => s.teamId === t.id);
    const { current, next } = currentAndNext(own, at);
    const l = latestMap.get(t.id);
    return {
      ...t,
      canWrite: ctx.can('handover:write') && (canWriteAny || isMember(ctx, t.id)),
      shifts: own,
      current: shiftView(current),
      next: shiftView(next),
      latest: l ? { id: l.id, status: l.status, shiftDate: l.shift_date, shiftName: l.shift_name, authorName: l.author_name, publishedAt: l.published_at, acknowledgedAt: l.acknowledged_at } : null,
      unacknowledged: pendingMap.get(t.id) ?? 0,
    };
  });
  // the person's own teams first, then the ones with shifts
  items.sort((a, b) => Number(isMember(ctx, b.id)) - Number(isMember(ctx, a.id)) || Number(b.shifts.length > 0) - Number(a.shifts.length > 0) || a.name.localeCompare(b.name));
  return { items };
}

// ---------------------------------------------------------------- digest and draft

/** The shift the handover covers: the one running now (its start is the window start), else the most recent one. */
async function windowFor(tx: Tx, teamId: string, at: Date) {
  const shifts = await tx.select().from(schema.teamShifts).where(and(eq(schema.teamShifts.teamId, teamId), eq(schema.teamShifts.isActive, true)));
  const { current, next } = currentAndNext(shifts, at);
  const prev = current ? null : previous(shifts, at);
  const covered = current ?? prev;
  const from = covered ? covered.startsAt : new Date(at.getTime() - 12 * 3_600_000);
  const nextAt = next ? next.startsAt : current ? current.endsAt : at;
  return { shifts, covered, next, from, nextAt };
}

export async function digest(ctx: Ctx, teamId: string, at = new Date()): Promise<HandoverFacts> {
  staffOnly(ctx);
  ctx.require('tickets:read');
  const w = await windowFor(ctx.tx, teamId, at);
  return buildDigest(ctx, { teamId, from: w.from, to: at, nextAt: w.nextAt });
}

/**
 * The digest plus a draft note: the model's when a provider is on and the
 * `handover` feature is enabled, the deterministic one otherwise. The facts
 * are gathered in one transaction and the model is called outside it (the
 * Steps pattern), so no connection is held while the provider answers.
 */
export async function draft(who: Ctx | Steps, input: z.infer<typeof draftInput>, at = new Date()) {
  const s = asSteps(who);
  const { facts, useModel } = await s.tx(async (ctx) => {
    requireWriter(ctx, input.teamId);
    const f = await digest(ctx, input.teamId, at);
    return { facts: f, useModel: aiEnabled() && featureEnabled(await loadAiSettings(ctx.tx), 'handover') };
  });
  const fallback = renderHandover(facts, input.notes);
  if (!useModel) return { body: fallback, facts, ai: false };
  const llm = await llmJson(HANDOVER_SYSTEM, JSON.stringify({ team: facts.team.name, window: facts.window, counts: facts.counts, tickets: facts.tickets, major: facts.major, changes: facts.changes, onCall: facts.onCall, notes: input.notes ?? '' }), (v) => draftSchema.parse(v), { maxTokens: 1400 });
  return llm ? { body: llm.data.body, facts, ai: true } : { body: fallback, facts, ai: false };
}

// ---------------------------------------------------------------- handovers

const detailColumns = {
  id: schema.shiftHandovers.id,
  teamId: schema.shiftHandovers.teamId,
  teamName: schema.teams.name,
  shiftId: schema.shiftHandovers.shiftId,
  shiftName: schema.teamShifts.name,
  shiftDate: schema.shiftHandovers.shiftDate,
  authorId: schema.shiftHandovers.authorId,
  authorName: sql<string | null>`(SELECT u.name FROM users u WHERE u.id = ${schema.shiftHandovers.authorId})`,
  status: schema.shiftHandovers.status,
  aiDraft: schema.shiftHandovers.aiDraft,
  body: schema.shiftHandovers.body,
  facts: schema.shiftHandovers.facts,
  publishedAt: schema.shiftHandovers.publishedAt,
  acknowledgedBy: schema.shiftHandovers.acknowledgedBy,
  acknowledgedByName: sql<string | null>`(SELECT u.name FROM users u WHERE u.id = ${schema.shiftHandovers.acknowledgedBy})`,
  acknowledgedAt: schema.shiftHandovers.acknowledgedAt,
  acknowledgementNote: schema.shiftHandovers.acknowledgementNote,
  createdAt: schema.shiftHandovers.createdAt,
  updatedAt: schema.shiftHandovers.updatedAt,
};

function base(ctx: Ctx) {
  return ctx.tx.select(detailColumns).from(schema.shiftHandovers).leftJoin(schema.teams, eq(schema.teams.id, schema.shiftHandovers.teamId)).leftJoin(schema.teamShifts, eq(schema.teamShifts.id, schema.shiftHandovers.shiftId));
}

export async function list(ctx: Ctx, q: z.infer<typeof listQuerySchema>) {
  staffOnly(ctx);
  ctx.require('tickets:read');
  const conds: SQL[] = [];
  if (q.teamId) conds.push(eq(schema.shiftHandovers.teamId, q.teamId));
  if (q.status === 'open') conds.push(inArray(schema.shiftHandovers.status, ['draft', 'final']));
  else if (q.status && q.status !== 'all') conds.push(eq(schema.shiftHandovers.status, q.status));
  const where = conds.length ? and(...conds) : undefined;
  const [{ total }] = await ctx.tx.select({ total: sql<number>`count(*)::int` }).from(schema.shiftHandovers).where(where);
  const items = await base(ctx).where(where).orderBy(desc(schema.shiftHandovers.shiftDate), desc(schema.shiftHandovers.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
  return { items, total, page: q.page, pageSize: q.pageSize };
}

export async function get(ctx: Ctx, id: string) {
  staffOnly(ctx);
  ctx.require('tickets:read');
  const [row] = await base(ctx).where(eq(schema.shiftHandovers.id, id)).limit(1);
  if (!row) throw new NotFoundError('Handover');
  return row;
}

async function loadRow(tx: Tx, id: string) {
  const [row] = await tx.select().from(schema.shiftHandovers).where(eq(schema.shiftHandovers.id, id)).limit(1);
  if (!row) throw new NotFoundError('Handover');
  return row;
}

function parseFacts(v: unknown): HandoverFacts | null {
  if (!v || typeof v !== 'object') return null;
  const f = v as HandoverFacts;
  return f.counts && f.team && Array.isArray(f.tickets) ? f : null;
}

export async function create(ctx: Ctx, input: z.infer<typeof handoverInput>, at = new Date()) {
  requireWriter(ctx, input.teamId);
  const team = await loadTeam(ctx.tx, input.teamId);
  const w = await windowFor(ctx.tx, input.teamId, at);
  let shiftId = input.shiftId ?? w.covered?.shift.id ?? null;
  if (shiftId && !w.shifts.some((s) => s.id === shiftId)) {
    const [s] = await ctx.tx.select({ id: schema.teamShifts.id }).from(schema.teamShifts).where(and(eq(schema.teamShifts.id, shiftId), eq(schema.teamShifts.teamId, input.teamId))).limit(1);
    if (!s) shiftId = null;
  }
  const shiftDate = input.shiftDate ?? w.covered?.shiftDate ?? at.toISOString().slice(0, 10);
  if (input.publish && !input.body.trim()) throw new ValidationError('Write the handover before publishing it');
  const [row] = await ctx.tx
    .insert(schema.shiftHandovers)
    .values({ teamId: team.id, shiftId, shiftDate, authorId: ctx.user.id, status: 'draft', aiDraft: input.aiDraft ?? null, body: input.body, facts: parseFacts(input.facts) })
    .returning();
  await ctx.audit({ entityType: 'shift_handover', entityId: row.id, entityLabel: `${team.name} ${shiftDate}`, action: 'create', metadata: { teamId: team.id, shiftId, shiftDate } });
  if (input.publish) return publish(ctx, row.id, at);
  return get(ctx, row.id);
}

export async function update(ctx: Ctx, id: string, patch: z.infer<typeof handoverPatch>) {
  const row = await loadRow(ctx.tx, id);
  requireWriter(ctx, row.teamId);
  if (row.status !== 'draft') throw new ConflictError('A published handover cannot be edited; write a new one');
  if (row.authorId !== ctx.user.id && !ctx.can('oncall:manage')) throw new ForbiddenError('Only the author edits a draft');
  await ctx.tx.update(schema.shiftHandovers).set({ ...patch, updatedAt: new Date() }).where(eq(schema.shiftHandovers.id, id));
  await ctx.audit({ entityType: 'shift_handover', entityId: id, action: 'update', metadata: { fields: Object.keys(patch) } });
  return get(ctx, id);
}

/** The people the handover reaches: whoever is on call when the next shift starts, else every active member of the team, never the author. */
async function incomingRecipients(tx: Tx, teamId: string, authorId: string | null, nextAt: Date) {
  const onCall = (await whoIsOnCall(tx, teamId, nextAt)).map((e) => e.userId).filter((x): x is string => !!x);
  const ids = onCall.length ? onCall : (await tx.select({ userId: schema.teamMembers.userId }).from(schema.teamMembers).where(eq(schema.teamMembers.teamId, teamId))).map((m) => m.userId);
  const clean = [...new Set(ids)].filter((id) => id !== authorId);
  if (!clean.length) return { recipients: [], via: onCall.length ? ('oncall' as const) : ('team' as const) };
  const users = await tx.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, phone: schema.users.phone, whatsappOptIn: schema.users.whatsappOptIn }).from(schema.users).where(and(inArray(schema.users.id, clean), eq(schema.users.status, 'active')));
  return { recipients: users.map((u) => ({ userId: u.id, name: u.name, email: u.email, phone: u.phone, whatsappOptIn: u.whatsappOptIn })), via: onCall.length ? ('oncall' as const) : ('team' as const) };
}

/** The "Watch first" section of a handover (the whole note when it has none), capped at 600 characters; the notification and the board panel share it. */
export const excerpt = (body: string) => {
  const m = /## Watch first\s*\n([\s\S]*?)(?:\n## |$)/.exec(body);
  const text = (m ? m[1] : body).trim();
  return text.length > 600 ? `${text.slice(0, 597)}…` : text;
};

export async function publish(ctx: Ctx, id: string, at = new Date()) {
  const row = await loadRow(ctx.tx, id);
  requireWriter(ctx, row.teamId);
  if (row.status !== 'draft') throw new ConflictError('This handover is already published');
  if (!row.body.trim()) throw new ValidationError('Write the handover before publishing it');
  const team = await loadTeam(ctx.tx, row.teamId);
  const w = await windowFor(ctx.tx, row.teamId, at);
  await ctx.tx.update(schema.shiftHandovers).set({ status: 'final', publishedAt: at, updatedAt: at }).where(eq(schema.shiftHandovers.id, id));
  const { recipients, via } = await incomingRecipients(ctx.tx, row.teamId, row.authorId, w.nextAt);
  const link = `${config.APP_URL.replace(/\/$/, '')}/operations/handover?team=${row.teamId}&handover=${row.id}`;
  const shiftName = row.shiftId ? (w.shifts.find((s) => s.id === row.shiftId)?.name ?? null) : null;
  if (recipients.length) {
    await queueNotification(ctx.tx, {
      event: 'handover.published',
      recipients,
      data: { handover: { team: team.name, shift: shiftName ?? 'shift', date: row.shiftDate, author: ctx.user.name, excerpt: excerpt(row.body), link } },
      channels: ['email', 'in_app', 'whatsapp'],
      entityType: 'shift_handover',
      entityId: row.id,
      link: `/operations/handover?team=${row.teamId}&handover=${row.id}`,
      title: `${team.name} handover: ${shiftName ?? row.shiftDate} by ${ctx.user.name}`,
      body: excerpt(row.body),
    });
  }
  await ctx.audit({ entityType: 'shift_handover', entityId: id, entityLabel: `${team.name} ${row.shiftDate}`, action: 'publish', metadata: { teamId: team.id, recipients: recipients.map((r) => r.userId), via } });
  return get(ctx, id);
}

export async function acknowledge(ctx: Ctx, id: string, note?: string | null) {
  const row = await loadRow(ctx.tx, id);
  staffOnly(ctx);
  ctx.require('handover:write');
  if (row.status === 'draft') throw new ConflictError('The handover has not been published yet');
  if (row.status === 'acknowledged') throw new ConflictError('The handover is already acknowledged');
  if (row.authorId === ctx.user.id) throw new ValidationError('Someone from the incoming shift acknowledges the handover, not its author');
  if (!isMember(ctx, row.teamId) && !ctx.can('oncall:manage')) throw new ForbiddenError('Only members of the team acknowledge its handovers');
  const now = new Date();
  await ctx.tx.update(schema.shiftHandovers).set({ status: 'acknowledged', acknowledgedBy: ctx.user.id, acknowledgedAt: now, acknowledgementNote: note?.trim() || null, updatedAt: now }).where(eq(schema.shiftHandovers.id, id));
  await ctx.audit({ entityType: 'shift_handover', entityId: id, action: 'acknowledge', metadata: { teamId: row.teamId, note: note?.trim() || null } });
  return get(ctx, id);
}

export async function remove(ctx: Ctx, id: string) {
  const row = await loadRow(ctx.tx, id);
  requireWriter(ctx, row.teamId);
  if (row.status !== 'draft' && !ctx.can('oncall:manage')) throw new ConflictError('Published handovers are kept; only a manager can delete one');
  if (row.status === 'draft' && row.authorId !== ctx.user.id && !ctx.can('oncall:manage')) throw new ForbiddenError('Only the author deletes a draft');
  await ctx.tx.delete(schema.shiftHandovers).where(eq(schema.shiftHandovers.id, id));
  await ctx.audit({ entityType: 'shift_handover', entityId: id, action: 'delete', metadata: { teamId: row.teamId, status: row.status } });
  return { ok: true as const };
}
