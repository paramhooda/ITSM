import type { Permission } from './permissions.js';

/**
 * The application map: every application and page of Progression, what it is
 * for, who may open it and how common tasks are done there. One source for the
 * assistant (where-is and how-to answers, validated navigation, page-aware
 * toolsets), the web (page context, capability hints) and the tests (every
 * route has an entry).
 */

export interface AppEntry {
  key: string;
  label: string;
  description: string;
  /** Any of these permissions opens the application. */
  perm?: Permission[];
  /** Shown in the customer portal. */
  portal?: boolean;
}

export type PageEntity = 'ticket' | 'customer' | 'contract' | 'asset' | 'ci' | 'field_visit' | 'kb_article' | 'sla_policy' | 'discovery_source' | 'discovery_run' | 'discovery_finding' | 'cab_meeting';

export interface AppPage {
  /** Stable key such as `tickets.list`. */
  key: string;
  app: string;
  label: string;
  /** Route pattern; `:id` marks a parameter. */
  route: string;
  purpose: string;
  /** Any of these permissions opens the page (none: every signed-in user of that shell). */
  perm?: Permission[];
  /** Available in the customer portal shell. */
  portal?: boolean;
  /** Available in the staff shell (default true unless the page is portal-only). */
  staff?: boolean;
  /** Query parameters the page understands (the assistant may pass these when navigating). */
  filters?: string[];
  /** The record kind a detail page shows. */
  entity?: PageEntity;
  /** Assistant toolsets that fit this page. */
  toolsets?: string[];
  /** How-to steps for the tasks people do here. */
  howTo?: string[];
  /** Redirect or technical page: never offered as a destination. */
  hidden?: boolean;
}

export const APPLICATIONS: AppEntry[] = [
  { key: 'dashboards', label: 'Dashboards', description: 'Home dashboards: management overview, NOC, SOC, AMC and my work, with a period and customer scope.' },
  { key: 'tickets', label: 'Tickets', description: 'Incidents, service requests, problems and changes with SLA clocks, approvals, comments and work notes.', perm: ['tickets:read'] },
  { key: 'operations', label: 'Operations', description: 'Major incidents (bridge, commander, stakeholder updates, post-incident review) and on-call (rotas, cover, escalation policies, paging).', perm: ['tickets:read'] },
  { key: 'customers', label: 'Customers', description: 'Customer accounts with sites, contacts, teams and an overview of tickets, contracts and SLA.', perm: ['customers:read'] },
  { key: 'contracts', label: 'Contracts & scope', description: 'Contracts, entitlements (AMC visits, support hours), scope items and the service levels attached to them.', perm: ['contracts:read'] },
  { key: 'services', label: 'Service catalog', description: 'The services the MSP delivers, grouped by category, with the customers subscribed to each.', perm: ['services:read'] },
  { key: 'teams', label: 'Teams', description: 'Teams, their members and leads.', perm: ['tickets:read', 'admin:users'] },
  { key: 'cmdb', label: 'Configuration (CMDB)', description: 'Configuration items, relationships, business services, the service map and discovery.', perm: ['cmdb:read'] },
  { key: 'assets', label: 'Assets', description: 'Asset inventory with warranty and AMC coverage and lifecycle stages.', perm: ['assets:read'] },
  { key: 'field', label: 'Field service', description: 'Field visits, the engineer calendar and preventive-maintenance programs.', perm: ['field:read', 'pm:read'] },
  { key: 'knowledge', label: 'Knowledge', description: 'Knowledge articles: SOPs, runbooks, known errors and troubleshooting, for staff and for customers.', perm: ['kb:read', 'portal:access'], portal: true },
  { key: 'reports', label: 'Reports', description: 'Operational and contractual reports with CSV and HTML output, and scheduled deliveries.', perm: ['reports:run', 'portal:reports'], portal: true },
  { key: 'admin', label: 'Administration', description: 'Option lists, SLA policies, calendars, automation rules, notification templates, request catalog, users, roles, settings, audit log and integrations.', perm: ['admin:config', 'admin:users', 'admin:audit', 'admin:system', 'integrations:manage', 'integrations:events'] },
  { key: 'portal', label: 'Customer portal', description: 'Self-service for customer users: raise and track tickets, approvals, services and SLA, assets, maintenance and visits, knowledge, reports and their own users.', portal: true },
];

const p = (page: AppPage): AppPage => page;
const CONFIG: Permission[] = ['admin:config'];
const USERS: Permission[] = ['admin:users'];
const SYSTEM: Permission[] = ['admin:system', 'admin:config'];

