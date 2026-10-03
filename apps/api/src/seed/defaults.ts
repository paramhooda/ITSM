import { eq, and, sql } from 'drizzle-orm';
import { ALL_PERMISSIONS, SYSTEM_ROLES, SYSTEM_ROLE_AREAS, OPTION_PARENT_TYPES, type OptionType } from '@itsm/shared';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import { OPTION_SEEDS, PRIORITY_MATRIX, TEAM_SEEDS, CI_TYPE_SEEDS, RELATIONSHIP_TYPE_SEEDS, KB_CATEGORY_SEEDS } from './options';
import { NOTIFICATION_TEMPLATE_SEEDS_ALL, NOTIFICATION_RULE_SEEDS } from './templates';
import { DEFAULT_BUSINESS_HOURS } from '@/lib/calendar';
import { logger } from '@/core/logger';

export async function seedDefaults(tx: Tx) {
  await seedRoles(tx);
  await seedOptions(tx);
  await seedPriorityMatrix(tx);
  await seedTeams(tx);
  await seedCalendars(tx);
  await seedSlaPolicies(tx);
  await seedCiTypes(tx);
  await seedRelationshipTypes(tx);
  await seedKbCategories(tx);
  await seedNotificationTemplates(tx);
  await seedNotificationRules(tx);
  await seedEscalationRules(tx);
  await seedApprovalWorkflows(tx);
  await seedCatalogItems(tx);
  await seedSystemSettings(tx);
}

async function seedRoles(tx: Tx) {
  for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
    const [existing] = await tx.select({ id: schema.roles.id, navAreas: schema.roles.navAreas }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
    let roleId = existing?.id;
    // Navigation areas introduced by an upgrade: apply the defaults once, never overwrite an administrator's choice.
    if (roleId && existing?.navAreas === null && SYSTEM_ROLE_AREAS[key]) await tx.update(schema.roles).set({ navAreas: SYSTEM_ROLE_AREAS[key] }).where(eq(schema.roles.id, roleId));
    if (!roleId) {
      const [row] = await tx.insert(schema.roles).values({ key, name: def.name, description: def.description, userType: def.userType, isSystem: true, navAreas: SYSTEM_ROLE_AREAS[key] ?? null }).returning({ id: schema.roles.id });
      roleId = row.id;
      await tx.insert(schema.rolePermissions).values(def.permissions.map((permission) => ({ roleId: roleId!, permission }))).onConflictDoNothing();
    } else if (key === 'admin') {
      // The administrator role always holds every (non-portal) permission, including ones added by upgrades.
      await tx
        .insert(schema.rolePermissions)
        .values(ALL_PERMISSIONS.filter((p) => !p.startsWith('portal:')).map((permission) => ({ roleId: roleId!, permission })))
        .onConflictDoNothing();
    } else {
      // System roles pick up permissions introduced by upgrades (never removes what an admin granted).
      await tx.insert(schema.rolePermissions).values(def.permissions.map((permission) => ({ roleId: roleId!, permission }))).onConflictDoNothing();
    }
  }
}

async function seedOptions(tx: Tx) {
  const idByTypeKey = new Map<string, string>();
  for (const [type, items] of Object.entries(OPTION_SEEDS)) {
    // Parent options (e.g. service_category) are listed before their children in OPTION_SEEDS, so their ids are already resolved here.
    const parentType = OPTION_PARENT_TYPES[type as OptionType];
    let order = 0;
    for (const item of items) {
      order += 10;
      const parentId = item.parent && parentType ? idByTypeKey.get(`${parentType}:${item.parent}`) ?? null : null;
      const [row] = await tx
        .insert(schema.configOptions)
        .values({
          type,
          key: item.key,
          label: item.label,
          description: item.description,
          parentId,
          domain: item.domain ?? 'general',
          statusCategory: item.statusCategory,
          pausesSla: item.pausesSla ?? false,
          level: item.level,
          color: item.color,
          icon: item.icon,
          sortOrder: order,
          isDefault: item.isDefault ?? false,
          isSystem: true,
          appliesTo: item.appliesTo ?? [],
          metadata: item.metadata ?? {},
        })
        .onConflictDoNothing()
        .returning({ id: schema.configOptions.id });
      const id = row?.id ?? (await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, item.key))))[0]?.id;
      if (id) idByTypeKey.set(`${type}:${item.key}`, id);
    }
  }
}

