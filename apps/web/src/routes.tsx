import { lazy, type ComponentType } from 'react';
import type { Permission } from '@itsm/shared';

export interface AppRoute {
  path: string;
  component: ComponentType;
  perm?: Permission[];
  /** Available in the customer portal shell. */
  portal?: boolean;
  /** Available in both shells. */
  shared?: boolean;
}

const page = (loader: () => Promise<{ default: ComponentType }>) => lazy(loader);

/**
 * Route table. Pages live under src/pages/<module>/. The navigation (AppShell /
 * PortalShell) decides what to show based on permissions; routes guard again.
 */
export const routes: AppRoute[] = [
  { path: '/', component: page(() => import('@/pages/dashboards/DashboardPage')), shared: true, portal: true },
  // Tickets
  { path: '/tickets', component: page(() => import('@/pages/tickets/TicketListPage')), perm: ['tickets:read'] },
  { path: '/tickets/new', component: page(() => import('@/pages/tickets/TicketCreatePage')), perm: ['tickets:create'] },
  { path: '/tickets/:id', component: page(() => import('@/pages/tickets/TicketDetailPage')), perm: ['tickets:read'] },
  // Customers & contracts
  { path: '/customers', component: page(() => import('@/pages/customers/CustomerListPage')), perm: ['customers:read'] },
  { path: '/customers/:id', component: page(() => import('@/pages/customers/CustomerDetailPage')), perm: ['customers:read'] },
  { path: '/contracts', component: page(() => import('@/pages/contracts/ContractListPage')), perm: ['contracts:read'] },
  { path: '/contracts/:id', component: page(() => import('@/pages/contracts/ContractDetailPage')), perm: ['contracts:read'] },
  { path: '/services', component: page(() => import('@/pages/services/ServiceCatalogPage')), perm: ['services:read'] },
  { path: '/sla', component: page(() => import('@/pages/sla/ServiceLevelsPage')), perm: ['contracts:read', 'admin:config'] },
  { path: '/sla/:id', component: page(() => import('@/pages/sla/SlaPolicyPage')), perm: ['contracts:read', 'admin:config'] },
  // Assets & CMDB
  { path: '/assets', component: page(() => import('@/pages/assets/AssetListPage')), perm: ['assets:read'] },
  { path: '/assets/:id', component: page(() => import('@/pages/assets/AssetDetailPage')), perm: ['assets:read'] },
  { path: '/cmdb', component: page(() => import('@/pages/cmdb/CiListPage')), perm: ['cmdb:read'] },
  { path: '/cmdb/:id', component: page(() => import('@/pages/cmdb/CiDetailPage')), perm: ['cmdb:read'] },
  { path: '/discovery', component: page(() => import('@/pages/cmdb/DiscoveryPage')), perm: ['discovery:run', 'discovery:manage'] },
  { path: '/integrations', component: page(() => import('@/pages/integrations/IntegrationsPage')), perm: ['integrations:events', 'integrations:manage'] },
  // Field & maintenance
  { path: '/field', component: page(() => import('@/pages/field/FieldVisitListPage')), perm: ['field:read'] },
  { path: '/field/:id', component: page(() => import('@/pages/field/FieldVisitDetailPage')), perm: ['field:read'] },
  { path: '/maintenance', component: page(() => import('@/pages/pm/MaintenancePage')), perm: ['pm:read'] },
  // Knowledge
  { path: '/knowledge', component: page(() => import('@/pages/knowledge/KnowledgeListPage')), perm: ['kb:read', 'portal:access'], shared: true, portal: true },
  { path: '/knowledge/:id', component: page(() => import('@/pages/knowledge/KnowledgeArticlePage')), perm: ['kb:read', 'portal:access'], shared: true, portal: true },
  // Reports
  { path: '/reports', component: page(() => import('@/pages/reports/ReportsPage')), perm: ['reports:run', 'portal:reports'], shared: true, portal: true },
  // Admin
  { path: '/admin/*', component: page(() => import('@/pages/admin/AdminPage')), perm: ['admin:config', 'admin:users', 'admin:audit', 'admin:system', 'integrations:manage'] },
  // Profile / settings
  { path: '/profile', component: page(() => import('@/pages/auth/ProfilePage')), shared: true, portal: true },
  { path: '/notifications', component: page(() => import('@/pages/notifications/NotificationsPage')), shared: true, portal: true },
  // Customer portal
  { path: '/portal/tickets', component: page(() => import('@/pages/portal/PortalTicketsPage')), perm: ['portal:tickets'], portal: true },
  { path: '/portal/tickets/new', component: page(() => import('@/pages/portal/PortalNewTicketPage')), perm: ['portal:tickets'], portal: true },
  { path: '/portal/tickets/:id', component: page(() => import('@/pages/portal/PortalTicketDetailPage')), perm: ['portal:tickets'], portal: true },
  { path: '/portal/services', component: page(() => import('@/pages/portal/PortalServicesPage')), perm: ['portal:contracts'], portal: true },
  { path: '/portal/assets', component: page(() => import('@/pages/portal/PortalAssetsPage')), perm: ['portal:assets'], portal: true },
  { path: '/portal/maintenance', component: page(() => import('@/pages/portal/PortalMaintenancePage')), perm: ['portal:access'], portal: true },
  { path: '/portal/approvals', component: page(() => import('@/pages/portal/PortalApprovalsPage')), perm: ['portal:approve'], portal: true },
  { path: '/portal/users', component: page(() => import('@/pages/portal/PortalUsersPage')), perm: ['portal:manage_users'], portal: true },
];
