import type { Permission } from '@itsm/shared';
import { LayoutDashboard, Ticket, Building2, FileSignature, Boxes, Server, Share2, Radar, Wrench, CalendarCheck, BookOpen, BarChart3, Settings, Plug, Layers, ClipboardCheck, Users, ShieldCheck, Gauge } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  perm?: Permission[];
  section?: string;
}

export const MSP_NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/tickets', label: 'Tickets', icon: Ticket, perm: ['tickets:read'] },
  { to: '/customers', label: 'Customers', icon: Building2, perm: ['customers:read'], section: 'Accounts' },
  { to: '/contracts', label: 'Contracts & Scope', icon: FileSignature, perm: ['contracts:read'] },
  { to: '/services', label: 'Service Catalog', icon: Layers, perm: ['services:read'] },
  { to: '/sla', label: 'Service Levels', icon: Gauge, perm: ['contracts:read', 'admin:config'] },
  { to: '/assets', label: 'Assets', icon: Boxes, perm: ['assets:read'], section: 'Infrastructure' },
  { to: '/cmdb', label: 'CMDB', icon: Server, perm: ['cmdb:read'] },
  { to: '/discovery', label: 'Discovery', icon: Radar, perm: ['discovery:run', 'discovery:manage'] },
  { to: '/integrations', label: 'Monitoring & SIEM', icon: Plug, perm: ['integrations:events', 'integrations:manage'] },
  { to: '/field', label: 'Field Service', icon: Wrench, perm: ['field:read'], section: 'Delivery' },
  { to: '/maintenance', label: 'Preventive Maintenance', icon: CalendarCheck, perm: ['pm:read'] },
  { to: '/knowledge', label: 'Knowledge', icon: BookOpen, perm: ['kb:read'] },
  { to: '/reports', label: 'Reports', icon: BarChart3, perm: ['reports:run'], section: 'Insight' },
  { to: '/admin', label: 'Administration', icon: Settings, perm: ['admin:config', 'admin:users', 'admin:audit', 'admin:system', 'integrations:manage'], section: 'System' },
];

export const PORTAL_NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard },
  { to: '/portal/tickets', label: 'My Tickets', icon: Ticket, perm: ['portal:tickets'] },
  { to: '/portal/approvals', label: 'Approvals', icon: ClipboardCheck, perm: ['portal:approve'] },
  { to: '/portal/services', label: 'Services & Contracts', icon: FileSignature, perm: ['portal:contracts'] },
  { to: '/portal/assets', label: 'Assets', icon: Boxes, perm: ['portal:assets'] },
  { to: '/portal/maintenance', label: 'Maintenance & Visits', icon: CalendarCheck, perm: ['portal:access'] },
  { to: '/knowledge', label: 'Knowledge', icon: BookOpen, perm: ['portal:access'] },
  { to: '/reports', label: 'Reports', icon: BarChart3, perm: ['portal:reports'] },
  { to: '/portal/users', label: 'Users', icon: Users, perm: ['portal:manage_users'] },
];

export { Share2, ShieldCheck };