async function optionId(tx: Tx, type: string, key: string) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1);
  return row?.id ?? null;
}

async function seedPriorityMatrix(tx: Tx) {
  for (const [impact, urgency, priority] of PRIORITY_MATRIX) {
    const impactId = await optionId(tx, 'ticket_impact', impact);
    const urgencyId = await optionId(tx, 'ticket_urgency', urgency);
    const priorityId = await optionId(tx, 'ticket_priority', priority);
    if (impactId && urgencyId && priorityId) await tx.insert(schema.priorityMatrix).values({ impactId, urgencyId, priorityId }).onConflictDoNothing();
  }
}

async function seedTeams(tx: Tx) {
  for (const t of TEAM_SEEDS) await tx.insert(schema.teams).values(t).onConflictDoNothing();
}

async function seedCalendars(tx: Tx) {
  const [existing] = await tx.select({ id: schema.businessCalendars.id }).from(schema.businessCalendars).limit(1);
  if (existing) return;
  const [hol] = await tx.insert(schema.holidayCalendars).values({ name: 'India Public Holidays', country: 'IN' }).returning();
  const year = new Date().getFullYear();
  const holidays = [
    ['01-26', 'Republic Day'],
    ['08-15', 'Independence Day'],
    ['10-02', 'Gandhi Jayanti'],
    ['12-25', 'Christmas Day'],
  ];
  for (const y of [year, year + 1]) {
    for (const [md, name] of holidays) await tx.insert(schema.holidays).values({ calendarId: hol.id, date: `${y}-${md}`, name }).onConflictDoNothing();
  }
  await tx.insert(schema.businessCalendars).values([
    { name: '24x7', description: 'Round-the-clock coverage', timezone: 'Asia/Kolkata', is24x7: true, hours: {}, isDefault: true },
    { name: 'Business Hours (Mon-Fri 09:00-18:00 IST)', description: 'Standard business hours', timezone: 'Asia/Kolkata', is24x7: false, hours: DEFAULT_BUSINESS_HOURS, holidayCalendarId: hol.id },
    { name: 'Extended Hours (Mon-Sat 08:00-20:00 IST)', description: 'Extended support window', timezone: 'Asia/Kolkata', is24x7: false, hours: { mon: [['08:00', '20:00']], tue: [['08:00', '20:00']], wed: [['08:00', '20:00']], thu: [['08:00', '20:00']], fri: [['08:00', '20:00']], sat: [['08:00', '20:00']] }, holidayCalendarId: hol.id },
  ]);
}

