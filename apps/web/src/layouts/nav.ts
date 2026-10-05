// Imported by apps/api/test/navigation.test.ts under the API tsconfig: no `@/` imports and no DOM types in this file.
import type { Permission, NavArea } from '@itsm/shared';
import { LayoutDashboard, Ticket, Building2, FileSignature, Boxes, Server, Wrench, CalendarCheck, BookOpen, BarChart3, Settings, Layers, ClipboardCheck, UsersRound, Siren, Activity, GitPullRequestArrow } from 'lucide-react';

/** A module inside an application (ServiceNow's navigator: Application → Modules). */
export interface NavChild {
  to: string;
  label: string;
  /** Any of these permissions unlocks the module (routes guard again). */
  perm?: Permission[];
  area?: NavArea;
}

export interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Any of these permissions unlocks the item (routes guard again). */
  perm?: Permission[];
  /** Navigation area; shown only when the user's roles include it (roles without areas show everything their permissions allow). */
  area?: NavArea;
  /** Section heading; consecutive items with the same section form one collapsible group. Items without a section sit above the first heading. */
  section?: string;
  /** Modules listed under the application when it is expanded (shown only when at least two are visible). */
  children?: NavChild[];
  /** Icon colour class: every application gets its own hue in the navigator. */
  tint?: string;
  /** Label of the phone bar (defaults to the first word of the label). */
  short?: string;
  /** Custom "this application is active" rule when its pages live under several prefixes. */
  match?: (pathname: string) => boolean;
}

/** The six sections of the staff navigator, in order; the labels are the headings people see. */
export const NAV_SECTIONS = { insight: 'Insight', desk: 'Service desk', operations: 'Service operations', accounts: 'Accounts', infrastructure: 'Infrastructure', system: 'System' } as const;
/** The three sections of the portal navigator; Overview sits above the first heading. */
export const PORTAL_SECTIONS = { support: 'Support', services: 'Your services', account: 'Account' } as const;
const S = NAV_SECTIONS;
const P = PORTAL_SECTIONS;
const startsWithAny = (p: string, ...prefixes: string[]) => prefixes.some((x) => p === x || p.startsWith(x + '/'));

/**
 * Staff navigator, in the order and with the labels of `APPLICATIONS` in the
 * application map (`apps/api/test/navigation.test.ts` keeps them in step).
 */
