import { eq, and, inArray, asc, lt, gt, sql } from 'drizzle-orm';
import { schema, type Tx } from '@/db/client';
import type { Ctx } from '@/core/context';
import { NotFoundError, ValidationError, ForbiddenError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import type { EscalationStep } from '@/db/schema/oncall';
import { NOTIFICATION_CHANNELS } from '@/modules/notifications/dispatch';
import { ROTATIONS, isHm, isValidZone, periodDays, resolveOnCall, expandSchedule, type OverrideDef, type Participant, type RotaDef, type Shift } from './schedule';

/**
 * On-call schedules: a team's rotas, the people in them, overrides and the
 * escalation policies that decide whom a page reaches. Everything here is
 * staff-only; customer users never hold `oncall:read`.
 */

export type RotaRow = typeof schema.oncallRotas.$inferSelect;
export type OverrideRow = typeof schema.oncallOverrides.$inferSelect;
export type PolicyRow = typeof schema.escalationPolicies.$inferSelect;

export const MAX_RANGE_DAYS = 62;
export const MAX_STEPS = 10;
export const STEP_TARGETS = ['oncall', 'user', 'team', 'manager'] as const;

export interface UserLite {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  whatsappOptIn: boolean;
}

const USER_LITE = { id: schema.users.id, name: schema.users.name, email: schema.users.email, phone: schema.users.phone, whatsappOptIn: schema.users.whatsappOptIn };

/** Active staff users by id (inactive or customer users are dropped, so a page never reaches them). */
export async function usersLite(tx: Tx, ids: (string | null | undefined)[]): Promise<UserLite[]> {
  const clean = [...new Set(ids.filter((x): x is string => !!x))];
  if (!clean.length) return [];
  return tx.select(USER_LITE).from(schema.users).where(and(inArray(schema.users.id, clean), eq(schema.users.status, 'active'), eq(schema.users.userType, 'msp')));
}

export async function userMap(tx: Tx, ids: (string | null | undefined)[]) {
  const clean = [...new Set(ids.filter((x): x is string => !!x))];
  if (!clean.length) return new Map<string, { id: string; name: string; email: string; phone: string | null }>();
  const rows = await tx.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, phone: schema.users.phone }).from(schema.users).where(inArray(schema.users.id, clean));
  return new Map(rows.map((r) => [r.id, r]));
}

const staffOnly = (ctx: Ctx) => {
  if (ctx.user.userType === 'customer') throw new ForbiddenError('On-call is for staff users');
};

async function requireTeam(tx: Tx, id: string) {
  const [t] = await tx.select().from(schema.teams).where(eq(schema.teams.id, id)).limit(1);
  if (!t) throw new NotFoundError('Team');
  return t;
}

