/**
 * "Needs attention" rules for record pages, as pure functions over the detail payload each
 * page already loads: nothing here fetches, reads the clock or touches React, so the rules
 * are unit-testable with a fixed `now`. Each function returns `AttentionItem`s for
 * `RecordAttention`; a record with nothing wrong gets an empty list (and no strip).
 *
 * Rules only use fields the payload really carries. Where a signal is missing from the API
 * (for example the priority of a CI's open tickets) the rule is left out rather than guessed.
 */
import type { AttentionItem } from './RecordAttention';
import { fmtDate, fmtDuration, titleCase } from '@/lib/format';
import type { TicketDetail } from '@/components/tickets/types';
import type { VisitDetail } from '@/components/field/types';
import type { Contact, CustomerDetail, CustomerOverview, Site } from '@/components/customers/types';
import type { ContractDetail } from '@/components/contracts/types';
import type { Coverage } from '@/components/assets/CoverageBadge';

export type Clock = Date | number;
type Action = NonNullable<AttentionItem['action']>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ms = (now: Clock) => (typeof now === 'number' ? now : now.getTime());
const at = (iso: string) => new Date(iso).getTime();
/** Whole minutes from `iso` up to `now`, never negative. */
const minutesSince = (iso: string, now: Clock) => Math.max(0, Math.round((ms(now) - at(iso)) / MINUTE));
/** "3h ago", "2d 4h ago". */
const ago = (iso: string, now: Clock) => `${fmtDuration(minutesSince(iso, now))} ago`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const call = (label: string, fn?: () => void): Action | undefined => (fn ? { label, onClick: fn } : undefined);

const OPEN_CATEGORIES = new Set(['new', 'open', 'pending']);
/** Status key the API uses for "waiting on the customer" (apps/api/src/modules/tickets/status.ts). */
const AWAITING_CUSTOMER_KEY = 'pending_customer';

// ---------------------------------------------------------------- ticket

export interface TicketAttentionActions {
  /** The page's assign-to-me mutation; omit when the viewer cannot assign. */
  onAssignMe?: () => void;
  /** Opens the escalate dialog; omit when the viewer cannot escalate. */
  onEscalate?: () => void;
  /** Focuses the reply composer; omit when the viewer cannot comment. */
  onNudge?: () => void;
  /** Opens the scope dialog; omit when the viewer cannot classify scope. */
  onScope?: () => void;
  /** Opens the declare-major dialog; omit when the viewer cannot declare or the ticket is not an open incident. */
  onDeclareMajor?: () => void;
}

