import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Tx } from '@/db/client';
import { createTicket, changeStatus } from '@/modules/tickets/service';
import * as changes from '@/modules/changes/service';
import { addDays, addMinutes, atIst, istWeekday } from './rng';
import { adminCtx, ctxFor, customer, principalOf, user, type DemoState } from './state';

/**
 * Change management on top of the demo tickets: blackout windows (one past,
 * one global year-end freeze, two customer freezes ahead), a scored risk
 * questionnaire on every change with a window, four standard changes raised
 * from the seeded catalog, and three CAB meetings (one closed last week with
 * generated minutes, one next Tuesday with the awaiting changes on the agenda,
 * one emergency CAB). Runs right after the tickets phase, before the extras
 * phase purges the notifications these actions queue.
 */

const HIGH = { scope: 'many_sites', service_impact: 'outage', dependencies: 'critical', backout: 'documented', experience: 'similar', timing: 'off_hours' };
const MEDIUM = { scope: 'one_site', service_impact: 'degraded', dependencies: 'shared', backout: 'tested', experience: 'similar', timing: 'off_hours' };
const LOW = { scope: 'single_user', service_impact: 'none', dependencies: 'isolated', backout: 'tested', experience: 'routine', timing: 'maintenance_window' };

export async function seedChanges(state: DemoState, tx: Tx) {
  const { now, rng } = state;
  const admin = adminCtx(state, tx);
  const rajesh = ctxFor(state, tx, principalOf(state, 'rajesh'));
  const abc = customer(state, 'abc');
  const meridian = customer(state, 'meridian');

  // ---- blackout windows
  const year = now.getUTCMonth() === 11 && now.getUTCDate() > 24 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  const yearEndStart = atIst(new Date(Date.UTC(year, 11, 24)), 0, 0);
  const yearEndEnd = atIst(new Date(Date.UTC(year + 1, 0, 2)), 6, 0);
  await changes.createBlackout(admin, { customerId: null, name: 'Year-end change freeze', reason: 'Finance year-end close', startsAt: yearEndStart, endsAt: yearEndEnd, allowEmergency: true });
  const abcStart = atIst(addDays(now, 9), 0, 0);
  await changes.createBlackout(admin, { customerId: abc.id, name: 'Plant shutdown audit', reason: 'Factory audit; no changes on the plant network', startsAt: abcStart, endsAt: addMinutes(abcStart, 48 * 60), allowEmergency: false });
  const mrdStart = atIst(addDays(now, 20), 18, 0);
  await changes.createBlackout(admin, { customerId: meridian.id, name: 'Core banking release freeze', reason: 'Bank release weekend', startsAt: mrdStart, endsAt: addMinutes(mrdStart, 72 * 60), allowEmergency: true });
  const pastEnd = addDays(now, -10);
  await changes.createBlackout(admin, { customerId: null, name: 'Quarter-end freeze', reason: 'Quarter-end close', startsAt: addDays(pastEnd, -3), endsAt: pastEnd, allowEmergency: true, isActive: true });
  state.counts.changeBlackouts = 4;

  // ---- risk answers on every demo change with a window
  const riskKeyOf = new Map(state.refs.optionsOf('change_risk').map((o) => [o.id, o.key]));
  const changeIds = [...state.tickets.values()].filter((t) => t.type === 'change').map((t) => t.id);
  const details = changeIds.length ? await tx.select({ ticketId: schema.changeDetails.ticketId, scheduledStart: schema.changeDetails.scheduledStart, riskId: schema.changeDetails.riskId }).from(schema.changeDetails).where(inArray(schema.changeDetails.ticketId, changeIds)) : [];
  let assessed = 0;
  for (const d of details) {
    if (!d.scheduledStart) continue;
    const key = d.riskId ? riskKeyOf.get(d.riskId) : null;
    const base = key === 'very_high' || key === 'high' ? HIGH : key === 'medium' ? MEDIUM : LOW;
    const answers: Record<string, string> = { ...base };
    if (rng.chance(0.3)) {
      // One answer flipped so the scores spread instead of repeating three values.
      const flips: Record<string, string[]> = { scope: ['one_site', 'many_sites'], backout: ['tested', 'documented'], experience: ['routine', 'first'], timing: ['business_hours', 'off_hours'] };
      const q = rng.pick(Object.keys(flips));
      answers[q] = rng.pick(flips[q]!);
    }
    await changes.assessRisk(rajesh, d.ticketId, answers);
    assessed++;
  }
  state.counts.riskAssessed = assessed;

  // ---- standard changes from the seeded catalog
  const templates = await tx.select().from(schema.changeTemplates);
  const templateByKey = (key: string) => {
    const t = templates.find((x) => x.key === key);
    if (!t) throw new Error(`change template ${key} missing`);
    return t;
  };
  const scheduledStatus = state.refs.option('ticket_status', 'scheduled');
  const standard = [
    { customerKey: 'abc', template: 'fw_patch', start: atIst(addDays(now, 3), 22, 0), minutes: 90, ciType: 'firewall', assignee: 'priya' },
    { customerKey: 'northwind', template: 'server_patching', start: atIst(addDays(now, 5), 23, 0), minutes: 120, ciType: 'server', assignee: 'deepak' },
    { customerKey: 'sterling', template: 'cert_renewal', start: atIst(addDays(now, 2), 21, 0), minutes: 60, ciType: 'application', assignee: 'arjun' },
    { customerKey: 'apex', template: 'switch_port_change', start: atIst(addDays(now, 1), 19, 0), minutes: 45, ciType: 'network_switch', assignee: 'priya' },
  ];
  for (const s of standard) {
    const cust = customer(state, s.customerKey);
    const tpl = templateByKey(s.template);
    const ci = cust.cis.find((c) => c.typeKey === s.ciType) ?? null;
    const ticket = await createTicket(rajesh, {
      type: 'change',
      customerId: cust.id,
      siteId: cust.sites[0]?.id ?? null,
      title: `${tpl.titleTemplate ?? tpl.name} – ${cust.name}`,
      changeTemplateId: tpl.id,
      primaryCiId: ci?.id ?? null,
      assigneeId: user(state, s.assignee).id,
      requesterUserId: user(state, 'rajesh').id,
      change: { scheduledStart: s.start, scheduledEnd: addMinutes(s.start, s.minutes) },
    });
    await changeStatus(rajesh, ticket.id, { statusId: scheduledStatus, comment: `Pre-approved standard change scheduled for ${s.start.toISOString().slice(0, 16).replace('T', ' ')} UTC.` });
    state.tickets.set(`std-${s.template}-${s.customerKey}`, { id: ticket.id, number: ticket.number, customerKey: cust.key, type: 'change', createdAt: ticket.createdAt, title: ticket.title, categoryKey: '', ciId: ci?.id ?? null, siteKey: cust.sites[0]?.key ?? null, resolvedAt: null, open: true, priorityKey: 'p4' });
  }
  state.counts.standardChanges = standard.length;

  // ---- CAB meetings
  const attendeeUserIds = [user(state, 'rajesh').id, user(state, 'ananya').id, user(state, 'sneha').id];
  const location = 'Teams bridge (NOC)';
  const changeRows = changeIds.length
    ? await tx
        .select({ id: schema.tickets.id, approvalStatus: schema.tickets.approvalStatus, changeType: schema.changeDetails.changeType, statusCategory: schema.configOptions.statusCategory })
        .from(schema.tickets)
        .innerJoin(schema.changeDetails, eq(schema.changeDetails.ticketId, schema.tickets.id))
        .innerJoin(schema.configOptions, eq(schema.configOptions.id, schema.tickets.statusId))
        .where(and(inArray(schema.tickets.id, changeIds)))
    : [];
  // Each agenda is filled to five items from the other changes when fewer qualify by status, so the item count never depends on the hour the dataset was loaded.
  const AGENDA_SIZE = 5;
  const OPEN = ['new', 'open', 'pending'];
  const byIndex = new Map(changeIds.map((id, i) => [id, i]));
  const ordered = [...changeRows].sort((a, b) => (byIndex.get(a.id) ?? 0) - (byIndex.get(b.id) ?? 0));
  const fillAgenda = <R extends { id: string; statusCategory: string | null }>(picked: R[], pool: R[], exclude: Set<string>, openOnly: boolean): R[] => {
    for (const r of pool) {
      if (picked.length >= AGENDA_SIZE) break;
      if (exclude.has(r.id) || picked.some((p) => p.id === r.id)) continue;
      if (openOnly && !OPEN.includes(r.statusCategory ?? '')) continue;
      picked.push(r);
    }
    return picked;
  };
  const backdate = async (meetingId: string, when: Date, closed: boolean) => {
    await tx.update(schema.cabMeetings).set({ createdAt: addDays(when, -3), updatedAt: closed ? addMinutes(when, 60) : addDays(when, -3), ...(closed ? { closedAt: addMinutes(when, 60) } : {}) }).where(eq(schema.cabMeetings.id, meetingId));
    await tx.update(schema.cabMeetingItems).set({ createdAt: addDays(when, -3), decidedAt: addMinutes(when, 30), updatedAt: addMinutes(when, 30) }).where(and(eq(schema.cabMeetingItems.meetingId, meetingId), inArray(schema.cabMeetingItems.decision, ['approved', 'rejected', 'deferred'])));
  };

  // Last week's CAB: the approved changes, each decided and the meeting closed with generated minutes.
  const lastWeek = atIst(addDays(now, -7), 10, 0);
  const approved = fillAgenda(fillAgenda(ordered.filter((r) => r.approvalStatus === 'approved').slice(0, 4), ordered, new Set(), true), ordered, new Set(), false);
  const past = await changes.createMeeting(rajesh, { title: 'Weekly CAB', scheduledAt: lastWeek, chairUserId: user(state, 'rajesh').id, location, attendeeUserIds, ticketIds: approved.map((r) => r.id) });
  for (const item of past.items) await changes.decideItem(rajesh, past.id, item.id, { decision: 'approved', notes: 'Approved for the stated window.' });
  await changes.closeMeeting(rajesh, past.id, {});
  await backdate(past.id, lastWeek, true);

  // Next Tuesday's CAB: the changes awaiting approval, with a note on the first.
  const wd = istWeekday(now);
  const untilTuesday = (2 - wd + 7) % 7 || 7;
  const nextTuesday = atIst(addDays(now, untilTuesday), 10, 0);
  const awaiting = fillAgenda(ordered.filter((r) => r.approvalStatus === 'pending' && OPEN.includes(r.statusCategory ?? '')).slice(0, 5), ordered, new Set(approved.map((a) => a.id)), true);
  const next = await changes.createMeeting(rajesh, { title: 'Weekly CAB', scheduledAt: nextTuesday, chairUserId: user(state, 'rajesh').id, location, attendeeUserIds });
  for (const [i, r] of awaiting.entries()) await changes.addItem(rajesh, next.id, { ticketId: r.id, notes: i === 0 ? "Requested by the customer's IT lead" : null });
  await backdate(next.id, addDays(now, -1), false);

  // The emergency CAB two days ago: one emergency change approved retrospectively.
  const emergencyAt = atIst(addDays(now, -2), 16, 30);
  const emergency = changeRows.find((r) => r.changeType === 'emergency' && !approved.some((a) => a.id === r.id));
  const em = await changes.createMeeting(rajesh, { title: 'Emergency CAB', scheduledAt: emergencyAt, chairUserId: user(state, 'rajesh').id, location, attendeeUserIds: attendeeUserIds.slice(0, 2), ticketIds: emergency ? [emergency.id] : [] });
  for (const item of em.items) await changes.decideItem(rajesh, em.id, item.id, { decision: 'approved', notes: 'Retrospective approval under the emergency procedure.' });
  await changes.closeMeeting(rajesh, em.id, {});
  await backdate(em.id, emergencyAt, true);
  state.counts.cabMeetings = 3;
}
