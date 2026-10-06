/**
 * Single source of truth for state → colour across the product.
 *
 * Values are option-palette names consumed by `Badge` (`colorClass`) and `dotClass`.
 * Rules: terminal/neutral states are zinc (slate/gray) with no emphasis; healthy is green;
 * attention is amber; breach/critical/expired is red; informational identity is blue.
 * Keep this restrained: a colour is a signal, not decoration.
 */

export const TICKET_CATEGORY_COLORS: Record<string, string> = { new: 'blue', open: 'indigo', pending: 'amber', resolved: 'green', closed: 'gray', cancelled: 'gray' };
export const TICKET_TYPE_COLORS: Record<string, string> = { incident: 'red', request: 'blue', problem: 'orange', change: 'purple' };
export const PRIORITY_LEVEL_COLORS: Record<number, string> = { 1: 'red', 2: 'orange', 3: 'amber', 4: 'blue', 5: 'slate' };
export const SCOPE_COLORS: Record<string, string> = { in_scope: 'green', out_of_scope: 'rose', unknown: 'slate' };
/** Breach forecast (scored by the risk job) and the customer's last mood (labelled after each customer comment). */
export const BREACH_RISK_COLORS: Record<string, string> = { high: 'red', medium: 'amber', low: 'green' };
export const SENTIMENT_COLORS: Record<string, string> = { angry: 'red', negative: 'amber', neutral: 'slate', positive: 'green' };
/** Business service health on the status page and the CMDB; announcement banners by type. */
export const SERVICE_HEALTH_COLORS: Record<string, string> = { good: 'green', degraded: 'amber', maintenance: 'blue', down: 'red' };
export const HANDOVER_STATUS_COLORS: Record<string, string> = { draft: 'slate', final: 'amber', acknowledged: 'green' };
export const ANNOUNCEMENT_TYPE_COLORS: Record<string, string> = { info: 'blue', maintenance: 'amber', outage: 'red' };
export const APPROVAL_STATUS_COLORS: Record<string, string> = { pending: 'amber', waiting: 'slate', approved: 'green', rejected: 'red', skipped: 'gray', superseded: 'gray', not_required: 'green' };
/** Change risk from the questionnaire (low/medium/high) and the CAB decision on an agenda item. */
export const CHANGE_RISK_COLORS: Record<string, string> = { low: 'green', medium: 'amber', high: 'red' };
/** CAB meetings (scheduled → closed) and the board's decision on an agenda item. */
export const CAB_STATUS_COLORS: Record<string, string> = { scheduled: 'blue', in_progress: 'amber', closed: 'green', cancelled: 'slate' };
export const CAB_DECISION_COLORS: Record<string, string> = { pending: 'slate', approved: 'green', rejected: 'red', deferred: 'amber' };
/** The customer-facing state of a planned change on the portal. */
export const PORTAL_CHANGE_STATE_COLORS: Record<string, string> = { planned: 'slate', approved: 'teal', in_progress: 'blue', implemented: 'green', cancelled: 'gray' };

export const VISIT_STATUS_COLORS: Record<string, string> = { requested: 'slate', scheduled: 'blue', in_progress: 'amber', completed: 'green', cancelled: 'gray' };
export const PM_STATUS_COLORS: Record<string, string> = { planned: 'slate', scheduled: 'blue', rescheduled: 'indigo', completed: 'green', missed: 'red', cancelled: 'gray' };

export const CI_STATUS_COLORS: Record<string, string> = { planned: 'blue', active: 'green', inactive: 'gray', maintenance: 'amber', retired: 'slate' };
export const CRITICALITY_COLORS: Record<string, string> = { critical: 'red', high: 'orange', medium: 'amber', low: 'slate' };
export const ENVIRONMENT_COLORS: Record<string, string> = { production: 'indigo', staging: 'sky', development: 'slate', test: 'slate', dr: 'violet' };

export const COVERAGE_COLORS: Record<string, string> = { none: 'slate', active: 'green', expiring: 'amber', expired: 'red' };
export const LIFECYCLE_COLORS: Record<string, string> = { ordered: 'blue', in_stock: 'sky', deployed: 'green', in_repair: 'amber', retired: 'slate', disposed: 'gray' };

export const CONTRACT_STATUS_COLORS: Record<string, string> = { draft: 'slate', active: 'green', expiring: 'amber', expired: 'red', renewed: 'blue', terminated: 'gray' };