async function requireStaff(tx: Tx, ids: string[], label: string) {
  const users = await usersLite(tx, ids);
  const found = new Set(users.map((u) => u.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new ValidationError(`${label}: ${missing.length === 1 ? 'one person is' : `${missing.length} people are`} not active staff`);
  return users;
}

// ------------------------------------------------------------------ rotas

export interface RotaInput {
  teamId: string;
  name: string;
  description?: string | null;
  timezone?: string;
  rotation?: string;
  rotationDays?: number;
  handoffTime?: string;
  shiftStart?: string | null;
  shiftEnd?: string | null;
  startDate: string;
  sortOrder?: number;
  isActive?: boolean;
  /** Ordered user ids; the first starts on the start date. */
  participants?: string[];
}

function validateRota(input: Partial<RotaInput>) {
  if (input.timezone !== undefined && !isValidZone(input.timezone)) throw new ValidationError('Unknown timezone');
  if (input.rotation !== undefined && !(ROTATIONS as readonly string[]).includes(input.rotation)) throw new ValidationError('Rotation must be weekly, daily or custom');
  if (input.rotationDays !== undefined && (input.rotationDays < 1 || input.rotationDays > 365)) throw new ValidationError('Rotation length must be between 1 and 365 days');
  if (input.handoffTime !== undefined && !isHm(input.handoffTime)) throw new ValidationError('Handoff time must be HH:mm');
  const hasStart = input.shiftStart !== undefined && input.shiftStart !== null;
  const hasEnd = input.shiftEnd !== undefined && input.shiftEnd !== null;
  if (hasStart !== hasEnd && (input.shiftStart !== undefined || input.shiftEnd !== undefined)) throw new ValidationError('Give both a shift start and a shift end, or neither');
  if (hasStart && !isHm(input.shiftStart)) throw new ValidationError('Shift start must be HH:mm');
  if (hasEnd && !isHm(input.shiftEnd)) throw new ValidationError('Shift end must be HH:mm');
  if (hasStart && hasEnd && input.shiftStart === input.shiftEnd) throw new ValidationError('A shift window cannot be empty');
  if (input.startDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) throw new ValidationError('Start date must be YYYY-MM-DD');
}

async function setParticipants(tx: Tx, rotaId: string, userIds: string[]) {
  const ordered = [...new Set(userIds)];
  await requireStaff(tx, ordered, 'Participants');
  await tx.delete(schema.oncallRotaParticipants).where(eq(schema.oncallRotaParticipants.rotaId, rotaId));
  if (ordered.length) await tx.insert(schema.oncallRotaParticipants).values(ordered.map((userId, position) => ({ rotaId, userId, position })));
}

async function participantsOf(tx: Tx, rotaIds: string[]) {
  if (!rotaIds.length) return [] as { rotaId: string; userId: string; position: number; name: string; email: string; phone: string | null }[];
  return tx
    .select({ rotaId: schema.oncallRotaParticipants.rotaId, userId: schema.oncallRotaParticipants.userId, position: schema.oncallRotaParticipants.position, name: schema.users.name, email: schema.users.email, phone: schema.users.phone })
    .from(schema.oncallRotaParticipants)
    .innerJoin(schema.users, eq(schema.users.id, schema.oncallRotaParticipants.userId))
    .where(inArray(schema.oncallRotaParticipants.rotaId, rotaIds))
    .orderBy(asc(schema.oncallRotaParticipants.rotaId), asc(schema.oncallRotaParticipants.position));
}

const rotaDef = (r: RotaRow): RotaDef => ({ id: r.id, timezone: r.timezone, rotation: r.rotation, rotationDays: r.rotationDays, handoffTime: r.handoffTime, shiftStart: r.shiftStart, shiftEnd: r.shiftEnd, startDate: r.startDate });

/** Rotas (all teams, or one) with their ordered participants. */
export async function listRotas(ctx: Ctx, teamId?: string | null) {
  staffOnly(ctx);
  const rows = await ctx.tx
    .select({ rota: schema.oncallRotas, teamName: schema.teams.name })
    .from(schema.oncallRotas)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.oncallRotas.teamId))
    .where(teamId ? eq(schema.oncallRotas.teamId, teamId) : undefined)
    .orderBy(asc(schema.teams.name), asc(schema.oncallRotas.sortOrder), asc(schema.oncallRotas.createdAt));
  const parts = await participantsOf(ctx.tx, rows.map((r) => r.rota.id));
  return rows.map((r) => ({ ...r.rota, teamName: r.teamName, periodDays: periodDays(r.rota), participants: parts.filter((p) => p.rotaId === r.rota.id).map(({ rotaId: _r, ...p }) => p) }));
}

export async function getRota(ctx: Ctx, id: string) {
  const [row] = await listRotas(ctx).then((rows) => rows.filter((r) => r.id === id));
  if (!row) throw new NotFoundError('Rota');
  return row;
}