/** Flags for an MSP engineer opening a ticket. Resolved, closed and cancelled tickets have nothing pending, so they get none. */
export function ticketAttention(t: TicketDetail, now: Clock, act: TicketAttentionActions = {}): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (!OPEN_CATEGORIES.has(t.status?.category ?? 'open')) return items;

  // SLA clocks: every breached metric (the engine may not have swept a running clock that is already past due),
  // then the nearest running clock that is at risk (< 25 % left, or the policy's own warn threshold).
  const breached = t.slas.filter((s) => s.state === 'breached' || (s.state === 'running' && s.remainingMinutes < 0));
  for (const s of breached) {
    const primary = s.metric === 'resolution' || s.metric === 'restoration';
    items.push({ key: `sla-breached-${s.metric}`, tone: primary ? 'bad' : 'warn', text: `${s.label} SLA breached ${ago(s.breachedAt ?? s.dueAt, now)}`, action: primary ? call('Escalate', act.onEscalate) : undefined });
  }
  const atRisk = t.slas
    .filter((s) => s.state === 'running' && s.remainingMinutes >= 0 && (s.warned || s.remainingMinutes < s.targetMinutes * 0.25))
    .sort((a, b) => a.remainingMinutes - b.remainingMinutes)[0];
  if (atRisk) items.push({ key: 'sla-at-risk', tone: 'warn', text: `${atRisk.label} SLA at risk · ${fmtDuration(atRisk.remainingMinutes)} left` });
  // The forecast: the risk job rates the ticket likely to breach although no clock says so yet (a breached or at-risk clock already says it louder).
  if (t.breachRisk?.level === 'high' && !breached.length && !atRisk) items.push({ key: 'breach-risk', tone: 'warn', text: `Likely to breach · ${t.breachRisk.reason}`, action: call('Escalate', act.onEscalate) });
  // The customer's mood: an unhappy last comment deserves a reply before anything else on the ticket.
  if (t.lastSentiment && (t.lastSentiment.sentiment === 'negative' || t.lastSentiment.sentiment === 'angry')) {
    items.push({ key: 'sentiment', tone: t.lastSentiment.sentiment === 'angry' ? 'bad' : 'warn', text: `The customer sounded ${t.lastSentiment.sentiment === 'angry' ? 'angry' : 'unhappy'}${t.lastSentiment.at ? ` ${ago(t.lastSentiment.at, now)}` : ''}`, action: call('Reply', act.onNudge) });
  }

  // Major incident: the stakeholder update cadence is the promise the team made; say when it slips.
  if (t.isMajor) {
    const due = t.major?.status === 'active' ? t.major.nextUpdateDueAt : null;
    const overdueBy = due ? Math.round((ms(now) - at(due)) / MINUTE) : 0;
    if (due && overdueBy > 0) items.push({ key: 'major', tone: 'bad', text: `Major incident · stakeholder update overdue by ${fmtDuration(overdueBy)}`, action: { label: 'Post update', to: '?tab=major' } });
    else if (due) items.push({ key: 'major', tone: 'bad', text: `Major incident · next update due in ${fmtDuration(-overdueBy)}`, action: { label: 'Incident command', to: '?tab=major' } });
    else items.push({ key: 'major', tone: 'bad', text: 'Major incident', action: { label: 'Incident command', to: '?tab=major' } });
  } else if (t.type === 'incident' && (t.priority?.level ?? 99) === 1 && act.onDeclareMajor) {
    items.push({ key: 'p1-not-major', tone: 'info', text: 'P1 incident not declared major', action: call('Declare major', act.onDeclareMajor) });
  }

  if (!t.assigneeId) {
    const mins = minutesSince(t.createdAt, now);
    items.push({ key: 'unassigned', tone: 'warn', text: mins < 60 ? 'Unassigned' : `Unassigned for ${fmtDuration(mins)}`, action: call('Assign to me', act.onAssignMe) });
  }

  // Waiting on the customer: the paused SLA clock says since when; otherwise the last activity is the best bound we have.
  if (t.status?.key === AWAITING_CUSTOMER_KEY) {
    const since = t.slas.find((s) => s.state === 'paused' && s.pausedAt)?.pausedAt ?? t.lastActivityAt;
    if (ms(now) - at(since) > 2 * DAY) items.push({ key: 'awaiting-customer', tone: 'warn', text: `Awaiting customer for ${fmtDuration(minutesSince(since, now))}`, action: call('Nudge customer', act.onNudge) });
  } else if (ms(now) - at(t.lastActivityAt) > 3 * DAY) {
    items.push({ key: 'stale', tone: 'warn', text: `No activity for ${fmtDuration(minutesSince(t.lastActivityAt, now))}` });
  }

  if (t.approvalStatus === 'pending') items.push({ key: 'approval', tone: 'info', text: 'Approval pending', action: { label: 'Approvals', to: '?tab=approvals' } });
  if (t.scopeStatus === 'out_of_scope') items.push({ key: 'scope', tone: 'warn', text: 'Out of contract scope', action: call('Scope', act.onScope) });
  if (t.reopenCount > 0) items.push({ key: 'reopened', tone: 'info', text: `Reopened ${t.reopenCount}×` });

  const problem = t.type === 'problem' ? undefined : t.links.find((l) => l.ticket.type === 'problem');
  if (problem) items.push({ key: 'problem', tone: 'info', text: `Linked to problem ${problem.ticket.number}`, action: { label: 'Open', to: `/tickets/${problem.ticket.id}` } });

  return items;
}

