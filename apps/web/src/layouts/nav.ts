import type { Permission, NavArea } from '@itsm/shared';
import { LayoutDashboard, Ticket, Building2, FileSignature, Boxes, Server, Wrench, CalendarCheck, BookOpen, BarChart3, Settings, Layers, ClipboardCheck, UsersRound, Siren, Activity } from 'lucide-react';

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
  section?: string;
  /** Modules listed under the application when it is expanded. */
  children?: NavChild[];
  /** Icon colour class: every application gets its own hue in the navigator. */
  tint?: string;
}

export const MSP_NAV: NavItem[] = [
  { to: '/', label: 'Dashboards', icon: LayoutDashboard, tint: 'text-brand-600' },
  {
    to: '/tickets',
    label: 'Tickets',
    icon: Ticket,
    tint: 'text-blue-600',
    perm: ['tickets:read'],
    area: 'tickets',
    section: 'Service desk',
    children: [
      { to: '/tickets', label: 'Open' },
      { to: '/tickets?assignee=me', label: 'Assigned to me' },
      { to: '/tickets?assignee=unassigned', label: 'Unassigned' },
      { to: '/tickets?type=incident', label: 'Incidents' },
      { to: '/tickets?type=request', label: 'Requests' },
      { to: '/tickets?type=problem', label: 'Problems' },
      { to: '/tickets?type=change', label: 'Changes' },
      { to: '/tickets/approvals', label: 'My approvals', perm: ['requests:approve', 'changes:approve'] },
      { to: '/tickets/new', label: 'Create new', perm: ['tickets:create'] },
    ],
  },
  {
    to: '/operations',
    label: 'Operations',
    icon: Siren,
    tint: 'text-red-600',
    perm: ['tickets:read'],
    area: 'operations',
    children: [
      { to: '/operations/major-incidents', label: 'Major incidents' },
      { to: '/operations/on-call', label: 'On-call', perm: ['oncall:read'] },
      { to: '/operations/announcements', label: 'Announcements', perm: ['announcements:manage'] },
      { to: '/operations/change-calendar', label: 'Change calendar' },
      { to: '/operations/cab', label: 'CAB', perm: ['changes:cab', 'changes:approve', 'changes:manage'] },
    ],
  },
  {
    to: '/customers',
    label: 'Customers',
    icon: Building2,
    tint: 'text-violet-600',
    perm: ['customers:read'],
    area: 'customers',
    section: 'Accounts',
    children: [
      { to: '/customers', label: 'Overview' },
      { to: '/customers/accounts', label: 'Accounts' },
    ],
  },
  {
    to: '/contracts',
    label: 'Contracts & Scope',
    icon: FileSignature,
    tint: 'text-emerald-600',
    perm: ['contracts:read'],
    area: 'contracts',
    children: [
      { to: '/contracts', label: 'Overview' },
      { to: '/contracts/list', label: 'Contracts' },
      { to: '/contracts/entitlements', label: 'Entitlements' },
      { to: '/sla', label: 'Service levels', perm: ['contracts:read', 'admin:config'] },
    ],
  },
  { to: '/services', label: 'Service Catalog', icon: Layers, perm: ['services:read'], area: 'catalog', tint: 'text-cyan-600' },
  { to: '/teams', label: 'Teams', icon: UsersRound, perm: ['tickets:read', 'admin:users'], area: 'teams', tint: 'text-pink-600' },
  {
    to: '/cmdb',
    label: 'Configuration (CMDB)',
    icon: Server,
    tint: 'text-indigo-600',
    perm: ['cmdb:read'],
    area: 'cmdb',
    section: 'Infrastructure',
    children: [
      { to: '/cmdb', label: 'Overview' },
      { to: '/cmdb/cis', label: 'Configuration items' },
      { to: '/cmdb/services', label: 'Business services' },
      { to: '/cmdb/map', label: 'Service map' },
      { to: '/cmdb/classes', label: 'CI classes' },
      { to: '/cmdb/discovery', label: 'Discovery', perm: ['discovery:run', 'discovery:manage'], area: 'discovery' },
    ],
  },
  {
    to: '/assets',
    label: 'Assets',
    icon: Boxes,
    perm: ['assets:read'],
    area: 'assets',
    tint: 'text-amber-600',
    children: [
      { to: '/assets', label: 'Overview' },
      { to: '/assets/inventory', label: 'Inventory' },
      { to: '/assets/coverage', label: 'Warranty & AMC' },
      { to: '/assets/lifecycle', label: 'Lifecycle' },
    ],
  },
  {
    to: '/field',
    label: 'Field Service',
    icon: Wrench,
    tint: 'text-orange-600',
    perm: ['field:read', 'pm:read'],
    area: 'field',
    section: 'Delivery',
    children: [
      { to: '/field', label: 'Overview', perm: ['field:read'] },
      { to: '/field/visits', label: 'Visits', perm: ['field:read'] },
      { to: '/field/calendar', label: 'Calendar', perm: ['field:read'] },
      { to: '/maintenance', label: 'Preventive maintenance', perm: ['pm:read'], area: 'maintenance' },
    ],
  },
  {
    to: '/knowledge',
    label: 'Knowledge',
    icon: BookOpen,
    perm: ['kb:read'],
    area: 'knowledge',
    tint: 'text-fuchsia-600',
    children: [
      { to: '/knowledge', label: 'Overview' },
      { to: '/knowledge/articles', label: 'Articles' },
      { to: '/knowledge/categories', label: 'Categories', perm: ['kb:manage'] },
    ],
  },
  { to: '/reports', label: 'Reports', icon: BarChart3, perm: ['reports:run'], area: 'reports', section: 'Insight', tint: 'text-teal-600' },
  { to: '/admin', label: 'Administration', icon: Settings, tint: 'text-zinc-500', perm: ['admin:config', 'admin:users', 'admin:audit', 'admin:system', 'integrations:manage', 'integrations:events'], section: 'System' },
];