export async function createRota(ctx: Ctx, input: RotaInput) {
  ctx.require('oncall:manage');
  validateRota(input);
  await requireTeam(ctx.tx, input.teamId);
  const [row] = await ctx.tx
    .insert(schema.oncallRotas)
    .values({
      teamId: input.teamId,
      name: input.name,
      description: input.description ?? null,
      timezone: input.timezone ?? 'Asia/Kolkata',
      rotation: input.rotation ?? 'weekly',
      rotationDays: input.rotationDays ?? 7,
      handoffTime: input.handoffTime ?? '09:00',
      shiftStart: input.shiftStart ?? null,
      shiftEnd: input.shiftEnd ?? null,
      startDate: input.startDate,
      sortOrder: input.sortOrder ?? 0,
      isActive: input.isActive ?? true,
    })
    .returning();
  await setParticipants(ctx.tx, row!.id, input.participants ?? []);
  await ctx.audit({ entityType: 'oncall_rota', entityId: row!.id, entityLabel: row!.name, action: 'create', metadata: { teamId: input.teamId, participants: input.participants?.length ?? 0 } });
  return getRota(ctx, row!.id);
}

export async function updateRota(ctx: Ctx, id: string, patch: Partial<RotaInput>) {
  ctx.require('oncall:manage');
  validateRota(patch);
  const [before] = await ctx.tx.select().from(schema.oncallRotas).where(eq(schema.oncallRotas.id, id)).limit(1);
  if (!before) throw new NotFoundError('Rota');
  if (patch.teamId && patch.teamId !== before.teamId) await requireTeam(ctx.tx, patch.teamId);
  const values: Partial<typeof schema.oncallRotas.$inferInsert> = { updatedAt: new Date() };
  for (const k of ['teamId', 'name', 'description', 'timezone', 'rotation', 'rotationDays', 'handoffTime', 'shiftStart', 'shiftEnd', 'startDate', 'sortOrder', 'isActive'] as const) {
    if (patch[k] !== undefined) (values as Record<string, unknown>)[k] = patch[k];
  }
  await ctx.tx.update(schema.oncallRotas).set(values).where(eq(schema.oncallRotas.id, id));
  if (patch.participants) await setParticipants(ctx.tx, id, patch.participants);
  await ctx.audit({ entityType: 'oncall_rota', entityId: id, entityLabel: patch.name ?? before.name, action: 'update', changes: diffChanges(before as Record<string, unknown>, values as Record<string, unknown>), metadata: patch.participants ? { participants: patch.participants.length } : undefined });
  return getRota(ctx, id);
}

export async function deleteRota(ctx: Ctx, id: string) {
  ctx.require('oncall:manage');
  const [before] = await ctx.tx.select().from(schema.oncallRotas).where(eq(schema.oncallRotas.id, id)).limit(1);
  if (!before) throw new NotFoundError('Rota');
  await ctx.tx.delete(schema.oncallRotas).where(eq(schema.oncallRotas.id, id));
  await ctx.audit({ entityType: 'oncall_rota', entityId: id, entityLabel: before.name, action: 'delete' });
}

// ------------------------------------------------------------------ overrides

export interface OverrideInput {
  rotaId: string;
  userId: string;
  startsAt: Date;
  endsAt: Date;
  reason?: string | null;
}

const canManageOverride = (ctx: Ctx, userId: string) => ctx.can('oncall:manage') || userId === ctx.user.id;

