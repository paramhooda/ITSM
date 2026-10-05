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
  { path: '/tickets/approvals', component: page(() => import('@/pages/tickets/ApprovalsInboxPage')), perm: ['requests:approve', 'changes:approve'] },
  { path: '/tickets/boards', component: page(() => import('@/pages/tickets/TaskBoardsPage')), perm: ['tickets:read'] },
  { path: '/tickets/:id', component: page(() => import('@/pages/tickets/TicketDetailPage')), perm: ['tickets:read'] },
  // Operations: Major incidents · On-call · Announcements · Change calendar · CAB (handover follows)
  { path: '/operations', component: page(() => import('@/pages/operations/MajorIncidentsPage')), perm: ['tickets:read'] },
  { path: '/operations/major-incidents', component: page(() => import('@/pages/operations/MajorIncidentsPage')), perm: ['tickets:read'] },
  { path: '/operations/on-call', component: page(() => import('@/pages/operations/OnCallPage')), perm: ['oncall:read'] },
  { path: '/operations/announcements', component: page(() => import('@/pages/operations/AnnouncementsPage')), perm: ['announcements:manage'] },
  { path: '/operations/handover', component: page(() => import('@/pages/operations/HandoverPage')), perm: ['handover:write', 'oncall:manage'] },
  { path: '/operations/change-calendar', component: page(() => import('@/pages/operations/ChangeCalendarPage')), perm: ['tickets:read'] },
  { path: '/operations/cab', component: page(() => import('@/pages/operations/CabMeetingsPage')), perm: ['changes:cab', 'changes:approve', 'changes:manage'] },
  { path: '/operations/cab/:id', component: page(() => import('@/pages/operations/CabMeetingPage')), perm: ['changes:cab', 'changes:approve', 'changes:manage'] },
  { path: '/operations/change-catalog', component: page(() => import('@/pages/operations/ChangeCatalogPage')), perm: ['tickets:read'] },
  // Customers & contracts
  // Customers: Overview · Accounts
  { path: '/customers', component: page(() => import('@/pages/customers/CustomersOverviewPage')), perm: ['customers:read'] },
  { path: '/customers/accounts', component: page(() => import('@/pages/customers/CustomerListPage')), perm: ['customers:read'] },
  { path: '/customers/:id', component: page(() => import('@/pages/customers/CustomerDetailPage')), perm: ['customers:read'] },
  // Contracts & scope: Overview · Contracts · Entitlements · Service levels
  { path: '/contracts', component: page(() => import('@/pages/contracts/ContractsOverviewPage')), perm: ['contracts:read'] },
  { path: '/contracts/list', component: page(() => import('@/pages/contracts/ContractListPage')), perm: ['contracts:read'] },
  { path: '/contracts/entitlements', component: page(() => import('@/pages/contracts/EntitlementsPage')), perm: ['contracts:read'] },
  { path: '/contracts/:id', component: page(() => import('@/pages/contracts/ContractDetailPage')), perm: ['contracts:read'] },
  { path: '/services', component: page(() => import('@/pages/services/ServiceCatalogPage')), perm: ['services:read'] },
  { path: '/teams', component: page(() => import('@/pages/teams/TeamsPage')), perm: ['tickets:read', 'admin:users'] },
  { path: '/sla', component: page(() => import('@/pages/sla/ServiceLevelsPage')), perm: ['contracts:read', 'admin:config'] },
  /** Policies are edited under Administration; keep /sla/new and /sla/:id links working. */
  { path: '/sla/:id', component: page(() => import('@/pages/sla/SlaPolicyRedirect')), perm: ['contracts:read', 'admin:config'] },
  // Assets & CMDB
  // Assets: Overview · Inventory · Warranty & AMC · Lifecycle
  { path: '/assets', component: page(() => import('@/pages/assets/AssetsOverviewPage')), perm: ['assets:read'] },
  { path: '/assets/inventory', component: page(() => import('@/pages/assets/AssetListPage')), perm: ['assets:read'] },
  { path: '/assets/coverage', component: page(() => import('@/pages/assets/AssetsCoveragePage')), perm: ['assets:read'] },
  { path: '/assets/lifecycle', component: page(() => import('@/pages/assets/AssetsLifecyclePage')), perm: ['assets:read'] },
  { path: '/assets/software', component: page(() => import('@/pages/assets/software/SoftwareOverviewPage')), perm: ['software:read'] },
  { path: '/assets/software/titles', component: page(() => import('@/pages/assets/software/SoftwareTitlesPage')), perm: ['software:read'] },
  { path: '/assets/software/titles/:id', component: page(() => import('@/pages/assets/software/SoftwareTitlePage')), perm: ['software:read'] },
  { path: '/assets/software/installations', component: page(() => import('@/pages/assets/software/SoftwareInstallationsPage')), perm: ['software:read'] },
  { path: '/assets/software/licences', component: page(() => import('@/pages/assets/software/LicencesPage')), perm: ['software:read'] },
  { path: '/assets/software/licences/:id', component: page(() => import('@/pages/assets/software/LicencePage')), perm: ['software:read'] },
  { path: '/assets/software/compliance', component: page(() => import('@/pages/assets/software/SoftwareCompliancePage')), perm: ['software:read'] },
  { path: '/assets/software/renewals', component: page(() => import('@/pages/assets/software/SoftwareRenewalsPage')), perm: ['software:read'] },
  { path: '/assets/:id', component: page(() => import('@/pages/assets/AssetDetailPage')), perm: ['assets:read'] },
  // Configuration (CMDB) module
  { path: '/cmdb', component: page(() => import('@/pages/cmdb/CmdbOverviewPage')), perm: ['cmdb:read'] },
  { path: '/cmdb/cis', component: page(() => import('@/pages/cmdb/CiListPage')), perm: ['cmdb:read'] },
  { path: '/cmdb/cis/:id', component: page(() => import('@/pages/cmdb/CiDetailPage')), perm: ['cmdb:read'] },
  { path: '/cmdb/services', component: page(() => import('@/pages/cmdb/BusinessServicesPage')), perm: ['cmdb:read'] },
  { path: '/cmdb/services/:id', component: page(() => import('@/pages/cmdb/ServiceMapPage')), perm: ['cmdb:read'] },
  { path: '/cmdb/map', component: page(() => import('@/pages/cmdb/ServiceMapPage')), perm: ['cmdb:read'] },
  { path: '/cmdb/classes', component: page(() => import('@/pages/cmdb/CiClassesPage')), perm: ['cmdb:read'] },
  { path: '/cmdb/discovery', component: page(() => import('@/pages/cmdb/discovery/DiscoveryOverviewPage')), perm: ['discovery:run', 'discovery:manage'] },
  { path: '/cmdb/discovery/sources', component: page(() => import('@/pages/cmdb/discovery/SourcesPage')), perm: ['discovery:run', 'discovery:manage'] },
  { path: '/cmdb/discovery/sources/:id', component: page(() => import('@/pages/cmdb/discovery/SourcePage')), perm: ['discovery:run', 'discovery:manage'] },
  { path: '/cmdb/discovery/runs', component: page(() => import('@/pages/cmdb/discovery/RunsPage')), perm: ['discovery:run', 'discovery:manage'] },
  { path: '/cmdb/discovery/runs/:id', component: page(() => import('@/pages/cmdb/discovery/RunPage')), perm: ['discovery:run', 'discovery:manage'] },
  { path: '/cmdb/discovery/findings', component: page(() => import('@/pages/cmdb/discovery/FindingsPage')), perm: ['discovery:run', 'discovery:manage'] },
  { path: '/cmdb/discovery/findings/:id', component: page(() => import('@/pages/cmdb/discovery/FindingPage')), perm: ['discovery:run', 'discovery:manage'] },
  { path: '/cmdb/:id', component: page(() => import('@/pages/cmdb/CiRedirect')), perm: ['cmdb:read'] },
  { path: '/discovery', component: page(() => import('@/pages/cmdb/DiscoveryRedirect')), perm: ['discovery:run', 'discovery:manage'] },
  /** Monitoring & SIEM lives under Administration now; keep old links working. */
  { path: '/integrations', component: page(() => import('@/pages/integrations/IntegrationsRedirect')), perm: ['integrations:events', 'integrations:manage'] },
  // Field & maintenance
  // Field service: Overview · Visits · Calendar · Preventive maintenance
  { path: '/field', component: page(() => import('@/pages/field/FieldOverviewPage')), perm: ['field:read'] },
  { path: '/field/visits', component: page(() => import('@/pages/field/FieldVisitListPage')), perm: ['field:read'] },
  { path: '/field/calendar', component: page(() => import('@/pages/field/FieldCalendarPage')), perm: ['field:read'] },
  { path: '/field/:id', component: page(() => import('@/pages/field/FieldVisitDetailPage')), perm: ['field:read'] },
  { path: '/maintenance', component: page(() => import('@/pages/pm/MaintenancePage')), perm: ['pm:read'] },
  // Knowledge
  // Knowledge: Overview · Articles · Known errors · Categories (portal users land on the articles)
  { path: '/knowledge', component: page(() => import('@/pages/knowledge/KnowledgeOverviewPage')), perm: ['kb:read', 'portal:access'], shared: true, portal: true },
  { path: '/knowledge/articles', component: page(() => import('@/pages/knowledge/KnowledgeListPage')), perm: ['kb:read', 'portal:access'], shared: true, portal: true },
  { path: '/knowledge/categories', component: page(() => import('@/pages/knowledge/KnowledgeCategoriesPage')), perm: ['kb:manage'] },
  { path: '/knowledge/known-errors', component: page(() => import('@/pages/knowledge/KnownErrorsPage')), perm: ['kedb:read', 'portal:kedb'], shared: true, portal: true },
  { path: '/knowledge/known-errors/:id', component: page(() => import('@/pages/knowledge/KnownErrorPage')), perm: ['kedb:read', 'portal:kedb'], shared: true, portal: true },
  { path: '/knowledge/:id', component: page(() => import('@/pages/knowledge/KnowledgeArticlePage')), perm: ['kb:read', 'portal:access'], shared: true, portal: true },
  // Reports
  { path: '/reports', component: page(() => import('@/pages/reports/ReportsPage')), perm: ['reports:run', 'portal:reports'], shared: true, portal: true },
  { path: '/reports/csat', component: page(() => import('@/pages/reports/CsatPage')), perm: ['surveys:read'] },
  // Admin
  { path: '/admin/*', component: page(() => import('@/pages/admin/AdminPage')), perm: ['admin:config', 'admin:users', 'admin:audit', 'admin:system', 'integrations:manage', 'integrations:events'] },
  // Profile / settings
  { path: '/profile', component: page(() => import('@/pages/auth/ProfilePage')), shared: true, portal: true },
  { path: '/notifications', component: page(() => import('@/pages/notifications/NotificationsPage')), shared: true, portal: true },
  // Customer portal
  { path: '/portal/tickets', component: page(() => import('@/pages/portal/PortalTicketsPage')), perm: ['portal:tickets'], portal: true },
  { path: '/portal/tickets/new', component: page(() => import('@/pages/portal/PortalNewTicketPage')), perm: ['portal:tickets'], portal: true },
  { path: '/portal/tickets/:id', component: page(() => import('@/pages/portal/PortalTicketDetailPage')), perm: ['portal:tickets'], portal: true },
  { path: '/portal/services', component: page(() => import('@/pages/portal/PortalServicesPage')), perm: ['portal:contracts'], portal: true },
  { path: '/portal/services/sla', component: page(() => import('@/pages/portal/PortalServicesSlaPage')), perm: ['portal:contracts'], portal: true },
  { path: '/portal/services/contracts', component: page(() => import('@/pages/portal/PortalServicesContractsPage')), perm: ['portal:contracts'], portal: true },
  { path: '/portal/assets', component: page(() => import('@/pages/portal/PortalAssetsOverviewPage')), perm: ['portal:assets'], portal: true },
  { path: '/portal/assets/inventory', component: page(() => import('@/pages/portal/PortalAssetsPage')), perm: ['portal:assets'], portal: true },
  { path: '/portal/assets/coverage', component: page(() => import('@/pages/portal/PortalAssetsCoveragePage')), perm: ['portal:assets'], portal: true },
  { path: '/portal/assets/software', component: page(() => import('@/pages/portal/PortalSoftwarePage')), perm: ['portal:software'], portal: true },
  { path: '/portal/maintenance', component: page(() => import('@/pages/portal/PortalMaintenancePage')), perm: ['portal:access'], portal: true },
  { path: '/portal/maintenance/history', component: page(() => import('@/pages/portal/PortalMaintenanceHistoryPage')), perm: ['portal:access'], portal: true },
  { path: '/portal/status', component: page(() => import('@/pages/portal/PortalStatusPage')), perm: ['portal:status'], portal: true },
  { path: '/portal/changes', component: page(() => import('@/pages/portal/PortalChangesPage')), perm: ['portal:status'], portal: true },
  { path: '/portal/approvals', component: page(() => import('@/pages/portal/PortalApprovalsPage')), perm: ['portal:approve'], portal: true },
  { path: '/portal/users', component: page(() => import('@/pages/portal/PortalUsersPage')), perm: ['portal:manage_users'], portal: true },
];