// ---------------------------------------------------------------- configuration item

/** The slice of the CI detail payload the rules read (the page's `CiDetail` satisfies it structurally). */
export interface CiAttentionInput {
  status: string;
  environment?: string | null;
  ownerTeamId?: string | null;
  relationshipCount: number;
  discoverySource?: string | null;
  discoveredAt?: string | null;
  lastSeenAt?: string | null;
  openTickets: { id: string }[];
}

/**
 * Flags for a CI. The payload's open tickets carry no priority, so "critical CI with an open P1"
 * is deliberately not derived here.
 */
export function ciAttention(ci: CiAttentionInput, now: Clock, act: { onEdit?: () => void } = {}): AttentionItem[] {
  const items: AttentionItem[] = [];
  const edit = call('Edit', act.onEdit);
  const open = ci.openTickets.length;
  const parked = ci.status === 'retired' || ci.status === 'inactive';

  if (parked && open > 0) items.push({ key: 'parked-open', tone: 'bad', text: `${titleCase(ci.status)} with ${plural(open, 'open ticket')}`, action: { label: 'Tickets', to: '?tab=tickets' } });
  if (!ci.ownerTeamId) items.push({ key: 'no-owner', tone: 'warn', text: 'No owner team', action: edit });
  if (ci.discoverySource) {
    if (!ci.lastSeenAt) items.push({ key: 'never-seen', tone: 'warn', text: ci.discoveredAt ? `Not seen by discovery since ${fmtDate(ci.discoveredAt)}` : 'Never seen by discovery' });
    else if (ms(now) - at(ci.lastSeenAt) > 30 * DAY) items.push({ key: 'stale', tone: 'warn', text: `Not seen by discovery for ${fmtDuration(minutesSince(ci.lastSeenAt, now))}` });
  }
  if (ci.relationshipCount === 0 && ci.status !== 'retired') items.push({ key: 'no-relationships', tone: 'info', text: 'No relationships mapped', action: { label: 'Relationships', to: '?tab=relationships' } });
  if (!ci.environment) items.push({ key: 'no-environment', tone: 'info', text: 'Environment not set', action: edit });

  return items;
}

// ---------------------------------------------------------------- asset

/** The slice of the asset detail payload the rules read (the page's `AssetDetail` satisfies it structurally). */
export interface AssetAttentionInput {
  lifecycleStage: string;
  /** Config-option key of the asset status (`in_use`, `in_stock`, `retired`, …). */
  statusKey?: string | null;
  warranty: Coverage;
  amc: Coverage;
  eol: Coverage;
  ci: { id: string } | null;
  amcContract: { id: string } | null;
}

/** Expired coverage is bad; coverage ending within 30 days is a warning; anything else is quiet. */
function coverageFlag(key: string, label: string, c: Coverage, action?: Action): AttentionItem | null {
  if (c.status === 'expired') return { key, tone: 'bad', text: `${label} expired ${Math.abs(c.days ?? 0)}d ago`, action };
  if (c.status === 'expiring' && c.days !== null && c.days <= 30) return { key, tone: 'warn', text: c.days === 0 ? `${label} expires today` : `${label} expires in ${c.days}d`, action };
  return null;
}

export function assetAttention(a: AssetAttentionInput, act: { onLinkCi?: () => void } = {}): AttentionItem[] {
  const items: AttentionItem[] = [];
  const gone = a.lifecycleStage === 'retired' || a.lifecycleStage === 'disposed';

  const warranty = coverageFlag('warranty', 'Warranty', a.warranty);
  if (warranty) items.push(warranty);
  const amc = coverageFlag('amc', 'AMC', a.amc, a.amcContract ? { label: 'Contract', to: `/contracts/${a.amcContract.id}` } : undefined);
  if (amc) items.push(amc);

  if (gone && a.statusKey === 'in_use') items.push({ key: 'lifecycle-status', tone: 'warn', text: `${titleCase(a.lifecycleStage)} but status is still In Use` });
  if (a.eol.status === 'expired' && a.lifecycleStage === 'deployed') items.push({ key: 'eol-deployed', tone: 'warn', text: `Past end of life (${fmtDate(a.eol.end)}) but still deployed` });
  if (!a.ci && !gone) items.push({ key: 'no-ci', tone: 'info', text: 'No linked configuration item', action: act.onLinkCi ? { label: 'Link CI', onClick: act.onLinkCi } : { label: 'CMDB', to: '/cmdb/cis' } });

  return items;
}