export const SEVERITY_COLORS: Record<string, string> = { critical: 'red', high: 'orange', medium: 'amber', low: 'blue', info: 'slate' };
export const EVENT_STATUS_COLORS: Record<string, string> = { open: 'red', resolved: 'green', acknowledged: 'purple', info: 'slate' };
export const PROCESSING_COLORS: Record<string, string> = { received: 'blue', correlated: 'teal', ticket_created: 'green', deduplicated: 'purple', ignored: 'gray', error: 'red' };

export const KB_STATUS_COLORS: Record<string, string> = { draft: 'amber', review: 'blue', published: 'green', archived: 'slate' };
export const KB_VISIBILITY_COLORS: Record<string, string> = { internal: 'slate', customer: 'violet', public: 'green' };
/** Known-error lifecycle on problem records (open → fix in progress → resolved; retired leaves the portal). */
export const KNOWN_ERROR_STATUS_COLORS: Record<string, string> = { open: 'orange', fix_in_progress: 'blue', resolved: 'green', retired: 'slate' };

/** Customer satisfaction: the rating 1-5 and the survey lifecycle. */
export const CSAT_RATING_COLORS: Record<number, string> = { 1: 'red', 2: 'orange', 3: 'amber', 4: 'green', 5: 'emerald' };
export const SURVEY_STATUS_COLORS: Record<string, string> = { pending: 'amber', answered: 'green', expired: 'slate', cancelled: 'gray', none: 'gray' };

/** Ticket task lanes and the sticky-note palette on the task boards. */
export const TASK_STATUS_COLORS: Record<string, string> = { open: 'blue', in_progress: 'indigo', done: 'green', cancelled: 'gray' };
export const BOARD_NOTE_COLORS: Record<string, string> = { amber: 'amber', blue: 'blue', green: 'green', rose: 'rose', slate: 'slate' };

/** Licence compliance position per title and customer, and the live status of a licence term. */
export const COMPLIANCE_COLORS: Record<string, string> = { compliant: 'green', under_deployed: 'amber', over_deployed: 'red', unlicensed: 'red', unlimited: 'blue' };
export const LICENCE_STATUS_COLORS: Record<string, string> = { active: 'green', expiring: 'amber', expired: 'red', future: 'sky', renewed: 'blue', inactive: 'slate' };
export const INSTALL_SOURCE_COLORS: Record<string, string> = { manual: 'slate', csv: 'blue', discovery: 'indigo', agent: 'violet' };

/** Identity colours for service domains / team types (categorical, not status). */
export const DOMAIN_COLORS: Record<string, string> = { noc: 'blue', soc: 'red', amc: 'amber', field: 'amber', service_desk: 'teal', infrastructure: 'indigo', network: 'sky', security: 'rose', cloud: 'violet', general: 'slate' };

/** Who a custom report reaches: only its owner, the roles and teams it is shared with, or the customer portal too. */
export const REPORT_VISIBILITY_COLORS: Record<string, string> = { private: 'slate', shared: 'blue', portal: 'green' };

/** A person's mobile number for chatting with Grady on WhatsApp: linked (verified and the chat on), verified with the chat off, a code pending, or nothing yet. */
export const WHATSAPP_LINK_COLORS: Record<string, string> = { linked: 'green', verified: 'blue', pending: 'amber', none: 'slate' };
/** What became of a message sent to the business number (whatsapp_inbound.outcome). */
export const WHATSAPP_INBOUND_COLORS: Record<string, string> = { replied: 'green', linked: 'green', started: 'green', unverified: 'amber', chat_off: 'amber', stopped: 'amber', audience: 'amber', cap: 'amber', throttled: 'slate', feature_off: 'slate', unsupported: 'slate', inactive: 'slate', ignored: 'gray', failed: 'red' };

/** Hex equivalents for charts (bars/dots), matching the badge tints. */
export const COLOR_HEX: Record<string, string> = {
  red: '#dc2626', orange: '#ea580c', amber: '#d97706', yellow: '#ca8a04', green: '#16a34a', emerald: '#16a34a', teal: '#0d9488', cyan: '#0891b2', sky: '#0284c7',
  blue: '#2563eb', indigo: '#4f46e5', violet: '#7c3aed', purple: '#9333ea', rose: '#e11d48', lime: '#65a30d', slate: '#a1a1aa', gray: '#a1a1aa',
};

export const statusColor = (map: Record<string, string>, key: string | null | undefined, fallback = 'slate') => (key ? map[key] ?? fallback : fallback);
export const hexFor = (color: string | null | undefined, fallback = '#2563eb') => COLOR_HEX[color ?? ''] ?? fallback;