export const APP_PAGES: AppPage[] = [
  // ---- home
  p({ key: 'home', app: 'dashboards', label: 'Home', route: '/', purpose: 'The home dashboard: management overview, NOC, SOC, AMC or my work for staff; the customer overview in the portal.', portal: true, filters: ['view', 'days', 'customerId'], toolsets: ['reports'], howTo: ['Switch the view with the tabs in the hero (Management, NOC, SOC, AMC, My work).', 'Change the period (7, 30, 90 days) and the customer scope in the hero filter row.', 'Click a KPI tile to open the matching list with the filter applied.'] }),

  // ---- tickets
  p({ key: 'tickets.list', app: 'tickets', label: 'Tickets', route: '/tickets', purpose: 'Every ticket the user may see, with quick views (Open, Assigned to me, Unassigned, by type), filters, KPI tiles and the insight band.', perm: ['tickets:read'], filters: ['q', 'type', 'status', 'statusCategory', 'priority', 'assignee', 'team', 'customer', 'customerId', 'slaState', 'scope', 'isMajor', 'view', 'sort'], toolsets: ['tickets', 'triage'], howTo: ['Use the filter bar pills (Type, Status, Priority, Customer, Assignee, SLA) to narrow the list; the URL keeps the filters.', 'Click a KPI tile to toggle its filter; click again to clear it.', 'Press n to create a new ticket.'] }),
  p({ key: 'tickets.new', app: 'tickets', label: 'New ticket', route: '/tickets/new', purpose: 'Create an incident, request, problem or change for a customer, with classification, assignment and affected CIs.', perm: ['tickets:create'], filters: ['type', 'customerId', 'title', 'description', 'priorityId', 'serviceId', 'siteId', 'categoryId', 'catalogItemId', 'templateId'], toolsets: ['tickets'], howTo: ['Pick the type and customer first; the service and site lists follow the customer.', 'Use "Suggest category & priority" to classify from the title and description.', 'Scope is classified automatically from the customer contract when the ticket is saved.'] }),
  p({ key: 'tickets.approvals', app: 'tickets', label: 'My approvals', route: '/tickets/approvals', purpose: 'Requests and changes waiting for the user\'s approval decision.', perm: ['requests:approve', 'changes:approve'], toolsets: ['approvals'], howTo: ['Open a row to read the ticket, then Approve or Reject with an optional comment.', 'Sequential workflows move to the next step after each decision.'] }),
  p({ key: 'tickets.detail', app: 'tickets', label: 'Ticket', route: '/tickets/:id', purpose: 'One ticket: details, SLA ribbon, comments and work notes, tasks, time, links, CIs, approvals, major-incident panel and the AI assist rail.', perm: ['tickets:read'], entity: 'ticket', toolsets: ['tickets', 'triage'], howTo: ['Reply to the customer with a comment, or add an internal work note from the composer.', 'Assign, change status, resolve, close, escalate and declare a major incident from the header actions.', 'The Assist tab in the right rail summarises, classifies, recommends an owner and drafts updates.'] }),
  p({ key: 'operations', app: 'operations', label: 'Operations', route: '/operations', purpose: 'Operations home (major incidents and on-call).', perm: ['tickets:read'], hidden: true }),
  p({ key: 'operations.oncall', app: 'operations', label: 'On-call', route: '/operations/on-call', purpose: 'Who is on call now for each team, the rota calendar for the coming weeks, cover (overrides), the rotas and escalation policies, and recent pages.', perm: ['oncall:read'], filters: ['teamId', 'week', 'tab'], toolsets: ['incident'], howTo: ['Pick a team to see its rotas, who is on call now and the calendar; add cover for yourself from the calendar (managers can add cover for anyone).', 'Rotas and escalation policies are edited on the Rotas and Policies tabs by people with oncall:manage; a team\'s default policy is set on its rota card.', 'Page someone from a ticket\'s actions menu (Page on-call…); the page escalates step by step until it is acknowledged from the message link or the ticket.'] }),
  p({ key: 'operations.major', app: 'operations', label: 'Major incidents', route: '/operations/major-incidents', purpose: 'Active and recent major incidents: bridge, commander, communications lead, last and next stakeholder update, child incidents.', perm: ['tickets:read'], filters: ['status', 'customerId', 'q'], toolsets: ['incident'], howTo: ['Declare a major incident from the incident\'s actions menu (Declare major incident…).', 'Post stakeholder updates from the Major incident tab of the ticket; the portal banner follows the setting on the record.', 'Complete the post-incident review on the same tab once the incident is resolved.'] }),
  p({ key: 'operations.announcements', app: 'operations', label: 'Announcements', route: '/operations/announcements', purpose: 'Banners for customers and staff (notices, planned maintenance, outage updates) with an audience, a customer list and a window; the public status page links per customer.', perm: ['announcements:manage'], filters: ['state', 'type', 'audience', 'customerId', 'q', 'tab'], toolsets: ['incident'], howTo: ['New announcement: pick the type and the audience, write the title and the message (or let Grady draft them from a ticket), set the window and publish; it appears above every page for its audience at once.', 'Status pages: pick a customer and create a link; the full link is shown once and can be revoked.'] }),
  p({ key: 'operations.changeCalendar', app: 'operations', label: 'Change calendar', route: '/operations/change-calendar', purpose: 'Every scheduled change window on a week or month grid, with the clashes between them (shared systems, the same business service, blackout windows) and the blackout windows in force.', perm: ['tickets:read'], filters: ['view', 'day', 'customerId', 'type', 'conflicts'], toolsets: ['tickets'], howTo: ['Switch between week and month, step with the arrows; click a chip to open the change plan.', 'A red ring marks a conflict; the amber bars are blackout windows (Administration → Blackout windows).'] }),
  p({ key: 'operations.cab', app: 'operations', label: 'CAB meetings', route: '/operations/cab', purpose: 'The change advisory board: meetings with their agenda of changes, the decisions and the minutes.', perm: ['changes:cab', 'changes:approve', 'changes:manage'], filters: ['status', 'q'], toolsets: ['approvals', 'tickets'], howTo: ['New meeting, then add the changes awaiting a decision; approve, reject or defer each one (an approval also decides the pending CAB step of the change); close the meeting with the minutes.'] }),
  p({ key: 'operations.cabMeeting', app: 'operations', label: 'CAB meeting', route: '/operations/cab/:id', purpose: 'One CAB meeting: the agenda, a decision per change and the minutes.', perm: ['changes:cab', 'changes:approve', 'changes:manage'], entity: 'cab_meeting', toolsets: ['approvals', 'tickets'] }),

  // ---- customers
  p({ key: 'customers.overview', app: 'customers', label: 'Customers overview', route: '/customers', purpose: 'Customer KPIs: active accounts, open tickets, SLA breaches and expiring contracts, with links into the account list.', perm: ['customers:read'], toolsets: ['customers'] }),
  p({ key: 'customers.list', app: 'customers', label: 'Accounts', route: '/customers/accounts', purpose: 'Customer accounts with open ticket and active contract counts, status and account manager.', perm: ['customers:read'], filters: ['q', 'status', 'accountManager', 'isActive'], toolsets: ['customers'], howTo: ['Open an account for its overview, sites, contacts, contracts, tickets, users and teams.', 'Create a customer with the New customer button (customers:manage).'] }),
  p({ key: 'customers.detail', app: 'customers', label: 'Customer', route: '/customers/:id', purpose: 'One customer: overview, sites, contacts, escalation contacts, contracts and entitlements, tickets, users, documents and assigned teams.', perm: ['customers:read'], entity: 'customer', toolsets: ['customers', 'contracts'] }),

  // ---- contracts
  p({ key: 'contracts.overview', app: 'contracts', label: 'Contracts overview', route: '/contracts', purpose: 'Contract KPIs: active, expiring within 90 days, entitlement consumption and out-of-scope work.', perm: ['contracts:read'], toolsets: ['contracts'] }),
  p({ key: 'contracts.list', app: 'contracts', label: 'Contracts', route: '/contracts/list', purpose: 'All contracts with status, dates, days to expiry and covered services.', perm: ['contracts:read'], filters: ['q', 'status', 'customerId', 'expiringWithinDays', 'serviceId'], toolsets: ['contracts'], howTo: ['Filter by status or expiry window from the filter bar.', 'Open a contract to manage services, sites, entitlements and scope items, or to activate, renew and terminate it.'] }),
  p({ key: 'contracts.entitlements', app: 'contracts', label: 'Entitlements', route: '/contracts/entitlements', purpose: 'Entitlement consumption across contracts: AMC visits, support hours and incident quotas with used, remaining and thresholds.', perm: ['contracts:read'], filters: ['customerId', 'type', 'state'], toolsets: ['contracts'] }),
  p({ key: 'contracts.detail', app: 'contracts', label: 'Contract', route: '/contracts/:id', purpose: 'One contract: services, sites, entitlements and consumption, scope items, SLA policy and history.', perm: ['contracts:read'], entity: 'contract', toolsets: ['contracts'] }),
  p({ key: 'sla.list', app: 'contracts', label: 'Service levels', route: '/sla', purpose: 'SLA policies with their targets per ticket type and priority, pause statuses, the contracts they apply to and 30-day compliance.', perm: ['contracts:read', 'admin:config'], toolsets: ['contracts'], howTo: ['Open a policy to see targets and compliance; administrators edit targets under Administration → SLA policies.'] }),
  p({ key: 'sla.detail', app: 'contracts', label: 'SLA policy', route: '/sla/:id', purpose: 'One SLA policy.', perm: ['contracts:read', 'admin:config'], entity: 'sla_policy', hidden: true }),
  p({ key: 'services.catalog', app: 'services', label: 'Service catalog', route: '/services', purpose: 'The MSP service catalog grouped by category and service line, with subscribed customers and incident counts per service.', perm: ['services:read'], filters: ['line', 'q', 'domain'], toolsets: ['config'], howTo: ['Filter by service line from the filter bar; sections update in place.', 'Administrators manage services under Administration → Service catalog.'] }),
  p({ key: 'teams', app: 'teams', label: 'Teams', route: '/teams', purpose: 'Teams with members, leads and open work per team.', perm: ['tickets:read', 'admin:users'], toolsets: ['config'] }),

  // ---- assets
  p({ key: 'assets.overview', app: 'assets', label: 'Assets overview', route: '/assets', purpose: 'Asset KPIs: inventory size, warranty and AMC cover expiring, lifecycle distribution.', perm: ['assets:read'], toolsets: ['assets'] }),
  p({ key: 'assets.inventory', app: 'assets', label: 'Inventory', route: '/assets/inventory', purpose: 'Every asset with tag, model, serial, site, lifecycle and coverage.', perm: ['assets:read'], filters: ['q', 'customerId', 'siteId', 'lifecycleStage', 'expired', 'warrantyExpiringDays', 'amcExpiringDays', 'hasCi'], toolsets: ['assets'], howTo: ['Import assets from CSV with the Import button (assets:manage); download the template first.', 'Open an asset to link or create its configuration item and to move it through the lifecycle.'] }),
  p({ key: 'assets.coverage', app: 'assets', label: 'Warranty & AMC', route: '/assets/coverage', purpose: 'Assets whose warranty or AMC cover expires soon or has lapsed.', perm: ['assets:read'], filters: ['kind', 'days', 'customerId'], toolsets: ['assets'] }),
  p({ key: 'assets.lifecycle', app: 'assets', label: 'Lifecycle', route: '/assets/lifecycle', purpose: 'Assets by lifecycle stage (ordered, in stock, deployed, in repair, retired, disposed).', perm: ['assets:read'], filters: ['stage', 'customerId'], toolsets: ['assets'] }),
  p({ key: 'assets.detail', app: 'assets', label: 'Asset', route: '/assets/:id', purpose: 'One asset: details, coverage, linked CI, tickets and lifecycle history.', perm: ['assets:read'], entity: 'asset', toolsets: ['assets'] }),

  // ---- cmdb and discovery
  p({ key: 'cmdb.overview', app: 'cmdb', label: 'CMDB overview', route: '/cmdb', purpose: 'CMDB KPIs: CIs by type and status, stale CIs, business services and discovery activity.', perm: ['cmdb:read'], toolsets: ['cmdb'] }),
  p({ key: 'cmdb.cis', app: 'cmdb', label: 'Configuration items', route: '/cmdb/cis', purpose: 'Configuration items with type, customer, site, status, criticality and owner team; bulk updates and CSV import.', perm: ['cmdb:read'], filters: ['q', 'customerId', 'typeKey', 'status', 'criticality', 'environment', 'serviceId', 'stale'], toolsets: ['cmdb'], howTo: ['Select rows for a bulk update of status, criticality, environment or owner team (cmdb:manage).', 'Open a CI for its relationships, graph, impact and history.'] }),
  p({ key: 'cmdb.ci', app: 'cmdb', label: 'Configuration item', route: '/cmdb/cis/:id', purpose: 'One CI: attributes, interfaces, relationships, dependency graph, impact, open tickets and history.', perm: ['cmdb:read'], entity: 'ci', toolsets: ['cmdb'] }),
  p({ key: 'cmdb.services', app: 'cmdb', label: 'Business services', route: '/cmdb/services', purpose: 'Business services with their dependent CIs and open tickets.', perm: ['cmdb:read'], toolsets: ['cmdb'] }),
  p({ key: 'cmdb.serviceMap', app: 'cmdb', label: 'Service map', route: '/cmdb/services/:id', purpose: 'The dependency map of one business service.', perm: ['cmdb:read'], toolsets: ['cmdb'] }),
  p({ key: 'cmdb.map', app: 'cmdb', label: 'Service map', route: '/cmdb/map', purpose: 'Pick a business service and explore its dependency map.', perm: ['cmdb:read'], toolsets: ['cmdb'] }),
  p({ key: 'cmdb.classes', app: 'cmdb', label: 'CI classes', route: '/cmdb/classes', purpose: 'CI types (classes) and how many items each holds.', perm: ['cmdb:read'], toolsets: ['cmdb'] }),
  p({ key: 'cmdb.ciRedirect', app: 'cmdb', label: 'Configuration item', route: '/cmdb/:id', purpose: 'Redirects to the CI page.', perm: ['cmdb:read'], hidden: true }),
  p({ key: 'discovery.overview', app: 'cmdb', label: 'Discovery', route: '/cmdb/discovery', purpose: 'Discovery KPIs: sources, recent runs, findings waiting to be reviewed.', perm: ['discovery:run', 'discovery:manage'], toolsets: ['cmdb'], howTo: ['Run a source from its page; findings appear in the queue with new, changed and unchanged states.', 'Apply or ignore findings one by one or in bulk; applying creates or updates CIs.'] }),
  p({ key: 'discovery.sources', app: 'cmdb', label: 'Discovery sources', route: '/cmdb/discovery/sources', purpose: 'Discovery sources (SNMP, agents, imports) per customer.', perm: ['discovery:run', 'discovery:manage'], toolsets: ['cmdb'] }),
  p({ key: 'discovery.source', app: 'cmdb', label: 'Discovery source', route: '/cmdb/discovery/sources/:id', purpose: 'One discovery source with its runs.', perm: ['discovery:run', 'discovery:manage'], entity: 'discovery_source', toolsets: ['cmdb'] }),
  p({ key: 'discovery.runs', app: 'cmdb', label: 'Discovery runs', route: '/cmdb/discovery/runs', purpose: 'All discovery runs with status and counts.', perm: ['discovery:run', 'discovery:manage'], filters: ['status', 'sourceId'], toolsets: ['cmdb'] }),
  p({ key: 'discovery.run', app: 'cmdb', label: 'Discovery run', route: '/cmdb/discovery/runs/:id', purpose: 'One discovery run and its findings.', perm: ['discovery:run', 'discovery:manage'], entity: 'discovery_run', toolsets: ['cmdb'] }),
  p({ key: 'discovery.findings', app: 'cmdb', label: 'Findings', route: '/cmdb/discovery/findings', purpose: 'The findings queue: discovered devices to apply to the CMDB or ignore.', perm: ['discovery:run', 'discovery:manage'], filters: ['status', 'diffStatus', 'q', 'customerId', 'sourceId'], toolsets: ['cmdb'] }),
  p({ key: 'discovery.finding', app: 'cmdb', label: 'Finding', route: '/cmdb/discovery/findings/:id', purpose: 'One discovery finding with the proposed CI changes.', perm: ['discovery:run', 'discovery:manage'], entity: 'discovery_finding', toolsets: ['cmdb'] }),
  p({ key: 'discovery.redirect', app: 'cmdb', label: 'Discovery', route: '/discovery', purpose: 'Redirects to discovery.', perm: ['discovery:run', 'discovery:manage'], hidden: true }),
  p({ key: 'integrations.redirect', app: 'admin', label: 'Monitoring & SIEM', route: '/integrations', purpose: 'Redirects to Administration → Monitoring & SIEM.', perm: ['integrations:events', 'integrations:manage'], hidden: true }),

  // ---- field service and maintenance
  p({ key: 'field.overview', app: 'field', label: 'Field service overview', route: '/field', purpose: 'Field KPIs: visits today and this week, unscheduled requests, engineer workload and completed work.', perm: ['field:read'], toolsets: ['field'] }),
  p({ key: 'field.visits', app: 'field', label: 'Visits', route: '/field/visits', purpose: 'Field visits with status, engineer, customer, site and schedule.', perm: ['field:read'], filters: ['q', 'status', 'engineerId', 'customerId', 'from', 'to', 'typeId'], toolsets: ['field'], howTo: ['Create a visit with New visit (field:manage), then schedule it with an engineer and a window.', 'Engineers start, complete and add notes and parts from the visit page; customers acknowledge in the portal.'] }),
  p({ key: 'field.calendar', app: 'field', label: 'Calendar', route: '/field/calendar', purpose: 'Visits and maintenance on a week calendar per engineer.', perm: ['field:read'], filters: ['from', 'engineerId', 'teamId'], toolsets: ['field'] }),
  p({ key: 'field.visit', app: 'field', label: 'Field visit', route: '/field/:id', purpose: 'One field visit: schedule, engineer, ticket, parts, notes, report and acknowledgement.', perm: ['field:read'], entity: 'field_visit', toolsets: ['field'] }),
  p({ key: 'maintenance', app: 'field', label: 'Preventive maintenance', route: '/maintenance', purpose: 'Preventive-maintenance programs and their occurrences: planned, scheduled, completed and missed.', perm: ['pm:read'], filters: ['customerId', 'status', 'from', 'to'], toolsets: ['field'], howTo: ['Programs generate occurrences from their frequency; schedule an occurrence to create the visit.', 'Complete an occurrence with the checklist results from the visit.'] }),

  // ---- knowledge (shared)
  p({ key: 'knowledge.overview', app: 'knowledge', label: 'Knowledge overview', route: '/knowledge', purpose: 'Knowledge KPIs and recent articles.', perm: ['kb:read', 'portal:access'], portal: true, toolsets: ['knowledge'] }),
  p({ key: 'knowledge.articles', app: 'knowledge', label: 'Articles', route: '/knowledge/articles', purpose: 'Knowledge articles (SOPs, runbooks, known errors, troubleshooting) with search and filters.', perm: ['kb:read', 'portal:access'], portal: true, filters: ['q', 'categoryId', 'articleType', 'status', 'visibility'], toolsets: ['knowledge'], howTo: ['Search by words in the title, summary or body.', 'Authors create and publish articles with kb:manage; versions can be restored.'] }),
  p({ key: 'knowledge.categories', app: 'knowledge', label: 'Categories', route: '/knowledge/categories', purpose: 'Knowledge categories.', perm: ['kb:manage'], toolsets: ['knowledge'] }),
  p({ key: 'knowledge.article', app: 'knowledge', label: 'Knowledge article', route: '/knowledge/:id', purpose: 'One article with its versions and feedback.', perm: ['kb:read', 'portal:access'], portal: true, entity: 'kb_article', toolsets: ['knowledge'] }),

  // ---- reports (shared)
  p({ key: 'reports', app: 'reports', label: 'Reports', route: '/reports', purpose: 'Run a report (open tickets, volume, SLA performance, service report, AMC utilisation, contract expiry, maintenance, visits, security incidents, assets, CMDB, audit) with parameters, download CSV or HTML, and manage schedules.', perm: ['reports:run', 'portal:reports'], portal: true, filters: ['key', 'customerId', 'dateRange'], toolsets: ['reports'], howTo: ['Pick a report, set the customer and date range, then Run; CSV and HTML downloads are kept under Runs.', 'Schedules (reports:manage) deliver a report by email on a cadence.'] }),

  // ---- administration
  p({ key: 'admin.overview', app: 'admin', label: 'Administration', route: '/admin', purpose: 'Administration home with attention items.', perm: ['admin:config', 'admin:users', 'admin:audit', 'admin:system', 'integrations:manage', 'integrations:events'], toolsets: ['config', 'admin'] }),
  p({ key: 'admin.options', app: 'admin', label: 'Option lists', route: '/admin/options', purpose: 'Ticket statuses, priorities, impacts, urgencies, categories, sources, resolution codes and other option lists.', perm: CONFIG, toolsets: ['config', 'admin'], howTo: ['Pick the list on the left, then add, rename, reorder or deactivate options; system options cannot be deleted.'] }),
  p({ key: 'admin.priorityMatrix', app: 'admin', label: 'Priority matrix', route: '/admin/priority-matrix', purpose: 'Impact × urgency → priority.', perm: CONFIG, toolsets: ['config', 'admin'] }),
  p({ key: 'admin.customFields', app: 'admin', label: 'Custom fields', route: '/admin/custom-fields', purpose: 'Custom fields per entity.', perm: CONFIG, toolsets: ['config', 'admin'] }),
  p({ key: 'admin.services', app: 'admin', label: 'Service catalog (admin)', route: '/admin/services', purpose: 'Create and edit the services of the catalog.', perm: ['services:manage'], toolsets: ['config', 'admin'] }),
  p({ key: 'admin.sla', app: 'admin', label: 'SLA policies', route: '/admin/sla', purpose: 'SLA policies: targets per ticket type and priority, calendars, pause statuses and contract assignment.', perm: CONFIG, toolsets: ['config', 'admin'] }),
  p({ key: 'admin.slaRedirect', app: 'admin', label: 'SLA policy', route: '/admin/sla/:id', purpose: 'Redirects to the SLA policy record.', perm: ['admin:config'], hidden: true }),
  p({ key: 'admin.calendars', app: 'admin', label: 'Business calendars', route: '/admin/calendars', purpose: 'Working hours used by SLA clocks.', perm: CONFIG, toolsets: ['config', 'admin'] }),
  p({ key: 'admin.holidays', app: 'admin', label: 'Holiday calendars', route: '/admin/holidays', purpose: 'Holidays that pause SLA clocks.', perm: CONFIG, toolsets: ['config', 'admin'] }),
  p({ key: 'admin.assignmentRules', app: 'admin', label: 'Assignment rules', route: '/admin/assignment-rules', purpose: 'Rules that route new tickets to teams and engineers.', perm: CONFIG, toolsets: ['config', 'admin'] }),
  p({ key: 'admin.escalationRules', app: 'admin', label: 'Escalation rules', route: '/admin/escalation-rules', purpose: 'Rules that escalate and notify on SLA warnings, breaches and other triggers.', perm: CONFIG, toolsets: ['config', 'admin'] }),
  p({ key: 'admin.changeTemplates', app: 'admin', label: 'Standard change templates', route: '/admin/change-templates', purpose: 'Repeatable, low-risk changes raised from a pattern: prefilled plans; a pre-approved template skips the approval workflow.', perm: CONFIG, toolsets: ['config', 'admin'] }),
  p({ key: 'admin.changeRiskQuestions', app: 'admin', label: 'Change risk questions', route: '/admin/change-risk-questions', purpose: 'The weighted questionnaire that scores a change low, medium or high (thresholds in the changes.risk_thresholds setting).', perm: CONFIG, toolsets: ['config', 'admin'] }),
  p({ key: 'admin.changeBlackouts', app: 'admin', label: 'Change blackout windows', route: '/admin/change-blackouts', purpose: 'Change freezes for one customer or everyone; a change scheduled inside one is warned on its record and the calendar.', perm: CONFIG, toolsets: ['config', 'admin'] }),
  p({ key: 'admin.notificationTemplates', app: 'admin', label: 'Notification templates', route: '/admin/notifications/templates', purpose: 'Email, in-app and WhatsApp templates per event.', perm: CONFIG, toolsets: ['config', 'admin'] }),
  p({ key: 'admin.notificationRules', app: 'admin', label: 'Notification rules', route: '/admin/notifications/rules', purpose: 'Who is notified on which event through which channel.', perm: CONFIG, toolsets: ['config', 'admin'] }),
  p({ key: 'admin.approvals', app: 'admin', label: 'Approval workflows', route: '/admin/approvals', purpose: 'Approval workflows with sequential steps for requests and changes.', perm: CONFIG, toolsets: ['config', 'admin'] }),
  p({ key: 'admin.catalog', app: 'admin', label: 'Request catalog', route: '/admin/catalog', purpose: 'Request catalog items with forms, offered to customers in the portal.', perm: CONFIG, toolsets: ['config', 'admin'] }),
  p({ key: 'admin.ciTypes', app: 'admin', label: 'CI types', route: '/admin/ci-types', purpose: 'CI classes and their attributes.', perm: CONFIG, toolsets: ['config', 'admin'] }),
  p({ key: 'admin.relationshipTypes', app: 'admin', label: 'Relationship types', route: '/admin/relationship-types', purpose: 'Relationship types between CIs and their impact direction.', perm: CONFIG, toolsets: ['config', 'admin'] }),
  p({ key: 'admin.users', app: 'admin', label: 'Users', route: '/admin/users', purpose: 'Staff and customer users, roles, teams and customer access.', perm: USERS, toolsets: ['iam'], howTo: ['Create a user, then assign roles (global or per customer), teams and customer access.', 'Reset a password from the user page.'] }),
  p({ key: 'admin.roles', app: 'admin', label: 'Roles', route: '/admin/roles', purpose: 'Roles and their permissions and navigation areas.', perm: USERS, toolsets: ['iam'] }),
  p({ key: 'admin.teams', app: 'admin', label: 'Teams (admin)', route: '/admin/teams', purpose: 'Create teams and manage members and leads.', perm: USERS, toolsets: ['iam'] }),
  p({ key: 'admin.apiKeys', app: 'admin', label: 'API keys', route: '/admin/api-keys', purpose: 'API keys for integrations with their permissions and expiry.', perm: ['integrations:manage'], toolsets: ['iam'] }),
  p({ key: 'admin.settings', app: 'admin', label: 'Settings', route: '/admin/settings', purpose: 'System settings by group (platform, tickets, contracts, portal, security, notifications, AI, WhatsApp).', perm: SYSTEM, toolsets: ['config', 'admin'] }),
  p({ key: 'admin.ai', app: 'admin', label: 'AI assistant', route: '/admin/ai', purpose: 'The assistant\'s control page: provider connection, kill switch, autonomy, effort, feature switches, daily token budget, reply timeout, conversation retention and the usage report (turns, tokens, tools, guardrail events, feedback).', perm: ['admin:system', 'admin:config'], toolsets: ['config', 'admin', 'iam'], howTo: ['Use Test connection to verify the provider and model set in the deployment.', 'Switch the assistant or single features off here; changes apply to the next message.', 'Autonomy auto_low lets low-risk internal writes (work notes, tasks, links, watching) apply without confirmation.'] }),
  p({ key: 'admin.outbox', app: 'admin', label: 'Notification outbox', route: '/admin/outbox', purpose: 'Queued, sent and failed notifications.', perm: SYSTEM, toolsets: ['iam'] }),
  p({ key: 'admin.whatsapp', app: 'admin', label: 'WhatsApp', route: '/admin/whatsapp', purpose: 'WhatsApp Business connection, templates, webhook and recent messages.', perm: SYSTEM, toolsets: ['config', 'admin'] }),
  p({ key: 'admin.audit', app: 'admin', label: 'Audit log', route: '/admin/audit', purpose: 'Who changed what, when, from where (UI, API, AI, integration, system).', perm: ['admin:audit'], filters: ['entityType', 'entityId', 'action', 'userId', 'source', 'from', 'to'], toolsets: ['iam'] }),
  p({ key: 'admin.integrations', app: 'admin', label: 'Monitoring & SIEM', route: '/admin/integrations', purpose: 'Monitoring and SIEM integrations (PRTG, FortiSIEM, generic webhook) and their events.', perm: ['integrations:events', 'integrations:manage'], toolsets: ['cmdb'] }),

  // ---- account (shared)
  p({ key: 'profile', app: 'dashboards', label: 'Profile', route: '/profile', purpose: 'The user\'s own profile: name, mobile number, WhatsApp opt-in, timezone, password and sessions.', portal: true }),
  p({ key: 'notifications', app: 'dashboards', label: 'Notifications', route: '/notifications', purpose: 'The user\'s in-app notifications.', portal: true }),

  // ---- customer portal
  p({ key: 'portal.tickets', app: 'portal', label: 'My tickets', route: '/portal/tickets', purpose: 'The organisation\'s tickets with status chips (open, awaiting you, resolved, closed).', perm: ['portal:tickets'], portal: true, staff: false, filters: ['status', 'type', 'q', 'mine'], toolsets: ['tickets'], howTo: ['Raise a ticket with New ticket; pick the site and describe the impact.', 'Reply on a ticket that is awaiting you; confirm or reopen a resolved ticket.'] }),
  p({ key: 'portal.newTicket', app: 'portal', label: 'New ticket (portal)', route: '/portal/tickets/new', purpose: 'Raise an incident or a catalog request.', perm: ['portal:tickets'], portal: true, staff: false, filters: ['type', 'title', 'description', 'serviceId', 'siteId', 'catalogItemId'], toolsets: ['tickets'] }),
  p({ key: 'portal.ticket', app: 'portal', label: 'Ticket (portal)', route: '/portal/tickets/:id', purpose: 'One ticket: status, SLA, conversation, attachments and the actions open to the customer.', perm: ['portal:tickets'], portal: true, staff: false, entity: 'ticket', toolsets: ['tickets'] }),
  p({ key: 'portal.services', app: 'portal', label: 'Services', route: '/portal/services', purpose: 'The services covered by the organisation\'s contracts.', perm: ['portal:contracts'], portal: true, staff: false, toolsets: ['contracts'] }),
  p({ key: 'portal.sla', app: 'portal', label: 'Service levels (portal)', route: '/portal/services/sla', purpose: 'SLA targets and recent compliance for the organisation.', perm: ['portal:contracts'], portal: true, staff: false, filters: ['days'], toolsets: ['contracts'] }),
  p({ key: 'portal.contracts', app: 'portal', label: 'Contracts (portal)', route: '/portal/services/contracts', purpose: 'The organisation\'s contracts, scope and entitlement usage.', perm: ['portal:contracts'], portal: true, staff: false, toolsets: ['contracts'] }),
  p({ key: 'portal.assets', app: 'portal', label: 'Assets (portal)', route: '/portal/assets', purpose: 'Asset KPIs for the organisation.', perm: ['portal:assets'], portal: true, staff: false, toolsets: ['assets'] }),
  p({ key: 'portal.assetsInventory', app: 'portal', label: 'Asset inventory (portal)', route: '/portal/assets/inventory', purpose: 'The organisation\'s assets and configuration items.', perm: ['portal:assets'], portal: true, staff: false, filters: ['q', 'siteId', 'lifecycleStage', 'expiring'], toolsets: ['assets'] }),
  p({ key: 'portal.assetsCoverage', app: 'portal', label: 'Warranty & AMC (portal)', route: '/portal/assets/coverage', purpose: 'Assets with warranty or AMC cover ending soon.', perm: ['portal:assets'], portal: true, staff: false, toolsets: ['assets'] }),
  p({ key: 'portal.maintenance', app: 'portal', label: 'Maintenance & visits', route: '/portal/maintenance', purpose: 'Upcoming preventive maintenance and field visits; acknowledge completed visits.', perm: ['portal:access'], portal: true, staff: false, toolsets: ['field'] }),
  p({ key: 'portal.maintenanceHistory', app: 'portal', label: 'Maintenance history', route: '/portal/maintenance/history', purpose: 'Completed maintenance and visits.', perm: ['portal:access'], portal: true, staff: false, toolsets: ['field'] }),
  p({ key: 'portal.status', app: 'portal', label: 'Service status', route: '/portal/status', purpose: 'The health of the business services the organisation relies on, planned maintenance for the next two weeks, announcements and incident notices.', perm: ['portal:status'], portal: true, staff: false, toolsets: ['cmdb'] }),
  p({ key: 'portal.approvals', app: 'portal', label: 'Approvals (portal)', route: '/portal/approvals', purpose: 'Requests and changes waiting for the customer\'s approval.', perm: ['portal:approve'], portal: true, staff: false, toolsets: ['approvals'] }),
  p({ key: 'portal.users', app: 'portal', label: 'Users (portal)', route: '/portal/users', purpose: 'The organisation\'s portal users; customer administrators add users, set roles and reset passwords.', perm: ['portal:manage_users'], portal: true, staff: false, toolsets: ['iam'] }),

  // ---- technical
  p({ key: 'admin.any', app: 'admin', label: 'Administration', route: '/admin/*', purpose: 'Administration pages.', perm: ['admin:config', 'admin:users', 'admin:audit', 'admin:system', 'integrations:manage', 'integrations:events'], hidden: true }),
];

