import { eq, and, inArray } from 'drizzle-orm';
import { withSystem, schema, type Tx } from '@/db/client';
import type { Ctx } from '@/core/context';
import type { Principal } from '@/core/principal';
import { logger } from '@/core/logger';
import { createTicket, assignTicket, changeStatus, resolveTicket, closeTicket, reopenTicket, updateProblemDetails, updateChangeDetails } from '@/modules/tickets/service';
import { addComment, addTimeEntry, createTask, updateTask } from '@/modules/tickets/activity';
import { decide, requestApproval } from '@/modules/tickets/approvals';
import { applyEscalationRules } from '@/modules/tickets/escalation';
import { reloadTicket, systemCtx } from '@/modules/tickets/common';
import type { CreateTicketInput } from '@/modules/tickets/schemas';
import { addWorkingMinutes, CALENDAR_24X7, type CalendarDef } from '@/lib/calendar';
import { calendarOf } from '@/modules/sla/engine';
import { ctxFor, integrationPrincipal, principalOf, user, type DemoCi, type DemoCustomer, type DemoSite, type DemoState } from './state';
import { findEntitlement } from './contracts';
import { backdateRuns, rewriteSla, type Phase, type TicketRun, type Timeline } from './backdate';
import { INCIDENT_TEMPLATES, REQUEST_TEMPLATES, PROBLEM_TEMPLATES, CHANGE_TEMPLATES, type IncidentTemplate, type RequestTemplate, type ProblemTemplate, type ChangeTemplate, type Vars } from './ticket-templates';
import { addDays, addMinutes, atIst, DAY, HOUR, isoDate, istWeekday, MINUTE, randomTimeOfDay, type Rng } from './rng';

type Actor = { kind: 'msp'; key: string } | { kind: 'portal'; userId: string; name: string } | { kind: 'integration'; name: string };
/** Customers whose portal logins the demo advertises: each gets at least one active known error. */
const SHOWCASE_PORTAL_CUSTOMERS = ['abc', 'meridian', 'northwind'];

type Outcome = 'new' | 'in_progress' | 'pending_customer' | 'pending_vendor' | 'resolved';

interface Plan {
  key: string;
  type: 'incident' | 'request' | 'problem' | 'change';
  cust: DemoCustomer;
  site: DemoSite | null;
  ci: DemoCi | null;
  vars: Vars;
  incident?: IncidentTemplate;
  request?: RequestTemplate;
  problem?: ProblemTemplate;
  change?: ChangeTemplate;
  categoryKey: string | null;
  subcategoryKey: string | null;
  serviceKey: string | null;
  impactKey: string;
  urgencyKey: string;
  priorityKey: string;
  sourceKey: string;
  creator: Actor;
  requesterContactId: string | null;
  requesterUserId: string | null;
  teamKey: string;
  assigneeKey: string | null;
  managerKey: string;
  assignedAtCreation: boolean;
  createdAt: Date;
  outcome: Outcome;
  responseMet: boolean;
  resolutionMet: boolean;
  workNotes: number;
  reopen: boolean;
  customerComment: boolean;
  approvalDecision: 'approved' | 'rejected' | 'pending' | null;
  changeStage: 'draft' | 'awaiting' | 'rejected' | 'scheduled' | 'implementing' | 'implemented' | 'failed' | null;
  problemStage: 'investigating' | 'rca' | 'known_error' | 'resolved' | null;
  title: string;
}

const TOTAL = 450;
const CUSTOMER_WEIGHTS: Record<string, number> = { abc: 16, meridian: 15, apex: 12, sterling: 10, northwind: 9, helios: 9, orbital: 8, quantum: 8, riverside: 7, crestline: 6 };
const PRIORITY_OF: Record<string, string> = { 'high:high': 'p1', 'high:medium': 'p2', 'high:low': 'p3', 'medium:high': 'p2', 'medium:medium': 'p3', 'medium:low': 'p4', 'low:high': 'p3', 'low:medium': 'p4', 'low:low': 'p4' };
const LEVELS = ['high', 'medium', 'low'];
const TEAM_OF_DOMAIN: Record<string, string> = { noc: 'noc', soc: 'soc', amc: 'field', service_desk: 'service_desk', general: 'service_desk' };
const MANAGER_OF_TEAM: Record<string, string> = { noc: 'rajesh', soc: 'sneha', field: 'ananya', service_desk: 'ananya', cloud: 'rajesh' };

function assigneeFor(rng: Rng, teamKey: string, categoryKey: string | null, cust: DemoCustomer): string {
  switch (teamKey) {
    case 'noc':
      if (['network', 'connectivity'].includes(categoryKey ?? '')) return rng.weighted([['priya', 0.7], ['arjun', 0.15], ['deepak', 0.15]]);
      if (['virtualization', 'cloud'].includes(categoryKey ?? '')) return rng.weighted([['deepak', 0.7], ['arjun', 0.3]]);
      return rng.weighted([['arjun', 0.6], ['priya', 0.15], ['deepak', 0.25]]);
    case 'cloud':
      return 'deepak';
    case 'soc':
      return rng.weighted([['karan', 0.6], ['fatima', 0.4]]);
    case 'field':
      return cust.fieldEngineerKeys.length ? rng.pick(cust.fieldEngineerKeys) : 'arjun';
    default:
      return rng.weighted([['rohan', 0.5], ['meera', 0.5]]);
  }
}

/** Sample a creation instant: open tickets are recent (exponential), closed ones follow a rising density over 120 days. */
function sampleCreatedAt(rng: Rng, now: Date, open: boolean, anyHour: boolean, worksWeekends: boolean): Date {
  let ageDays: number;
  if (open) ageDays = Math.min(35, 0.02 + -Math.log(1 - rng.next()) * 4);
  else {
    for (;;) {
      const d = rng.float(0.15, 120);
      if (rng.next() < (3 - (2 * d) / 120) / 3) {
        ageDays = d;
        break;
      }
    }
  }
  let day = addDays(now, -ageDays);
  let at = randomTimeOfDay(rng, day, anyHour);
  if (!anyHour && !worksWeekends) {
    const wd = istWeekday(at);
    if ((wd === 0 || wd === 6) && rng.chance(0.75)) {
      day = addDays(day, wd === 0 ? 1 : 2);
      at = randomTimeOfDay(rng, day, false);
    }
  }
  if (at.getTime() > now.getTime() - 15 * MINUTE) at = new Date(now.getTime() - rng.int(15, 240) * MINUTE);
  return at;
}

function pickSite(rng: Rng, cust: DemoCustomer, preferCovered: string[] | null): DemoSite {
  if (preferCovered?.length && rng.chance(0.85)) return cust.sites.find((s) => s.key === rng.pick(preferCovered))!;
  return rng.weighted(cust.sites.map((s, i): [DemoSite, number] => [s, i === 0 ? 0.45 : 0.55 / Math.max(1, cust.sites.length - 1)]));
}

function pickCi(rng: Rng, cust: DemoCustomer, site: DemoSite | null, types: string[]): DemoCi | null {
  if (!types.length) return null;
  const pool = cust.cis.filter((c) => types.includes(c.typeKey));
  if (!pool.length) return null;
  const atSite = site ? pool.filter((c) => c.siteKey === site.key) : [];
  return rng.pick(atSite.length ? atSite : pool);
}

function varsFor(rng: Rng, cust: DemoCustomer, site: DemoSite | null, ci: DemoCi | null, userName: string): Vars {
  const app = cust.cis.find((c) => c.typeKey === 'application' && c.siteKey === cust.sites[0]!.key) ?? cust.cis.find((c) => c.typeKey === 'application');
  return { rng, cust, site, ci, host: ci?.hostname ?? ci?.name ?? `${cust.short}-${site?.code.toLowerCase() ?? 'hq'}-srv01`, ip: ci?.ipAddress ?? `10.${cust.index}.${site?.subnet ?? 1}.${rng.int(20, 200)}`, user: userName, app: app?.name ?? 'ERP', n: rng.int(1, 99) };
}