// ---------------------------------------------------------------- customer

/**
 * Flags for an account. `overview`, `sites` and `contacts` are the page's separate queries;
 * pass `undefined` while they load and the rules that need them stay silent.
 */
export function customerAttention(c: CustomerDetail, overview: CustomerOverview | undefined, sites: Site[] | undefined, contacts: Contact[] | undefined): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (overview) {
    // ticketsByPriority counts open tickets only (status category new/open/pending).
    const p1 = overview.ticketsByPriority.find((p) => p.level === 1);
    if (p1 && p1.count > 0) items.push({ key: 'p1', tone: 'bad', text: plural(p1.count, 'open P1 ticket'), action: { label: 'Tickets', to: `/tickets?customerId=${c.id}${p1.priorityId ? `&priorityId=${p1.priorityId}` : ''}` } });

    const live = overview.contracts.filter((k) => k.status === 'active' || k.status === 'expiring');
    for (const k of live.filter((k) => k.daysToExpiry < 0)) items.push({ key: `contract-overdue-${k.id}`, tone: 'bad', text: `${k.number} past its end date but still ${k.statusLabel.toLowerCase()}`, action: { label: 'Contract', to: `/contracts/${k.id}` } });
    const expiring = live.filter((k) => k.daysToExpiry >= 0 && k.daysToExpiry <= 60);
    if (expiring.length === 1) items.push({ key: 'contract-expiring', tone: 'warn', text: expiring[0]!.daysToExpiry === 0 ? `${expiring[0]!.number} expires today` : `${expiring[0]!.number} expires in ${expiring[0]!.daysToExpiry}d`, action: { label: 'Contracts', to: '?tab=contracts' } });
    else if (expiring.length > 1) items.push({ key: 'contract-expiring', tone: 'warn', text: `${expiring.length} contracts expire within 60 days`, action: { label: 'Contracts', to: '?tab=contracts' } });

    const hot = overview.entitlements.filter((e) => e.isActive && (e.utilization.exhausted || e.utilization.overThreshold));
    if (hot.length === 1) {
      const e = hot[0]!;
      items.push({ key: 'entitlements', tone: 'warn', text: e.utilization.exhausted ? `${e.name} exhausted` : `${e.name} at ${Math.round(e.utilization.pct)}%`, action: { label: 'Entitlements', to: `/contracts/${e.contractId}?tab=entitlements` } });
    } else if (hot.length > 1) {
      const exhausted = hot.filter((e) => e.utilization.exhausted).length;
      items.push({ key: 'entitlements', tone: 'warn', text: exhausted ? `${plural(exhausted, 'entitlement')} exhausted, ${hot.length - exhausted} near limit` : `${hot.length} entitlements near limit`, action: { label: 'Contracts', to: '?tab=contracts' } });
    }

    if (overview.sla30d.breached > 0) items.push({ key: 'sla-30d', tone: 'warn', text: `${plural(overview.sla30d.breached, 'SLA breach', 'SLA breaches')} in the last 30 days`, action: { label: 'Tickets', to: `/tickets?customerId=${c.id}&slaState=breached` } });
  }

  if (sites && !sites.some((s) => s.isPrimary && s.isActive)) items.push({ key: 'no-primary-site', tone: 'info', text: 'No primary site', action: { label: 'Sites', to: '?tab=sites' } });
  if (contacts && !contacts.some((x) => x.isPrimary && x.isActive)) items.push({ key: 'no-primary-contact', tone: 'info', text: 'No primary contact', action: { label: 'Contacts', to: '?tab=contacts' } });

  return items;
}