export async function listOverrides(ctx: Ctx, q: { teamId?: string | null; rotaId?: string | null; from?: Date; to?: Date }) {
  staffOnly(ctx);
  const from = q.from ?? new Date();
  const to = q.to ?? new Date(from.getTime() + 30 * 86_400_000);
  const conds = [gt(schema.oncallOverrides.endsAt, from), lt(schema.oncallOverrides.startsAt, to)];
  if (q.rotaId) conds.push(eq(schema.oncallOverrides.rotaId, q.rotaId));
  if (q.teamId) conds.push(eq(schema.oncallRotas.teamId, q.teamId));
  const rows = await ctx.tx
    .select({ o: schema.oncallOverrides, rotaName: schema.oncallRotas.name, teamId: schema.oncallRotas.teamId, userName: schema.users.name })
    .from(schema.oncallOverrides)
    .innerJoin(schema.oncallRotas, eq(schema.oncallRotas.id, schema.oncallOverrides.rotaId))
    .innerJoin(schema.users, eq(schema.users.id, schema.oncallOverrides.userId))
    .where(and(...conds))
    .orderBy(asc(schema.oncallOverrides.startsAt));
  const creators = await userMap(ctx.tx, rows.map((r) => r.o.createdBy));
  return rows.map((r) => ({ ...r.o, rotaName: r.rotaName, teamId: r.teamId, userName: r.userName, createdByName: creators.get(r.o.createdBy ?? '')?.name ?? null, mine: canManageOverride(ctx, r.o.userId) || r.o.createdBy === ctx.user.id }));
}

/** Anyone with `oncall:manage` covers anyone; other staff may put themselves on cover. */
export async function createOverride(ctx: Ctx, input: OverrideInput) {
  staffOnly(ctx);
  ctx.require('oncall:read');
  if (!canManageOverride(ctx, input.userId)) throw new ForbiddenError('You can only add cover for yourself');
  const [rota] = await ctx.tx.select().from(schema.oncallRotas).where(eq(schema.oncallRotas.id, input.rotaId)).limit(1);
  if (!rota) throw new NotFoundError('Rota');
  if (!(input.endsAt > input.startsAt)) throw new ValidationError('The cover must end after it starts');
  if (input.endsAt.getTime() - input.startsAt.getTime() > 31 * 86_400_000) throw new ValidationError('Cover is limited to 31 days; add several entries for longer periods');
  const [user] = await requireStaff(ctx.tx, [input.userId], 'Cover');
  const [row] = await ctx.tx.insert(schema.oncallOverrides).values({ rotaId: input.rotaId, userId: input.userId, startsAt: input.startsAt, endsAt: input.endsAt, reason: input.reason ?? null, createdBy: ctx.user.id }).returning();
  await ctx.audit({ entityType: 'oncall_override', entityId: row!.id, entityLabel: `${user!.name} covers ${rota.name}`, action: 'create', metadata: { rotaId: rota.id, userId: input.userId, startsAt: input.startsAt, endsAt: input.endsAt } });
  return { ...row!, rotaName: rota.name, teamId: rota.teamId, userName: user!.name };
}

export async function deleteOverride(ctx: Ctx, id: string) {
  staffOnly(ctx);
  const [row] = await ctx.tx.select().from(schema.oncallOverrides).where(eq(schema.oncallOverrides.id, id)).limit(1);
  if (!row) throw new NotFoundError('Override');
  if (!canManageOverride(ctx, row.userId) && row.createdBy !== ctx.user.id) throw new ForbiddenError('You can only remove cover you added or that is yours');
  await ctx.tx.delete(schema.oncallOverrides).where(eq(schema.oncallOverrides.id, id));
  await ctx.audit({ entityType: 'oncall_override', entityId: id, action: 'delete', metadata: { rotaId: row.rotaId, userId: row.userId } });
}

// ------------------------------------------------------------------ policies

export interface PolicyInput {
  name: string;
  description?: string | null;
  steps: EscalationStep[];
  repeatCount?: number;
  assignOnAck?: boolean;
  isActive?: boolean;
}

