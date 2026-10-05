// Imported by apps/api/test/navigation.test.ts under the API tsconfig: no `@/` imports and no DOM types in this file.
import type { Permission } from '@itsm/shared';

/**
 * Module strips: every major application opens on an Overview and offers its
 * modules in one strip under the page header (the ServiceNow shape CMDB already
 * had: Overview · Configuration items · Business services …). The navigator's
 * children mirror these lists, so the left rail and the strip never disagree
 * (`apps/api/test/navigation.test.ts` checks every strip against its
 * application). A strip renders nothing below two visible entries, and
 * `visibleNav` hides an application's modules by the same rule.
 */
export interface ModuleItem {
  to: string;
  label: string;
  /** Active only on an exact path match (for the Overview entry). */
  end?: boolean;
  /** Any of these permissions shows the module. */
  perm?: Permission[];
  /** Custom active rule when the module owns several paths. */
  match?: (pathname: string) => boolean;
}

export const OPERATIONS_MODULES: ModuleItem[] = [
  { to: '/operations/major-incidents', label: 'Major incidents', match: (p) => p === '/operations' || p.startsWith('/operations/major-incidents') },
  { to: '/operations/on-call', label: 'On-call', perm: ['oncall:read'] },
  { to: '/operations/announcements', label: 'Announcements', perm: ['announcements:manage'] },
  { to: '/operations/handover', label: 'Handover', perm: ['handover:write', 'oncall:manage'] },
];

export const CHANGE_MODULES: ModuleItem[] = [
  { to: '/operations/change-calendar', label: 'Change calendar' },
  { to: '/operations/cab', label: 'CAB', perm: ['changes:cab', 'changes:approve', 'changes:manage'], match: (p) => p.startsWith('/operations/cab') },
  { to: '/operations/change-catalog', label: 'Change catalog' },
];

export const CMDB_MODULES: ModuleItem[] = [
  { to: '/cmdb', label: 'Overview', end: true },
  { to: '/cmdb/cis', label: 'Configuration items' },
  { to: '/cmdb/services', label: 'Business services', match: (p) => p === '/cmdb/services' },
  { to: '/cmdb/map', label: 'Service map', match: (p) => p === '/cmdb/map' || /^\/cmdb\/services\/[^/]+$/.test(p) },
  { to: '/cmdb/classes', label: 'CI classes' },
  { to: '/cmdb/discovery', label: 'Discovery', perm: ['discovery:run', 'discovery:manage'] },
];

export const ASSET_MODULES: ModuleItem[] = [
  { to: '/assets', label: 'Overview', end: true },
  { to: '/assets/inventory', label: 'Inventory' },
  { to: '/assets/coverage', label: 'Warranty & AMC' },
  { to: '/assets/lifecycle', label: 'Lifecycle' },
  { to: '/assets/software', label: 'Software', perm: ['software:read'], match: (p) => p.startsWith('/assets/software') },
];

/** Secondary strip inside Software (rendered by components/software/SoftwareNav.tsx), not mirrored by navigator children. */
export const SOFTWARE_MODULES: ModuleItem[] = [
  { to: '/assets/software', label: 'Overview', end: true },
  { to: '/assets/software/titles', label: 'Titles' },
  { to: '/assets/software/installations', label: 'Installations' },
  { to: '/assets/software/licences', label: 'Licences' },
  { to: '/assets/software/compliance', label: 'Compliance' },
  { to: '/assets/software/renewals', label: 'Renewals' },
];

export const CUSTOMER_MODULES: ModuleItem[] = [
  { to: '/customers', label: 'Overview', end: true },
  { to: '/customers/accounts', label: 'Accounts' },
];

export const CONTRACT_MODULES: ModuleItem[] = [
  { to: '/contracts', label: 'Overview', end: true },
  { to: '/contracts/list', label: 'Contracts' },
  { to: '/contracts/entitlements', label: 'Entitlements' },
  { to: '/sla', label: 'Service levels', perm: ['contracts:read', 'admin:config'] },
];

export const FIELD_MODULES: ModuleItem[] = [
  { to: '/field', label: 'Overview', end: true, perm: ['field:read'] },
  { to: '/field/visits', label: 'Visits', perm: ['field:read'] },
  { to: '/field/calendar', label: 'Calendar', perm: ['field:read'] },
  { to: '/maintenance', label: 'Preventive maintenance', perm: ['pm:read'], match: (p) => p.startsWith('/maintenance') },
];

export const KNOWLEDGE_MODULES: ModuleItem[] = [
  { to: '/knowledge', label: 'Overview', end: true, perm: ['kb:read'] },
  { to: '/knowledge/articles', label: 'Articles' },
  { to: '/knowledge/known-errors', label: 'Known errors', perm: ['kedb:read'], match: (p) => p.startsWith('/knowledge/known-errors') },
  { to: '/knowledge/categories', label: 'Categories', perm: ['kb:manage'] },
];

export const REPORT_MODULES: ModuleItem[] = [
  { to: '/reports', label: 'Catalogue', end: true },
  { to: '/reports/builder', label: 'Report builder', perm: ['reports:build'], match: (p) => p.startsWith('/reports/builder') },
  { to: '/reports/csat', label: 'Customer satisfaction', perm: ['surveys:read'] },
];

// ---- customer portal

export const PORTAL_ASSET_MODULES: ModuleItem[] = [
  { to: '/portal/assets', label: 'Overview', end: true },
  { to: '/portal/assets/inventory', label: 'Inventory' },
  { to: '/portal/assets/coverage', label: 'Warranty & AMC' },
  { to: '/portal/assets/software', label: 'Software', perm: ['portal:software'] },
];

export const PORTAL_SERVICE_MODULES: ModuleItem[] = [
  { to: '/portal/services', label: 'Services', end: true },
  { to: '/portal/services/sla', label: 'Service levels' },
  { to: '/portal/services/contracts', label: 'Contracts' },
];

export const PORTAL_MAINTENANCE_MODULES: ModuleItem[] = [
  { to: '/portal/maintenance', label: 'Upcoming', end: true },
  { to: '/portal/maintenance/history', label: 'History' },
];

export const PORTAL_KNOWLEDGE_MODULES: ModuleItem[] = [
  { to: '/knowledge', label: 'Overview', end: true },
  { to: '/knowledge/articles', label: 'Articles' },
  { to: '/knowledge/known-errors', label: 'Known errors', perm: ['portal:kedb'], match: (p) => p.startsWith('/knowledge/known-errors') },
];

export const PORTAL_STATUS_MODULES: ModuleItem[] = [
  { to: '/portal/status', label: 'Status', end: true },
  { to: '/portal/changes', label: 'Planned changes' },
];