export const MSP_NAV: NavItem[] = [
  // ---- Insight
  {
    to: '/', label: 'Dashboards', short: 'Home', icon: LayoutDashboard, tint: 'text-brand-600', section: S.insight,
    children: [
      { to: '/?view=management', label: 'Management overview', perm: ['dashboards:management'] },
      { to: '/?view=noc', label: 'Network operations', perm: ['dashboards:noc'] },
      { to: '/?view=soc', label: 'Security operations', perm: ['dashboards:soc'] },
      { to: '/?view=amc', label: 'AMC & field service', perm: ['dashboards:amc'] },
      { to: '/?view=engineer', label: 'My work' },
    ],
  },
  {
    to: '/reports', label: 'Reports', icon: BarChart3, tint: 'text-teal-600', perm: ['reports:run'], area: 'reports', section: S.insight,
    children: [
      { to: '/reports', label: 'Catalogue' },
      // slot #1: { to: '/reports/builder', label: 'Report builder', perm: ['reports:build'] }
      { to: '/reports/csat', label: 'Customer satisfaction', perm: ['surveys:read'] },
    ],
  },
  // ---- Service desk
  {
    to: '/tickets', label: 'Tickets', icon: Ticket, tint: 'text-blue-600', perm: ['tickets:read'], area: 'tickets', section: S.desk,
    children: [
      { to: '/tickets', label: 'Open' },
      { to: '/tickets?assignee=me', label: 'Assigned to me' },
      { to: '/tickets?assignee=unassigned', label: 'Unassigned' },
      { to: '/tickets?type=incident', label: 'Incidents' },
      { to: '/tickets?type=request', label: 'Requests' },
      { to: '/tickets?type=problem', label: 'Problems' },
      { to: '/tickets?type=change', label: 'Changes' },
      { to: '/tickets/approvals', label: 'My approvals', perm: ['requests:approve', 'changes:approve'] },
      { to: '/tickets/boards', label: 'Task boards' },
      { to: '/tickets/new', label: 'Create new', perm: ['tickets:create'] },
    ],
  },
  {
    to: '/knowledge', label: 'Knowledge', icon: BookOpen, tint: 'text-fuchsia-600', perm: ['kb:read'], area: 'knowledge', section: S.desk,
    children: [
      { to: '/knowledge', label: 'Overview', perm: ['kb:read'] },
      { to: '/knowledge/articles', label: 'Articles' },
      { to: '/knowledge/known-errors', label: 'Known errors', perm: ['kedb:read'] },
      { to: '/knowledge/categories', label: 'Categories', perm: ['kb:manage'] },
    ],
  },
  // ---- Service operations
  {
    to: '/operations', label: 'Operations', icon: Siren, tint: 'text-red-600', perm: ['tickets:read'], area: 'operations', section: S.operations,
    match: (p) => p === '/operations' || startsWithAny(p, '/operations/major-incidents', '/operations/on-call', '/operations/announcements', '/operations/handover'),
    children: [
      { to: '/operations/major-incidents', label: 'Major incidents' },
      { to: '/operations/on-call', label: 'On-call', perm: ['oncall:read'] },
      { to: '/operations/announcements', label: 'Announcements', perm: ['announcements:manage'] },
      { to: '/operations/handover', label: 'Shift handover', perm: ['handover:write', 'oncall:manage'] },
    ],
  },
  {
    to: '/operations/change-calendar', label: 'Changes', icon: GitPullRequestArrow, tint: 'text-purple-600', perm: ['tickets:read'], area: 'operations', section: S.operations,
    match: (p) => startsWithAny(p, '/operations/change-calendar', '/operations/cab', '/operations/change-catalog'),
    children: [
      { to: '/tickets?type=change', label: 'All changes' },
      { to: '/operations/change-calendar', label: 'Change calendar' },
      { to: '/operations/cab', label: 'CAB', perm: ['changes:cab', 'changes:approve', 'changes:manage'] },
      { to: '/operations/change-catalog', label: 'Change catalog' },
    ],
  },
  {
    to: '/field', label: 'Field service', short: 'Field', icon: Wrench, tint: 'text-orange-600', perm: ['field:read', 'pm:read'], area: 'field', section: S.operations,
    match: (p) => startsWithAny(p, '/field', '/maintenance'),
    children: [
      { to: '/field', label: 'Overview', perm: ['field:read'] },
      { to: '/field/visits', label: 'Visits', perm: ['field:read'] },
      { to: '/field/calendar', label: 'Calendar', perm: ['field:read'] },
      { to: '/maintenance', label: 'Preventive maintenance', perm: ['pm:read'], area: 'maintenance' },
    ],
  },
  { to: '/teams', label: 'Teams', icon: UsersRound, tint: 'text-pink-600', perm: ['tickets:read', 'admin:users'], area: 'teams', section: S.operations },
  // ---- Accounts
  {
    to: '/customers', label: 'Customers', icon: Building2, tint: 'text-violet-600', perm: ['customers:read'], area: 'customers', section: S.accounts,
    children: [
      { to: '/customers', label: 'Overview' },
      { to: '/customers/accounts', label: 'Accounts' },
    ],
  },
  {
    to: '/contracts', label: 'Contracts & scope', short: 'Contracts', icon: FileSignature, tint: 'text-emerald-600', perm: ['contracts:read'], area: 'contracts', section: S.accounts,
    match: (p) => startsWithAny(p, '/contracts', '/sla'),
    children: [
      { to: '/contracts', label: 'Overview' },
      { to: '/contracts/list', label: 'Contracts' },
      { to: '/contracts/entitlements', label: 'Entitlements' },
      { to: '/sla', label: 'Service levels', perm: ['contracts:read', 'admin:config'] },
    ],
  },
  { to: '/services', label: 'Service catalog', short: 'Catalog', icon: Layers, tint: 'text-cyan-600', perm: ['services:read'], area: 'catalog', section: S.accounts },
  // ---- Infrastructure
  {
    to: '/cmdb', label: 'Configuration (CMDB)', short: 'CMDB', icon: Server, tint: 'text-indigo-600', perm: ['cmdb:read'], area: 'cmdb', section: S.infrastructure,
    match: (p) => startsWithAny(p, '/cmdb', '/admin/integrations'),
    children: [
      { to: '/cmdb', label: 'Overview' },
      { to: '/cmdb/cis', label: 'Configuration items' },
      { to: '/cmdb/services', label: 'Business services' },
      { to: '/cmdb/map', label: 'Service map' },
      { to: '/cmdb/classes', label: 'CI classes' },
      { to: '/cmdb/discovery', label: 'Discovery', perm: ['discovery:run', 'discovery:manage'], area: 'discovery' },
      { to: '/admin/integrations', label: 'Monitoring & SIEM', perm: ['integrations:events', 'integrations:manage'], area: 'monitoring' },
    ],
  },
  {
    to: '/assets', label: 'Assets', icon: Boxes, tint: 'text-amber-600', perm: ['assets:read'], area: 'assets', section: S.infrastructure,
    children: [
      { to: '/assets', label: 'Overview' },
      { to: '/assets/inventory', label: 'Inventory' },
      { to: '/assets/coverage', label: 'Warranty & AMC' },
      { to: '/assets/lifecycle', label: 'Lifecycle' },
      // slot #2: { to: '/assets/software', label: 'Software', perm: ['software:read'] }
      // slot #2: { to: '/assets/software/licences', label: 'Licences', perm: ['software:read'] }
    ],
  },
  // ---- System
  { to: '/admin', label: 'Administration', short: 'Admin', icon: Settings, tint: 'text-zinc-500', perm: ['admin:config', 'admin:users', 'admin:audit', 'admin:system', 'integrations:manage'], section: S.system },
];