export async function validateSteps(tx: Tx, steps: EscalationStep[]) {
  if (!Array.isArray(steps) || !steps.length) throw new ValidationError('A policy needs at least one step');
  if (steps.length > MAX_STEPS) throw new ValidationError(`A policy can have at most ${MAX_STEPS} steps`);
  const userIds: string[] = [];
  const teamIds: string[] = [];
  for (const [i, s] of steps.entries()) {
    const n = i + 1;
    if (!(STEP_TARGETS as readonly string[]).includes(s.target)) throw new ValidationError(`Step ${n}: unknown target`);
    if (s.target === 'user' && !s.userId) throw new ValidationError(`Step ${n}: pick the person to page`);
    if (s.userId) userIds.push(s.userId);
    if (s.teamId) teamIds.push(s.teamId);
    const channels = [...new Set(s.channels ?? [])];
    if (!channels.length || channels.some((c) => !(NOTIFICATION_CHANNELS as string[]).includes(c))) throw new ValidationError(`Step ${n}: choose at least one channel (email, in-app, WhatsApp)`);
    if (!Number.isInteger(s.timeoutMinutes) || s.timeoutMinutes < 1 || s.timeoutMinutes > 1440) throw new ValidationError(`Step ${n}: the timeout must be between 1 and 1440 minutes`);
  }
  if (userIds.length) await requireStaff(tx, [...new Set(userIds)], 'Step targets');
  if (teamIds.length) {
    const rows = await tx.select({ id: schema.teams.id }).from(schema.teams).where(inArray(schema.teams.id, [...new Set(teamIds)]));
    if (rows.length !== new Set(teamIds).size) throw new ValidationError('A step names a team that does not exist');
  }
}

export async function listPolicies(ctx: Ctx) {
  staffOnly(ctx);
  const rows = await ctx.tx.select().from(schema.escalationPolicies).orderBy(asc(schema.escalationPolicies.name));
  const teams = await ctx.tx.select({ id: schema.teams.id, name: schema.teams.name, escalationPolicyId: schema.teams.escalationPolicyId }).from(schema.teams).where(and(eq(schema.teams.isActive, true), sql`${schema.teams.escalationPolicyId} IS NOT NULL`));
  const names = await userMap(ctx.tx, rows.flatMap((p) => p.steps.map((s) => s.userId)));
  const teamNames = new Map((await ctx.tx.select({ id: schema.teams.id, name: schema.teams.name }).from(schema.teams)).map((t) => [t.id, t.name]));
  return rows.map((p) => ({
    ...p,
    steps: p.steps.map((s) => ({ ...s, userName: s.userId ? (names.get(s.userId)?.name ?? null) : null, teamName: s.teamId ? (teamNames.get(s.teamId) ?? null) : null })),
    teams: teams.filter((t) => t.escalationPolicyId === p.id).map((t) => ({ id: t.id, name: t.name })),
  }));
}

export async function createPolicy(ctx: Ctx, input: PolicyInput) {
  ctx.require('oncall:manage');
  await validateSteps(ctx.tx, input.steps);
  const [row] = await ctx.tx
    .insert(schema.escalationPolicies)
    .values({ name: input.name, description: input.description ?? null, steps: input.steps, repeatCount: input.repeatCount ?? 0, assignOnAck: input.assignOnAck ?? true, isActive: input.isActive ?? true })
    .returning();
  await ctx.audit({ entityType: 'escalation_policy', entityId: row!.id, entityLabel: row!.name, action: 'create', metadata: { steps: input.steps.length } });
  return row!;
}

export async function updatePolicy(ctx: Ctx, id: string, patch: Partial<PolicyInput>) {
  ctx.require('oncall:manage');
  const [before] = await ctx.tx.select().from(schema.escalationPolicies).where(eq(schema.escalationPolicies.id, id)).limit(1);
  if (!before) throw new NotFoundError('Escalation policy');
  if (patch.steps) await validateSteps(ctx.tx, patch.steps);
  const values: Partial<typeof schema.escalationPolicies.$inferInsert> = { updatedAt: new Date() };
  for (const k of ['name', 'description', 'steps', 'repeatCount', 'assignOnAck', 'isActive'] as const) if (patch[k] !== undefined) (values as Record<string, unknown>)[k] = patch[k];
  const [after] = await ctx.tx.update(schema.escalationPolicies).set(values).where(eq(schema.escalationPolicies.id, id)).returning();
  await ctx.audit({ entityType: 'escalation_policy', entityId: id, entityLabel: after!.name, action: 'update', changes: diffChanges(before as Record<string, unknown>, values as Record<string, unknown>) });
  return after!;
}