export const PORTAL_NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, tint: 'text-brand-600' },
  { to: '/portal/status', label: 'Service status', icon: Activity, perm: ['portal:status'], tint: 'text-emerald-600' },
  { to: '/portal/tickets', label: 'My Tickets', icon: Ticket, perm: ['portal:tickets'], tint: 'text-blue-600' },
  { to: '/portal/approvals', label: 'Approvals', icon: ClipboardCheck, perm: ['portal:approve'], tint: 'text-amber-600' },
  {
    to: '/portal/services',
    label: 'Services & Contracts',
    icon: FileSignature,
    tint: 'text-emerald-600',
    perm: ['portal:contracts'],
    children: [
      { to: '/portal/services', label: 'Services' },
      { to: '/portal/services/sla', label: 'Service levels' },
      { to: '/portal/services/contracts', label: 'Contracts' },
    ],
  },
  {
    to: '/portal/assets',
    label: 'Assets',
    icon: Boxes,
    perm: ['portal:assets'],
    tint: 'text-amber-600',
    children: [
      { to: '/portal/assets', label: 'Overview' },
      { to: '/portal/assets/inventory', label: 'Inventory' },
      { to: '/portal/assets/coverage', label: 'Warranty & AMC' },
    ],
  },
  {
    to: '/portal/maintenance',
    label: 'Maintenance & Visits',
    icon: CalendarCheck,
    tint: 'text-orange-600',
    perm: ['portal:access'],
    children: [
      { to: '/portal/maintenance', label: 'Upcoming' },
      { to: '/portal/maintenance/history', label: 'History' },
    ],
  },
  { to: '/knowledge', label: 'Knowledge', icon: BookOpen, perm: ['portal:access'], tint: 'text-fuchsia-600' },
  { to: '/reports', label: 'Reports', icon: BarChart3, perm: ['portal:reports'], tint: 'text-teal-600' },
  { to: '/portal/users', label: 'Users', icon: UsersRound, perm: ['portal:manage_users'], tint: 'text-pink-600' },
];

type Can = (...perms: Permission[]) => boolean;
const allowed = (item: { perm?: Permission[]; area?: NavArea }, can: Can, areas: string[] | null | undefined) => (!item.perm || can(...item.perm)) && (!item.area || !areas || areas.includes(item.area));

/** Items (and their modules) the user may see, by permission and navigation area. */
export function visibleNav(items: NavItem[], can: Can, areas: string[] | null | undefined): NavItem[] {
  return items.filter((i) => allowed(i, can, areas)).map((i) => (i.children ? { ...i, children: i.children.filter((c) => allowed(c, can, areas)) } : i));
}