const patternOf = (route: string) => new RegExp(`^${route.replace(/\/\*$/, '(?:/.*)?').replace(/:([a-zA-Z]+)/g, '(?<$1>[^/]+)')}/?$`);
const compiled = APP_PAGES.map((page) => ({ page, re: patternOf(page.route), literal: !/[:*]/.test(page.route) }));

/** The page a pathname belongs to (literal routes win over parameterised ones, longer routes over shorter). */
export function matchRoute(pathname: string): { page: AppPage; params: Record<string, string> } | null {
  const path = pathname.split('?')[0]!.replace(/\/+$/, '') || '/';
  const candidates = compiled.filter((c) => c.re.test(path)).sort((a, b) => Number(b.literal) - Number(a.literal) || b.page.route.length - a.page.route.length);
  const hit = candidates[0];
  if (!hit) return null;
  const m = hit.re.exec(path);
  return { page: hit.page, params: { ...(m?.groups ?? {}) } };
}

export const pageByKey = (key: string): AppPage | null => APP_PAGES.find((p) => p.key === key) ?? null;

type Can = (...perms: Permission[]) => boolean;

/** Whether a page is open to a user of the given shell with the given permissions. */
export function pageAllowed(page: AppPage, can: Can, portal: boolean): boolean {
  if (portal ? !page.portal : page.staff === false) return false;
  return !page.perm || can(...page.perm);
}

/** The pages a user may open, hidden ones excluded. */
export const pagesFor = (can: Can, portal: boolean): AppPage[] => APP_PAGES.filter((p) => !p.hidden && pageAllowed(p, can, portal));

/** Fills `:id` parameters and keeps only the query parameters the page understands. */
export function buildPath(page: AppPage, params: Record<string, string> = {}, query: Record<string, string | number | boolean | null | undefined> = {}): string {
  let path = page.route.replace(/:([a-zA-Z]+)/g, (_, k: string) => encodeURIComponent(params[k] ?? ''));
  path = path.replace(/\/\*$/, '');
  const allowed = new Set(page.filters ?? []);
  const qs = Object.entries(query)
    .filter(([k, v]) => allowed.has(k) && v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return qs.length ? `${path}?${qs.join('&')}` : path;
}
