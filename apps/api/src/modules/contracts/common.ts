import { eq, and, inArray, or, isNull, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { NotFoundError } from '@/core/errors';
import { config } from '@/config';
import type { Recipient } from '@/modules/notifications/dispatch';

export type ContractRow = typeof schema.contracts.$inferSelect;
export type CustomerRow = typeof schema.customers.$inferSelect;

// ---------------------------------------------------------------- dates

/** Today as YYYY-MM-DD (UTC). Contract dates are civil dates without time zone. */
export const todayStr = (now: Date = new Date()) => now.toISOString().slice(0, 10);

export const dateToUtc = (d: string) => {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day);
};

export const utcToDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (d: string, days: number) => utcToDate(dateToUtc(d) + days * 86_400_000);

/** Adds calendar months, clamping the day to the target month length (Jan 31 + 1 → Feb 28/29). */
export function addMonths(d: string, months: number) {
  const [y, m, day] = d.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const daysInMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, daysInMonth))).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is in the past). */
export const daysBetween = (from: string, to: string) => Math.round((dateToUtc(to) - dateToUtc(from)) / 86_400_000);

export const daysToExpiry = (endDate: string, now: Date = new Date()) => daysBetween(todayStr(now), endDate);

// ---------------------------------------------------------------- loading

/** Loads a contract and enforces customer access for the caller. */
export async function loadContract(ctx: Ctx, id: string): Promise<ContractRow> {
  const [row] = await ctx.tx.select().from(schema.contracts).where(eq(schema.contracts.id, id)).limit(1);
  if (!row) throw new NotFoundError('Contract');
  ctx.requireCustomer(row.customerId);
  return row;
}

export async function contractStatusOptions(tx: Tx) {
  const rows = await tx.select({ key: schema.configOptions.key, label: schema.configOptions.label, color: schema.configOptions.color }).from(schema.configOptions).where(eq(schema.configOptions.type, 'contract_status'));
  return new Map(rows.map((r) => [r.key, r]));
}

export const STATUS_COLORS: Record<string, string> = { draft: 'slate', active: 'green', expiring: 'amber', expired: 'red', renewed: 'blue', terminated: 'gray' };

export function statusDisplay(status: string, map: Map<string, { key: string; label: string; color: string | null }>) {
  const opt = map.get(status);
  return { statusLabel: opt?.label ?? status.charAt(0).toUpperCase() + status.slice(1), statusColor: opt?.color ?? STATUS_COLORS[status] ?? 'slate' };
}

export async function optionLabels(tx: Tx, ids: (string | null | undefined)[]) {
  const clean = [...new Set(ids.filter((x): x is string => !!x))];
  if (!clean.length) return new Map<string, { id: string; key: string; label: string; color: string | null; type: string; metadata: Record<string, unknown> }>();
  const rows = await tx.select({ id: schema.configOptions.id, key: schema.configOptions.key, label: schema.configOptions.label, color: schema.configOptions.color, type: schema.configOptions.type, metadata: schema.configOptions.metadata }).from(schema.configOptions).where(inArray(schema.configOptions.id, clean));
  return new Map(rows.map((r) => [r.id, r]));
}

export async function userNames(tx: Tx, ids: (string | null | undefined)[]) {
  const clean = [...new Set(ids.filter((x): x is string => !!x))];
  if (!clean.length) return new Map<string, { id: string; name: string; email: string }>();
  const rows = await tx.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, clean));
  return new Map(rows.map((r) => [r.id, r]));
}

export const contractLink = (id: string) => `${config.APP_URL.replace(/\/$/, '')}/contracts/${id}`;

/**
 * Who hears about a contract: the customer's account manager, the contract
 * owner and everyone holding the contract_admin / service_manager roles
 * (globally or for this customer).
 */
export async function contractRecipients(tx: Tx, contract: Pick<ContractRow, 'customerId' | 'ownerUserId'>, customer?: Pick<CustomerRow, 'accountManagerId'> | null): Promise<Recipient[]> {
  const direct = [customer?.accountManagerId, contract.ownerUserId].filter((x): x is string => !!x);
  const roleHolders = await tx
    .select({ id: schema.users.id })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
    .innerJoin(schema.users, eq(schema.users.id, schema.userRoles.userId))
    .where(and(inArray(schema.roles.key, ['contract_admin', 'service_manager']), or(isNull(schema.userRoles.customerId), eq(schema.userRoles.customerId, contract.customerId)), eq(schema.users.status, 'active')));
  const ids = [...new Set([...direct, ...roleHolders.map((r) => r.id)])];
  if (!ids.length) return [];
  const users = await tx.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, status: schema.users.status }).from(schema.users).where(inArray(schema.users.id, ids));
  return users.filter((u) => u.status === 'active').map((u) => ({ userId: u.id, email: u.email, name: u.name }));
}

/**
 * Records a milestone for a contract exactly once. Returns true when this call
 * created it (i.e. the caller should send the notification).
 */
export async function claimMilestone(tx: Tx, contractId: string, customerId: string, milestone: string): Promise<boolean> {
  const rows = await tx.insert(schema.contractNotifications).values({ contractId, customerId, milestone }).onConflictDoNothing().returning({ id: schema.contractNotifications.id });
  return rows.length > 0;
}

export const countSql = sql<number>`count(*)::int`;

/** `id in (...)` list for raw SQL fragments (drizzle expands plain JS arrays into comma-separated params). */
export const uuidList = (ids: string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);

/** Runs async thunks one after another on the same transaction client (pg does not allow concurrent queries on one client). */
export async function sequential<T extends unknown[]>(thunks: [...{ [K in keyof T]: () => Promise<T[K]> }]): Promise<T> {
  const out: unknown[] = [];
  for (const t of thunks) out.push(await t());
  return out as T;
}