async function seedSlaPolicies(tx: Tx) {
  const [existing] = await tx.select({ id: schema.slaPolicies.id }).from(schema.slaPolicies).limit(1);
  if (existing) return;
  const cals = await tx.select().from(schema.businessCalendars);
  const c247 = cals.find((c) => c.is24x7)!;
  const cBiz = cals.find((c) => !c.is24x7)!;
  const prio = async (k: string) => (await optionId(tx, 'ticket_priority', k))!;
  const P = { p1: await prio('p1'), p2: await prio('p2'), p3: await prio('p3'), p4: await prio('p4'), p5: await prio('p5') };

  type T = { ticketType: 'incident' | 'request' | 'problem' | 'change'; priority: keyof typeof P | null; metric: 'acknowledgement' | 'response' | 'restoration' | 'resolution'; minutes: number; calendarTime?: boolean };
  const standard: T[] = [
    { ticketType: 'incident', priority: 'p1', metric: 'acknowledgement', minutes: 15, calendarTime: true },
    { ticketType: 'incident', priority: 'p1', metric: 'response', minutes: 30, calendarTime: true },
    { ticketType: 'incident', priority: 'p1', metric: 'restoration', minutes: 240, calendarTime: true },
    { ticketType: 'incident', priority: 'p1', metric: 'resolution', minutes: 480, calendarTime: true },
    { ticketType: 'incident', priority: 'p2', metric: 'acknowledgement', minutes: 30, calendarTime: true },
    { ticketType: 'incident', priority: 'p2', metric: 'response', minutes: 60, calendarTime: true },
    { ticketType: 'incident', priority: 'p2', metric: 'restoration', minutes: 480, calendarTime: true },
    { ticketType: 'incident', priority: 'p2', metric: 'resolution', minutes: 1440, calendarTime: true },
    { ticketType: 'incident', priority: 'p3', metric: 'response', minutes: 240 },
    { ticketType: 'incident', priority: 'p3', metric: 'resolution', minutes: 1440 },
    { ticketType: 'incident', priority: 'p4', metric: 'response', minutes: 480 },
    { ticketType: 'incident', priority: 'p4', metric: 'resolution', minutes: 2880 },
    { ticketType: 'incident', priority: 'p5', metric: 'response', minutes: 1440 },
    { ticketType: 'incident', priority: 'p5', metric: 'resolution', minutes: 7200 },
    { ticketType: 'request', priority: 'p1', metric: 'response', minutes: 60, calendarTime: true },
    { ticketType: 'request', priority: 'p1', metric: 'resolution', minutes: 480, calendarTime: true },
    { ticketType: 'request', priority: 'p2', metric: 'response', minutes: 240 },
    { ticketType: 'request', priority: 'p2', metric: 'resolution', minutes: 1440 },
    { ticketType: 'request', priority: 'p3', metric: 'response', minutes: 480 },
    { ticketType: 'request', priority: 'p3', metric: 'resolution', minutes: 2880 },
    { ticketType: 'request', priority: 'p4', metric: 'response', minutes: 960 },
    { ticketType: 'request', priority: 'p4', metric: 'resolution', minutes: 4800 },
    { ticketType: 'request', priority: 'p5', metric: 'response', minutes: 1440 },
    { ticketType: 'request', priority: 'p5', metric: 'resolution', minutes: 9600 },
    { ticketType: 'problem', priority: null, metric: 'response', minutes: 1440 },
    { ticketType: 'problem', priority: null, metric: 'resolution', minutes: 43200 },
  ];
  const premiumFactor = 0.5;

  const policies = [
    { name: 'Standard SLA', description: 'Default policy: P1/P2 on a 24x7 clock, P3-P5 on business hours.', isDefault: true, targets: standard, calendarId: cBiz.id },
    { name: 'Premium 24x7 SLA', description: 'All priorities on a 24x7 clock with tighter targets.', isDefault: false, targets: standard.map((t) => ({ ...t, minutes: Math.max(10, Math.round(t.minutes * premiumFactor)), calendarTime: true })), calendarId: c247.id },
    { name: 'Business Hours SLA', description: 'All priorities measured in business hours only.', isDefault: false, targets: standard.map((t) => ({ ...t, calendarTime: false })), calendarId: cBiz.id },
  ];
  for (const p of policies) {
    const [row] = await tx.insert(schema.slaPolicies).values({ name: p.name, description: p.description, isDefault: p.isDefault, calendarId: p.calendarId, holidayCalendarId: cBiz.holidayCalendarId }).returning();
    await tx.insert(schema.slaTargets).values(
      p.targets.map((t) => ({ policyId: row.id, ticketType: t.ticketType, priorityId: t.priority ? P[t.priority] : null, metric: t.metric, minutes: t.minutes, warnPct: 75, calendarTime: t.calendarTime ?? false })),
    );
  }
}

async function seedCiTypes(tx: Tx) {
  let order = 0;
  for (const t of CI_TYPE_SEEDS) {
    order += 10;
    await tx.insert(schema.ciTypes).values({ key: t.key, name: t.name, icon: t.icon, color: t.color, attributeSchema: (t as { attributeSchema?: Record<string, unknown>[] }).attributeSchema ?? [], isSystem: true, sortOrder: order }).onConflictDoNothing();
  }
}

async function seedRelationshipTypes(tx: Tx) {
  for (const r of RELATIONSHIP_TYPE_SEEDS) {
    await tx.insert(schema.ciRelationshipTypes).values({ ...r, isSystem: true }).onConflictDoNothing();
    // Impact metadata introduced by an upgrade: fill it in for known keys still at the 'none' default, never overwrite an administrator's choice.
    if (r.impactDirection !== 'none') {
      await tx.update(schema.ciRelationshipTypes).set({ impactDirection: r.impactDirection }).where(and(eq(schema.ciRelationshipTypes.key, r.key), eq(schema.ciRelationshipTypes.impactDirection, 'none')));
    }
  }
}

async function seedKbCategories(tx: Tx) {
  let order = 0;
  for (const c of KB_CATEGORY_SEEDS) {
    order += 10;
    await tx.insert(schema.kbCategories).values({ ...c, sortOrder: order }).onConflictDoNothing();
  }
}