// ---------------------------------------------------------------- field visit

export interface VisitAttentionActions {
  /** Opens the schedule / re-assign dialog; omit when the viewer cannot schedule. */
  onAssign?: () => void;
  /** Opens the reschedule dialog; omit when the viewer cannot reschedule. */
  onReschedule?: () => void;
  /** Opens the acknowledgement dialog; omit when the viewer cannot record it. */
  onAcknowledge?: () => void;
}

/**
 * Flags for a field visit. The payload has no part status and no SLA on the linked ticket,
 * so "parts pending" and "linked ticket breached" are deliberately not derived here.
 */
export function visitAttention(v: VisitDetail, now: Clock, act: VisitAttentionActions = {}): AttentionItem[] {
  const items: AttentionItem[] = [];
  const pending = v.status === 'requested' || v.status === 'scheduled';

  if (v.status === 'scheduled' && v.scheduledStart && at(v.scheduledStart) < ms(now)) items.push({ key: 'overdue', tone: 'bad', text: `Scheduled start passed ${ago(v.scheduledStart, now)}`, action: call('Reschedule', act.onReschedule) });
  if (!v.engineerId && pending) items.push({ key: 'no-engineer', tone: 'warn', text: 'No engineer assigned', action: call('Assign', act.onAssign) });
  if (v.status === 'in_progress' && v.actualStart && ms(now) - at(v.actualStart) > 8 * HOUR) items.push({ key: 'long-visit', tone: 'warn', text: `On site for ${fmtDuration(minutesSince(v.actualStart, now))}` });
  if (v.status === 'completed' && !v.customerAckAt) items.push({ key: 'no-ack', tone: 'info', text: 'Completed, awaiting customer acknowledgement', action: call('Record', act.onAcknowledge) });

  return items;
}

// ---------------------------------------------------------------- contract

export function contractAttention(c: ContractDetail, act: { onRenew?: () => void; onEdit?: () => void } = {}): AttentionItem[] {
  const items: AttentionItem[] = [];
  const live = c.status === 'active' || c.status === 'expiring';
  const current = live || c.status === 'draft';
  const renew = call('Renew', act.onRenew);

  if (c.status === 'expired') items.push({ key: 'expired', tone: 'bad', text: `Expired ${Math.abs(c.daysToExpiry)}d ago`, action: renew });
  else if (live && c.daysToExpiry < 0) items.push({ key: 'expired', tone: 'bad', text: `Past end date (${fmtDate(c.endDate)}) but still ${c.status}`, action: renew });
  else if (live && (c.status === 'expiring' || c.daysToExpiry <= 60)) items.push({ key: 'expiring', tone: 'warn', text: c.daysToExpiry === 0 ? 'Expires today' : `Expires in ${c.daysToExpiry}d`, action: renew });

  // A contract policy is only missing when some covered service would fall back to the platform default.
  const covered = c.services.length > 0 && c.services.every((s) => !!s.effectiveSlaPolicyId);
  if (current && !c.slaPolicyId && !covered) items.push({ key: 'no-sla', tone: 'warn', text: 'No SLA policy (platform default applies)', action: call('Edit', act.onEdit) });
  if (current && c.services.length === 0) items.push({ key: 'no-services', tone: 'info', text: 'No covered services', action: { label: 'Services', to: '?tab=services' } });
  if (live && !c.documents.signedAgreement) items.push({ key: 'no-agreement', tone: 'warn', text: 'No signed agreement on file', action: { label: 'Documents', to: '?tab=documents' } });

  const exhausted = c.entitlements.filter((e) => e.isActive && e.utilization.exhausted);
  if (exhausted.length === 1) items.push({ key: 'exhausted', tone: 'warn', text: `${exhausted[0]!.name} exhausted`, action: { label: 'Entitlements', to: '?tab=entitlements' } });
  else if (exhausted.length > 1) items.push({ key: 'exhausted', tone: 'warn', text: `${exhausted.length} entitlements exhausted`, action: { label: 'Entitlements', to: '?tab=entitlements' } });

  return items;
}