function buildPlans(state: DemoState): Plan[] {
  const { rng, now } = state;
  const plans: Plan[] = [];
  let seq = 0;
  for (const cust of state.customers) {
    const n = Math.round((TOTAL * (CUSTOMER_WEIGHTS[cust.key] ?? 5)) / 100);
    const problems = Math.max(1, Math.round(n * 0.07));
    const changes = Math.max(1, Math.round(n * 0.05));
    const requests = Math.round(n * 0.18);
    const incidents = n - problems - changes - requests;
    const amc = cust.contracts.find((c) => c.typeKey === 'amc' && ['active', 'expiring'].includes(c.status));
    const worksWeekends = cust.key === 'apex' || cust.key === 'sterling';
    const requesterOf = (sourceKey: string): { creator: Actor; contactId: string | null; userId: string | null; name: string } => {
      if (sourceKey === 'portal' && cust.portalUsers.length) {
        const pu = rng.pick(cust.portalUsers);
        return { creator: { kind: 'portal', userId: pu.id, name: pu.name }, contactId: pu.contactId, userId: pu.id, name: pu.name };
      }
      if (sourceKey === 'monitoring') return { creator: { kind: 'integration', name: 'PRTG Monitoring' }, contactId: null, userId: null, name: cust.contacts.find((c) => c.isPrimary)!.name };
      if (sourceKey === 'siem') return { creator: { kind: 'integration', name: 'FortiSIEM' }, contactId: null, userId: null, name: cust.contacts.find((c) => c.isPrimary)!.name };
      const contact = rng.pick(cust.contacts);
      if (sourceKey === 'engineer') return { creator: { kind: 'msp', key: '__assignee__' }, contactId: contact.id, userId: contact.userId, name: contact.name };
      return { creator: { kind: 'msp', key: rng.pick(['rohan', 'meera']) }, contactId: contact.id, userId: contact.userId, name: contact.name };
    };
    const slaFlags = (priorityKey: string) => {
      let resp = 0.92;
      let res = 0.95;
      if (cust.key === 'apex') {
        resp -= 0.25;
        res -= 0.22;
      }
      if (priorityKey === 'p1') {
        resp -= 0.12;
        res -= 0.14;
      }
      return { responseMet: rng.chance(resp), resolutionMet: rng.chance(res) };
    };

    // ------------------------------------------------------------ incidents
    const covered = new Set(cust.contracts.filter((c) => ['active', 'expiring'].includes(c.status) && c.startDate <= isoDate(now) && c.endDate >= isoDate(now)).flatMap((c) => c.serviceKeys));
    const weighted = INCIDENT_TEMPLATES.map((t): [IncidentTemplate, number] => {
      let w = t.weight;
      if (t.domain === 'soc') w *= cust.domains.soc ? 3 : 0.06;
      if (t.domain === 'amc') w *= cust.domains.amc ? 1 : 0.08;
      if (t.categoryKey === 'cloud') w *= cust.domains.cloud ? 2 : 0;
      if (t.domain === 'service_desk') w *= cust.domains.eus ? 2.2 : 0.12;
      if (t.key === 'store_switch_replace') w *= cust.key === 'apex' ? 3 : 0.3;
      // Work mostly lands on services the customer actually buys; a few out-of-scope requests remain realistic.
      if (t.serviceKey && !covered.has(t.serviceKey)) w *= 0.04;
      return [t, w];
    }).filter(([, w]) => w > 0);
    for (let i = 0; i < incidents; i++) {
      const t = rng.weighted(weighted);
      const site = pickSite(rng, cust, t.domain === 'amc' && amc?.siteKeys.length ? amc.siteKeys : null);
      const ci = pickCi(rng, cust, site, t.ciTypes);
      const effectiveSite = ci?.siteKey ? cust.sites.find((s) => s.key === ci.siteKey)! : site;
      const sourceKey = rng.weighted(t.sources.map(([k, w]): [string, number] => [k, w]));
      const req = requesterOf(sourceKey);
      let urgency = t.urgency;
      if (rng.chance(0.2)) urgency = LEVELS[Math.max(0, Math.min(2, LEVELS.indexOf(t.urgency) + (rng.chance(0.5) ? 1 : -1)))] as typeof urgency;
      const priorityKey = PRIORITY_OF[`${t.impact}:${urgency}`]!;
      const open = rng.chance(0.1);
      const anyHour = sourceKey === 'monitoring' || sourceKey === 'siem' || priorityKey === 'p1';
      const createdAt = sampleCreatedAt(rng, now, open, anyHour, worksWeekends);
      let teamKey = t.categoryKey === 'cloud' ? 'cloud' : TEAM_OF_DOMAIN[t.domain]!;
      if (teamKey === 'field' && !cust.fieldEngineerKeys.length) teamKey = 'noc';
      const outcome: Outcome = !open ? 'resolved' : rng.weighted([['new', 0.15], ['in_progress', 0.6], ['pending_customer', t.pendingVendor ? 0.1 : 0.2], ['pending_vendor', t.pendingVendor ? 0.15 : 0.05]]);
      const assigneeKey = outcome === 'new' ? null : assigneeFor(rng, teamKey, t.categoryKey, cust);
      const creator: Actor = req.creator.kind === 'msp' && req.creator.key === '__assignee__' ? { kind: 'msp', key: assigneeKey ?? assigneeFor(rng, teamKey, t.categoryKey, cust) } : req.creator;
      const vars = varsFor(rng, cust, effectiveSite, ci, req.name);
      plans.push({
        key: `inc-${++seq}`, type: 'incident', cust, site: effectiveSite, ci, vars, incident: t,
        categoryKey: t.categoryKey, subcategoryKey: t.subcategoryKey ?? null, serviceKey: t.serviceKey,
        impactKey: t.impact, urgencyKey: urgency, priorityKey, sourceKey, creator,
        requesterContactId: req.contactId, requesterUserId: req.userId, teamKey, assigneeKey, managerKey: MANAGER_OF_TEAM[teamKey]!,
        assignedAtCreation: creator.kind === 'msp' && !!assigneeKey && rng.chance(0.65),
        createdAt, outcome, ...slaFlags(priorityKey), workNotes: rng.weighted([[0, 0.2], [1, 0.4], [2, 0.3], [3, 0.1]]), reopen: !open && rng.chance(0.06), customerComment: creator.kind === 'portal' && rng.chance(0.45),
        approvalDecision: null, changeStage: null, problemStage: null, title: t.title(vars),
      });
    }

    // ------------------------------------------------------------ requests
    for (let i = 0; i < requests; i++) {
      const t = rng.weighted(REQUEST_TEMPLATES.map((r): [RequestTemplate, number] => [r, (r.key === 'maintenance_window' && !cust.domains.amc ? 0.2 : r.weight) * (r.serviceKey && !covered.has(r.serviceKey) ? 0.12 : 1)]));
      const site = pickSite(rng, cust, null);
      const ci = pickCi(rng, cust, site, t.catalogKey === 'config_change' ? ['firewall', 'network_switch'] : t.catalogKey === 'certificate_renewal' ? ['application'] : []);
      const sourceKey = rng.weighted(t.sources.map(([k, w]): [string, number] => [k, w]));
      const req = requesterOf(sourceKey);
      const catalog = state.refs.catalogItem(t.catalogKey);
      const hasApproval = !!catalog.approvalWorkflowId;
      const open = rng.chance(0.12);
      const createdAt = sampleCreatedAt(rng, now, open, false, worksWeekends);
      const svc = t.serviceKey ? state.services.get(t.serviceKey) : null;
      const teamKey = svc?.teamKey ?? 'service_desk';
      const outcome: Outcome = !open ? 'resolved' : rng.weighted([['new', 0.25], ['in_progress', 0.6], ['pending_customer', 0.15]]);
      const approvalDecision = hasApproval ? (open && rng.chance(0.4) ? 'pending' : rng.chance(0.08) ? 'rejected' : 'approved') : null;
      const assigneeKey = outcome === 'new' || approvalDecision === 'pending' || approvalDecision === 'rejected' ? null : assigneeFor(rng, teamKey, svc?.categoryKey ?? null, cust);
      const vars = varsFor(rng, cust, site, ci, req.name);
      plans.push({
        key: `req-${++seq}`, type: 'request', cust, site, ci, vars, request: t,
        categoryKey: null, subcategoryKey: null, serviceKey: t.serviceKey, impactKey: 'low', urgencyKey: 'medium', priorityKey: 'p4', sourceKey,
        creator: req.creator.kind === 'msp' && req.creator.key === '__assignee__' ? { kind: 'msp', key: 'rohan' } : req.creator, requesterContactId: req.contactId, requesterUserId: req.userId,
        teamKey, assigneeKey, managerKey: MANAGER_OF_TEAM[teamKey]!, assignedAtCreation: false,
        createdAt, outcome, responseMet: rng.chance(0.92), resolutionMet: rng.chance(0.94), workNotes: rng.weighted([[0, 0.3], [1, 0.5], [2, 0.2]]), reopen: false, customerComment: req.creator.kind === 'portal' && rng.chance(0.3),
        approvalDecision, changeStage: null, problemStage: null, title: t.title(vars),
      });
    }

    // ------------------------------------------------------------ problems
    // The first open problem of a customer whose portal login the demo advertises always reaches the known-error
    // stage, so the portal has an active known issue to show; the random draw is still taken to keep the sequence.
    let showcaseKnownError = !SHOWCASE_PORTAL_CUSTOMERS.includes(cust.key);
    for (let i = 0; i < problems; i++) {
      const t = rng.pick(PROBLEM_TEMPLATES);
      const site = pickSite(rng, cust, null);
      const ci = pickCi(rng, cust, site, t.ciTypes);
      const effectiveSite = ci?.siteKey ? cust.sites.find((s) => s.key === ci.siteKey)! : site;
      const open = rng.chance(0.3);
      const createdAt = sampleCreatedAt(rng, now, false, false, false);
      const assigneeKey = assigneeFor(rng, 'noc', t.categoryKey, cust);
      const vars = varsFor(rng, cust, effectiveSite, ci, cust.contacts.find((c) => c.isPrimary)!.name);
      const problemStageFor = (isOpen: boolean): Plan['problemStage'] => {
        if (!isOpen) return 'resolved';
        const drawn = rng.weighted([['investigating', 0.4], ['rca', 0.3], ['known_error', 0.3]]) as Plan['problemStage'];
        if (showcaseKnownError) return drawn;
        showcaseKnownError = true;
        return 'known_error';
      };
      plans.push({
        key: `prb-${++seq}`, type: 'problem', cust, site: effectiveSite, ci, vars, problem: t,
        categoryKey: t.categoryKey, subcategoryKey: t.subcategoryKey ?? null, serviceKey: t.serviceKey, impactKey: 'medium', urgencyKey: 'medium', priorityKey: 'p3', sourceKey: 'engineer',
        creator: { kind: 'msp', key: assigneeKey }, requesterContactId: null, requesterUserId: null, teamKey: 'noc', assigneeKey, managerKey: 'rajesh', assignedAtCreation: true,
        createdAt, outcome: open ? 'in_progress' : 'resolved', responseMet: true, resolutionMet: true, workNotes: 1, reopen: false, customerComment: false,
        approvalDecision: null, changeStage: null, problemStage: problemStageFor(open), title: t.title(vars),
      });
    }

    // ------------------------------------------------------------ changes
    for (let i = 0; i < changes; i++) {
      const t = rng.pick(CHANGE_TEMPLATES.filter((c) => (c.key === 'ups_battery' ? cust.domains.amc : true)));
      const site = pickSite(rng, cust, null);
      const ci = pickCi(rng, cust, site, t.ciTypes);
      const effectiveSite = ci?.siteKey ? cust.sites.find((s) => s.key === ci.siteKey)! : site;
      const open = rng.chance(0.3);
      const createdAt = sampleCreatedAt(rng, now, open, false, false);
      const assigneeKey = assigneeFor(rng, t.categoryKey === 'hardware' ? 'field' : 'noc', t.categoryKey, cust);
      const stage: Plan['changeStage'] = open ? rng.weighted([['draft', 0.15], ['awaiting', 0.35], ['scheduled', 0.35], ['implementing', 0.15]]) : rng.weighted([['implemented', 0.82], ['failed', 0.08], ['rejected', 0.1]]);
      const vars = varsFor(rng, cust, effectiveSite, ci, cust.contacts.find((c) => c.isPrimary)!.name);
      plans.push({
        key: `chg-${++seq}`, type: 'change', cust, site: effectiveSite, ci, vars, change: t,
        categoryKey: t.categoryKey, subcategoryKey: null, serviceKey: t.serviceKey, impactKey: 'medium', urgencyKey: t.changeType === 'emergency' ? 'high' : 'low', priorityKey: t.changeType === 'emergency' ? 'p2' : 'p4', sourceKey: 'engineer',
        creator: { kind: 'msp', key: assigneeKey }, requesterContactId: cust.contacts.find((c) => c.isPrimary)!.id, requesterUserId: null, teamKey: t.categoryKey === 'hardware' && cust.fieldEngineerKeys.length ? 'field' : 'noc', assigneeKey, managerKey: 'rajesh', assignedAtCreation: true,
        createdAt, outcome: open ? 'in_progress' : 'resolved', responseMet: true, resolutionMet: true, workNotes: 1, reopen: false, customerComment: false,
        approvalDecision: null, changeStage: stage, problemStage: null, title: t.title(vars),
      });
    }
  }
  return plans.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

// ---------------------------------------------------------------- execution

interface Targets {
  response: { minutes: number; cal: CalendarDef } | null;
  resolution: { minutes: number; cal: CalendarDef } | null;
  restoration: { minutes: number; cal: CalendarDef } | null;
}

function targetsOf(rows: (typeof schema.ticketSlas.$inferSelect)[]): Targets {
  const pick = (metric: string) => {
    const r = rows.find((x) => x.metric === metric);
    return r ? { minutes: r.targetMinutes, cal: calendarOf(r) } : null;
  };
  return { response: pick('response') ?? pick('acknowledgement'), resolution: pick('resolution') ?? pick('restoration'), restoration: pick('restoration') };
}

const work = (from: Date, minutes: number, cal: CalendarDef | undefined) => addWorkingMinutes(from, Math.max(1, Math.round(minutes)), cal ?? CALENDAR_24X7);

interface IncidentTimes {
  tl: Timeline;
  assignAt: Date | null;
  progressAt: Date | null;
  workNoteTimes: Date[];
  customerCommentAt: Date | null;
  pauseStart: Date | null;
  pauseEnd: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  closedBySystem: boolean;
  reopenAt: Date | null;
  resolved2At: Date | null;
  closed2At: Date | null;
  outcome: Outcome;
}

function planIncidentTimes(plan: Plan, rows: (typeof schema.ticketSlas.$inferSelect)[], now: Date): IncidentTimes {
  const { rng } = plan.vars;
  const T0 = plan.createdAt;
  const tg = targetsOf(rows);
  const resp = tg.response ?? { minutes: 240, cal: CALENDAR_24X7 };
  const res = tg.resolution ?? { minutes: 2880, cal: CALENDAR_24X7 };
  let outcome = plan.outcome;
  const assigned = !!plan.assigneeKey && outcome !== 'new';
  let ackAt: Date | null = null;
  let assignAt: Date | null = null;
  if (assigned) {
    if (plan.assignedAtCreation) ackAt = T0;
    else {
      assignAt = work(T0, resp.minutes * rng.float(0.05, 0.4), resp.cal);
      if (assignAt.getTime() > now.getTime()) assignAt = new Date(now.getTime() - rng.int(5, 60) * MINUTE);
      ackAt = assignAt;
    }
  }
  const progressAt = assigned && plan.assignedAtCreation ? addMinutes(ackAt!, rng.int(2, 25)) : null;
  let firstResponseAt: Date | null = null;
  if (assigned) {
    const f = plan.responseMet ? rng.float(0.15, 0.85) : rng.float(1.1, 2.4);
    firstResponseAt = work(T0, resp.minutes * f, resp.cal);
    if (ackAt && firstResponseAt.getTime() < ackAt.getTime() + 2 * MINUTE) firstResponseAt = addMinutes(ackAt, rng.int(2, 15));
    if (firstResponseAt.getTime() > now.getTime() - 2 * MINUTE) firstResponseAt = null;
  }
  const afterResponse = firstResponseAt ?? ackAt ?? T0;
  let pauseStart: Date | null = null;
  let pauseEnd: Date | null = null;
  let pausedMinutes = 0;
  const wantsPause = outcome === 'pending_customer' || outcome === 'pending_vendor' || (outcome === 'resolved' && rng.chance(plan.incident?.pendingVendor ?? plan.incident?.pendingCustomer ?? 0.1));
  if (wantsPause && assigned) {
    pauseStart = work(afterResponse, res.minutes * rng.float(0.05, 0.2), res.cal);
    if (outcome === 'pending_customer' || outcome === 'pending_vendor') {
      if (pauseStart.getTime() >= now.getTime()) pauseStart = new Date(now.getTime() - rng.int(10, 180) * MINUTE);
      if (pauseStart.getTime() <= afterResponse.getTime()) pauseStart = addMinutes(afterResponse, 1);
    } else {
      pausedMinutes = res.minutes * rng.float(0.2, 0.8);
      pauseEnd = work(pauseStart, pausedMinutes, res.cal);
    }
  }
  let resolvedAt: Date | null = null;
  if (outcome === 'resolved') {
    const f = plan.resolutionMet ? rng.float(0.15, 0.85) : rng.float(1.1, 1.9);
    resolvedAt = work(T0, res.minutes * f + pausedMinutes, res.cal);
    const floor = Math.max(afterResponse.getTime(), (pauseEnd ?? pauseStart ?? T0).getTime()) + 5 * MINUTE;
    if (resolvedAt.getTime() < floor) resolvedAt = new Date(floor + rng.int(5, 90) * MINUTE);
    if (resolvedAt.getTime() > now.getTime() - 20 * MINUTE) {
      outcome = pauseStart ? 'pending_customer' : 'in_progress';
      resolvedAt = null;
      if (pauseStart) {
        pauseEnd = null;
        if (pauseStart.getTime() >= now.getTime()) pauseStart = new Date(now.getTime() - rng.int(10, 180) * MINUTE);
      }
    }
  }
  if (!resolvedAt && !assigned) outcome = 'new';
  // Service restoration precedes the resolution (workaround first, then the fix) when a restoration clock exists.
  let restoredAt: Date | null = null;
  if (resolvedAt && tg.restoration) {
    const f = rng.chance(plan.resolutionMet ? 0.95 : 0.6) ? rng.float(0.2, 0.9) : rng.float(1.05, 1.6);
    restoredAt = work(T0, tg.restoration.minutes * f + pausedMinutes, tg.restoration.cal);
    if (restoredAt.getTime() < afterResponse.getTime()) restoredAt = addMinutes(afterResponse, rng.int(5, 40));
    if (restoredAt.getTime() > resolvedAt.getTime()) restoredAt = resolvedAt;
  }
  let closedAt: Date | null = null;
  let closedBySystem = false;
  if (resolvedAt) {
    const confirmed = rng.chance(0.3);
    const candidate = confirmed ? addMinutes(resolvedAt, rng.int(90, 2 * 24 * 60)) : addDays(resolvedAt, 5);
    if (candidate.getTime() < now.getTime()) {
      closedAt = candidate;
      closedBySystem = !confirmed;
    }
  }
  // Reopen: customer comes back after resolution; second resolution and close.
  let reopenAt: Date | null = null;
  let resolved2At: Date | null = null;
  let closed2At: Date | null = null;
  if (plan.reopen && resolvedAt) {
    const r = addMinutes(resolvedAt, rng.int(120, 36 * 60));
    if (r.getTime() < now.getTime() - 6 * HOUR) {
      reopenAt = r;
      if (closedAt && closedAt.getTime() < reopenAt.getTime()) {
        /* reopened after close */
      } else closedAt = null;
      const r2 = work(reopenAt, res.minutes * rng.float(0.2, 0.6), res.cal);
      if (r2.getTime() < now.getTime() - HOUR) {
        resolved2At = r2;
        const c2 = addDays(r2, 5);
        if (c2.getTime() < now.getTime()) closed2At = c2;
      }
    }
  }
  const endOfWork = resolvedAt ?? pauseStart ?? now;
  const workNoteTimes: Date[] = [];
  const noteWindow = endOfWork.getTime() - afterResponse.getTime();
  for (let i = 0; i < plan.workNotes && assigned && noteWindow > 10 * MINUTE; i++) workNoteTimes.push(new Date(afterResponse.getTime() + noteWindow * rng.float(0.15, 0.9)));
  workNoteTimes.sort((a, b) => a.getTime() - b.getTime());
  const customerCommentAt = plan.customerComment && firstResponseAt && noteWindow > 30 * MINUTE ? new Date(afterResponse.getTime() + noteWindow * rng.float(0.2, 0.8)) : null;
  const finalResolved = reopenAt ? resolved2At : resolvedAt;
  const finalClosed = reopenAt ? closed2At : closedAt;
  const pauses: [Date, Date | null][] = pauseStart ? [[pauseStart, pauseEnd]] : [];
  const lastActivityAt = new Date(Math.max(...[T0, ackAt, firstResponseAt, pauseStart, pauseEnd, resolvedAt, closedAt, reopenAt, resolved2At, closed2At, customerCommentAt, ...workNoteTimes].filter((d): d is Date => !!d).map((d) => d.getTime())));
  return {
    tl: { createdAt: T0, acknowledgedAt: ackAt, firstResponseAt, pauses, firstResolvedAt: reopenAt ? resolvedAt : null, reopenedAt: reopenAt, resolvedAt: finalResolved, restoredAt: reopenAt ? finalResolved : restoredAt, closedAt: finalClosed, cancelledAt: null, lastActivityAt },
    assignAt, progressAt, workNoteTimes, customerCommentAt, pauseStart, pauseEnd, resolvedAt, closedAt, closedBySystem, reopenAt, resolved2At, closed2At, outcome,
  };
}

class Runner {
  phases: Phase[] = [];
  audit: TicketRun['audit'] = [];
  timeEntries: TicketRun['timeEntries'] = [];
  tasks: TicketRun['tasks'] = [];
  escalations: Date[] = [];
  approvalsRequestedAt: Date | null = null;
  constructor(readonly state: DemoState, readonly tx: Tx, readonly plan: Plan) {}

  mark(at: Date) {
    this.phases.push({ real: new Date(), at });
  }
  ctx(actor: Actor | string, source: Ctx['source'] = 'ui'): Ctx {
    const a: Actor = typeof actor === 'string' ? { kind: 'msp', key: actor } : actor;
    let p: Principal;
    if (a.kind === 'msp') p = principalOf(this.state, a.key);
    else if (a.kind === 'portal') p = principalOf(this.state, `portal:${a.userId}`);
    else {
      const apiKeyId = this.state.integrations.get(a.name === 'FortiSIEM' ? 'fortisiem:apikey' : 'prtg:apikey') ?? '00000000-0000-0000-0000-000000000001';
      p = integrationPrincipal(a.name, apiKeyId, null);
      source = 'integration';
    }
    return ctxFor(this.state, this.tx, p, source);
  }
  actorAudit(actor: Actor | string, action: string, at: Date) {
    const a: Actor = typeof actor === 'string' ? { kind: 'msp', key: actor } : actor;
    const userId = a.kind === 'msp' ? user(this.state, a.key).id : a.kind === 'portal' ? a.userId : null;
    const userName = a.kind === 'msp' ? user(this.state, a.key).name : a.name;
    this.audit.push({ action, at, userId, userName });
  }
  system(): Ctx {
    return systemCtx(this.tx, 'demo-seed');
  }

  baseInput(): CreateTicketInput {
    const { plan, state } = this;
    const refs = state.refs;
    const svc = plan.serviceKey ? state.services.get(plan.serviceKey) : null;
    const creatorIsPortal = plan.creator.kind === 'portal';
    return {
      type: plan.type,
      customerId: plan.cust.id,
      siteId: plan.site?.id ?? null,
      serviceId: svc?.id ?? null,
      title: plan.title,
      description: '',
      categoryId: plan.categoryKey ? refs.option('ticket_category', plan.categoryKey) : null,
      subcategoryId: plan.subcategoryKey ? refs.option('ticket_subcategory', plan.subcategoryKey) : null,
      impactId: refs.option('ticket_impact', plan.impactKey),
      urgencyId: refs.option('ticket_urgency', plan.urgencyKey),
      sourceId: creatorIsPortal ? null : refs.option('ticket_source', plan.sourceKey),
      assignedTeamId: creatorIsPortal ? null : refs.team(plan.teamKey),
      assigneeId: !creatorIsPortal && plan.assignedAtCreation && plan.assigneeKey ? user(state, plan.assigneeKey).id : null,
      requesterUserId: creatorIsPortal ? null : plan.requesterUserId,
      requesterContactId: plan.requesterContactId,
      primaryCiId: plan.ci?.id ?? null,
      primaryAssetId: plan.ci?.assetId ?? null,
      tags: [],
      isMajor: false,
    };
  }

  async create(input: CreateTicketInput) {
    this.mark(this.plan.createdAt);
    const t = await createTicket(this.ctx(this.plan.creator), input);
    this.actorAudit(this.plan.creator, 'ticket.create', this.plan.createdAt);
    return t;
  }

  async slaRows(ticketId: string) {
    return this.tx.select().from(schema.ticketSlas).where(eq(schema.ticketSlas.ticketId, ticketId));
  }

  async workNotesAndTime(ticketId: string, assignee: string, times: Date[], notes: ((v: Vars) => string)[], onsite = false) {
    const { plan, state } = this;
    for (let i = 0; i < times.length; i++) {
      const at = times[i]!;
      const body = notes.length ? notes[i % notes.length]!(plan.vars) : 'Investigation in progress; see linked notes.';
      this.mark(at);
      await addComment(this.ctx(assignee), ticketId, { kind: 'work_note', body });
      const minutes = plan.vars.rng.int(15, onsite ? 240 : 120);
      const ent = plan.vars.rng.chance(0.3) ? findEntitlement(state, plan.cust.key, plan.vars.rng.chance(0.5) ? 'remote_support_hours' : 'engineering_hours', at) : null;
      this.mark(addMinutes(at, 1));
      const entry = await addTimeEntry(this.ctx(assignee), ticketId, { minutes, description: body.slice(0, 120), workType: onsite ? 'onsite' : 'remote', billable: false, startedAt: at, entitlementId: ent?.entitlementId ?? null });
      this.timeEntries.push({ id: entry.id, at, consumptionId: entry.consumptionId ?? null });
    }
  }

  result(ticket: { id: string; number: string }, tl: Timeline): TicketRun {
    return { ticketId: ticket.id, customerId: this.plan.cust.id, number: ticket.number, phases: this.phases, tl, timeEntries: this.timeEntries, tasks: this.tasks, approvalsRequestedAt: this.approvalsRequestedAt, escalations: this.escalations, audit: this.audit };
  }
}

async function runIncident(state: DemoState, tx: Tx, plan: Plan): Promise<TicketRun> {
  const r = new Runner(state, tx, plan);
  const t = plan.incident!;
  const { refs, now } = state;
  const input = r.baseInput();
  input.description = t.description(plan.vars);
  input.tags = [...t.tags];
  input.isMajor = !!t.isMajor && plan.priorityKey === 'p1';
  if (t.severity) input.securitySeverityId = refs.option('security_severity', t.severity);
  if (plan.creator.kind === 'integration') input.externalRef = plan.sourceKey === 'siem' ? `FSM-INC-${plan.vars.n * 131 + 7000}` : `PRTG-${plan.ci?.monitoringRef ?? plan.vars.n * 97}-${plan.vars.n}`;
  if (input.isMajor && plan.creator.kind !== 'portal') input.watcherIds = [user(state, 'vikram').id, user(state, 'ananya').id];
  const ticket = await r.create(input);
  const rows = await r.slaRows(ticket.id);
  const times = planIncidentTimes(plan, rows, now);
  const assignee = plan.assigneeKey;
  const resolveCtx = () => r.ctx(assignee!);

  if (times.assignAt && assignee) {
    r.mark(times.assignAt);
    const by = plan.vars.rng.chance(0.5) ? plan.managerKey : assignee;
    await assignTicket(r.ctx(by), ticket.id, { teamId: refs.team(plan.teamKey), assigneeId: user(state, assignee).id, autoProgress: true, comment: by === assignee ? 'Picking this up.' : null });
    r.actorAudit(by, 'ticket.assign', times.assignAt);
  } else if (times.progressAt && assignee) {
    r.mark(times.progressAt);
    await changeStatus(resolveCtx(), ticket.id, { statusId: refs.option('ticket_status', 'in_progress') });
  }
  if (times.tl.firstResponseAt && assignee) {
    r.mark(times.tl.firstResponseAt);
    await addComment(resolveCtx(), ticket.id, { kind: 'comment', body: t.firstResponse(plan.vars) });
    r.actorAudit(assignee, 'ticket.comment', times.tl.firstResponseAt);
  }
  if (t.tasks && assignee && times.tl.firstResponseAt) {
    for (const [i, title] of t.tasks.entries()) {
      const at = addMinutes(times.tl.firstResponseAt, 3 + i);
      r.mark(at);
      const task = await createTask(resolveCtx(), ticket.id, { title, assigneeId: user(state, assignee).id, teamId: refs.team(plan.teamKey), sortOrder: i });
      r.tasks.push({ id: task.id, createdAt: at, completedAt: null });
    }
  }
  await r.workNotesAndTime(ticket.id, assignee ?? plan.managerKey, times.workNoteTimes, t.workNotes, !!t.fieldVisit);
  if (times.customerCommentAt && plan.creator.kind === 'portal' && t.customerComment) {
    r.mark(times.customerCommentAt);
    await addComment(r.ctx(plan.creator), ticket.id, { kind: 'comment', body: t.customerComment(plan.vars) });
  }
  if (times.pauseStart && assignee) {
    r.mark(times.pauseStart);
    const vendor = times.outcome === 'pending_vendor' || (!!t.pendingVendor && times.outcome === 'resolved');
    await changeStatus(resolveCtx(), ticket.id, { statusId: refs.option('ticket_status', vendor ? 'pending_vendor' : 'pending_customer'), comment: vendor ? 'Waiting for the vendor / ISP to complete their action; we will update as soon as we hear back.' : 'We need a confirmation from your side before we can proceed - please see the question above.' });
    if (times.pauseEnd) {
      r.mark(times.pauseEnd);
      await changeStatus(resolveCtx(), ticket.id, { statusId: refs.option('ticket_status', 'in_progress'), comment: vendor ? 'Vendor update received; resuming work.' : 'Thanks for the confirmation; resuming work.' });
    }
  }
  // Escalation on breached resolution clocks for P1/P2.
  const resRow = rows.find((x) => x.metric === 'resolution');
  if (resRow && assignee && ['p1', 'p2'].includes(plan.priorityKey)) {
    const rewritten = rewriteSla(resRow, times.tl, now);
    if (rewritten.state === 'breached' && rewritten.breachedAt) {
      const at = addMinutes(rewritten.breachedAt, 3);
      r.mark(at);
      const current = await reloadTicket(tx, ticket.id);
      await applyEscalationRules(r.system(), current, { kind: 'breach', metric: 'resolution', pct: 100, slaId: resRow.id, dueAt: rewritten.dueAt });
      r.escalations.push(at);
      r.audit.push({ action: 'escalate.auto', at, userId: null, userName: 'System' });
    }
  }
  if (times.resolvedAt && assignee) {
    for (const task of r.tasks) {
      const at = addMinutes(times.resolvedAt, -10);
      r.mark(at);
      await updateTask(resolveCtx(), ticket.id, task.id, { status: 'done' });
      task.completedAt = at;
    }
    r.mark(times.resolvedAt);
    await resolveTicket(resolveCtx(), ticket.id, { resolutionCodeId: refs.option('resolution_code', t.resolutionCode), resolutionNotes: t.resolution(plan.vars), comment: plan.vars.rng.chance(0.5) ? `${plan.vars.user.split(' ')[0]}, this has been resolved - please let us know within 5 days if the issue persists, otherwise the ticket will close automatically.` : null });
    r.actorAudit(assignee, 'ticket.resolve', times.resolvedAt);
  }
  if (times.closedAt && assignee) {
    r.mark(times.closedAt);
    if (times.closedBySystem) await closeTicket(r.system(), ticket.id, { closureCodeId: refs.option('closure_code', 'resolved_auto') });
    else await closeTicket(resolveCtx(), ticket.id, { closureCodeId: refs.option('closure_code', 'resolved_confirmed'), comment: 'Closure confirmed with the requester.' });
    r.audit.push({ action: 'ticket.close', at: times.closedAt, userId: times.closedBySystem ? null : user(state, assignee).id, userName: times.closedBySystem ? 'System' : user(state, assignee).name });
  }
  if (times.reopenAt && assignee) {
    r.mark(times.reopenAt);
    const by: Actor = plan.creator.kind === 'portal' ? plan.creator : { kind: 'msp', key: assignee };
    await reopenTicket(r.ctx(by), ticket.id, { comment: 'The issue has reoccurred this morning - reopening.' });
    r.actorAudit(by, 'ticket.reopen', times.reopenAt);
    if (times.resolved2At) {
      r.mark(addMinutes(times.resolved2At, -30));
      await addComment(resolveCtx(), ticket.id, { kind: 'work_note', body: 'Reoccurrence traced to the same root cause; applied the permanent fix instead of the earlier workaround.' });
      r.mark(times.resolved2At);
      await resolveTicket(resolveCtx(), ticket.id, { resolutionCodeId: refs.option('resolution_code', 'fixed'), resolutionNotes: `Reoccurrence fixed permanently. ${t.resolution(plan.vars)}` });
      r.actorAudit(assignee, 'ticket.resolve', times.resolved2At);
      if (times.closed2At) {
        r.mark(times.closed2At);
        await closeTicket(r.system(), ticket.id, { closureCodeId: refs.option('closure_code', 'resolved_auto') });
      }
    }
  }
  return r.result(ticket, times.tl);
}

async function runRequest(state: DemoState, tx: Tx, plan: Plan): Promise<TicketRun> {
  const r = new Runner(state, tx, plan);
  const t = plan.request!;
  const { refs, now } = state;
  const rng = plan.vars.rng;
  const catalog = refs.catalogItem(t.catalogKey);
  const input = r.baseInput();
  input.description = t.description(plan.vars);
  input.catalogItemId = catalog.id;
  input.formData = t.formData(plan.vars);
  input.tags = [...t.tags];
  input.impactId = null;
  input.urgencyId = null;
  const ticket = await r.create(input);
  const rows = await r.slaRows(ticket.id);
  const T0 = plan.createdAt;
  const pauses: [Date, Date | null][] = [];
  let cancelledAt: Date | null = null;
  let decidedAt: Date | null = null;
  if (plan.approvalDecision) {
    const admin = plan.cust.portalUsers.find((p) => p.roleKey === 'customer_admin')!;
    if (plan.approvalDecision === 'pending') pauses.push([T0, null]);
    else {
      decidedAt = addMinutes(T0, rng.int(30, 2 * 24 * 60));
      if (decidedAt.getTime() > now.getTime() - 10 * MINUTE) decidedAt = new Date(now.getTime() - rng.int(10, 120) * MINUTE);
      pauses.push([T0, decidedAt]);
      const pending = await tx.select().from(schema.approvals).where(and(eq(schema.approvals.ticketId, ticket.id), eq(schema.approvals.status, 'pending')));
      r.mark(decidedAt);
      for (const a of pending) await decide(r.ctx({ kind: 'portal', userId: admin.id, name: admin.name }), ticket.id, a.id, plan.approvalDecision, plan.approvalDecision === 'approved' ? 'Approved.' : 'Not approved - please raise this through the department budget process first.');
      r.audit.push({ action: `approval.${plan.approvalDecision}`, at: decidedAt, userId: admin.id, userName: admin.name });
      if (plan.approvalDecision === 'rejected') cancelledAt = decidedAt;
    }
  }
  const tl: Timeline = { createdAt: T0, acknowledgedAt: null, firstResponseAt: null, pauses, firstResolvedAt: null, reopenedAt: null, resolvedAt: null, restoredAt: null, closedAt: null, cancelledAt, lastActivityAt: decidedAt ?? T0 };
  if (cancelledAt || plan.approvalDecision === 'pending' || !plan.assigneeKey) return r.result(ticket, tl);
  // Work the request
  const start = decidedAt ?? T0;
  const assignee = plan.assigneeKey;
  const tg = targetsOf(rows);
  const resp = tg.response ?? { minutes: 480, cal: CALENDAR_24X7 };
  const res = tg.resolution ?? { minutes: 2880, cal: CALENDAR_24X7 };
  let assignAt = work(start, rng.int(10, 120), resp.cal);
  if (assignAt.getTime() > now.getTime() - 5 * MINUTE) assignAt = new Date(now.getTime() - rng.int(5, 30) * MINUTE);
  r.mark(assignAt);
  await assignTicket(r.ctx(plan.managerKey), ticket.id, { teamId: refs.team(plan.teamKey), assigneeId: user(state, assignee).id, autoProgress: true });
  r.actorAudit(plan.managerKey, 'ticket.assign', assignAt);
  tl.acknowledgedAt = assignAt;
  let firstResponseAt: Date | null = work(start, resp.minutes * (plan.responseMet ? rng.float(0.1, 0.8) : rng.float(1.1, 2)), resp.cal);
  if (firstResponseAt.getTime() < assignAt.getTime()) firstResponseAt = addMinutes(assignAt, rng.int(2, 20));
  if (firstResponseAt.getTime() > now.getTime() - 2 * MINUTE) firstResponseAt = null;
  if (firstResponseAt) {
    r.mark(firstResponseAt);
    await addComment(r.ctx(assignee), ticket.id, { kind: 'comment', body: t.firstResponse(plan.vars) });
    tl.firstResponseAt = firstResponseAt;
  }
  let resolvedAt: Date | null = null;
  if (plan.outcome === 'resolved') {
    resolvedAt = work(start, res.minutes * (plan.resolutionMet ? rng.float(0.1, 0.8) : rng.float(1.1, 1.8)), res.cal);
    const floor = (firstResponseAt ?? assignAt).getTime() + 10 * MINUTE;
    if (resolvedAt.getTime() < floor) resolvedAt = new Date(floor + rng.int(5, 240) * MINUTE);
    if (resolvedAt.getTime() > now.getTime() - 15 * MINUTE) resolvedAt = null;
  }
  const noteEnd = resolvedAt ?? now;
  const noteTimes: Date[] = [];
  const from = firstResponseAt ?? assignAt;
  if (noteEnd.getTime() - from.getTime() > 20 * MINUTE) for (let i = 0; i < plan.workNotes; i++) noteTimes.push(new Date(from.getTime() + (noteEnd.getTime() - from.getTime()) * rng.float(0.2, 0.85)));
  noteTimes.sort((a, b) => a.getTime() - b.getTime());
  await r.workNotesAndTime(ticket.id, assignee, noteTimes, t.workNotes);
  if (plan.outcome === 'pending_customer' && !resolvedAt) {
    const at = new Date(Math.max(from.getTime() + 5 * MINUTE, now.getTime() - rng.int(30, 600) * MINUTE));
    r.mark(at);
    await changeStatus(r.ctx(assignee), ticket.id, { statusId: refs.option('ticket_status', 'pending_customer'), comment: 'Could you confirm the details requested above so we can proceed?' });
    tl.pauses.push([at, null]);
  }
  if (resolvedAt) {
    r.mark(resolvedAt);
    await resolveTicket(r.ctx(assignee), ticket.id, { resolutionCodeId: refs.option('resolution_code', 'fixed'), resolutionNotes: t.resolution(plan.vars), comment: 'Your request has been fulfilled. Please reach out if anything else is needed.' });
    r.actorAudit(assignee, 'ticket.resolve', resolvedAt);
    tl.resolvedAt = resolvedAt;
    const closeAt = addDays(resolvedAt, 5);
    if (closeAt.getTime() < now.getTime()) {
      r.mark(closeAt);
      await closeTicket(r.system(), ticket.id, { closureCodeId: refs.option('closure_code', 'resolved_auto') });
      tl.closedAt = closeAt;
    }
  }
  tl.lastActivityAt = new Date(Math.max(...[T0, decidedAt, assignAt, firstResponseAt, resolvedAt, tl.closedAt, ...noteTimes, ...tl.pauses.map((p) => p[0])].filter((d): d is Date => !!d).map((d) => d.getTime())));
  return r.result(ticket, tl);
}

async function runProblem(state: DemoState, tx: Tx, plan: Plan): Promise<TicketRun> {
  const r = new Runner(state, tx, plan);
  const t = plan.problem!;
  const { refs, now } = state;
  const rng = plan.vars.rng;
  const input = r.baseInput();
  input.description = t.description(plan.vars);
  input.tags = [...t.tags];
  input.priorityId = refs.option('ticket_priority', 'p3');
  input.problem = { symptoms: t.symptoms(plan.vars), impactSummary: t.impactSummary(plan.vars) };
  input.watcherIds = [user(state, 'rajesh').id];
  const ticket = await r.create(input);
  const T0 = plan.createdAt;
  const assignee = plan.assigneeKey!;
  const stage = plan.problemStage!;
  const investigatingAt = addMinutes(T0, rng.int(60, 8 * 60));
  const times: Date[] = [investigatingAt];
  r.mark(investigatingAt);
  await changeStatus(r.ctx(assignee), ticket.id, { statusId: refs.option('ticket_status', 'under_investigation') });
  r.mark(addMinutes(investigatingAt, 5));
  await addComment(r.ctx(assignee), ticket.id, { kind: 'comment', body: `Problem record opened to investigate the recurring incidents on ${plan.vars.host}. Investigation plan: correlate incident timelines, review logs and vendor advisories, and identify a workaround while the root cause is confirmed.` });
  const tl: Timeline = { createdAt: T0, acknowledgedAt: T0, firstResponseAt: addMinutes(investigatingAt, 5), pauses: [], firstResolvedAt: null, reopenedAt: null, resolvedAt: null, restoredAt: null, closedAt: null, cancelledAt: null, lastActivityAt: investigatingAt };
  const order: Plan['problemStage'][] = ['investigating', 'rca', 'known_error', 'resolved'];
  const reach = order.indexOf(stage);
  let cursor = investigatingAt;
  const step = (min: number, max: number) => {
    const next = addMinutes(cursor, rng.int(min, max));
    return next.getTime() < now.getTime() - 30 * MINUTE ? next : null;
  };
  if (reach >= 1) {
    const at = step(2 * 24 * 60, 10 * 24 * 60);
    if (at) {
      cursor = at;
      times.push(at);
      r.mark(at);
      await updateProblemDetails(r.ctx(assignee), ticket.id, { investigation: t.investigation(plan.vars), rootCause: t.rootCause(plan.vars) });
      r.mark(addMinutes(at, 2));
      await changeStatus(r.ctx(assignee), ticket.id, { statusId: refs.option('ticket_status', 'root_cause_identified') });
      await r.workNotesAndTime(ticket.id, assignee, [addMinutes(at, 10)], [() => `Root cause analysis documented. ${t.rootCause(plan.vars)}`]);
    }
  }
  if (reach >= 2) {
    const at = step(24 * 60, 3 * 24 * 60);
    if (at) {
      cursor = at;
      times.push(at);
      r.mark(at);
      await updateProblemDetails(r.ctx(assignee), ticket.id, { isKnownError: true, workaround: t.workaround(plan.vars), permanentFix: t.permanentFix(plan.vars) });
      r.actorAudit(assignee, 'problem.known_error', at);
    }
  }
  if (reach >= 3) {
    const at = step(5 * 24 * 60, 20 * 24 * 60);
    if (at) {
      cursor = at;
      times.push(at);
      r.mark(at);
      await resolveTicket(r.ctx(assignee), ticket.id, { resolutionCodeId: refs.option('resolution_code', 'fixed'), resolutionNotes: t.resolution(plan.vars) });
      r.actorAudit(assignee, 'ticket.resolve', at);
      tl.resolvedAt = at;
      const closeAt = addDays(at, 5);
      if (closeAt.getTime() < now.getTime()) {
        r.mark(closeAt);
        await closeTicket(r.ctx('rajesh'), ticket.id, { closureCodeId: refs.option('closure_code', 'resolved_confirmed'), comment: 'Problem review completed; closing.' });
        tl.closedAt = closeAt;
        times.push(closeAt);
      }
    }
  }
  tl.lastActivityAt = new Date(Math.max(...times.map((d) => d.getTime())));
  return r.result(ticket, tl);
}

async function runChange(state: DemoState, tx: Tx, plan: Plan): Promise<TicketRun> {
  const r = new Runner(state, tx, plan);
  const t = plan.change!;
  const { refs, now } = state;
  const rng = plan.vars.rng;
  const T0 = plan.createdAt;
  const stage = plan.changeStage!;
  const future = ['draft', 'awaiting', 'scheduled'].includes(stage);
  const scheduledStart = future ? atIst(addDays(now, rng.int(2, 12)), 22, 0) : atIst(addDays(T0, rng.int(2, 9)), t.changeType === 'emergency' ? 20 : 22, 0);
  const duration = t.downtimeMinutes ? t.downtimeMinutes + rng.int(30, 120) : rng.int(60, 240);
  const scheduledEnd = addMinutes(scheduledStart, duration + 60);
  const input = r.baseInput();
  input.description = t.description(plan.vars);
  input.tags = [...t.tags];
  input.priorityId = refs.option('ticket_priority', plan.priorityKey);
  input.impactId = null;
  input.urgencyId = null;
  input.change = { changeType: t.changeType, riskId: refs.option('change_risk', t.riskKey), riskAssessment: t.riskAssessment(plan.vars), impactAssessment: t.impactAssessment(plan.vars), justification: t.justification(plan.vars), implementationPlan: t.implementationPlan(plan.vars), testPlan: t.testPlan(plan.vars), backoutPlan: t.backoutPlan(plan.vars), communicationPlan: t.communicationPlan(plan.vars), scheduledStart, scheduledEnd, downtimeExpectedMinutes: t.downtimeMinutes, cabNotes: t.changeType === 'standard' ? 'Pre-approved standard change (patch policy).' : null };
  input.watcherIds = [user(state, 'ananya').id];
  const ticket = await r.create(input);
  const assignee = plan.assigneeKey!;
  const tl: Timeline = { createdAt: T0, acknowledgedAt: T0, firstResponseAt: null, pauses: [], firstResolvedAt: null, reopenedAt: null, resolvedAt: null, restoredAt: null, closedAt: null, cancelledAt: null, lastActivityAt: T0 };
  const times: Date[] = [T0];
  if (stage === 'draft') return r.result(ticket, tl);
  const reqAt = addMinutes(T0, rng.int(10, 240));
  times.push(reqAt);
  r.mark(reqAt);
  await requestApproval(r.ctx('rajesh'), ticket.id);
  r.approvalsRequestedAt = reqAt;
  r.actorAudit('rajesh', 'approval.request', reqAt);
  if (stage === 'awaiting') {
    tl.pauses.push([reqAt, null]);
    tl.lastActivityAt = reqAt;
    return r.result(ticket, tl);
  }
  const pending = await tx.select().from(schema.approvals).where(and(eq(schema.approvals.ticketId, ticket.id), eq(schema.approvals.status, 'pending'))).orderBy(schema.approvals.step);
  let decidedAt = reqAt;
  for (const [i, a] of pending.entries()) {
    decidedAt = addMinutes(decidedAt, rng.int(30, 12 * 60));
    if (decidedAt.getTime() > scheduledStart.getTime() - HOUR) decidedAt = addMinutes(scheduledStart, -rng.int(60, 180));
    const approver = a.approverRoleKey === 'service_manager' ? 'ananya' : 'rajesh';
    const decision = stage === 'rejected' && i === pending.length - 1 ? 'rejected' : 'approved';
    times.push(decidedAt);
    r.mark(decidedAt);
    await decide(r.ctx(approver), ticket.id, a.id, decision, decision === 'approved' ? (t.changeType === 'emergency' ? 'Approved under the emergency change procedure.' : 'CAB approved for the proposed window.') : 'Rejected: insufficient test evidence; please resubmit with the DR validation results.');
    r.actorAudit(approver, `approval.${decision}`, decidedAt);
    if (decision === 'rejected') {
      tl.cancelledAt = decidedAt;
      tl.pauses.push([reqAt, decidedAt]);
      tl.lastActivityAt = decidedAt;
      return r.result(ticket, tl);
    }
  }
  tl.pauses.push([reqAt, decidedAt]);
  const schedAt = addMinutes(decidedAt, rng.int(15, 240));
  times.push(schedAt);
  r.mark(schedAt);
  await changeStatus(r.ctx(assignee), ticket.id, { statusId: refs.option('ticket_status', 'scheduled'), comment: `Scheduled for ${scheduledStart.toISOString().slice(0, 16).replace('T', ' ')} UTC (window ${duration + 60} minutes).` });
  if (stage === 'scheduled') {
    tl.lastActivityAt = schedAt;
    return r.result(ticket, tl);
  }
  const implAt = scheduledStart.getTime() < now.getTime() ? scheduledStart : new Date(now.getTime() - rng.int(20, 90) * MINUTE);
  times.push(implAt);
  r.mark(implAt);
  await changeStatus(r.ctx(assignee), ticket.id, { statusId: refs.option('ticket_status', 'implementing') });
  r.mark(addMinutes(implAt, 1));
  await updateChangeDetails(r.ctx('rajesh'), ticket.id, { actualStart: implAt });
  if (stage === 'implementing') {
    tl.lastActivityAt = implAt;
    return r.result(ticket, tl);
  }
  const endAt = addMinutes(implAt, duration);
  await r.workNotesAndTime(ticket.id, assignee, [addMinutes(implAt, Math.round(duration / 2))], [() => 'Implementation in progress per plan; pre-checks complete, backup taken.'], t.categoryKey === 'hardware');
  times.push(endAt);
  r.mark(endAt);
  if (stage === 'failed') {
    await changeStatus(r.ctx(assignee), ticket.id, { statusId: refs.option('ticket_status', 'failed'), resolutionNotes: 'Post-implementation validation failed; backout plan executed and service restored to the previous state. Re-planning with the vendor.', comment: 'Change backed out; service verified on the previous configuration.' });
    r.mark(addMinutes(endAt, 2));
    await updateChangeDetails(r.ctx('rajesh'), ticket.id, { actualEnd: endAt, implementationNotes: 'Validation failed (see notes); backout executed successfully.', pirNotes: 'Backout successful. Root cause of the failure: vendor firmware incompatibility not listed in the release notes.', pirOutcome: 'backed_out' });
  } else {
    await resolveTicket(r.ctx(assignee), ticket.id, { resolutionCodeId: refs.option('resolution_code', 'config_change'), resolutionNotes: t.implementationNotes(plan.vars) });
    r.mark(addMinutes(endAt, 2));
    await updateChangeDetails(r.ctx('rajesh'), ticket.id, { actualEnd: endAt, implementationNotes: t.implementationNotes(plan.vars) });
    const pirAt = addDays(endAt, 2);
    if (pirAt.getTime() < now.getTime()) {
      r.mark(pirAt);
      await updateChangeDetails(r.ctx('rajesh'), ticket.id, { pirNotes: t.pirNotes(plan.vars), pirOutcome: 'successful' });
      times.push(pirAt);
    }
  }
  r.actorAudit(assignee, stage === 'failed' ? 'ticket.status' : 'ticket.resolve', endAt);
  tl.resolvedAt = endAt;
  const closeAt = addDays(endAt, 3);
  if (closeAt.getTime() < now.getTime()) {
    r.mark(closeAt);
    await closeTicket(r.ctx('rajesh'), ticket.id, { closureCodeId: refs.option('closure_code', 'resolved_confirmed') });
    tl.closedAt = closeAt;
    times.push(closeAt);
  }
  tl.lastActivityAt = new Date(Math.max(...times.map((d) => d.getTime())));
  return r.result(ticket, tl);
}

async function runPlan(state: DemoState, tx: Tx, plan: Plan): Promise<TicketRun> {
  switch (plan.type) {
    case 'incident':
      return runIncident(state, tx, plan);
    case 'request':
      return runRequest(state, tx, plan);
    case 'problem':
      return runProblem(state, tx, plan);
    default:
      return runChange(state, tx, plan);
  }
}

// ---------------------------------------------------------------- links (problems, changes, duplicates)

async function linkTickets(state: DemoState, tx: Tx, plans: Plan[]) {
  const { refs, rng, now } = state;
  const reg = state.tickets;
  const rajesh = user(state, 'rajesh');
  let links = 0;
  const addLink = async (sourceKey: string, targetKey: string, linkType: string) => {
    const s = reg.get(sourceKey);
    const t = reg.get(targetKey);
    if (!s || !t || s.customerKey !== t.customerKey) return;
    const at = new Date(Math.min(now.getTime() - MINUTE, Math.max(s.createdAt.getTime(), t.createdAt.getTime()) + 10 * MINUTE));
    const [row] = await tx.insert(schema.ticketLinks).values({ sourceTicketId: s.id, targetTicketId: t.id, customerId: state.customers.find((c) => c.key === s.customerKey)!.id, linkType, createdBy: rajesh.id, createdAt: at }).onConflictDoNothing().returning();
    if (!row) return;
    const customerId = row.customerId;
    await tx.insert(schema.ticketActivities).values([
      { ticketId: s.id, customerId, actorId: rajesh.id, actorName: rajesh.name, activityType: 'link', summary: `Linked to ${t.number} (${linkType.replace(/_/g, ' ')})`, data: { linkId: row.id, targetTicketId: t.id, targetNumber: t.number, linkType }, customerVisible: false, createdAt: at },
      { ticketId: t.id, customerId, actorId: rajesh.id, actorName: rajesh.name, activityType: 'link', summary: `Linked from ${s.number} (${linkType.replace(/_/g, ' ')})`, data: { linkId: row.id, sourceTicketId: s.id, sourceNumber: s.number, linkType }, customerVisible: false, createdAt: at },
    ]);
    links++;
  };
  const incidentsOf = (custKey: string) => plans.filter((p) => p.type === 'incident' && p.cust.key === custKey && reg.has(p.key));
  for (const prb of plans.filter((p) => p.type === 'problem')) {
    const related = incidentsOf(prb.cust.key).filter((p) => prb.problem!.relatedIncidentKeys.includes(p.incident!.key) && Math.abs(p.createdAt.getTime() - prb.createdAt.getTime()) < 45 * DAY);
    const fallback = incidentsOf(prb.cust.key).filter((p) => p.categoryKey === prb.categoryKey);
    const pool = related.length ? related : fallback;
    for (const inc of rng.sample(pool, Math.min(3, pool.length))) await addLink(inc.key, prb.key, 'problem_of');
    // the problem's related incidents become children for navigation
    await tx.update(schema.tickets).set({ parentTicketId: reg.get(prb.key)!.id }).where(and(inArray(schema.tickets.id, rng.sample(pool, Math.min(2, pool.length)).map((p) => reg.get(p.key)!.id)), eq(schema.tickets.customerId, prb.cust.id)));
  }
  for (const chg of plans.filter((p) => p.type === 'change' && p.change!.relatedIncidentKeys?.length)) {
    const pool = incidentsOf(chg.cust.key).filter((p) => chg.change!.relatedIncidentKeys!.includes(p.incident!.key) && p.createdAt.getTime() < chg.createdAt.getTime());
    if (pool.length) await addLink(chg.key, rng.pick(pool).key, 'change_for');
    const prb = plans.find((p) => p.type === 'problem' && p.cust.key === chg.cust.key && reg.has(p.key));
    if (prb && rng.chance(0.5)) await addLink(chg.key, prb.key, 'related');
  }
  // Duplicates: same customer + template within 3 days; the later one points to the earlier one.
  let dup = 0;
  const groups = new Map<string, Plan[]>();
  for (const p of plans.filter((p) => p.type === 'incident' && reg.has(p.key))) groups.set(`${p.cust.key}:${p.incident!.key}`, [...(groups.get(`${p.cust.key}:${p.incident!.key}`) ?? []), p]);
  for (const list of groups.values()) {
    if (dup >= 7) break;
    const sorted = list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (let i = 1; i < sorted.length && dup < 7; i++) {
      const a = sorted[i - 1]!;
      const b = sorted[i]!;
      if (b.createdAt.getTime() - a.createdAt.getTime() > 3 * DAY || !reg.get(b.key)!.resolvedAt) continue;
      await addLink(b.key, a.key, 'duplicate_of');
      await tx.update(schema.tickets).set({ resolutionCodeId: refs.option('resolution_code', 'duplicate'), resolutionNotes: `Duplicate of ${reg.get(a.key)!.number}; tracked there.` }).where(eq(schema.tickets.id, reg.get(b.key)!.id));
      dup++;
      break;
    }
  }
  // Related: incidents sharing a primary CI.
  const byCi = new Map<string, Plan[]>();
  for (const p of plans.filter((p) => p.type === 'incident' && p.ci && reg.has(p.key))) byCi.set(p.ci!.id, [...(byCi.get(p.ci!.id) ?? []), p]);
  let related = 0;
  for (const list of byCi.values()) {
    if (related >= 6) break;
    if (list.length >= 2 && list[0]!.incident!.key !== list[1]!.incident!.key) {
      await addLink(list[1]!.key, list[0]!.key, 'related');
      related++;
    }
  }
  state.counts.ticketLinks = links;
}

export async function seedTickets(state: DemoState) {
  const plans = buildPlans(state);
  const chunkSize = 40;
  let done = 0;
  let slaRows = 0;
  const t0 = Date.now();
  for (let i = 0; i < plans.length; i += chunkSize) {
    const chunk = plans.slice(i, i + chunkSize);
    await withSystem(async (tx) => {
      const runs: TicketRun[] = [];
      for (const plan of chunk) {
        try {
          const run = await runPlan(state, tx, plan);
          runs.push(run);
          state.tickets.set(plan.key, { id: run.ticketId, number: run.number, customerKey: plan.cust.key, type: plan.type, createdAt: plan.createdAt, title: plan.title, categoryKey: plan.categoryKey ?? '', ciId: plan.ci?.id ?? null, siteKey: plan.site?.key ?? null, resolvedAt: run.tl.resolvedAt, open: !run.tl.resolvedAt && !run.tl.cancelledAt, priorityKey: plan.priorityKey, templateKey: plan.problem?.key });
        } catch (err) {
          logger.error({ err, plan: plan.key, title: plan.title, type: plan.type, customer: plan.cust.key }, 'demo ticket failed');
          throw err;
        }
      }
      const res = await backdateRuns(tx, runs, state.now);
      slaRows += res.slaRows;
    });
    done += chunk.length;
    logger.info({ tickets: done, of: plans.length, ms: Date.now() - t0 }, 'demo tickets progress');
  }
  await withSystem((tx) => linkTickets(state, tx, plans));
  state.counts.tickets = done;
  state.counts.ticketSlas = slaRows;
}