async function seedNotificationTemplates(tx: Tx) {
  for (const t of NOTIFICATION_TEMPLATE_SEEDS_ALL) await tx.insert(schema.notificationTemplates).values({ ...t, isSystem: true }).onConflictDoNothing();
}

async function seedNotificationRules(tx: Tx) {
  const [existing] = await tx.select({ id: schema.notificationRules.id }).from(schema.notificationRules).limit(1);
  if (existing) return;
  await tx.insert(schema.notificationRules).values(NOTIFICATION_RULE_SEEDS);
}

async function seedEscalationRules(tx: Tx) {
  const [existing] = await tx.select({ id: schema.escalationRules.id }).from(schema.escalationRules).limit(1);
  if (existing) return;
  await tx.insert(schema.escalationRules).values([
    { name: 'SLA warning: notify assignee and team', sortOrder: 10, conditions: { metric: 'any', thresholdPct: 75 }, actions: { notifyAssignee: true, notifyTeam: true } },
    { name: 'SLA breach: escalate to team manager', sortOrder: 20, conditions: { metric: 'any', onBreach: true }, actions: { notifyAssignee: true, notifyTeam: true, notifyManager: true, raiseEscalationLevel: true } },
    { name: 'P1 breach: notify management', sortOrder: 30, conditions: { metric: 'resolution', onBreach: true, priorityKeys: ['p1'] }, actions: { notifyRoles: ['noc_manager', 'service_manager', 'management'], raiseEscalationLevel: true } },
  ]);
}

async function seedApprovalWorkflows(tx: Tx) {
  const [existing] = await tx.select({ id: schema.approvalWorkflows.id }).from(schema.approvalWorkflows).limit(1);
  if (existing) return;
  await tx.insert(schema.approvalWorkflows).values([
    { name: 'Customer approval', description: 'Approved by a customer administrator or escalation contact.', steps: [{ name: 'Customer approval', approverType: 'customer_admin', required: 'any' }] },
    { name: 'Service manager approval', description: 'Approved by an MSP service manager.', steps: [{ name: 'Service manager', approverType: 'role', approverRef: 'service_manager', required: 'any' }] },
    { name: 'CAB approval', description: 'Change Advisory Board: NOC manager and service manager.', steps: [{ name: 'CAB', approverType: 'role', approverRef: 'noc_manager', required: 'any' }, { name: 'Service management', approverType: 'role', approverRef: 'service_manager', required: 'any' }] },
  ]);
}

