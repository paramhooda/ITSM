import type { TicketType } from './constants.js';
import { DOMAINS } from './constants.js';

/**
 * The one way a dashboard number becomes a link: every tile, chart segment,
 * breakdown row and panel "View all" builds its `/tickets?…` link through
 * `ticketListPath`, carrying the exact predicates its number was counted
 * with (customer scope, domain, type, SLA state, period as a created or
 * resolved range), so the list it opens shows the same number. The keys are
 * the ticket list page's own URL keys (`apps/web/src/components/tickets/listQuery.ts`
 * turns them into API parameters), never the legacy `open=true` / `mine=true`
 * aliases.
 */
export type TicketLinkDomain = 'soc' | 'amc' | 'noc' | 'not_soc';
export type TicketLinkStatus = 'open' | 'any' | 'resolved';
export type TicketLinkSla = 'breached' | 'at_risk' | 'ok';
export type TicketLinkAssignee = 'me' | 'unassigned' | 'watching' | (string & {});

export interface TicketListLink {
  customerId?: string | null;
  type?: TicketType | null;
  /** `not_soc` is every domain but security: what the NOC dashboard and staff without `soc:read` count. */
  domain?: TicketLinkDomain | null;
  /** `open` is the page default (new, open and pending); `any` lifts the status filter; `resolved` is the resolved category only. */
  status?: TicketLinkStatus | null;
  sla?: TicketLinkSla | TicketLinkSla[] | null;
  breachRisk?: 'high' | 'medium' | 'low' | null;
  /** `me`, `unassigned`, `watching` or a user id. */
  assignee?: TicketLinkAssignee | null;
  teamId?: string | string[] | null;
  priorityIds?: string[] | null;
  severityIds?: string[] | null;
  statusIds?: string[] | null;
  categoryId?: string | null;
  serviceId?: string | null;
  csat?: 'rated' | 'low' | 'pending' | 'unrated' | null;
  knownError?: boolean | null;
  isMajor?: boolean | null;
  /** Period bounds as YYYY-MM-DD days (inclusive) or timestamps. */
  createdFrom?: string | null;
  createdTo?: string | null;
  resolvedFrom?: string | null;
  resolvedTo?: string | null;
}

/** The ticket list page's default status filter (the "All open" root of its breadcrumb). */
export const TICKET_LIST_OPEN_CATEGORIES = 'new,open,pending';

const NOT_SOC = DOMAINS.filter((d) => d !== 'soc').join(',');
const list = (v: string | string[] | null | undefined): string | undefined => (Array.isArray(v) ? (v.length ? v.join(',') : undefined) : v || undefined);

/** The query string (no leading `?`) for a ticket list link; empty for the default list. Keys come out in a fixed order so two equal links are the same string. */
export function ticketListQuery(link: TicketListLink): string {
  const p = new URLSearchParams();
  const put = (k: string, v: string | undefined | null) => {
    if (v) p.set(k, v);
  };
  put('customerId', link.customerId);
  put('type', link.type);
  if (link.domain) put('domain', link.domain === 'not_soc' ? NOT_SOC : link.domain);
  if (link.status === 'any') put('statusCategory', 'any');
  else if (link.status === 'resolved') put('statusCategory', 'resolved');
  // `open` (and unset) is the page default: nothing to carry.
  put('statusId', list(link.statusIds));
  put('slaState', list(link.sla));
  put('breachRisk', link.breachRisk);
  put('assignee', link.assignee);
  put('teamId', list(link.teamId));
  put('priorityId', list(link.priorityIds));
  put('securitySeverityId', list(link.severityIds));
  put('categoryId', link.categoryId);
  put('serviceId', link.serviceId);
  put('csat', link.csat);
  if (link.knownError) put('knownError', 'true');
  if (link.isMajor) put('isMajor', 'true');
  put('createdFrom', link.createdFrom);
  put('createdTo', link.createdTo);
  put('resolvedFrom', link.resolvedFrom);
  put('resolvedTo', link.resolvedTo);
  return p.toString();
}

/** `/tickets?…` for a link (just `/tickets` for the default list). */
export function ticketListPath(link: TicketListLink): string {
  const q = ticketListQuery(link);
  return q ? `/tickets?${q}` : '/tickets';
}
