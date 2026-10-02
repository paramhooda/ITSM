import { eq, and, inArray, asc } from 'drizzle-orm';
import type { Permission, TicketType } from '@itsm/shared';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import { buildCtx, type Ctx } from '@/core/context';
import type { Principal } from '@/core/principal';
import { ForbiddenError, NotFoundError, ValidationError } from '@/core/errors';
import type { SlaActor } from '@/modules/sla/engine';

export type TicketRow = typeof schema.tickets.$inferSelect;
export type OptionRow = typeof schema.configOptions.$inferSelect;

export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/** Principal used by background jobs (auto-close, SLA breaches). `isSystem` grants every permission; audit rows carry no user id. */
export const SYSTEM_PRINCIPAL: Principal = {
  id: SYSTEM_USER_ID,
  email: 'system@local',
  name: 'System',
  phone: null,
  userType: 'msp',
  customerId: null,
  status: 'active',
  timezone: 'UTC',
  preferences: {},
  globalPermissions: new Set<Permission>(),
  customerPermissions: new Map(),
  customerScope: 'all',
  roles: [],
  teams: [],
  areas: null,
  apiKeyId: 'system',
  isSystem: true,
};

/** Builds a system Ctx over a `withSystem` transaction so job code can reuse the service layer. */
export const systemCtx = (tx: Tx, requestId = 'job'): Ctx => buildCtx(SYSTEM_PRINCIPAL, tx, { requestId, source: 'system' });

export const isCustomerUser = (ctx: Ctx) => ctx.user.userType === 'customer';
export const isSystemCtx = (ctx: Ctx) => !!ctx.user.isSystem;

export const actorOf = (ctx: Ctx): SlaActor => ({ id: isSystemCtx(ctx) ? null : ctx.user.id, name: ctx.user.name });

/** User id usable in FK columns (null for system / API keys). */
export const userIdOf = (ctx: Ctx): string | null => (isSystemCtx(ctx) || ctx.user.apiKeyId ? null : ctx.user.id);

// ---------------------------------------------------------------- permissions

/** Read access: MSP users need tickets:read (and soc:read for SOC tickets); customer users need portal:tickets for their own customer. */
export function requireRead(ctx: Ctx, ticket: Pick<TicketRow, 'customerId' | 'domain'>) {
  ctx.requireCustomer(ticket.customerId);
  if (isCustomerUser(ctx)) {
    if (!ctx.can('portal:tickets', ticket.customerId)) throw new ForbiddenError('Missing permission: portal:tickets');
    return;
  }
  if (!ctx.can('tickets:read', ticket.customerId)) throw new ForbiddenError('Missing permission: tickets:read');
  if (ticket.domain === 'soc' && !ctx.can('soc:read', ticket.customerId)) throw new ForbiddenError('Security tickets require the soc:read permission');
}

/** Action permission for MSP users, or `portalPerm` for customer users (own customer only). */
export function requireAction(ctx: Ctx, ticket: Pick<TicketRow, 'customerId' | 'domain'>, perm: Permission, portalPerm: Permission | null = null) {
  requireRead(ctx, ticket);
  if (isCustomerUser(ctx)) {
    if (!portalPerm || !ctx.can(portalPerm, ticket.customerId)) throw new ForbiddenError(portalPerm ? `Missing permission: ${portalPerm}` : 'This action is not available in the customer portal');
    return;
  }
  ctx.require(perm, ticket.customerId);
}

// ---------------------------------------------------------------- loading

export async function loadTicket(ctx: Ctx, id: string): Promise<TicketRow> {
  const [row] = await ctx.tx.select().from(schema.tickets).where(eq(schema.tickets.id, id)).limit(1);
  if (!row) throw new NotFoundError('Ticket');
  requireRead(ctx, row);
  return row;
}

export async function loadTicketByNumber(ctx: Ctx, number: string): Promise<TicketRow> {
  const [row] = await ctx.tx.select().from(schema.tickets).where(eq(schema.tickets.number, number.trim().toUpperCase())).limit(1);
  if (!row) throw new NotFoundError('Ticket');
  requireRead(ctx, row);
  return row;
}

