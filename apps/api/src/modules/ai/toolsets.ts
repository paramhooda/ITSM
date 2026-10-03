import { matchRoute } from '@itsm/shared';
import type { SkillKey } from './schemas';
import { TOOLSET_KEYS, type ToolsetKey, type Who } from './tools/types';
import { availableToolsets } from './tools';

/**
 * Toolsets keep each model call small: the core and UI sets are always on; the
 * others are enabled by the page the user is on, a deterministic keyword
 * router over the message, the active skill, the sets the conversation already
 * used (sticky), or the model calling `enable_toolset`. At most
 * `MAX_EXTRA_SETS` beyond the base sets.
 */
export interface Toolset {
  key: ToolsetKey;
  label: string;
  /** One line for the capabilities section and for `enable_toolset`. */
  description: string;
  keywords: RegExp[];
  /** Offered to customer (portal) users. */
  portal: boolean;
}

export const TOOLSETS: Record<ToolsetKey, Toolset> = {
  core: { key: 'core', label: 'Core', description: 'search, the ticket query layer, one ticket, knowledge search, my workload, the application guide', keywords: [], portal: true },
  ui: { key: 'ui', label: 'Navigation', description: 'open pages and records, prefill the new-ticket form', keywords: [], portal: true },
  tickets: { key: 'tickets', label: 'Tickets', description: 'ticket detail (timeline, tasks, time, approvals, escalations, scope, similar, summary material), the request catalog, and every ticket action: create, update, comment, work note, assign, status, resolve, close, reopen, cancel, escalate, scope, links, tasks, time, watch, CIs, bulk', keywords: [/\b(tickets?|incidents?|requests?|problems?|changes?|assign|resolve|close|reopen|escalat|comment|reply|work[ -]?note|tasks?|log time|time entr|watch|link|bulk|cancel|scope|timeline|calendar|blackout|freeze|change window)\b/i], portal: true },
  triage: { key: 'triage', label: 'Triage', description: 'triage signals (classification, owner, duplicates, knowledge), resolution material, update drafts, apply a triage decision', keywords: [/\b(triage|classif|categor|priorit|duplicate|recommend|summar|draft|resolution ideas|how (do|would) i fix|similar)\b/i], portal: false },
  incident: { key: 'incident', label: 'Major incidents & on-call', description: 'major incidents: list, detail, declare, demote, update, stakeholder updates, bridge notes, child incidents; who is on call for a team and paging through an escalation policy; announcements and status banners for customers and staff', keywords: [/\b(major|bridge|commander|stakeholder|outage|war ?room|\bmi\b|p1\b|on[ -]?call|page|paging|rota|escalation polic|wake|announce|banner|status page|maintenance notice)/i], portal: false },
  approvals: { key: 'approvals', label: 'Approvals', description: 'approvals waiting for the user, start a workflow, approve or reject', keywords: [/\b(approv|reject|cab\b|sign[ -]?off)/i], portal: true },
  customers: { key: 'customers', label: 'Customers', description: 'customer list, customer overview, sites and contacts', keywords: [/\b(customers?|accounts?|sites?|contacts?|organisations?|organizations?|account manager)\b/i], portal: false },
  contracts: { key: 'contracts', label: 'Contracts & service levels', description: 'contracts, entitlements and consumption, scope, services, SLA policies and compliance', keywords: [/\b(contracts?|entitlements?|sla|service levels?|scope|amc|coverage|compliance|consum|expir|renew)/i], portal: true },
  cmdb: { key: 'cmdb', label: 'CMDB', description: 'configuration items, history, impact, business services and the service map, discovery findings, monitoring/SIEM events, CI changes and relationships', keywords: [/\b(\bci\b|cis\b|configuration items?|cmdb|servers?|switch(es)?|routers?|firewalls?|hosts?|impact|depend|discover|monitoring|events?|alerts?|integration|siem)\b/i], portal: true },
  assets: { key: 'assets', label: 'Assets', description: 'asset inventory, one asset, coverage figures, lifecycle changes', keywords: [/\b(assets?|warrant|serial|lifecycle|inventory|eol|end of life|laptops?|printers?)\b/i], portal: true },
  field: { key: 'field', label: 'Field service & maintenance', description: 'field visits, engineer workload, preventive maintenance programs and occurrences, visit scheduling, notes and acknowledgement', keywords: [/\b(visits?|field|maintenance|\bpm\b|preventive|site visit|schedul|engineer calendar|dispatch)/i], portal: true },
  knowledge: { key: 'knowledge', label: 'Knowledge', description: 'read articles, draft and publish, rate an article', keywords: [/\b(articles?|knowledge|\bkb\b|runbooks?|sop|known errors?|documentation|how[ -]to)\b/i], portal: true },
  reports: { key: 'reports', label: 'Reports & analysis', description: 'the report catalogue, run and export reports, dashboards, trends, scheduled deliveries', keywords: [/\b(reports?|dashboards?|kpis?|trends?|export|csv|metrics?|statistics?|charts?|how many|breakdown|analy)/i], portal: true },
  config: { key: 'config', label: 'Configuration (read)', description: 'option lists, teams, priority matrix, rules and workflows, the settings that are not protected', keywords: [/\b(options?|teams?|services?|catalog(ue)?|priority matrix|rules?|workflows?|templates?|settings?|configur)/i], portal: true },
  admin: { key: 'admin', label: 'Administration (change)', description: 'change settings, option lists, rules, workflows, templates, calendars and SLA policy attributes (always confirmed)', keywords: [/\b(settings?|configur|turn (on|off)|enable|disable|add (a|an|the) (option|rule|category|status)|rename|deactivate)\b/i], portal: false },
  iam: { key: 'iam', label: 'Users & audit (read)', description: 'users, roles, API keys, audit log search, notification delivery status', keywords: [/\b(users?|roles?|permissions?|api keys?|audit|who (did|changed)|login|outbox|deliver)/i], portal: false },
};

