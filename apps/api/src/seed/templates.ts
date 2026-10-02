/**
 * Default notification templates (Handlebars). Administrators can edit these in
 * Administration > Notifications. Variables available depend on the event; the
 * common ones are: platformName, appUrl, ticket (number, title, status, priority,
 * customer, link), actor, comment, sla (metric, dueAt, pct), contract, entitlement...
 */
const ticketBlock = `<p><strong>{{ticket.number}}</strong> &middot; {{ticket.customerName}}</p>
<p style="font-size:15px"><a href="{{ticket.link}}">{{ticket.title}}</a></p>
<table style="font-size:13px;border-collapse:collapse">
<tr><td style="padding:2px 12px 2px 0;color:#64748b">Status</td><td>{{ticket.status}}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#64748b">Priority</td><td>{{ticket.priority}}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#64748b">Service</td><td>{{default ticket.service "-"}}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#64748b">Assigned to</td><td>{{default ticket.assignee "Unassigned"}}</td></tr>
</table>`;

export const NOTIFICATION_TEMPLATE_SEEDS = [
  { event: 'ticket.created', channel: 'email', name: 'Ticket created', subject: '[{{ticket.number}}] {{ticket.title}}', body: `<p>A new {{ticket.typeLabel}} has been logged.</p>${ticketBlock}<p>{{ticket.description}}</p>` },
  { event: 'ticket.assigned', channel: 'email', name: 'Ticket assigned', subject: '[{{ticket.number}}] Assigned to you: {{ticket.title}}', body: `<p>{{actor}} assigned this ticket to {{ticket.assignee}}.</p>${ticketBlock}` },
  { event: 'ticket.status_changed', channel: 'email', name: 'Ticket status changed', subject: '[{{ticket.number}}] Status: {{ticket.status}}', body: `<p>{{actor}} changed the status from <strong>{{previousStatus}}</strong> to <strong>{{ticket.status}}</strong>.</p>${ticketBlock}` },
  { event: 'ticket.customer_comment', channel: 'email', name: 'Customer commented', subject: '[{{ticket.number}}] New customer comment', body: `<p><strong>{{actor}}</strong> commented:</p><blockquote style="border-left:3px solid #cbd5e1;margin:8px 0;padding:4px 12px">{{comment}}</blockquote>${ticketBlock}` },
  { event: 'ticket.engineer_comment', channel: 'email', name: 'Engineer commented', subject: '[{{ticket.number}}] Update from {{platformName}}', body: `<p><strong>{{actor}}</strong> posted an update:</p><blockquote style="border-left:3px solid #cbd5e1;margin:8px 0;padding:4px 12px">{{comment}}</blockquote>${ticketBlock}` },
  { event: 'ticket.resolved', channel: 'email', name: 'Ticket resolved', subject: '[{{ticket.number}}] Resolved: {{ticket.title}}', body: `<p>This ticket has been resolved by {{actor}}.</p><p><strong>Resolution:</strong> {{ticket.resolutionNotes}}</p>${ticketBlock}<p>If the issue persists you can reopen the ticket from the portal within {{reopenDays}} days.</p>` },
  { event: 'ticket.closed', channel: 'email', name: 'Ticket closed', subject: '[{{ticket.number}}] Closed: {{ticket.title}}', body: `<p>This ticket is now closed.</p>${ticketBlock}` },
  { event: 'ticket.escalated', channel: 'email', name: 'Ticket escalated', subject: '[{{ticket.number}}] ESCALATION L{{level}}: {{ticket.title}}', body: `<p style="color:#b91c1c"><strong>Escalation level {{level}}</strong> &mdash; {{reason}}</p>${ticketBlock}` },
  { event: 'sla.warning', channel: 'email', name: 'SLA warning', subject: '[{{ticket.number}}] SLA warning: {{sla.metric}} {{sla.pct}}% consumed', body: `<p style="color:#b45309"><strong>{{sla.metric}} SLA is at {{sla.pct}}%</strong>, due {{date sla.dueAt}}.</p>${ticketBlock}` },
  { event: 'sla.breached', channel: 'email', name: 'SLA breached', subject: '[{{ticket.number}}] SLA BREACH: {{sla.metric}}', body: `<p style="color:#b91c1c"><strong>The {{sla.metric}} SLA was breached</strong> (due {{date sla.dueAt}}).</p>${ticketBlock}` },
  { event: 'change.approval_requested', channel: 'email', name: 'Change approval requested', subject: '[{{ticket.number}}] Approval requested: {{ticket.title}}', body: `<p>Your approval is requested for this change.</p>${ticketBlock}<p><a href="{{ticket.link}}">Review and approve</a></p>` },
  { event: 'change.approved', channel: 'email', name: 'Change approved', subject: '[{{ticket.number}}] Change approved', body: `<p>The change was approved by {{actor}}.</p>${ticketBlock}` },
  { event: 'change.rejected', channel: 'email', name: 'Change rejected', subject: '[{{ticket.number}}] Change rejected', body: `<p>The change was rejected by {{actor}}. {{comment}}</p>${ticketBlock}` },
  { event: 'request.approval_requested', channel: 'email', name: 'Request approval requested', subject: '[{{ticket.number}}] Approval requested: {{ticket.title}}', body: `<p>Your approval is requested for this service request.</p>${ticketBlock}<p><a href="{{ticket.link}}">Review and approve</a></p>` },
  { event: 'request.approved', channel: 'email', name: 'Request approved', subject: '[{{ticket.number}}] Request approved', body: `<p>The request was approved by {{actor}} and is now being fulfilled.</p>${ticketBlock}` },
  { event: 'request.rejected', channel: 'email', name: 'Request rejected', subject: '[{{ticket.number}}] Request rejected', body: `<p>The request was rejected by {{actor}}. {{comment}}</p>${ticketBlock}` },
  { event: 'contract.expiring', channel: 'email', name: 'Contract expiring', subject: 'Contract {{contract.number}} ({{contract.customerName}}) expires in {{daysLeft}} days', body: `<p>Contract <strong>{{contract.number}} - {{contract.name}}</strong> for {{contract.customerName}} ends on {{contract.endDate}} ({{daysLeft}} days).</p><p><a href="{{contract.link}}">Open contract</a></p>` },
  { event: 'contract.expired', channel: 'email', name: 'Contract expired', subject: 'Contract {{contract.number}} ({{contract.customerName}}) has expired', body: `<p>Contract <strong>{{contract.number}} - {{contract.name}}</strong> for {{contract.customerName}} expired on {{contract.endDate}}.</p>` },
  { event: 'contract.renewal_due', channel: 'email', name: 'Contract renewal due', subject: 'Renewal due: {{contract.number}} ({{contract.customerName}})', body: `<p>The renewal date for <strong>{{contract.number}}</strong> is {{contract.renewalDate}}.</p>` },
  { event: 'contract.missing_documents', channel: 'email', name: 'Contract missing documents', subject: 'Contract {{contract.number}} is missing documentation', body: `<p>Contract <strong>{{contract.number}}</strong> has no signed agreement attached.</p>` },
  { event: 'entitlement.threshold', channel: 'email', name: 'Entitlement threshold', subject: '{{entitlement.customerName}}: {{entitlement.name}} at {{entitlement.pct}}%', body: `<p>Entitlement <strong>{{entitlement.name}}</strong> on contract {{entitlement.contractNumber}} has reached {{entitlement.pct}}% ({{entitlement.used}} of {{entitlement.quantity}} {{entitlement.unit}}).</p>` },
  { event: 'entitlement.exhausted', channel: 'email', name: 'Entitlement exhausted', subject: '{{entitlement.customerName}}: {{entitlement.name}} exhausted', body: `<p>Entitlement <strong>{{entitlement.name}}</strong> on contract {{entitlement.contractNumber}} is fully consumed ({{entitlement.used}} of {{entitlement.quantity}} {{entitlement.unit}}). Further work may be billable.</p>` },
  { event: 'pm.scheduled', channel: 'email', name: 'Maintenance scheduled', subject: 'Preventive maintenance scheduled: {{pm.programName}} on {{pm.date}}', body: `<p>Preventive maintenance <strong>{{pm.programName}}</strong> for {{pm.customerName}} is scheduled for {{pm.date}}.</p>` },
  { event: 'pm.due', channel: 'email', name: 'Maintenance due', subject: 'Preventive maintenance due: {{pm.programName}}', body: `<p>Preventive maintenance <strong>{{pm.programName}}</strong> for {{pm.customerName}} is due on {{pm.date}} and is not yet scheduled.</p>` },
  { event: 'pm.missed', channel: 'email', name: 'Maintenance missed', subject: 'Preventive maintenance MISSED: {{pm.programName}}', body: `<p style="color:#b91c1c">Preventive maintenance <strong>{{pm.programName}}</strong> for {{pm.customerName}} planned for {{pm.date}} was missed.</p>` },
  { event: 'field_visit.scheduled', channel: 'email', name: 'Field visit scheduled', subject: 'Site visit scheduled: {{visit.number}} - {{visit.title}}', body: `<p>A site visit has been scheduled for <strong>{{visit.customerName}}</strong> ({{visit.siteName}}) on {{date visit.scheduledStart}}.</p><p>Engineer: {{visit.engineer}}</p>` },
  { event: 'field_visit.completed', channel: 'email', name: 'Field visit completed', subject: 'Site visit completed: {{visit.number}} - {{visit.title}}', body: `<p>The site visit at <strong>{{visit.customerName}}</strong> ({{visit.siteName}}) was completed by {{visit.engineer}}.</p><p><strong>Summary:</strong> {{visit.workSummary}}</p>` },
  { event: 'report.delivered', channel: 'email', name: 'Scheduled report', subject: '{{report.name}} - {{report.period}}', body: `<p>Please find attached the <strong>{{report.name}}</strong> for {{report.period}}.</p>{{{report.summaryHtml}}}` },
  { event: 'user.password_reset', channel: 'email', name: 'Password reset', subject: 'Reset your {{platformName}} password', body: `<p>Hello {{user.name}},</p><p>Use the link below to reset your password. It expires in 60 minutes.</p><p><a href="{{resetLink}}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>` },
  { event: 'user.welcome', channel: 'email', name: 'Welcome', subject: 'Welcome to {{platformName}}', body: `<p>Hello {{user.name}},</p><p>An account has been created for you.</p><p>Sign in at <a href="{{appUrl}}">{{appUrl}}</a> with your email address{{#if temporaryPassword}} and temporary password <strong>{{temporaryPassword}}</strong>{{/if}}.</p>` },
];