async function seedCatalogItems(tx: Tx) {
  const [existing] = await tx.select({ id: schema.catalogItems.id }).from(schema.catalogItems).limit(1);
  if (existing) return;
  const [customerApproval] = await tx.select().from(schema.approvalWorkflows).where(eq(schema.approvalWorkflows.name, 'Customer approval'));
  const access = await optionId(tx, 'ticket_category', 'access');
  const software = await optionId(tx, 'ticket_category', 'software');
  const network = await optionId(tx, 'ticket_category', 'network');
  const backup = await optionId(tx, 'ticket_category', 'backup');
  const hardware = await optionId(tx, 'ticket_category', 'hardware');
  const p3 = await optionId(tx, 'ticket_priority', 'p3');
  const p4 = await optionId(tx, 'ticket_priority', 'p4');
  const items = [
    { key: 'access_request', name: 'Access Request', description: 'Request access to a system, share or application.', icon: 'key', ticketCategoryId: access, defaultPriorityId: p3, approvalWorkflowId: customerApproval?.id, formSchema: [{ key: 'system', label: 'System / Application', type: 'text', required: true }, { key: 'accessLevel', label: 'Access level', type: 'select', required: true, options: ['read', 'write', 'admin'] }, { key: 'justification', label: 'Business justification', type: 'textarea', required: true }] },
    { key: 'new_user', name: 'New User Onboarding', description: 'Create accounts and provision a device for a new joiner.', icon: 'user-plus', ticketCategoryId: access, defaultPriorityId: p3, approvalWorkflowId: customerApproval?.id, formSchema: [{ key: 'fullName', label: 'Full name', type: 'text', required: true }, { key: 'department', label: 'Department', type: 'text', required: true }, { key: 'startDate', label: 'Start date', type: 'date', required: true }, { key: 'needsLaptop', label: 'Laptop required', type: 'boolean' }] },
    { key: 'software_install', name: 'Software Installation', description: 'Install or upgrade software on a device.', icon: 'package', ticketCategoryId: software, defaultPriorityId: p4, formSchema: [{ key: 'software', label: 'Software', type: 'text', required: true }, { key: 'device', label: 'Device / hostname', type: 'text', required: true }, { key: 'licenseAvailable', label: 'License available', type: 'boolean' }] },
    { key: 'config_change', name: 'Configuration Request', description: 'Request a configuration change (firewall rule, VLAN, DNS...).', icon: 'settings', ticketCategoryId: network, defaultPriorityId: p3, approvalWorkflowId: customerApproval?.id, formSchema: [{ key: 'system', label: 'System', type: 'text', required: true }, { key: 'change', label: 'Requested change', type: 'textarea', required: true }, { key: 'window', label: 'Preferred window', type: 'text' }] },
    { key: 'backup_restore', name: 'Backup Restore', description: 'Restore files, mailboxes or systems from backup.', icon: 'archive-restore', ticketCategoryId: backup, defaultPriorityId: p3, formSchema: [{ key: 'what', label: 'What to restore', type: 'textarea', required: true }, { key: 'pointInTime', label: 'Restore point (date/time)', type: 'text', required: true }, { key: 'target', label: 'Restore to', type: 'text' }] },
    { key: 'new_device', name: 'New Device / Hardware', description: 'Provision a new server, network device or endpoint.', icon: 'monitor', ticketCategoryId: hardware, defaultPriorityId: p4, approvalWorkflowId: customerApproval?.id, formSchema: [{ key: 'deviceType', label: 'Device type', type: 'text', required: true }, { key: 'quantity', label: 'Quantity', type: 'number', required: true }, { key: 'site', label: 'Site', type: 'text' }] },
    { key: 'certificate_renewal', name: 'Certificate Renewal', description: 'Renew an SSL/TLS certificate.', icon: 'badge-check', ticketCategoryId: network, defaultPriorityId: p3, formSchema: [{ key: 'domain', label: 'Domain / service', type: 'text', required: true }, { key: 'expiry', label: 'Current expiry', type: 'date' }] },
    { key: 'report_request', name: 'Report Request', description: 'Request an ad-hoc operational or security report.', icon: 'file-text', ticketCategoryId: null, defaultPriorityId: p4, formSchema: [{ key: 'report', label: 'Report needed', type: 'textarea', required: true }, { key: 'period', label: 'Period', type: 'text' }] },
    { key: 'maintenance_request', name: 'Maintenance Request', description: 'Request a maintenance window or on-site maintenance.', icon: 'wrench', ticketCategoryId: hardware, defaultPriorityId: p4, formSchema: [{ key: 'scope', label: 'Maintenance scope', type: 'textarea', required: true }, { key: 'preferredDate', label: 'Preferred date', type: 'date' }] },
  ];
  let order = 0;
  for (const it of items) {
    order += 10;
    await tx.insert(schema.catalogItems).values({ ...it, sortOrder: order }).onConflictDoNothing();
  }
}