export async function deletePolicy(ctx: Ctx, id: string) {
  ctx.require('oncall:manage');
  const [before] = await ctx.tx.select().from(schema.escalationPolicies).where(eq(schema.escalationPolicies.id, id)).limit(1);
  if (!before) throw new NotFoundError('Escalation policy');
  const [rule] = await ctx.tx.select({ name: schema.escalationRules.name }).from(schema.escalationRules).where(sql`${schema.escalationRules.actions}->>'pagePolicyId' = ${id}`).limit(1);
  if (rule) throw new ValidationError(`The escalation rule "${rule.name}" pages through this policy; change the rule first`);
  await ctx.tx.delete(schema.escalationPolicies).where(eq(schema.escalationPolicies.id, id));
  await ctx.audit({ entityType: 'escalation_policy', entityId: id, entityLabel: before.name, action: 'delete' });
}

/** The policy "page the team" means for a team. */
export async function setTeamPolicy(ctx: Ctx, teamId: string, policyId: string | null) {
  ctx.require('oncall:manage');
  const team = await requireTeam(ctx.tx, teamId);
  if (policyId) {
    const [p] = await ctx.tx.select({ id: schema.escalationPolicies.id }).from(schema.escalationPolicies).where(eq(schema.escalationPolicies.id, policyId)).limit(1);
    if (!p) throw new NotFoundError('Escalation policy');
  }
  await ctx.tx.update(schema.teams).set({ escalationPolicyId: policyId, updatedAt: new Date() }).where(eq(schema.teams.id, teamId));
  await ctx.audit({ entityType: 'team', entityId: teamId, entityLabel: team.name, action: 'update', changes: { escalationPolicyId: { old: team.escalationPolicyId, new: policyId } } });
  return { teamId, policyId };
}

// ------------------------------------------------------------------ who is on call

export interface OnCallEntry {
  rotaId: string;
  rotaName: string;
  timezone: string;
  userId: string | null;
  override: { id: string; reason: string | null } | null;
  until: Date | null;
}

async function overridesAround(tx: Tx, rotaIds: string[], from: Date, to: Date) {
  if (!rotaIds.length) return [] as OverrideRow[];
  return tx.select().from(schema.oncallOverrides).where(and(inArray(schema.oncallOverrides.rotaId, rotaIds), gt(schema.oncallOverrides.endsAt, from), lt(schema.oncallOverrides.startsAt, to))).orderBy(asc(schema.oncallOverrides.startsAt));
}

/** Who each active rota of a team puts on call at `at` (primary rota first). Pure data: no permission check, used by notifications and jobs. */
export async function whoIsOnCall(tx: Tx, teamId: string, at: Date = new Date()): Promise<OnCallEntry[]> {
  const rotas = await tx.select().from(schema.oncallRotas).where(and(eq(schema.oncallRotas.teamId, teamId), eq(schema.oncallRotas.isActive, true))).orderBy(asc(schema.oncallRotas.sortOrder), asc(schema.oncallRotas.createdAt));
  if (!rotas.length) return [];
  const parts = await participantsOf(tx, rotas.map((r) => r.id));
  const overrides = await overridesAround(tx, rotas.map((r) => r.id), new Date(at.getTime() - 1), new Date(at.getTime() + 1));
  return rotas.map((r) => {
    const res = resolveOnCall(
      rotaDef(r),
      parts.filter((p) => p.rotaId === r.id).map((p): Participant => ({ userId: p.userId, position: p.position })),
      overrides.filter((o) => o.rotaId === r.id).map((o): OverrideDef => ({ id: o.id, userId: o.userId, startsAt: o.startsAt, endsAt: o.endsAt, reason: o.reason })),
      at,
    );
    return { rotaId: r.id, rotaName: r.name, timezone: r.timezone, userId: res.userId, override: res.override ? { id: res.override.id, reason: res.override.reason ?? null } : null, until: res.until };
  });
}