/** Customer portal navigator: only `portal:*` permissions, every page fenced to the user's own organisation. */
export const PORTAL_NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, tint: 'text-brand-600' },
  // ---- Support
  {
    to: '/portal/status', label: 'Service status', short: 'Status', icon: Activity, tint: 'text-emerald-600', perm: ['portal:status'], section: P.support,
    children: [{ to: '/portal/status', label: 'Status' }, { to: '/portal/changes', label: 'Planned changes' }],
  },
  { to: '/portal/tickets', label: 'My tickets', short: 'Tickets', icon: Ticket, tint: 'text-blue-600', perm: ['portal:tickets'], section: P.support },
  { to: '/portal/approvals', label: 'Approvals', icon: ClipboardCheck, tint: 'text-amber-600', perm: ['portal:approve'], section: P.support },
  {
    to: '/knowledge', label: 'Knowledge', icon: BookOpen, tint: 'text-fuchsia-600', perm: ['portal:access'], section: P.support,
    children: [
      { to: '/knowledge', label: 'Overview' },
      { to: '/knowledge/articles', label: 'Articles' },
      { to: '/knowledge/known-errors', label: 'Known errors', perm: ['portal:kedb'] },
    ],
  },
  // ---- Your services
  {
    to: '/portal/services', label: 'Services & contracts', short: 'Services', icon: FileSignature, tint: 'text-emerald-600', perm: ['portal:contracts'], section: P.services,
    children: [
      { to: '/portal/services', label: 'Services' },
      { to: '/portal/services/sla', label: 'Service levels' },
      { to: '/portal/services/contracts', label: 'Contracts' },
    ],
  },
  {
    to: '/portal/assets', label: 'Assets', icon: Boxes, tint: 'text-amber-600', perm: ['portal:assets'], section: P.services,
    children: [
      { to: '/portal/assets', label: 'Overview' },
      { to: '/portal/assets/inventory', label: 'Inventory' },
      { to: '/portal/assets/coverage', label: 'Warranty & AMC' },
      // slot #2: { to: '/portal/assets/software', label: 'Software', perm: ['portal:software'] }
    ],
  },
  {
    to: '/portal/maintenance', label: 'Maintenance & visits', short: 'Visits', icon: CalendarCheck, tint: 'text-orange-600', perm: ['portal:access'], section: P.services,
    children: [
      { to: '/portal/maintenance', label: 'Upcoming' },
      { to: '/portal/maintenance/history', label: 'History' },
    ],
  },
  // ---- Account
  { to: '/reports', label: 'Reports', icon: BarChart3, tint: 'text-teal-600', perm: ['portal:reports'], section: P.account },
  { to: '/portal/users', label: 'Users', icon: UsersRound, tint: 'text-pink-600', perm: ['portal:manage_users'], section: P.account },
];

type Can = (...perms: Permission[]) => boolean;
const allowed = (item: { perm?: Permission[]; area?: NavArea }, can: Can, areas: string[] | null | undefined) => (!item.perm || can(...item.perm)) && (!item.area || !areas || areas.includes(item.area));

/** Items (and their modules) the user may see, by permission and navigation area; an application lists modules only when at least two are visible. */
export function visibleNav(items: NavItem[], can: Can, areas: string[] | null | undefined): NavItem[] {
  return items
    .filter((i) => allowed(i, can, areas))
    .map((i) => {
      if (!i.children) return i;
      const children = i.children.filter((c) => allowed(c, can, areas));
      return children.length >= 2 ? { ...i, children } : { ...i, children: undefined };
    });
}

/** Whether the current path belongs to an application (its own prefix, or its `match` rule). */
export const isAppActive = (item: NavItem, pathname: string): boolean => (item.match ? item.match(pathname) : item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(item.to + '/'));

/** Consecutive items sharing a section form one group; items without a section form a headless group. */
export function groupNav(items: NavItem[]): { section?: string; items: NavItem[] }[] {
  const groups: { section?: string; items: NavItem[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.section === item.section) last.items.push(item);
    else groups.push({ section: item.section, items: [item] });
  }
  return groups;
}