async function seedSystemSettings(tx: Tx) {
  const defaults: Record<string, { value: unknown; description: string }> = {
    'platform.name': { value: 'Progression', description: 'Product name shown in the UI and emails' },
    'tickets.auto_close_days': { value: 5, description: 'Days after resolution before a ticket is automatically closed' },
    'tickets.reopen_window_days': { value: 14, description: 'Days after closure a customer may reopen a ticket' },
    'tickets.default_sla_policy_fallback': { value: true, description: 'Apply the default SLA policy when no contract policy applies' },
    'contracts.expiry_notice_days': { value: [90, 60, 30, 7], description: 'Days before contract expiry at which notifications are sent' },
    'entitlements.default_warn_pct': { value: 80, description: 'Default consumption warning threshold' },
    'portal.allow_self_registration': { value: false, description: 'Allow customer contacts to self-register in the portal' },
    'security.password_min_length': { value: 10, description: 'Minimum password length' },
    'security.lockout_attempts': { value: 5, description: 'Failed logins before temporary lockout' },
    'security.lockout_minutes': { value: 15, description: 'Lockout duration in minutes' },
    'audit.retention_months': { value: 36, description: 'Months to retain audit log partitions' },
    'events.retention_months': { value: 12, description: 'Months to retain integration event partitions' },
    'ai.assistant.enabled': { value: true, description: 'Kill switch for Grady: off stops every chat and AI feature at once' },
    'ai.disabled_features': { value: [], description: 'AI features switched off (assistant, summarize, classify, assign, similar, suggest_kb, resolution, draft, duplicates, change_impact, problem_clusters)' },
    'ai.autonomy': { value: 'confirm_all', description: 'confirm_all: every change waits for confirmation; auto_low: low-risk internal writes (work notes, watching, tasks, links) apply at once' },
    'ai.effort': { value: 'low', description: 'Reasoning effort for the assistant (low, medium, high) on models that support it' },
    'ai.daily_token_budget': { value: 250000, description: 'Tokens one person may spend on the assistant per day (0 = unlimited)' },
    'ai.turn_timeout_seconds': { value: 90, description: 'Wall-clock limit for one assistant reply including tool calls' },
    'ai.conversation_retention_days': { value: 90, description: 'Days to keep assistant conversations (0 = forever, minimum 7)' },
    'ai.triage.auto_apply_confidence': { value: 85, description: 'Triage on arrival applies the category and the owner without a person at or above this confidence (50-100); below it they wait as proposals' },
    'ai.triage.storm_window_minutes': { value: 30, description: 'Similar tickets opened within this many minutes count towards an alert storm' },
    'ai.triage.storm_threshold': { value: 3, description: 'This many similar open tickets in the window (including the new one) is an alert storm' },
    'ai.triage.storm_auto_link': { value: true, description: 'Link a ticket raised by monitoring or the SIEM as a duplicate of the oldest open look-alike' },
    'changes.risk_thresholds': { value: { medium: 35, high: 65 }, description: 'Change risk questionnaire: scores (0-100) at or above these are medium and high' },
    'changes.reminder_hours': { value: 24, description: 'Remind the implementer and the requester this many hours before a scheduled change window opens' },
    'changes.conflict_warnings': { value: true, description: 'Record overlapping changes on shared systems and blackout windows as warnings on the change (never a block)' },
    'notifications.outbox_retention_days': { value: 90, description: 'Days to keep sent and failed outbox messages' },
    'whatsapp.enabled': { value: false, description: 'Send WhatsApp notifications to people who opted in' },
    'whatsapp.phone_number_id': { value: '', description: 'Meta WhatsApp Cloud API phone number id' },
    'whatsapp.business_account_id': { value: '', description: 'WhatsApp Business Account id (for reference)' },
    'whatsapp.access_token.secret': { value: '', description: 'Permanent system-user access token for the Cloud API' },
    'whatsapp.app.secret': { value: '', description: 'Meta app secret, used to verify delivery callbacks' },
    'whatsapp.verify_token.secret': { value: '', description: 'Verify token you enter when subscribing the webhook in Meta' },
    'whatsapp.api_version': { value: 'v21.0', description: 'Graph API version' },
    'whatsapp.default_country_code': { value: '91', description: 'Country code assumed for ten-digit numbers' },
    'whatsapp.webhook_url': { value: '', description: 'Webhook URL to register in Meta; blank derives it from APP_URL. Set a tunnel URL (for example ngrok) when the platform runs on localhost' },
    'whatsapp.templates': { value: { default: { name: 'progression_update', language: 'en', params: ['subject', 'text', 'link'] } }, description: 'Approved template per event group (default, ticket, sla, incident, page, handover, briefing); params in template order from subject, text, link, event' },
  };
  for (const [key, def] of Object.entries(defaults)) {
    await tx.insert(schema.systemSettings).values({ key, value: def.value as never, description: def.description }).onConflictDoNothing();
  }
  await tx.execute(sql`SELECT 1`);
}

export async function seedAdmin(tx: Tx, admin: { email: string; name: string; passwordHash: string }) {
  const [existing] = await tx.select({ id: schema.users.id }).from(schema.users).limit(1);
  if (existing) return false;
  const [user] = await tx.insert(schema.users).values({ email: admin.email.toLowerCase(), name: admin.name, passwordHash: admin.passwordHash, userType: 'msp', status: 'active', timezone: 'Asia/Kolkata', passwordChangedAt: new Date() }).returning();
  const [adminRole] = await tx.select().from(schema.roles).where(eq(schema.roles.key, 'admin'));
  await tx.insert(schema.userRoles).values({ userId: user.id, roleId: adminRole.id });
  logger.info({ email: admin.email }, 'initial administrator created');
  return true;
}