/** Distinct active users on call for a team right now, primary rota first. */
export async function onCallUserIds(tx: Tx, teamId: string, at: Date = new Date()): Promise<string[]> {
  const entries = await whoIsOnCall(tx, teamId, at);
  const ids = [...new Set(entries.map((e) => e.userId).filter((x): x is string => !!x))];
  if (!ids.length) return [];
  const active = new Set((await usersLite(tx, ids)).map((u) => u.id));
  return ids.filter((id) => active.has(id));
}

/** The person a page for a team should reach: the first rota with someone on call, else the team's manager. */
export async function pageTarget(tx: Tx, teamId: string, at: Date = new Date()): Promise<{ userId: string; via: 'rota' | 'manager'; rotaName: string | null } | null> {
  const entries = await whoIsOnCall(tx, teamId, at);
  const active = new Set((await usersLite(tx, entries.map((e) => e.userId))).map((u) => u.id));
  const hit = entries.find((e) => e.userId && active.has(e.userId));
  if (hit) return { userId: hit.userId!, via: 'rota', rotaName: hit.rotaName };
  const [team] = await tx.select({ managerUserId: schema.teams.managerUserId }).from(schema.teams).where(eq(schema.teams.id, teamId)).limit(1);
  if (team?.managerUserId && (await usersLite(tx, [team.managerUserId])).length) return { userId: team.managerUserId, via: 'manager', rotaName: null };
  return null;
}

/** The "on call now" board: every team with a rota (or one team), each rota's current person and when their cover ends. (The correlated subqueries name `teams.id` in plain SQL: in a single-table select drizzle drops the table qualifier, and `"id"` would bind to the rota.) */
export async function onCallNow(ctx: Ctx, q: { teamId?: string | null; at?: Date } = {}) {
  staffOnly(ctx);
  const at = q.at ?? new Date();
  const teamRows = await ctx.tx
    .select({ id: schema.teams.id, name: schema.teams.name, teamType: schema.teams.teamType, managerUserId: schema.teams.managerUserId, escalationPolicyId: schema.teams.escalationPolicyId, rotas: sql<number>`(SELECT count(*)::int FROM oncall_rotas r WHERE r.team_id = teams.id AND r.is_active)` })
    .from(schema.teams)
    .where(q.teamId ? eq(schema.teams.id, q.teamId) : eq(schema.teams.isActive, true))
    .orderBy(asc(schema.teams.name));
  const teams = teamRows.filter((t) => q.teamId || t.rotas > 0);
  const policies = new Map((await ctx.tx.select({ id: schema.escalationPolicies.id, name: schema.escalationPolicies.name }).from(schema.escalationPolicies)).map((p) => [p.id, p.name]));
  const result = [];
  for (const t of teams) {
    const entries = await whoIsOnCall(ctx.tx, t.id, at);
    const names = await userMap(ctx.tx, [t.managerUserId, ...entries.map((e) => e.userId)]);
    result.push({
      id: t.id,
      name: t.name,
      teamType: t.teamType,
      managerUserId: t.managerUserId,
      managerName: names.get(t.managerUserId ?? '')?.name ?? null,
      escalationPolicyId: t.escalationPolicyId,
      escalationPolicyName: t.escalationPolicyId ? (policies.get(t.escalationPolicyId) ?? null) : null,
      rotas: entries.map((e) => {
        const u = e.userId ? names.get(e.userId) : null;
        return { id: e.rotaId, name: e.rotaName, timezone: e.timezone, user: u ? { id: u.id, name: u.name, email: u.email, phone: u.phone } : null, until: e.until, override: e.override };
      }),
    });
  }
  return { generatedAt: at, teams: result };
}