export const NOTIFICATION_RULE_SEEDS = [
  { event: 'ticket.created', name: 'Notify requester, team and watchers on creation', recipients: { requester: true, team: true, watchers: true }, channels: ['email', 'in_app'] },
  { event: 'ticket.assigned', name: 'Notify assignee', recipients: { assignee: true }, channels: ['email', 'in_app'] },
  { event: 'ticket.status_changed', name: 'Notify requester and assignee', recipients: { requester: true, assignee: true, watchers: true }, channels: ['email', 'in_app'] },
  { event: 'ticket.customer_comment', name: 'Notify assignee and team', recipients: { assignee: true, team: true, watchers: true }, channels: ['email', 'in_app'] },
  { event: 'ticket.engineer_comment', name: 'Notify requester', recipients: { requester: true, watchers: true }, channels: ['email', 'in_app'] },
  { event: 'ticket.resolved', name: 'Notify requester', recipients: { requester: true, watchers: true }, channels: ['email', 'in_app'] },
  { event: 'ticket.closed', name: 'Notify requester', recipients: { requester: true }, channels: ['email'] },
  { event: 'ticket.escalated', name: 'Notify assignee, team and manager', recipients: { assignee: true, team: true, manager: true }, channels: ['email', 'in_app'] },
  { event: 'sla.warning', name: 'Notify assignee and team', recipients: { assignee: true, team: true }, channels: ['email', 'in_app'] },
  { event: 'sla.breached', name: 'Notify assignee, team and manager', recipients: { assignee: true, team: true, manager: true }, channels: ['email', 'in_app'] },
  { event: 'change.approval_requested', name: 'Notify approvers', recipients: { approvers: true }, channels: ['email', 'in_app'] },
  { event: 'change.approved', name: 'Notify requester and assignee', recipients: { requester: true, assignee: true }, channels: ['email', 'in_app'] },
  { event: 'change.rejected', name: 'Notify requester and assignee', recipients: { requester: true, assignee: true }, channels: ['email', 'in_app'] },
  { event: 'request.approval_requested', name: 'Notify approvers', recipients: { approvers: true }, channels: ['email', 'in_app'] },
  { event: 'request.approved', name: 'Notify requester and assignee', recipients: { requester: true, assignee: true }, channels: ['email', 'in_app'] },
  { event: 'request.rejected', name: 'Notify requester', recipients: { requester: true }, channels: ['email', 'in_app'] },
  { event: 'contract.expiring', name: 'Notify account manager and contract admins', recipients: { accountManager: true, roles: ['contract_admin', 'service_manager'] }, channels: ['email', 'in_app'] },
  { event: 'contract.expired', name: 'Notify account manager and contract admins', recipients: { accountManager: true, roles: ['contract_admin', 'service_manager'] }, channels: ['email', 'in_app'] },
  { event: 'contract.renewal_due', name: 'Notify account manager', recipients: { accountManager: true, roles: ['contract_admin'] }, channels: ['email', 'in_app'] },
  { event: 'contract.missing_documents', name: 'Notify contract admins', recipients: { roles: ['contract_admin'] }, channels: ['in_app'] },
  { event: 'entitlement.threshold', name: 'Notify account manager and service manager', recipients: { accountManager: true, roles: ['service_manager', 'contract_admin'] }, channels: ['email', 'in_app'] },
  { event: 'entitlement.exhausted', name: 'Notify account manager and service manager', recipients: { accountManager: true, roles: ['service_manager', 'contract_admin'] }, channels: ['email', 'in_app'] },
  { event: 'pm.scheduled', name: 'Notify customer contacts and engineer', recipients: { customerContacts: true, assignee: true }, channels: ['email', 'in_app'] },
  { event: 'pm.due', name: 'Notify field team', recipients: { team: true, roles: ['service_manager'] }, channels: ['email', 'in_app'] },
  { event: 'pm.missed', name: 'Notify service manager', recipients: { team: true, roles: ['service_manager'] }, channels: ['email', 'in_app'] },
  { event: 'field_visit.scheduled', name: 'Notify engineer and customer contacts', recipients: { assignee: true, customerContacts: true }, channels: ['email', 'in_app'] },
  { event: 'field_visit.completed', name: 'Notify customer contacts', recipients: { customerContacts: true, requester: true }, channels: ['email', 'in_app'] },
  { event: 'report.delivered', name: 'Deliver to configured recipients', recipients: { scheduleRecipients: true }, channels: ['email'] },
];
