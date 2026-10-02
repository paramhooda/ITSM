import { eq, and, asc } from 'drizzle-orm';
import type { TicketType } from '@itsm/shared';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import { CALENDAR_24X7, type CalendarDef } from '@/lib/calendar';

export interface PolicySelection {
  ticketType: TicketType;
  customerId: string;
  serviceId?: string | null;
  contractId?: string | null;
  catalogItemId?: string | null;
  explicitPolicyId?: string | null;
}

/**
 * Resolves the SLA policy for a ticket. Order: explicit policy on the ticket →
 * catalog item → contract service override → contract → service default →
 * platform default policy.
 */
export async function selectPolicy(tx: Tx, input: PolicySelection): Promise<{ policyId: string; source: string } | null> {
  const active = async (id: string | null | undefined) => {
    if (!id) return null;
    const [p] = await tx.select({ id: schema.slaPolicies.id }).from(schema.slaPolicies).where(and(eq(schema.slaPolicies.id, id), eq(schema.slaPolicies.isActive, true))).limit(1);
    return p?.id ?? null;
  };

  if (input.explicitPolicyId) {
    const id = await active(input.explicitPolicyId);
    if (id) return { policyId: id, source: 'explicit' };
  }
  if (input.catalogItemId) {
    const [item] = await tx.select({ slaPolicyId: schema.catalogItems.slaPolicyId }).from(schema.catalogItems).where(eq(schema.catalogItems.id, input.catalogItemId)).limit(1);
    const id = await active(item?.slaPolicyId);
    if (id) return { policyId: id, source: 'catalog_item' };
  }
  if (input.contractId) {
    if (input.serviceId) {
      const [cs] = await tx
        .select({ slaPolicyId: schema.contractServices.slaPolicyId })
        .from(schema.contractServices)
        .where(and(eq(schema.contractServices.contractId, input.contractId), eq(schema.contractServices.serviceId, input.serviceId)))
        .limit(1);
      const id = await active(cs?.slaPolicyId);
      if (id) return { policyId: id, source: 'contract_service' };
    }
    const [c] = await tx.select({ slaPolicyId: schema.contracts.slaPolicyId }).from(schema.contracts).where(eq(schema.contracts.id, input.contractId)).limit(1);
    const id = await active(c?.slaPolicyId);
    if (id) return { policyId: id, source: 'contract' };
  }
  if (input.serviceId) {
    const [s] = await tx.select({ defaultSlaPolicyId: schema.services.defaultSlaPolicyId }).from(schema.services).where(eq(schema.services.id, input.serviceId)).limit(1);
    const id = await active(s?.defaultSlaPolicyId);
    if (id) return { policyId: id, source: 'service' };
  }
  const [def] = await tx
    .select({ id: schema.slaPolicies.id })
    .from(schema.slaPolicies)
    .where(and(eq(schema.slaPolicies.isDefault, true), eq(schema.slaPolicies.isActive, true)))
    .orderBy(asc(schema.slaPolicies.createdAt))
    .limit(1);
  if (def) return { policyId: def.id, source: 'default' };
  return null;
}

export interface CalendarResolution {
  policy: { id: string; calendarId: string | null; holidayCalendarId: string | null };
  contractId?: string | null;
  serviceId?: string | null;
  calendarTime: boolean;
}

async function loadHolidays(tx: Tx, holidayCalendarId: string | null | undefined): Promise<string[]> {
  if (!holidayCalendarId) return [];
  const rows = await tx.select({ date: schema.holidays.date }).from(schema.holidays).where(eq(schema.holidays.calendarId, holidayCalendarId));
  return rows.map((r) => String(r.date));
}

/**
 * Builds the calendar definition snapshot for a target: 24x7 when the target
 * runs on calendar time; otherwise the contract's support-hours calendar
 * (service override first) or the policy calendar. Holidays come from the
 * calendar's holiday calendar, falling back to the policy's.
 */
export async function resolveCalendar(tx: Tx, input: CalendarResolution): Promise<CalendarDef> {
  if (input.calendarTime) return { ...CALENDAR_24X7 };
  let calendarId: string | null = null;
  if (input.contractId) {
    if (input.serviceId) {
      const [cs] = await tx
        .select({ cal: schema.contractServices.supportHoursCalendarId })
        .from(schema.contractServices)
        .where(and(eq(schema.contractServices.contractId, input.contractId), eq(schema.contractServices.serviceId, input.serviceId)))
        .limit(1);
      calendarId = cs?.cal ?? null;
    }
    if (!calendarId) {
      const [c] = await tx.select({ cal: schema.contracts.supportHoursCalendarId }).from(schema.contracts).where(eq(schema.contracts.id, input.contractId)).limit(1);
      calendarId = c?.cal ?? null;
    }
  }
  if (!calendarId) calendarId = input.policy.calendarId;
  let cal: typeof schema.businessCalendars.$inferSelect | undefined;
  if (calendarId) [cal] = await tx.select().from(schema.businessCalendars).where(eq(schema.businessCalendars.id, calendarId)).limit(1);
  if (!cal) {
    [cal] = await tx.select().from(schema.businessCalendars).where(eq(schema.businessCalendars.isDefault, true)).limit(1);
  }
  if (!cal) return { ...CALENDAR_24X7 };
  if (cal.is24x7) return { timezone: cal.timezone, is24x7: true, hours: {}, holidays: [] };
  const holidays = await loadHolidays(tx, cal.holidayCalendarId ?? input.policy.holidayCalendarId);
  return { timezone: cal.timezone, is24x7: false, hours: cal.hours ?? {}, holidays };
}