export const BASE_SETS: ToolsetKey[] = ['core', 'ui'];
export const MAX_EXTRA_SETS = 4;

/** The toolsets each skill works with (its playbook names their tools). */
export const SKILL_TOOLSETS: Record<SkillKey, ToolsetKey[]> = {
  lookup: ['tickets', 'customers', 'contracts'],
  triage: ['tickets', 'triage'],
  act: ['tickets'],
  incident: ['incident', 'tickets'],
  approvals: ['approvals'],
  knowledge: ['knowledge'],
  analyse: ['reports', 'contracts'],
  navigate: [],
  admin: ['config', 'admin', 'iam'],
  selfservice: ['tickets', 'approvals', 'knowledge', 'contracts', 'field'],
};

export interface ToolsetState {
  /** Enabled this turn, base sets first. */
  active: ToolsetKey[];
  /** Everything the principal could enable (at least one tool available). */
  offered: ToolsetKey[];
  /** Why each extra set is on (skill, page, message, sticky, enabled). */
  reasons: Partial<Record<ToolsetKey, string>>;
}

const isKey = (k: unknown): k is ToolsetKey => typeof k === 'string' && (TOOLSET_KEYS as readonly string[]).includes(k);

/** Toolsets a conversation already used, read back from its stored context. */
export const stickyOf = (context: Record<string, unknown> | null | undefined): ToolsetKey[] => {
  const v = (context ?? {}).toolsets;
  return Array.isArray(v) ? v.filter(isKey) : [];
};

export function keywordToolsets(message: string): ToolsetKey[] {
  const text = message.slice(0, 2000);
  return TOOLSET_KEYS.filter((k) => !BASE_SETS.includes(k) && TOOLSETS[k].keywords.some((re) => re.test(text)));
}

export function pageToolsets(pathname: string | null | undefined): ToolsetKey[] {
  if (!pathname) return [];
  const hit = matchRoute(pathname.split('?')[0]!);
  return (hit?.page.toolsets ?? []).filter(isKey);
}

function cap(state: ToolsetState): ToolsetState {
  const extras = state.active.filter((k) => !BASE_SETS.includes(k)).slice(0, MAX_EXTRA_SETS);
  const active = [...BASE_SETS.filter((k) => state.offered.includes(k)), ...extras];
  const reasons: ToolsetState['reasons'] = {};
  for (const k of extras) reasons[k] = state.reasons[k] ?? 'enabled';
  return { active, offered: state.offered, reasons };
}

/** Base sets, then the skill's, the page's, the message's and the conversation's sets, in that priority, capped. */
export function resolveToolsets(args: { who: Who; message: string; page?: string | null; sticky?: ToolsetKey[] | null; skill?: SkillKey | null }): ToolsetState {
  const offered = availableToolsets(args.who);
  const active: ToolsetKey[] = [];
  const reasons: ToolsetState['reasons'] = {};
  const add = (keys: ToolsetKey[], reason: string) => {
    for (const k of keys) {
      if (!offered.includes(k) || active.includes(k) || BASE_SETS.includes(k)) continue;
      active.push(k);
      reasons[k] = reason;
    }
  };
  if (args.skill) add(SKILL_TOOLSETS[args.skill] ?? [], `skill ${args.skill}`);
  add(pageToolsets(args.page), 'current page');
  add(keywordToolsets(args.message), 'message');
  add(args.sticky ?? [], 'earlier in this conversation');
  return cap({ active: [...BASE_SETS, ...active], offered, reasons });
}

/** The model asked for another set: it goes first among the extras so the cap never drops it. */
export function enableToolset(state: ToolsetState, key: ToolsetKey): ToolsetState {
  if (!state.offered.includes(key)) return state;
  const extras = [key, ...state.active.filter((k) => !BASE_SETS.includes(k) && k !== key)];
  return cap({ active: [...BASE_SETS, ...extras], offered: state.offered, reasons: { ...state.reasons, [key]: 'enabled by the assistant' } });
}

export const describeToolset = (k: ToolsetKey) => `${k} (${TOOLSETS[k].description})`;
