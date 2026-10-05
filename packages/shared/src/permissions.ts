import { ALL_NAV_AREAS, type NavArea } from './constants.js';
/**
 * Permission catalog.
 *
 * Permissions are the atomic unit of authorization. Roles are bundles of
 * permissions; role assignments may be global (all customers the user can see)
 * or scoped to a single customer. The three initial user categories
 * (Customer / Engineer / Admin) are simply pre-built roles on top of this model.
 *
 * Naming: `<module>:<action>`. Keep the list flat and explicit so that the
 * administration UI can render it and auditors can reason about it.
 */
export const PERMISSIONS = {
  // Tenant visibility
  'tenant:all': 'See every customer (MSP-wide visibility). Without it, visibility is limited to explicitly granted customers/teams.',

  // Customers, sites, contacts
  'customers:read': 'View customers, sites and contacts',
  'customers:manage': 'Create and edit customers, sites and contacts',

  // Contracts, entitlements, scope
  'contracts:read': 'View contracts, entitlements and scope',
  'contracts:manage': 'Create and edit contracts, entitlements and scope',

  // Services
  'services:read': 'View the service catalog',
  'services:manage': 'Manage the service catalog',

  // Tickets (incidents, service requests, problems, changes)
  'tickets:read': 'View tickets',
  'tickets:create': 'Create tickets',
  'tickets:update': 'Edit ticket fields',
  'tickets:assign': 'Assign tickets to teams and engineers',
  'tickets:resolve': 'Resolve and close tickets',
  'tickets:delete': 'Delete tickets',
  'tickets:work_notes': 'Add internal work notes',
  'tickets:comment': 'Add customer-visible comments',
  'tickets:time': 'Record time against tickets',
  'tickets:scope': 'Override scope classification on tickets',
  'tickets:escalate': 'Escalate tickets',
  'problems:manage': 'Manage problem records (root cause, known errors)',
  'changes:manage': 'Manage change records',
  'changes:approve': 'Approve changes',
  'requests:approve': 'Approve service requests',
  'soc:read': 'View security (SOC) tickets and security information',
  'soc:manage': 'Work security (SOC) tickets',

  // Operations (major incidents, on-call, CAB, announcements, handover)
  'tickets:major': 'Declare and run major incidents (bridge, stakeholder updates, review)',
  'oncall:read': 'See who is on call and the on-call rotas',
  'oncall:manage': 'Manage on-call rotas, overrides and escalation policies',
  'changes:cab': 'Run CAB meetings and record decisions',
  'announcements:manage': 'Publish announcements and status page notices',
  'handover:write': 'Write and acknowledge shift handovers',

  // Assets & CMDB
  'assets:read': 'View assets',
  'assets:manage': 'Create and edit assets',
  'cmdb:read': 'View configuration items and relationships',
  'cmdb:manage': 'Create and edit configuration items and relationships',
  'discovery:run': 'Run network discovery and reconcile findings',
  'discovery:manage': 'Configure discovery sources',
  'software:read': 'View software titles, installations, licences and compliance',
  'software:manage': 'Create and edit software titles, installations and licences; import CSV',

  // Field service & maintenance
  'field:read': 'View field visits',
  'field:manage': 'Schedule and manage field visits',
  'field:execute': 'Execute assigned field visits (notes, parts, acknowledgement)',
  'pm:read': 'View preventive maintenance programs',
  'pm:manage': 'Manage preventive maintenance programs',

  // Knowledge
  'kb:read': 'Read knowledge articles',
  'kb:manage': 'Author and publish knowledge articles',
  'kedb:read': 'View the known error database (problems flagged as known errors, their workarounds and fix changes)',
  'kedb:publish': 'Publish known errors to the customer portal with customer-facing wording, update or withdraw them',

  // Reporting & dashboards
  'reports:run': 'Run reports',
  'reports:manage': 'Configure scheduled reports',
  'dashboards:management': 'View management dashboards',
  'dashboards:noc': 'View NOC dashboards',
  'dashboards:soc': 'View SOC dashboards',
  'dashboards:amc': 'View AMC / field service dashboards',

  // Customer satisfaction
  'surveys:read': 'View customer satisfaction responses and CSAT figures',
  'surveys:manage': 'Configure survey policies per customer or contract and send surveys by hand',

  // Integrations
  'integrations:manage': 'Configure monitoring/security integrations',
  'integrations:events': 'View integration events',

  // AI
  'ai:use': 'Use the AI assistant',
  'ai:act': 'Allow the AI assistant to perform actions on your behalf',

  // Administration
  'admin:config': 'Manage platform configuration (categories, SLAs, calendars, templates, rules)',
  'admin:users': 'Manage users, roles and teams',
  'admin:audit': 'View the audit trail',
  'admin:system': 'Manage system settings',

  // Customer portal
  'portal:access': 'Access the customer portal',
  'portal:tickets': 'Raise and track tickets in the customer portal',
  'portal:approve': 'Approve requests on behalf of the customer',
  'portal:assets': 'View assets and configuration items in the portal',
  'portal:contracts': 'View contracts, scope and SLA in the portal',
  'portal:reports': 'View reports in the portal',
  'portal:manage_users': 'Manage portal users for the customer',
  'portal:status': 'View the service status page in the portal',
  'portal:kedb': 'View published known errors and their workarounds in the portal',
  'portal:software': "View the organisation's software inventory and licence position in the portal",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const PERMISSION_MODULES: Record<string, Permission[]> = {
  Visibility: ['tenant:all'],
  Customers: ['customers:read', 'customers:manage'],
  Contracts: ['contracts:read', 'contracts:manage'],
  Services: ['services:read', 'services:manage'],
  Tickets: [
    'tickets:read', 'tickets:create', 'tickets:update', 'tickets:assign', 'tickets:resolve',
    'tickets:delete', 'tickets:work_notes', 'tickets:comment', 'tickets:time', 'tickets:scope',
    'tickets:escalate', 'problems:manage', 'changes:manage', 'changes:approve', 'requests:approve',
  ],
  Security: ['soc:read', 'soc:manage'],
  Operations: ['tickets:major', 'oncall:read', 'oncall:manage', 'changes:cab', 'announcements:manage', 'handover:write'],
  'Assets & CMDB': ['assets:read', 'assets:manage', 'cmdb:read', 'cmdb:manage', 'discovery:run', 'discovery:manage', 'software:read', 'software:manage'],
  'Field Service': ['field:read', 'field:manage', 'field:execute', 'pm:read', 'pm:manage'],
  Knowledge: ['kb:read', 'kb:manage', 'kedb:read', 'kedb:publish'],
  Reporting: ['reports:run', 'reports:manage', 'dashboards:management', 'dashboards:noc', 'dashboards:soc', 'dashboards:amc'],
  'Customer satisfaction': ['surveys:read', 'surveys:manage'],
  Integrations: ['integrations:manage', 'integrations:events'],
  AI: ['ai:use', 'ai:act'],
  Administration: ['admin:config', 'admin:users', 'admin:audit', 'admin:system'],
  Portal: ['portal:access', 'portal:tickets', 'portal:approve', 'portal:assets', 'portal:contracts', 'portal:reports', 'portal:manage_users', 'portal:status', 'portal:kedb', 'portal:software'],
};

/** System roles shipped by default. Administrators can add more. */
/** Navigation areas each system role works in (see NAV_AREAS). Administrators see everything. */
export const SYSTEM_ROLE_AREAS: Record<string, NavArea[]> = {
  admin: ALL_NAV_AREAS,
  itsm_admin: ['tickets', 'customers', 'contracts', 'catalog', 'teams', 'knowledge', 'reports'],
  service_manager: ['tickets', 'operations', 'customers', 'contracts', 'catalog', 'teams', 'assets', 'cmdb', 'field', 'maintenance', 'knowledge', 'reports'],
  account_manager: ['tickets', 'customers', 'contracts', 'catalog', 'teams', 'reports'],
  engineer: ['tickets', 'operations', 'teams', 'assets', 'field', 'maintenance', 'knowledge'],
  service_desk: ['tickets', 'operations', 'customers', 'teams', 'field', 'knowledge'],
  noc_engineer: ['tickets', 'operations', 'teams', 'cmdb', 'discovery', 'monitoring', 'knowledge'],
  noc_manager: ['tickets', 'operations', 'customers', 'teams', 'assets', 'cmdb', 'discovery', 'monitoring', 'field', 'maintenance', 'knowledge', 'reports'],
  soc_analyst: ['tickets', 'operations', 'teams', 'cmdb', 'monitoring', 'knowledge'],
  soc_manager: ['tickets', 'operations', 'customers', 'teams', 'cmdb', 'monitoring', 'knowledge', 'reports'],
  cmdb_admin: ['tickets', 'teams', 'assets', 'cmdb', 'discovery', 'monitoring', 'knowledge'],
  contract_admin: ['customers', 'contracts', 'catalog', 'teams', 'reports'],
  management: ['tickets', 'customers', 'contracts', 'catalog', 'teams', 'reports'],
  auditor: ['tickets', 'customers', 'contracts', 'teams', 'reports'],
};

export const SYSTEM_ROLES: Record<string, { name: string; description: string; userType: 'msp' | 'customer'; permissions: Permission[] }> = {
  admin: {
    name: 'Administrator',
    description: 'Full administrative and operational access.',
    userType: 'msp',
    permissions: ALL_PERMISSIONS.filter((p) => !p.startsWith('portal:')),
  },
  itsm_admin: {
    name: 'ITSM Administrator',
    description: 'Configures the operating model: categories, SLAs, workflows, templates.',
    userType: 'msp',
    permissions: ['tenant:all', 'admin:config', 'admin:audit', 'customers:read', 'contracts:read', 'services:read', 'services:manage', 'tickets:read', 'kb:read', 'kb:manage', 'reports:run', 'dashboards:amc', 'reports:manage', 'dashboards:management', 'ai:use', 'oncall:read', 'oncall:manage', 'changes:cab', 'announcements:manage', 'kedb:read', 'kedb:publish', 'surveys:read', 'surveys:manage'],
  },
  service_manager: {
    name: 'Service Manager',
    description: 'Manages service delivery, SLAs and customer relationships.',
    userType: 'msp',
    permissions: ['tenant:all', 'customers:read', 'customers:manage', 'contracts:read', 'contracts:manage', 'services:read', 'tickets:read', 'tickets:create', 'tickets:update', 'tickets:assign', 'tickets:resolve', 'tickets:work_notes', 'tickets:comment', 'tickets:scope', 'tickets:escalate', 'problems:manage', 'changes:manage', 'changes:approve', 'requests:approve', 'assets:read', 'cmdb:read', 'field:read', 'field:manage', 'pm:read', 'pm:manage', 'kb:read', 'kb:manage', 'reports:run', 'dashboards:amc', 'reports:manage', 'dashboards:management', 'dashboards:noc', 'dashboards:soc', 'soc:read', 'ai:use', 'ai:act', 'tickets:major', 'oncall:read', 'oncall:manage', 'changes:cab', 'announcements:manage', 'handover:write', 'kedb:read', 'kedb:publish', 'surveys:read', 'surveys:manage', 'software:read', 'software:manage'],
  },
  account_manager: {
    name: 'Account Manager',
    description: 'Account ownership of customers and contracts.',
    userType: 'msp',
    permissions: ['customers:read', 'customers:manage', 'contracts:read', 'contracts:manage', 'services:read', 'tickets:read', 'tickets:comment', 'assets:read', 'cmdb:read', 'field:read', 'pm:read', 'kb:read', 'reports:run', 'dashboards:amc', 'dashboards:management', 'ai:use', 'oncall:read', 'kedb:read', 'surveys:read', 'surveys:manage', 'software:read'],
  },
  engineer: {
    name: 'Engineer',
    description: 'Works tickets, assets and CIs for assigned customers.',
    userType: 'msp',
    permissions: ['customers:read', 'contracts:read', 'services:read', 'tickets:read', 'tickets:create', 'tickets:update', 'tickets:assign', 'tickets:resolve', 'tickets:work_notes', 'tickets:comment', 'tickets:time', 'tickets:escalate', 'assets:read', 'assets:manage', 'cmdb:read', 'cmdb:manage', 'field:read', 'field:execute', 'pm:read', 'kb:read', 'kb:manage', 'reports:run', 'dashboards:amc', 'ai:use', 'ai:act', 'oncall:read', 'handover:write', 'kedb:read', 'software:read', 'software:manage'],
  },
  service_desk: {
    name: 'Service Desk Engineer',
    description: 'First-line ticket handling across all customers.',
    userType: 'msp',
    permissions: ['tenant:all', 'customers:read', 'contracts:read', 'services:read', 'tickets:read', 'tickets:create', 'tickets:update', 'tickets:assign', 'tickets:resolve', 'tickets:work_notes', 'tickets:comment', 'tickets:time', 'tickets:escalate', 'assets:read', 'cmdb:read', 'field:read', 'field:manage', 'pm:read', 'kb:read', 'reports:run', 'dashboards:amc', 'ai:use', 'ai:act', 'tickets:major', 'oncall:read', 'handover:write', 'kedb:read', 'surveys:read', 'software:read'],
  },
  noc_engineer: {
    name: 'NOC Engineer',
    description: 'Infrastructure monitoring and incident handling across all customers.',
    userType: 'msp',
    permissions: ['tenant:all', 'customers:read', 'contracts:read', 'services:read', 'tickets:read', 'tickets:create', 'tickets:update', 'tickets:assign', 'tickets:resolve', 'tickets:work_notes', 'tickets:comment', 'tickets:time', 'tickets:escalate', 'problems:manage', 'assets:read', 'cmdb:read', 'cmdb:manage', 'discovery:run', 'integrations:events', 'field:read', 'pm:read', 'kb:read', 'kb:manage', 'reports:run', 'dashboards:noc', 'ai:use', 'ai:act', 'tickets:major', 'oncall:read', 'handover:write', 'kedb:read', 'software:read'],
  },
  noc_manager: {
    name: 'NOC Manager',
    description: 'Manages NOC operations, escalations and engineer workload.',
    userType: 'msp',
    permissions: ['tenant:all', 'customers:read', 'contracts:read', 'services:read', 'tickets:read', 'tickets:create', 'tickets:update', 'tickets:assign', 'tickets:resolve', 'tickets:work_notes', 'tickets:comment', 'tickets:time', 'tickets:scope', 'tickets:escalate', 'problems:manage', 'changes:manage', 'changes:approve', 'assets:read', 'cmdb:read', 'cmdb:manage', 'discovery:run', 'discovery:manage', 'integrations:events', 'integrations:manage', 'field:read', 'field:manage', 'pm:read', 'pm:manage', 'kb:read', 'kb:manage', 'reports:run', 'dashboards:amc', 'reports:manage', 'dashboards:noc', 'dashboards:management', 'ai:use', 'ai:act', 'tickets:major', 'oncall:read', 'oncall:manage', 'changes:cab', 'announcements:manage', 'handover:write', 'kedb:read', 'kedb:publish', 'surveys:read', 'software:read'],
  },
  soc_analyst: {
    name: 'SOC Analyst',
    description: 'Security incident investigation across all customers.',
    userType: 'msp',
    permissions: ['tenant:all', 'customers:read', 'contracts:read', 'services:read', 'tickets:read', 'tickets:create', 'tickets:update', 'tickets:assign', 'tickets:resolve', 'tickets:work_notes', 'tickets:comment', 'tickets:time', 'tickets:escalate', 'soc:read', 'soc:manage', 'problems:manage', 'assets:read', 'cmdb:read', 'integrations:events', 'kb:read', 'kb:manage', 'reports:run', 'dashboards:soc', 'ai:use', 'ai:act', 'tickets:major', 'oncall:read', 'handover:write', 'kedb:read', 'software:read'],
  },
  soc_manager: {
    name: 'SOC Manager',
    description: 'Manages SOC operations and security escalations.',
    userType: 'msp',
    permissions: ['tenant:all', 'customers:read', 'contracts:read', 'services:read', 'tickets:read', 'tickets:create', 'tickets:update', 'tickets:assign', 'tickets:resolve', 'tickets:work_notes', 'tickets:comment', 'tickets:time', 'tickets:scope', 'tickets:escalate', 'soc:read', 'soc:manage', 'problems:manage', 'changes:manage', 'changes:approve', 'assets:read', 'cmdb:read', 'integrations:events', 'integrations:manage', 'kb:read', 'kb:manage', 'reports:run', 'reports:manage', 'dashboards:soc', 'dashboards:management', 'ai:use', 'ai:act', 'tickets:major', 'oncall:read', 'oncall:manage', 'changes:cab', 'announcements:manage', 'handover:write', 'kedb:read', 'kedb:publish', 'surveys:read', 'software:read'],
  },
  cmdb_admin: {
    name: 'CMDB Administrator',
    description: 'Owns asset and configuration data quality.',
    userType: 'msp',
    permissions: ['tenant:all', 'customers:read', 'contracts:read', 'services:read', 'tickets:read', 'assets:read', 'assets:manage', 'cmdb:read', 'cmdb:manage', 'discovery:run', 'discovery:manage', 'integrations:events', 'kb:read', 'reports:run', 'ai:use', 'oncall:read', 'kedb:read', 'software:read', 'software:manage'],
  },
  contract_admin: {
    name: 'Contract Administrator',
    description: 'Maintains contracts, entitlements and scope definitions.',
    userType: 'msp',
    permissions: ['tenant:all', 'customers:read', 'customers:manage', 'contracts:read', 'contracts:manage', 'services:read', 'tickets:read', 'tickets:scope', 'field:read', 'pm:read', 'reports:run', 'dashboards:amc', 'dashboards:management', 'ai:use', 'oncall:read', 'surveys:read', 'software:read', 'software:manage'],
  },
  management: {
    name: 'Management',
    description: 'Read-only management visibility across the business.',
    userType: 'msp',
    permissions: ['tenant:all', 'customers:read', 'contracts:read', 'services:read', 'tickets:read', 'soc:read', 'assets:read', 'cmdb:read', 'field:read', 'pm:read', 'kb:read', 'reports:run', 'dashboards:amc', 'dashboards:management', 'dashboards:noc', 'dashboards:soc', 'ai:use', 'oncall:read', 'kedb:read', 'surveys:read', 'software:read'],
  },
  auditor: {
    name: 'Auditor',
    description: 'Read-only access including the audit trail.',
    userType: 'msp',
    permissions: ['tenant:all', 'customers:read', 'contracts:read', 'services:read', 'tickets:read', 'soc:read', 'assets:read', 'cmdb:read', 'field:read', 'pm:read', 'kb:read', 'reports:run', 'dashboards:amc', 'admin:audit', 'dashboards:management', 'oncall:read', 'kedb:read', 'surveys:read', 'software:read'],
  },
  customer_admin: {
    name: 'Customer Administrator',
    description: 'Customer portal administrator for their own organization.',
    userType: 'customer',
    permissions: ['portal:access', 'portal:tickets', 'portal:approve', 'portal:assets', 'portal:contracts', 'portal:reports', 'portal:manage_users', 'ai:use', 'ai:act', 'portal:status', 'portal:kedb', 'portal:software'],
  },
  customer_user: {
    name: 'Customer User',
    description: 'Raises and tracks tickets for their own organization.',
    userType: 'customer',
    permissions: ['portal:access', 'portal:tickets', 'portal:contracts', 'portal:assets', 'ai:use', 'ai:act', 'portal:status', 'portal:kedb'],
  },
};