export async function reloadTicket(tx: Tx, id: string): Promise<TicketRow> {
  const [row] = await tx.select().from(schema.tickets).where(eq(schema.tickets.id, id)).limit(1);
  if (!row) throw new NotFoundError('Ticket');
  return row;
}

// ---------------------------------------------------------------- options

export async function optionById(tx: Tx, id: string | null | undefined): Promise<OptionRow | null> {
  if (!id) return null;
  const [row] = await tx.select().from(schema.configOptions).where(eq(schema.configOptions.id, id)).limit(1);
  return row ?? null;
}

export async function optionByKey(tx: Tx, type: string, key: string): Promise<OptionRow | null> {
  const [row] = await tx.select().from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1);
  return row ?? null;
}

export async function optionsOfType(tx: Tx, type: string): Promise<OptionRow[]> {
  return tx.select().from(schema.configOptions).where(eq(schema.configOptions.type, type)).orderBy(asc(schema.configOptions.sortOrder), asc(schema.configOptions.label));
}

export async function optionMap(tx: Tx, ids: (string | null | undefined)[]): Promise<Map<string, OptionRow>> {
  const clean = [...new Set(ids.filter((x): x is string => !!x))];
  if (!clean.length) return new Map();
  const rows = await tx.select().from(schema.configOptions).where(inArray(schema.configOptions.id, clean));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Validates an option id belongs to the expected type (and is active). */
export async function requireOption(tx: Tx, type: string, id: string | null | undefined, label = type): Promise<OptionRow | null> {
  if (!id) return null;
  const opt = await optionById(tx, id);
  if (!opt || opt.type !== type) throw new ValidationError(`Invalid ${label.replace(/_/g, ' ')}`);
  return opt;
}

/** Default status for a ticket type: the option flagged default that applies to the type, else `new` / `draft`. */
export async function defaultStatusFor(tx: Tx, type: TicketType): Promise<OptionRow> {
  const all = await optionsOfType(tx, 'ticket_status');
  const applicable = all.filter((o) => o.isActive && (!o.appliesTo.length || o.appliesTo.includes(type)));
  const preferredKey = type === 'change' ? 'draft' : 'new';
  const byKey = applicable.find((o) => o.key === preferredKey);
  if (byKey) return byKey;
  const flagged = applicable.find((o) => o.isDefault);
  if (flagged) return flagged;
  const anyNew = applicable.find((o) => o.statusCategory === 'new');
  if (anyNew) return anyNew;
  throw new ValidationError(`No default status configured for ${type}`);
}

export const statusApplies = (opt: Pick<OptionRow, 'appliesTo'>, type: TicketType) => !opt.appliesTo.length || opt.appliesTo.includes(type);

export const toLabel = (o: OptionRow | null | undefined) => (o ? { id: o.id, key: o.key, label: o.label, color: o.color ?? null, category: o.statusCategory ?? null, level: o.level ?? null, domain: o.domain } : null);

// ---------------------------------------------------------------- activities

export interface ActivityInput {
  type: string;
  summary: string;
  data?: Record<string, unknown>;
  customerVisible?: boolean;
}

/** Timeline entry + last-activity bump. */
export async function addActivity(ctx: Ctx, ticket: Pick<TicketRow, 'id' | 'customerId'>, input: ActivityInput) {
  const actor = actorOf(ctx);
  const [row] = await ctx.tx
    .insert(schema.ticketActivities)
    .values({ ticketId: ticket.id, customerId: ticket.customerId, actorId: actor.id, actorName: actor.name, activityType: input.type, summary: input.summary, data: input.data ?? {}, customerVisible: input.customerVisible ?? true, createdAt: new Date() })
    .returning();
  await ctx.tx.update(schema.tickets).set({ lastActivityAt: new Date() }).where(eq(schema.tickets.id, ticket.id));
  return row;
}

export const TYPE_LABEL: Record<TicketType, string> = { incident: 'Incident', request: 'Service Request', problem: 'Problem', change: 'Change' };

export const csv = (v: string | undefined | null) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