export interface ScheduleShift extends Shift {
  userName: string | null;
}

/** Shifts for a team over a range (at most 62 days), rota by rota, overrides applied. */
export async function schedule(ctx: Ctx, q: { teamId: string; from: Date; to: Date }) {
  staffOnly(ctx);
  if (!(q.to > q.from)) throw new ValidationError('The range must end after it starts');
  if (q.to.getTime() - q.from.getTime() > MAX_RANGE_DAYS * 86_400_000) throw new ValidationError(`The range is limited to ${MAX_RANGE_DAYS} days`);
  const team = await requireTeam(ctx.tx, q.teamId);
  const rotas = await ctx.tx.select().from(schema.oncallRotas).where(and(eq(schema.oncallRotas.teamId, q.teamId), eq(schema.oncallRotas.isActive, true))).orderBy(asc(schema.oncallRotas.sortOrder), asc(schema.oncallRotas.createdAt));
  const parts = await participantsOf(ctx.tx, rotas.map((r) => r.id));
  const overrides = await overridesAround(ctx.tx, rotas.map((r) => r.id), q.from, q.to);
  const shifts: Shift[] = [];
  for (const r of rotas) {
    shifts.push(
      ...expandSchedule(
        rotaDef(r),
        parts.filter((p) => p.rotaId === r.id).map((p): Participant => ({ userId: p.userId, position: p.position })),
        overrides.filter((o) => o.rotaId === r.id).map((o): OverrideDef => ({ id: o.id, userId: o.userId, startsAt: o.startsAt, endsAt: o.endsAt, reason: o.reason })),
        q.from,
        q.to,
      ),
    );
  }
  const names = await userMap(ctx.tx, [...shifts.map((s) => s.userId), ...overrides.map((o) => o.userId), ...overrides.map((o) => o.createdBy)]);
  return {
    team: { id: team.id, name: team.name, teamType: team.teamType, escalationPolicyId: team.escalationPolicyId },
    from: q.from,
    to: q.to,
    rotas: rotas.map((r) => ({ ...r, periodDays: periodDays(r), participants: parts.filter((p) => p.rotaId === r.id).map(({ rotaId: _r, ...p }) => p) })),
    shifts: shifts.map((s): ScheduleShift => ({ ...s, userName: s.userId ? (names.get(s.userId)?.name ?? null) : null })),
    overrides: overrides.map((o) => ({ ...o, userName: names.get(o.userId)?.name ?? null, createdByName: names.get(o.createdBy ?? '')?.name ?? null })),
  };
}

/** Teams the directory shows with an on-call line (for the dashboards): the first rota's person per team type. */
export async function onCallSummary(tx: Tx, teamTypes: string[] | null, at: Date = new Date(), limit = 8) {
  const teams = await tx
    .select({ id: schema.teams.id, name: schema.teams.name, teamType: schema.teams.teamType })
    .from(schema.teams)
    .where(and(eq(schema.teams.isActive, true), teamTypes?.length ? inArray(schema.teams.teamType, teamTypes) : undefined, sql`EXISTS (SELECT 1 FROM oncall_rotas r WHERE r.team_id = teams.id AND r.is_active)`))
    .orderBy(asc(schema.teams.name))
    .limit(limit);
  const out = [];
  for (const t of teams) {
    const entries = await whoIsOnCall(tx, t.id, at);
    const names = await userMap(tx, entries.map((e) => e.userId));
    out.push({ teamId: t.id, teamName: t.name, teamType: t.teamType, rotas: entries.map((e) => ({ id: e.rotaId, name: e.rotaName, userId: e.userId, userName: e.userId ? (names.get(e.userId)?.name ?? null) : null, until: e.until, override: !!e.override })) });
  }
  return out;
}
