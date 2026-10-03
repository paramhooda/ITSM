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
export const APPROVAL_STATUS_COLORS: Record<string, string> = { pending: 'amber', waiting: 'slate', approved: 'green', rejected: 'red', skipped: 'gray', superseded: 'gray' };

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

/** Identity colours for service domains / team types (categorical, not status). */
export const DOMAIN_COLORS: Record<string, string> = { noc: 'blue', soc: 'red', amc: 'amber', field: 'amber', service_desk: 'teal', infrastructure: 'indigo', network: 'sky', security: 'rose', cloud: 'violet', general: 'slate' };

/** Hex equivalents for charts (bars/dots), matching the badge tints. */
export const COLOR_HEX: Record<string, string> = {
  red: '#dc2626', orange: '#ea580c', amber: '#d97706', yellow: '#ca8a04', green: '#16a34a', emerald: '#16a34a', teal: '#0d9488', cyan: '#0891b2', sky: '#0284c7',
  blue: '#2563eb', indigo: '#4f46e5', violet: '#7c3aed', purple: '#9333ea', rose: '#e11d48', lime: '#65a30d', slate: '#a1a1aa', gray: '#a1a1aa',
};

export const statusColor = (map: Record<string, string>, key: string | null | undefined, fallback = 'slate') => (key ? map[key] ?? fallback : fallback);
export const hexFor = (color: string | null | undefined, fallback = '#2563eb') => COLOR_HEX[color ?? ''] ?? fallback;
