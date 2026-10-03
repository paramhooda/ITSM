import { eq, and, inArray, asc, desc, sql } from 'drizzle-orm';
import type { TicketType } from '@itsm/shared';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { enqueue } from '@/jobs/queues';
import { ForbiddenError, NotFoundError, ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { applySlas, markAcknowledged, slaSummary, worstSla } from '@/modules/sla/engine';
import type { RiskLevel } from '@/modules/sla/risk';
import type { Sentiment } from '@/modules/ai/sentiment';
import { nextTicketNumber } from './numbers';
import { classifyScope, contractForTicket } from './scope';
import { evaluateAssignment } from './assignment';
import { declareCore } from './major';
import { notifyTicketEvent } from './notify';
import { escalateManually, escalationHistory } from './escalation';
import { startApproval } from './approvals';
import { changeStatusCore, statusByKey, applicableStatuses, RESOLVE_KEY, REOPEN_KEY } from './status';
import {
  type TicketRow,
  type OptionRow,
  TYPE_LABEL,
  actorOf,
  addActivity,
  defaultStatusFor,
  isCustomerUser,
  loadTicket,
  optionById,
  optionByKey,
  optionMap,
  optionsOfType,
  reloadTicket,
  requireAction,
  requireOption,
  statusApplies,
  toLabel,
  userIdOf,
} from './common';
import type { CreateTicketInput, UpdateTicketInput, ChangeDetailsInput, ProblemDetailsInput } from './schemas';
import { loadTemplate, recordConflicts, type TemplateRow as ChangeTemplateRow } from '@/modules/changes/service';

// ---------------------------------------------------------------- helpers

async function priorityFromMatrix(ctx: Ctx, impactId: string | null | undefined, urgencyId: string | null | undefined): Promise<string | null> {
  if (!impactId || !urgencyId) return null;
  const [cell] = await ctx.tx.select().from(schema.priorityMatrix).where(and(eq(schema.priorityMatrix.impactId, impactId), eq(schema.priorityMatrix.urgencyId, urgencyId))).limit(1);
  return cell?.priorityId ?? null;
}

async function defaultOption(ctx: Ctx, type: string): Promise<OptionRow | null> {
  const all = await optionsOfType(ctx.tx, type);
  return all.find((o) => o.isDefault && o.isActive) ?? null;
}

async function assertCustomerEntities(ctx: Ctx, customerId: string, input: { siteId?: string | null; requesterContactId?: string | null; primaryCiId?: string | null; primaryAssetId?: string | null; ciIds?: string[]; assetIds?: string[]; parentTicketId?: string | null; contractId?: string | null }) {
  if (input.siteId) {
    const [s] = await ctx.tx.select({ customerId: schema.sites.customerId }).from(schema.sites).where(eq(schema.sites.id, input.siteId)).limit(1);
    if (!s || s.customerId !== customerId) throw new ValidationError('Site does not belong to the customer');
  }
  if (input.requesterContactId) {
    const [c] = await ctx.tx.select({ customerId: schema.contacts.customerId }).from(schema.contacts).where(eq(schema.contacts.id, input.requesterContactId)).limit(1);
    if (!c || c.customerId !== customerId) throw new ValidationError('Contact does not belong to the customer');
  }
  if (input.contractId) {
    const [c] = await ctx.tx.select({ customerId: schema.contracts.customerId }).from(schema.contracts).where(eq(schema.contracts.id, input.contractId)).limit(1);
    if (!c || c.customerId !== customerId) throw new ValidationError('Contract does not belong to the customer');
  }
  const ciIds = [...new Set([...(input.ciIds ?? []), ...(input.primaryCiId ? [input.primaryCiId] : [])])];
  if (ciIds.length) {
    const rows = await ctx.tx.select({ id: schema.cis.id, customerId: schema.cis.customerId }).from(schema.cis).where(inArray(schema.cis.id, ciIds));
    if (rows.length !== ciIds.length || rows.some((r) => r.customerId !== customerId)) throw new ValidationError('One or more configuration items do not belong to the customer');
  }
  const assetIds = [...new Set([...(input.assetIds ?? []), ...(input.primaryAssetId ? [input.primaryAssetId] : [])])];
  if (assetIds.length) {
    const rows = await ctx.tx.select({ id: schema.assets.id, customerId: schema.assets.customerId }).from(schema.assets).where(inArray(schema.assets.id, assetIds));
    if (rows.length !== assetIds.length || rows.some((r) => r.customerId !== customerId)) throw new ValidationError('One or more assets do not belong to the customer');
  }
  if (input.parentTicketId) {
    const [p] = await ctx.tx.select({ customerId: schema.tickets.customerId }).from(schema.tickets).where(eq(schema.tickets.id, input.parentTicketId)).limit(1);
    if (!p || p.customerId !== customerId) throw new ValidationError('Parent ticket does not belong to the customer');
  }
}

function validateFormData(formSchema: Record<string, unknown>[], formData: Record<string, unknown>) {
  const missing: string[] = [];
  for (const f of formSchema) {
    if (!f.required) continue;
    const v = formData[String(f.key)];
    if (v === undefined || v === null || v === '' || v === false) missing.push(String(f.label ?? f.key));
  }
  if (missing.length) throw new ValidationError(`Required form fields missing: ${missing.join(', ')}`, { missing });
}

// ---------------------------------------------------------------- create

export async function createTicket(ctx: Ctx, input: CreateTicketInput): Promise<TicketRow> {
  const customer = isCustomerUser(ctx);
  const customerId = customer ? ctx.user.customerId! : input.customerId;
  if (customer) {
    if (!ctx.can('portal:tickets', customerId)) throw new ForbiddenError('Missing permission: portal:tickets');
    if (input.type !== 'incident' && input.type !== 'request') throw new ForbiddenError('Customer users can only raise incidents and service requests');
  } else {
    ctx.require('tickets:create', customerId);
  }
  ctx.requireCustomer(customerId);
  const [cust] = await ctx.tx.select({ id: schema.customers.id, isActive: schema.customers.isActive }).from(schema.customers).where(eq(schema.customers.id, customerId)).limit(1);
  if (!cust) throw new NotFoundError('Customer');
  await assertCustomerEntities(ctx, customerId, input);

  const type = input.type;
  let categoryId = input.categoryId ?? null;
  let priorityId = input.priorityId ?? null;
  let serviceId = input.serviceId ?? null;
  let teamId = customer ? null : (input.assignedTeamId ?? null);
  let assigneeId = customer ? null : (input.assigneeId ?? null);
  let slaPolicyId = customer ? null : (input.slaPolicyId ?? null);
  let approvalWorkflowId: string | null = null;
  let catalog: typeof schema.catalogItems.$inferSelect | null = null;

  // Catalog item defaults (service requests)
  if (input.catalogItemId) {
    [catalog] = await ctx.tx.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, input.catalogItemId)).limit(1);
    if (!catalog || !catalog.isActive) throw new NotFoundError('Catalog item');
    if (catalog.customerIds.length && !catalog.customerIds.includes(customerId)) throw new ValidationError('This catalog item is not available for the customer');
    if (customer && !catalog.portalVisible) throw new ForbiddenError('This catalog item is not available in the portal');
    validateFormData(catalog.formSchema ?? [], input.formData ?? {});
    categoryId = categoryId ?? catalog.ticketCategoryId ?? null;
    priorityId = priorityId ?? catalog.defaultPriorityId ?? null;
    serviceId = serviceId ?? catalog.serviceId ?? null;
    teamId = teamId ?? catalog.teamId ?? null;
    slaPolicyId = slaPolicyId ?? catalog.slaPolicyId ?? null;
    approvalWorkflowId = catalog.approvalWorkflowId ?? null;
  }

  // Standard change templates: the plans are prefilled; a pre-approved template skips approval.
  let template: ChangeTemplateRow | null = null;
  if (type === 'change' && input.changeTemplateId) {
    template = await loadTemplate(ctx.tx, input.changeTemplateId, customerId);
    if (!template) throw new NotFoundError('Change template');
    categoryId = categoryId ?? template.categoryId ?? null;
    serviceId = serviceId ?? template.serviceId ?? null;
  }

  // Validate option ids by type
  const category = await requireOption(ctx.tx, 'ticket_category', categoryId, 'category');
  const subcategory = await requireOption(ctx.tx, 'ticket_subcategory', input.subcategoryId, 'subcategory');
  if (subcategory && category && subcategory.parentId && subcategory.parentId !== category.id) throw new ValidationError('Subcategory does not belong to the selected category');
  await requireOption(ctx.tx, 'ticket_impact', input.impactId, 'impact');
  await requireOption(ctx.tx, 'ticket_urgency', input.urgencyId, 'urgency');
  await requireOption(ctx.tx, 'security_severity', input.securitySeverityId, 'security severity');
  if (priorityId) await requireOption(ctx.tx, 'ticket_priority', priorityId, 'priority');

  // Priority: matrix when impact + urgency given, else explicit, else default
  const matrixPriority = await priorityFromMatrix(ctx, input.impactId, input.urgencyId);
  if (matrixPriority && (!input.priorityId || customer)) priorityId = matrixPriority;
  if (!priorityId) priorityId = (await defaultOption(ctx, 'ticket_priority'))?.id ?? (await optionByKey(ctx.tx, 'ticket_priority', 'p3'))?.id ?? null;

  // Status
  let status: OptionRow;
  if (input.statusId && !customer) {
    const s = await requireOption(ctx.tx, 'ticket_status', input.statusId, 'status');
    if (!s || !statusApplies(s, type)) throw new ValidationError('Status does not apply to this ticket type');
    status = s;
  } else status = await defaultStatusFor(ctx.tx, type);

  // Source
  let sourceId = customer ? null : (input.sourceId ?? null);
  if (sourceId) await requireOption(ctx.tx, 'ticket_source', sourceId, 'source');
  if (!sourceId) sourceId = (await optionByKey(ctx.tx, 'ticket_source', customer ? 'portal' : ctx.source === 'integration' ? 'api' : ctx.source === 'ai' ? 'ai' : 'engineer'))?.id ?? (await defaultOption(ctx, 'ticket_source'))?.id ?? null;

  // Service → domain fallback; category domain wins
  let domain = category?.domain ?? 'general';
  if (domain === 'general' && serviceId) {
    const [svc] = await ctx.tx.select({ domain: schema.services.domain }).from(schema.services).where(eq(schema.services.id, serviceId)).limit(1);
    if (svc) domain = svc.domain;
  }
  if (domain === 'soc' && !customer && !ctx.can('soc:read', customerId) && !ctx.can('soc:manage', customerId)) {
    // Engineers without SOC access may still raise security tickets; they simply will not see them afterwards.
  }

  // Contract + scope
  const contractSel = await contractForTicket(ctx.tx, { customerId, serviceId, siteId: input.siteId });
  const contractId = (!customer && input.contractId) || contractSel?.contractId || null;
  const scope = await classifyScope(ctx.tx, { customerId, serviceId, siteId: input.siteId, ticketCategoryId: categoryId, primaryCiId: input.primaryCiId });

  // Assignment rules
  let assignmentSource: string | null = null;
  if (!teamId && !assigneeId) {
    const a = await evaluateAssignment(ctx.tx, { ticketType: type, categoryId, serviceId, customerId, priorityId, domain, sourceId, contractTeamId: contractSel?.teamId ?? null });
    teamId = a.teamId;
    assigneeId = a.userId;
    assignmentSource = a.source === 'rule' ? `rule "${a.ruleName}"` : a.source === 'none' ? null : a.source;
  }
  if (assigneeId) {
    const [u] = await ctx.tx.select({ id: schema.users.id, userType: schema.users.userType, status: schema.users.status }).from(schema.users).where(eq(schema.users.id, assigneeId)).limit(1);
    if (!u || u.userType !== 'msp' || u.status !== 'active') throw new ValidationError('Assignee must be an active MSP user');
  }

  const requesterUserId = customer ? ctx.user.id : (input.requesterUserId ?? null);
  const now = new Date();
  const number = await nextTicketNumber(ctx.tx, type);
  const [ticket] = await ctx.tx
    .insert(schema.tickets)
    .values({
      number,
      type,
      customerId,
      siteId: input.siteId ?? null,
      contractId,
      serviceId,
      title: input.title,
      description: input.description ?? template?.descriptionTemplate ?? null,
      categoryId,
      subcategoryId: input.subcategoryId ?? null,
      priorityId,
      impactId: input.impactId ?? null,
      urgencyId: input.urgencyId ?? null,
      statusId: status.id,
      sourceId,
      domain,
      assignedTeamId: teamId,
      assigneeId,
      requesterUserId,
      requesterContactId: input.requesterContactId ?? null,
      primaryCiId: input.primaryCiId ?? null,
      primaryAssetId: input.primaryAssetId ?? null,
      scopeStatus: scope.status,
      scopeContractId: scope.contractId,
      scopeItemId: scope.scopeItemId,
      scopeNote: scope.reason,
      slaPolicyId,
      catalogItemId: catalog?.id ?? null,
      formData: input.formData ?? {},
      parentTicketId: input.parentTicketId ?? null,
      securitySeverityId: input.securitySeverityId ?? null,
      isMajor: !customer && type === 'incident' && !!input.isMajor && ctx.can('tickets:major', customerId),
      externalRef: input.externalRef ?? null,
      tags: input.tags ?? [],
      customFields: input.customFields ?? {},
      acknowledgedAt: assigneeId ? now : null,
      createdBy: userIdOf(ctx),
      updatedBy: userIdOf(ctx),
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
    .returning();

  // Affected CIs / assets
  const ciIds = [...new Set([...(input.ciIds ?? []), ...(input.primaryCiId ? [input.primaryCiId] : [])])];
  if (ciIds.length) await ctx.tx.insert(schema.ticketCis).values(ciIds.map((ciId) => ({ ticketId: ticket.id, ciId, customerId, role: ciId === input.primaryCiId ? 'primary' : 'affected' }))).onConflictDoNothing();
  const assetIds = [...new Set([...(input.assetIds ?? []), ...(input.primaryAssetId ? [input.primaryAssetId] : [])])];
  if (assetIds.length) await ctx.tx.insert(schema.ticketAssets).values(assetIds.map((assetId) => ({ ticketId: ticket.id, assetId, customerId }))).onConflictDoNothing();

  // Watchers: explicit + creator (MSP) so they hear about updates
  const watcherIds = new Set<string>(customer ? [] : (input.watcherIds ?? []));
  if (watcherIds.size) await ctx.tx.insert(schema.ticketWatchers).values([...watcherIds].map((userId) => ({ ticketId: ticket.id, userId, customerId }))).onConflictDoNothing();

  // Type extensions
  if (type === 'change') {
    // What the form sent wins over the template; the template fills the rest.
    const given = Object.fromEntries(Object.entries(input.change ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '')) as NonNullable<CreateTicketInput['change']>;
    const tpl = template ? { changeType: template.changeType as ChangeDetailsInput['changeType'], riskId: template.riskId, justification: template.justification, implementationPlan: template.implementationPlan, testPlan: template.testPlan, backoutPlan: template.backoutPlan, communicationPlan: template.communicationPlan, downtimeExpectedMinutes: template.downtimeExpectedMinutes } : {};
    const c = { ...tpl, ...given };
    await ctx.tx.insert(schema.changeDetails).values({ ticketId: ticket.id, customerId, changeType: c.changeType ?? 'normal', riskId: c.riskId ?? (await defaultOption(ctx, 'change_risk'))?.id ?? null, riskAssessment: c.riskAssessment ?? null, impactAssessment: c.impactAssessment ?? null, justification: c.justification ?? null, implementationPlan: c.implementationPlan ?? null, testPlan: c.testPlan ?? null, backoutPlan: c.backoutPlan ?? null, communicationPlan: c.communicationPlan ?? null, scheduledStart: c.scheduledStart ?? null, scheduledEnd: c.scheduledEnd ?? null, downtimeExpectedMinutes: c.downtimeExpectedMinutes ?? null, cabNotes: c.cabNotes ?? null, templateId: template?.id ?? null });
    if (template?.skipApproval) {
      await ctx.tx.update(schema.tickets).set({ approvalStatus: 'not_required' }).where(eq(schema.tickets.id, ticket.id));
      await addActivity(ctx, ticket, { type: 'approval', summary: `Pre-approved standard change (template "${template.name}")`, data: { templateId: template.id }, customerVisible: false });
    }
  } else if (type === 'problem') {
    const p = input.problem ?? {};
    await ctx.tx.insert(schema.problemDetails).values({ ticketId: ticket.id, customerId, symptoms: p.symptoms ?? null, investigation: p.investigation ?? null, rootCause: p.rootCause ?? null, workaround: p.workaround ?? null, isKnownError: p.isKnownError ?? false, permanentFix: p.permanentFix ?? null, kbArticleId: p.kbArticleId ?? null, impactSummary: p.impactSummary ?? null });
  }

  await addActivity(ctx, ticket, { type: 'created', summary: `${TYPE_LABEL[type]} ${number} created`, data: { source: ctx.source, catalogItemId: catalog?.id ?? null }, customerVisible: true });
  await addActivity(ctx, ticket, { type: 'scope', summary: `Scope classified as ${scope.status.replace(/_/g, ' ')}: ${scope.reason}`, data: { ...scope, automatic: true }, customerVisible: false });
  if (teamId || assigneeId) {
    const [team] = teamId ? await ctx.tx.select({ name: schema.teams.name }).from(schema.teams).where(eq(schema.teams.id, teamId)).limit(1) : [];
    const [user] = assigneeId ? await ctx.tx.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, assigneeId)).limit(1) : [];
    await addActivity(ctx, ticket, { type: 'assignment', summary: `Assigned to ${[team?.name, user?.name].filter(Boolean).join(' / ')}${assignmentSource ? ` by ${assignmentSource}` : ''}`, data: { teamId, assigneeId, automatic: !!assignmentSource }, customerVisible: true });
  }
  await ctx.audit({ entityType: 'ticket', entityId: ticket.id, entityLabel: number, action: 'ticket.create', customerId, metadata: { type, title: ticket.title, scope: scope.status, catalogItemId: catalog?.id ?? null } });
  if (ticket.isMajor) await declareCore(ctx, ticket, { reason: 'Flagged as major at creation', notify: false });

  let current = ticket;
  await applySlas(ctx.tx, current, actorOf(ctx), { reason: 'created' });
  if (assigneeId) await markAcknowledged(ctx.tx, current, actorOf(ctx), now);
  await notifyTicketEvent(ctx, 'ticket.created', current);
  if (assigneeId && assigneeId !== ctx.user.id) await notifyTicketEvent(ctx, 'ticket.assigned', current);
  if (approvalWorkflowId) {
    current = await reloadTicket(ctx.tx, ticket.id);
    await startApproval(ctx, current, approvalWorkflowId);
  }
  // Triage on arrival runs a moment later in the worker (the row must be committed first); the job checks the switches itself.
  if (type === 'incident' || type === 'request') void enqueue('ai', 'triage-ticket', { ticketId: ticket.id }, { delay: 2000, jobId: `triage-${ticket.id}` });
  // A scheduled change is checked for clashes right away (a warning on the ticket, never a block).
  if (type === 'change' && input.change?.scheduledStart) await recordConflicts(ctx, ticket);
  return reloadTicket(ctx.tx, ticket.id);
}

// ---------------------------------------------------------------- read (detail)

export async function getTicket(ctx: Ctx, id: string) {
  const t = await loadTicket(ctx, id);
  const customer = isCustomerUser(ctx);
  const opts = await optionMap(ctx.tx, [t.statusId, t.priorityId, t.impactId, t.urgencyId, t.categoryId, t.subcategoryId, t.sourceId, t.securitySeverityId, t.resolutionCodeId, t.closureCodeId]);
  const [cust] = await ctx.tx.select({ id: schema.customers.id, name: schema.customers.name, code: schema.customers.code, accountManagerId: schema.customers.accountManagerId }).from(schema.customers).where(eq(schema.customers.id, t.customerId)).limit(1);
  const [site] = t.siteId ? await ctx.tx.select({ id: schema.sites.id, name: schema.sites.name, code: schema.sites.code }).from(schema.sites).where(eq(schema.sites.id, t.siteId)).limit(1) : [];
  const [service] = t.serviceId ? await ctx.tx.select({ id: schema.services.id, name: schema.services.name, key: schema.services.key }).from(schema.services).where(eq(schema.services.id, t.serviceId)).limit(1) : [];
  const [contract] = t.contractId ? await ctx.tx.select({ id: schema.contracts.id, number: schema.contracts.number, name: schema.contracts.name, slaPolicyId: schema.contracts.slaPolicyId, status: schema.contracts.status, endDate: schema.contracts.endDate }).from(schema.contracts).where(eq(schema.contracts.id, t.contractId)).limit(1) : [];
  const [scopeContract] = t.scopeContractId && t.scopeContractId !== t.contractId ? await ctx.tx.select({ id: schema.contracts.id, number: schema.contracts.number, name: schema.contracts.name }).from(schema.contracts).where(eq(schema.contracts.id, t.scopeContractId)).limit(1) : [];
  const userIds = [t.assigneeId, t.requesterUserId, t.createdBy, t.scopeClassifiedBy].filter((x): x is string => !!x);
  const users = userIds.length ? await ctx.tx.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, userType: schema.users.userType }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
  const userOf = (id: string | null) => (id ? (users.find((u) => u.id === id) ?? null) : null);
  const [team] = t.assignedTeamId ? await ctx.tx.select({ id: schema.teams.id, name: schema.teams.name, key: schema.teams.key, managerUserId: schema.teams.managerUserId }).from(schema.teams).where(eq(schema.teams.id, t.assignedTeamId)).limit(1) : [];
  const [requesterContact] = t.requesterContactId ? await ctx.tx.select({ id: schema.contacts.id, name: schema.contacts.name, email: schema.contacts.email, phone: schema.contacts.phone }).from(schema.contacts).where(eq(schema.contacts.id, t.requesterContactId)).limit(1) : [];
  const [catalogItem] = t.catalogItemId ? await ctx.tx.select({ id: schema.catalogItems.id, name: schema.catalogItems.name, formSchema: schema.catalogItems.formSchema, fulfilmentInstructions: schema.catalogItems.fulfilmentInstructions }).from(schema.catalogItems).where(eq(schema.catalogItems.id, t.catalogItemId)).limit(1) : [];
  const [parent] = t.parentTicketId ? await ctx.tx.select({ id: schema.tickets.id, number: schema.tickets.number, title: schema.tickets.title }).from(schema.tickets).where(eq(schema.tickets.id, t.parentTicketId)).limit(1) : [];

  const slas = await slaSummary(ctx.tx, t.id);
  const policyIds = [...new Set([...slas.map((s) => s.policyId), t.slaPolicyId, contract?.slaPolicyId].filter((x): x is string => !!x))];
  const policies = policyIds.length ? await ctx.tx.select({ id: schema.slaPolicies.id, name: schema.slaPolicies.name }).from(schema.slaPolicies).where(inArray(schema.slaPolicies.id, policyIds)) : [];
  const slaPolicyId = slas[0]?.policyId ?? t.slaPolicyId ?? contract?.slaPolicyId ?? null;

  const watchers = await ctx.tx.select({ userId: schema.ticketWatchers.userId, name: schema.users.name, email: schema.users.email }).from(schema.ticketWatchers).innerJoin(schema.users, eq(schema.users.id, schema.ticketWatchers.userId)).where(eq(schema.ticketWatchers.ticketId, t.id));
  const cis = await ctx.tx.select({ id: schema.cis.id, name: schema.cis.name, hostname: schema.cis.hostname, ipAddress: schema.cis.ipAddress, status: schema.cis.status, role: schema.ticketCis.role, typeId: schema.cis.typeId }).from(schema.ticketCis).innerJoin(schema.cis, eq(schema.cis.id, schema.ticketCis.ciId)).where(eq(schema.ticketCis.ticketId, t.id));
  const assets = await ctx.tx.select({ id: schema.assets.id, tag: schema.assets.tag, name: schema.assets.name, serialNumber: schema.assets.serialNumber }).from(schema.ticketAssets).innerJoin(schema.assets, eq(schema.assets.id, schema.ticketAssets.assetId)).where(eq(schema.ticketAssets.ticketId, t.id));
  const links = await listLinks(ctx, t);
  const tasks = customer ? [] : await ctx.tx.select().from(schema.ticketTasks).where(eq(schema.ticketTasks.ticketId, t.id)).orderBy(asc(schema.ticketTasks.sortOrder), asc(schema.ticketTasks.createdAt));
  const approvals = await ctx.tx.select().from(schema.approvals).where(eq(schema.approvals.ticketId, t.id)).orderBy(desc(schema.approvals.createdAt), asc(schema.approvals.step));
  const [problem] = t.type === 'problem' ? await ctx.tx.select().from(schema.problemDetails).where(eq(schema.problemDetails.ticketId, t.id)).limit(1) : [];
  const [change] = t.type === 'change' ? await ctx.tx.select().from(schema.changeDetails).where(eq(schema.changeDetails.ticketId, t.id)).limit(1) : [];
  const [majorRow] = t.type === 'incident' ? await ctx.tx.select().from(schema.majorIncidents).where(eq(schema.majorIncidents.ticketId, t.id)).limit(1) : [];
  const riskOpt = change?.riskId ? await optionById(ctx.tx, change.riskId) : null;
  const escalations = customer ? [] : await escalationHistory(ctx, t.id);
  const statuses = await applicableStatuses(ctx, t.type);

  const base = customer ? stripInternal(t) : stripVector(t);
  return {
    ...base,
    typeLabel: TYPE_LABEL[t.type],
    status: toLabel(opts.get(t.statusId)),
    priority: toLabel(opts.get(t.priorityId ?? '')),
    impact: toLabel(opts.get(t.impactId ?? '')),
    urgency: toLabel(opts.get(t.urgencyId ?? '')),
    category: toLabel(opts.get(t.categoryId ?? '')),
    subcategory: toLabel(opts.get(t.subcategoryId ?? '')),
    source: toLabel(opts.get(t.sourceId ?? '')),
    securitySeverity: toLabel(opts.get(t.securitySeverityId ?? '')),
    resolutionCode: toLabel(opts.get(t.resolutionCodeId ?? '')),
    closureCode: toLabel(opts.get(t.closureCodeId ?? '')),
    customer: cust ? { id: cust.id, name: cust.name, code: cust.code } : null,
    site: site ?? null,
    service: service ?? null,
    contract: contract ? { ...contract, slaPolicyName: policies.find((p) => p.id === contract.slaPolicyId)?.name ?? null } : null,
    scopeContract: scopeContract ?? (contract && contract.id === t.scopeContractId ? { id: contract.id, number: contract.number, name: contract.name } : null),
    scopeClassifiedByUser: userOf(t.scopeClassifiedBy),
    assignee: userOf(t.assigneeId),
    team: team ?? null,
    requester: userOf(t.requesterUserId),
    requesterContact: requesterContact ?? null,
    createdByUser: userOf(t.createdBy),
    catalogItem: catalogItem ?? null,
    parent: parent ?? null,
    slaPolicy: slaPolicyId ? { id: slaPolicyId, name: policies.find((p) => p.id === slaPolicyId)?.name ?? null } : null,
    slas,
    sla: worstSla(slas),
    // Staff only: the breach forecast and the customer's mood are internal signals.
    breachRisk: !customer && t.breachRisk ? { level: t.breachRisk as RiskLevel, score: t.breachRiskScore ?? 0, reason: t.breachRiskReason ?? '', at: t.breachRiskAt } : null,
    lastSentiment: !customer && t.lastSentiment && t.lastSentiment !== 'n/a' ? { sentiment: t.lastSentiment as Sentiment, at: t.lastSentimentAt } : null,
    watchers: watchers.map((w) => ({ id: w.userId, name: w.name, email: w.email })),
    isWatching: watchers.some((w) => w.userId === ctx.user.id),
    cis,
    assets,
    links,
    tasks,
    approvals,
    problem: problem ?? null,
    change: change ? { ...change, risk: toLabel(riskOpt) } : null,
    major: majorRow ? { status: majorRow.status, declaredAt: majorRow.declaredAt, resolvedAt: majorRow.resolvedAt, lastUpdateAt: majorRow.lastUpdateAt, nextUpdateDueAt: majorRow.nextUpdateDueAt, updateIntervalMinutes: majorRow.updateIntervalMinutes, commanderUserId: majorRow.commanderUserId, commsLeadUserId: majorRow.commsLeadUserId, bridgeUrl: majorRow.bridgeUrl, portalBanner: majorRow.portalBanner, pirCompletedAt: majorRow.pirCompletedAt } : null,
    escalations,
    statuses: statuses.map((s) => toLabel(s)),
    permissions: permissionsFor(ctx, t),
  };
}

function stripInternal(t: TicketRow) {
  const { customFields: _cf, integrationEventId: _ie, externalRef: _er, ...rest } = stripVector(t);
  return rest;
}

/** Drops the search vector and the raw risk/sentiment columns (exposed as objects above, staff only). */
function stripVector(t: TicketRow) {
  const { searchVector: _sv, breachRisk: _br, breachRiskScore: _bs, breachRiskReason: _bre, breachRiskAt: _ba, lastSentiment: _ls, lastSentimentAt: _la, ...rest } = t;
  return rest;
}

export function permissionsFor(ctx: Ctx, t: TicketRow) {
  const c = t.customerId;
  if (isCustomerUser(ctx)) {
    const portal = ctx.can('portal:tickets', c);
    return { update: false, assign: false, resolve: false, close: false, reopen: portal, cancel: false, comment: portal, workNote: false, time: false, scope: false, escalate: false, problem: false, change: false, approve: ctx.can('portal:approve', c), tasks: false, links: false, watch: portal, major: false };
  }
  return {
    update: ctx.can('tickets:update', c),
    assign: ctx.can('tickets:assign', c),
    resolve: ctx.can('tickets:resolve', c),
    close: ctx.can('tickets:resolve', c),
    reopen: ctx.can('tickets:resolve', c) || ctx.can('tickets:update', c),
    cancel: ctx.can('tickets:resolve', c),
    comment: ctx.can('tickets:comment', c),
    workNote: ctx.can('tickets:work_notes', c),
    time: ctx.can('tickets:time', c),
    scope: ctx.can('tickets:scope', c),
    escalate: ctx.can('tickets:escalate', c),
    problem: ctx.can('problems:manage', c),
    change: ctx.can('changes:manage', c),
    approve: ctx.can(t.type === 'change' ? 'changes:approve' : 'requests:approve', c),
    tasks: ctx.can('tickets:update', c),
    links: ctx.can('tickets:update', c),
    watch: true,
    major: t.type === 'incident' && ctx.can('tickets:major', c),
  };
}

async function listLinks(ctx: Ctx, t: TicketRow) {
  const rows = await ctx.tx.select().from(schema.ticketLinks).where(and(eq(schema.ticketLinks.customerId, t.customerId), inArray(schema.ticketLinks.sourceTicketId, [t.id])));
  const inbound = await ctx.tx.select().from(schema.ticketLinks).where(eq(schema.ticketLinks.targetTicketId, t.id));
  const all = [...rows, ...inbound.filter((l) => !rows.some((r) => r.id === l.id))];
  const otherIds = [...new Set(all.map((l) => (l.sourceTicketId === t.id ? l.targetTicketId : l.sourceTicketId)))];
  if (!otherIds.length) return [];
  const others = await ctx.tx.select({ id: schema.tickets.id, number: schema.tickets.number, title: schema.tickets.title, type: schema.tickets.type, statusId: schema.tickets.statusId, priorityId: schema.tickets.priorityId, customerId: schema.tickets.customerId }).from(schema.tickets).where(inArray(schema.tickets.id, otherIds));
  const opts = await optionMap(ctx.tx, others.flatMap((o) => [o.statusId, o.priorityId]));
  return all
    .map((l) => {
      const otherId = l.sourceTicketId === t.id ? l.targetTicketId : l.sourceTicketId;
      const o = others.find((x) => x.id === otherId);
      if (!o) return null;
      return { id: l.id, linkType: l.linkType, direction: l.sourceTicketId === t.id ? 'outbound' : 'inbound', createdAt: l.createdAt, ticket: { id: o.id, number: o.number, title: o.title, type: o.type, status: toLabel(opts.get(o.statusId)), priority: toLabel(opts.get(o.priorityId ?? '')) } };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
}

// ---------------------------------------------------------------- update

export async function updateTicket(ctx: Ctx, id: string, patch: UpdateTicketInput): Promise<TicketRow> {
  const t = await loadTicket(ctx, id);
  requireAction(ctx, t, 'tickets:update');
  await assertCustomerEntities(ctx, t.customerId, patch);
  const values: Partial<typeof schema.tickets.$inferInsert> = {};
  const keys: (keyof UpdateTicketInput)[] = ['title', 'description', 'siteId', 'serviceId', 'contractId', 'categoryId', 'subcategoryId', 'priorityId', 'impactId', 'urgencyId', 'sourceId', 'requesterUserId', 'requesterContactId', 'primaryCiId', 'primaryAssetId', 'tags', 'customFields', 'formData', 'securitySeverityId', 'parentTicketId', 'slaPolicyId', 'externalRef', 'resolutionNotes'];
  for (const k of keys) if (patch[k] !== undefined) (values as Record<string, unknown>)[k] = patch[k];
  if (patch.parentTicketId && patch.parentTicketId === t.id) throw new ValidationError('A ticket cannot be its own parent');

  const category = patch.categoryId !== undefined ? await requireOption(ctx.tx, 'ticket_category', patch.categoryId, 'category') : null;
  if (patch.subcategoryId !== undefined) await requireOption(ctx.tx, 'ticket_subcategory', patch.subcategoryId, 'subcategory');
  if (patch.priorityId !== undefined) await requireOption(ctx.tx, 'ticket_priority', patch.priorityId, 'priority');
  if (patch.impactId !== undefined) await requireOption(ctx.tx, 'ticket_impact', patch.impactId, 'impact');
  if (patch.urgencyId !== undefined) await requireOption(ctx.tx, 'ticket_urgency', patch.urgencyId, 'urgency');
  if (patch.sourceId !== undefined) await requireOption(ctx.tx, 'ticket_source', patch.sourceId, 'source');
  if (patch.securitySeverityId !== undefined) await requireOption(ctx.tx, 'security_severity', patch.securitySeverityId, 'security severity');
  if (category) values.domain = category.domain;

  // Impact/urgency → matrix priority (unless an explicit priority is part of the same patch)
  if ((patch.impactId !== undefined || patch.urgencyId !== undefined) && patch.priorityId === undefined) {
    const mp = await priorityFromMatrix(ctx, patch.impactId !== undefined ? patch.impactId : t.impactId, patch.urgencyId !== undefined ? patch.urgencyId : t.urgencyId);
    if (mp) values.priorityId = mp;
  }
  if (!Object.keys(values).length) return t;
  values.updatedAt = new Date();
  values.updatedBy = userIdOf(ctx);
  values.lastActivityAt = new Date();

  // Scope re-evaluation when the drivers change and no manual override exists
  const scopeDrivers = patch.serviceId !== undefined || patch.siteId !== undefined || patch.categoryId !== undefined || patch.primaryCiId !== undefined;
  if (scopeDrivers && !t.scopeClassifiedBy) {
    const scope = await classifyScope(ctx.tx, { customerId: t.customerId, serviceId: patch.serviceId !== undefined ? patch.serviceId : t.serviceId, siteId: patch.siteId !== undefined ? patch.siteId : t.siteId, ticketCategoryId: patch.categoryId !== undefined ? patch.categoryId : t.categoryId, primaryCiId: patch.primaryCiId !== undefined ? patch.primaryCiId : t.primaryCiId });
    values.scopeStatus = scope.status;
    values.scopeContractId = scope.contractId;
    values.scopeItemId = scope.scopeItemId;
    values.scopeNote = scope.reason;
    if (scope.status !== t.scopeStatus) await addActivity(ctx, t, { type: 'scope', summary: `Scope reclassified as ${scope.status.replace(/_/g, ' ')}: ${scope.reason}`, data: { ...scope, automatic: true }, customerVisible: false });
  }
  if (patch.serviceId !== undefined && patch.serviceId !== t.serviceId && patch.contractId === undefined) {
    const sel = await contractForTicket(ctx.tx, { customerId: t.customerId, serviceId: patch.serviceId, siteId: patch.siteId !== undefined ? patch.siteId : t.siteId });
    if (sel) values.contractId = sel.contractId;
  }

  await ctx.tx.update(schema.tickets).set(values).where(eq(schema.tickets.id, t.id));
  const updated = await reloadTicket(ctx.tx, t.id);
  const changes = diffChanges(t as unknown as Record<string, unknown>, values as Record<string, unknown>, ['updatedAt', 'updatedBy', 'lastActivityAt']);
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'ticket.update', customerId: t.customerId, changes });

  if (values.priorityId !== undefined && values.priorityId !== t.priorityId) {
    const opts = await optionMap(ctx.tx, [t.priorityId, values.priorityId]);
    await addActivity(ctx, t, { type: 'priority', summary: `Priority changed from ${opts.get(t.priorityId ?? '')?.label ?? '—'} to ${opts.get(values.priorityId ?? '')?.label ?? '—'}`, data: { from: t.priorityId, to: values.priorityId }, customerVisible: true });
  }
  const changedFields = Object.keys(changes).filter((k) => !['priorityId', 'scopeStatus', 'scopeContractId', 'scopeItemId', 'scopeNote', 'domain'].includes(k));
  if (changedFields.length) await addActivity(ctx, t, { type: 'update', summary: `Updated ${changedFields.map((f) => f.replace(/Id$/, '').replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ')}`, data: { fields: changedFields }, customerVisible: changedFields.some((f) => ['title', 'description', 'serviceId', 'siteId', 'categoryId'].includes(f)) });

  const slaDrivers = (values.priorityId !== undefined && values.priorityId !== t.priorityId) || (values.slaPolicyId !== undefined && values.slaPolicyId !== t.slaPolicyId) || (values.contractId !== undefined && values.contractId !== t.contractId) || (values.serviceId !== undefined && values.serviceId !== t.serviceId);
  if (slaDrivers) await applySlas(ctx.tx, updated, actorOf(ctx), { reason: 'recalculated' });
  return reloadTicket(ctx.tx, t.id);
}

// ---------------------------------------------------------------- status actions

export interface StatusInput {
  statusId: string;
  resolutionCodeId?: string | null;
  resolutionNotes?: string | null;
  closureCodeId?: string | null;
  comment?: string | null;
}

export async function changeStatus(ctx: Ctx, id: string, input: StatusInput): Promise<TicketRow> {
  const t = await loadTicket(ctx, id);
  const to = await optionById(ctx.tx, input.statusId);
  if (!to || to.type !== 'ticket_status' || !to.isActive) throw new ValidationError('Invalid status');
  if (to.id === t.statusId) return t;
  const from = await optionById(ctx.tx, t.statusId);
  const cat = to.statusCategory;
  if (isCustomerUser(ctx)) {
    // Portal users may only reopen (or cancel their own request before work starts).
    const reopening = (from?.statusCategory === 'resolved' || from?.statusCategory === 'closed') && (cat === 'open' || cat === 'new');
    const cancelling = cat === 'cancelled' && from?.statusCategory === 'new';
    if (!reopening && !cancelling) throw new ForbiddenError('Customer users can only reopen or cancel tickets');
    if (reopening) await assertReopenWindow(ctx, t);
    requireAction(ctx, t, 'tickets:resolve', 'portal:tickets');
  } else if (cat === 'resolved' || cat === 'closed' || cat === 'cancelled') requireAction(ctx, t, 'tickets:resolve');
  else if (from?.statusCategory === 'resolved' || from?.statusCategory === 'closed' || from?.statusCategory === 'cancelled') {
    if (!ctx.can('tickets:resolve', t.customerId) && !ctx.can('tickets:update', t.customerId)) throw new ForbiddenError('Missing permission: tickets:resolve');
  } else requireAction(ctx, t, 'tickets:update');
  if (cat === 'resolved' && !input.resolutionNotes && !t.resolutionNotes && !input.comment) throw new ValidationError('Resolution notes are required to resolve a ticket');
  return changeStatusCore(ctx, t, to, { resolutionCodeId: input.resolutionCodeId, resolutionNotes: input.resolutionNotes, closureCodeId: input.closureCodeId, comment: input.comment });
}

async function assertReopenWindow(ctx: Ctx, t: TicketRow) {
  const [row] = await ctx.tx.select({ value: schema.systemSettings.value }).from(schema.systemSettings).where(eq(schema.systemSettings.key, 'tickets.reopen_window_days')).limit(1);
  const days = Number(row?.value ?? 14);
  const ref = t.closedAt ?? t.resolvedAt;
  if (ref && Date.now() - ref.getTime() > days * 86_400_000) throw new ValidationError(`This ticket can no longer be reopened (window of ${days} days has passed). Please raise a new ticket.`);
}

export async function resolveTicket(ctx: Ctx, id: string, input: { resolutionCodeId?: string | null; resolutionNotes: string; comment?: string | null }) {
  const t = await loadTicket(ctx, id);
  requireAction(ctx, t, 'tickets:resolve');
  const to = await statusByKey(ctx, RESOLVE_KEY[t.type], t.type);
  let codeId = input.resolutionCodeId ?? null;
  if (!codeId) codeId = (await defaultOption(ctx, 'resolution_code'))?.id ?? null;
  return changeStatusCore(ctx, t, to, { resolutionCodeId: codeId, resolutionNotes: input.resolutionNotes, comment: input.comment, action: 'resolve' });
}

export async function closeTicket(ctx: Ctx, id: string, input: { closureCodeId?: string | null; comment?: string | null }) {
  const t = await loadTicket(ctx, id);
  requireAction(ctx, t, 'tickets:resolve');
  const to = await statusByKey(ctx, 'closed', t.type);
  return changeStatusCore(ctx, t, to, { closureCodeId: input.closureCodeId ?? undefined, comment: input.comment, action: 'close' });
}

export async function reopenTicket(ctx: Ctx, id: string, input: { comment?: string | null }) {
  const t = await loadTicket(ctx, id);
  const from = await optionById(ctx.tx, t.statusId);
  if (!from || !['resolved', 'closed', 'cancelled'].includes(from.statusCategory ?? '')) throw new ValidationError('Only resolved, closed or cancelled tickets can be reopened');
  if (isCustomerUser(ctx)) {
    requireAction(ctx, t, 'tickets:resolve', 'portal:tickets');
    await assertReopenWindow(ctx, t);
  } else if (!ctx.can('tickets:resolve', t.customerId) && !ctx.can('tickets:update', t.customerId)) throw new ForbiddenError('Missing permission: tickets:resolve');
  const to = (await optionByKey(ctx.tx, 'ticket_status', REOPEN_KEY[t.type])) ?? (await defaultStatusFor(ctx.tx, t.type));
  if (!statusApplies(to, t.type)) throw new ValidationError('No reopen status configured for this ticket type');
  return changeStatusCore(ctx, t, to, { comment: input.comment, action: 'reopen' });
}

export async function cancelTicket(ctx: Ctx, id: string, input: { closureCodeId?: string | null; comment?: string | null }) {
  const t = await loadTicket(ctx, id);
  if (isCustomerUser(ctx)) {
    const from = await optionById(ctx.tx, t.statusId);
    if (from?.statusCategory !== 'new' || t.requesterUserId !== ctx.user.id) throw new ForbiddenError('Only your own tickets that have not been started can be cancelled');
    requireAction(ctx, t, 'tickets:resolve', 'portal:tickets');
  } else requireAction(ctx, t, 'tickets:resolve');
  const to = await statusByKey(ctx, 'cancelled', t.type);
  let codeId = input.closureCodeId ?? null;
  if (!codeId && isCustomerUser(ctx)) codeId = (await optionByKey(ctx.tx, 'closure_code', 'cancelled_by_customer'))?.id ?? null;
  return changeStatusCore(ctx, t, to, { closureCodeId: codeId ?? undefined, comment: input.comment, action: 'cancel' });
}

// ---------------------------------------------------------------- assignment

export async function assignTicket(ctx: Ctx, id: string, input: { teamId?: string | null; assigneeId?: string | null; autoProgress?: boolean; comment?: string | null }): Promise<TicketRow> {
  const t = await loadTicket(ctx, id);
  requireAction(ctx, t, 'tickets:assign');
  const values: Partial<typeof schema.tickets.$inferInsert> = { updatedAt: new Date(), updatedBy: userIdOf(ctx), lastActivityAt: new Date() };
  if (input.teamId !== undefined) {
    if (input.teamId) {
      const [team] = await ctx.tx.select({ id: schema.teams.id }).from(schema.teams).where(and(eq(schema.teams.id, input.teamId), eq(schema.teams.isActive, true))).limit(1);
      if (!team) throw new NotFoundError('Team');
    }
    values.assignedTeamId = input.teamId;
  }
  if (input.assigneeId !== undefined) {
    if (input.assigneeId) {
      const [u] = await ctx.tx.select({ id: schema.users.id, userType: schema.users.userType, status: schema.users.status }).from(schema.users).where(eq(schema.users.id, input.assigneeId)).limit(1);
      if (!u || u.userType !== 'msp' || u.status !== 'active') throw new ValidationError('Assignee must be an active MSP user');
      if (values.assignedTeamId === undefined && !t.assignedTeamId) {
        const [m] = await ctx.tx.select({ teamId: schema.teamMembers.teamId }).from(schema.teamMembers).where(eq(schema.teamMembers.userId, input.assigneeId)).limit(1);
        if (m) values.assignedTeamId = m.teamId;
      }
    }
    values.assigneeId = input.assigneeId;
  }
  const teamChanged = values.assignedTeamId !== undefined && values.assignedTeamId !== t.assignedTeamId;
  const assigneeChanged = values.assigneeId !== undefined && values.assigneeId !== t.assigneeId;
  if (!teamChanged && !assigneeChanged) return t;
  const now = new Date();
  if (assigneeChanged && values.assigneeId && !t.acknowledgedAt) values.acknowledgedAt = now;
  await ctx.tx.update(schema.tickets).set(values).where(eq(schema.tickets.id, t.id));
  let updated = await reloadTicket(ctx.tx, t.id);
  const [team] = updated.assignedTeamId ? await ctx.tx.select({ name: schema.teams.name }).from(schema.teams).where(eq(schema.teams.id, updated.assignedTeamId)).limit(1) : [];
  const [user] = updated.assigneeId ? await ctx.tx.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, updated.assigneeId)).limit(1) : [];
  const target = [team?.name, user?.name].filter(Boolean).join(' / ') || 'Unassigned';
  await addActivity(ctx, t, { type: 'assignment', summary: `Assigned to ${target}${input.comment ? ` — ${input.comment}` : ''}`, data: { teamId: updated.assignedTeamId, assigneeId: updated.assigneeId, previousTeamId: t.assignedTeamId, previousAssigneeId: t.assigneeId }, customerVisible: true });
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'ticket.assign', customerId: t.customerId, changes: diffChanges(t as unknown as Record<string, unknown>, { assignedTeamId: updated.assignedTeamId, assigneeId: updated.assigneeId }) });
  if (assigneeChanged && values.assigneeId && !t.acknowledgedAt) await markAcknowledged(ctx.tx, updated, actorOf(ctx), now);
  if (assigneeChanged && updated.assigneeId) await notifyTicketEvent(ctx, 'ticket.assigned', updated, { comment: input.comment ?? null });
  if (input.autoProgress && updated.assigneeId) {
    const cur = await optionById(ctx.tx, updated.statusId);
    if (cur?.statusCategory === 'new') {
      const next = await optionByKey(ctx.tx, 'ticket_status', t.type === 'request' ? 'in_fulfilment' : t.type === 'problem' ? 'under_investigation' : 'in_progress');
      if (next && next.isActive && statusApplies(next, t.type)) updated = await changeStatusCore(ctx, updated, next, { action: 'status' });
    }
  }
  return reloadTicket(ctx.tx, t.id);
}

export async function escalateTicket(ctx: Ctx, id: string, input: { reason: string; notifyRoles?: string[] }) {
  const t = await loadTicket(ctx, id);
  requireAction(ctx, t, 'tickets:escalate');
  return escalateManually(ctx, t, input.reason, input.notifyRoles);
}

export async function setScope(ctx: Ctx, id: string, input: { scopeStatus: TicketRow['scopeStatus']; scopeNote?: string | null; scopeContractId?: string | null }) {
  const t = await loadTicket(ctx, id);
  requireAction(ctx, t, 'tickets:scope');
  if (input.scopeContractId) {
    const [c] = await ctx.tx.select({ customerId: schema.contracts.customerId }).from(schema.contracts).where(eq(schema.contracts.id, input.scopeContractId)).limit(1);
    if (!c || c.customerId !== t.customerId) throw new ValidationError('Contract does not belong to the customer');
  }
  const values = { scopeStatus: input.scopeStatus, scopeNote: input.scopeNote ?? null, scopeContractId: input.scopeContractId !== undefined ? input.scopeContractId : t.scopeContractId, scopeItemId: null, scopeClassifiedBy: userIdOf(ctx), scopeClassifiedAt: new Date(), updatedAt: new Date(), updatedBy: userIdOf(ctx), lastActivityAt: new Date() };
  await ctx.tx.update(schema.tickets).set(values).where(eq(schema.tickets.id, t.id));
  await addActivity(ctx, t, { type: 'scope', summary: `Scope set to ${input.scopeStatus.replace(/_/g, ' ')} by ${ctx.user.name}${input.scopeNote ? `: ${input.scopeNote}` : ''}`, data: { scopeStatus: input.scopeStatus, scopeNote: input.scopeNote ?? null, previous: t.scopeStatus, manual: true }, customerVisible: false });
  await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'ticket.scope', customerId: t.customerId, changes: diffChanges(t as unknown as Record<string, unknown>, { scopeStatus: input.scopeStatus, scopeNote: input.scopeNote ?? null, scopeContractId: values.scopeContractId }) });
  return reloadTicket(ctx.tx, t.id);
}

// ---------------------------------------------------------------- problem / change details

export async function updateProblemDetails(ctx: Ctx, id: string, patch: ProblemDetailsInput) {
  const t = await loadTicket(ctx, id);
  if (t.type !== 'problem') throw new ValidationError('Not a problem record');
  requireAction(ctx, t, 'problems:manage');
  const [before] = await ctx.tx.select().from(schema.problemDetails).where(eq(schema.problemDetails.ticketId, t.id)).limit(1);
  const values: Partial<typeof schema.problemDetails.$inferInsert> = {};
  for (const k of ['symptoms', 'investigation', 'rootCause', 'workaround', 'isKnownError', 'permanentFix', 'kbArticleId', 'impactSummary'] as const) if (patch[k] !== undefined) (values as Record<string, unknown>)[k] = patch[k];
  values.updatedAt = new Date();
  let after;
  if (before) [after] = await ctx.tx.update(schema.problemDetails).set(values).where(eq(schema.problemDetails.ticketId, t.id)).returning();
  else [after] = await ctx.tx.insert(schema.problemDetails).values({ ticketId: t.id, customerId: t.customerId, ...values }).returning();
  const changes = diffChanges((before ?? {}) as Record<string, unknown>, values as Record<string, unknown>);
  if (Object.keys(changes).length) {
    await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'problem.update', customerId: t.customerId, changes });
    await addActivity(ctx, t, { type: 'update', summary: `Problem details updated (${Object.keys(changes).map((k) => k.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ')})`, data: { fields: Object.keys(changes) }, customerVisible: false });
    if (patch.isKnownError && !before?.isKnownError) {
      const ke = await optionByKey(ctx.tx, 'ticket_status', 'known_error');
      const cur = await optionById(ctx.tx, t.statusId);
      if (ke && ke.isActive && statusApplies(ke, t.type) && cur?.statusCategory && ['new', 'open'].includes(cur.statusCategory) && cur.id !== ke.id) await changeStatusCore(ctx, t, ke, { action: 'status' });
    }
  }
  return after;
}

export async function updateChangeDetails(ctx: Ctx, id: string, patch: ChangeDetailsInput) {
  const t = await loadTicket(ctx, id);
  if (t.type !== 'change') throw new ValidationError('Not a change record');
  requireAction(ctx, t, 'changes:manage');
  if (patch.riskId !== undefined) await requireOption(ctx.tx, 'change_risk', patch.riskId, 'risk');
  const [before] = await ctx.tx.select().from(schema.changeDetails).where(eq(schema.changeDetails.ticketId, t.id)).limit(1);
  const values: Partial<typeof schema.changeDetails.$inferInsert> = {};
  for (const k of ['changeType', 'riskId', 'riskAssessment', 'impactAssessment', 'justification', 'implementationPlan', 'testPlan', 'backoutPlan', 'communicationPlan', 'scheduledStart', 'scheduledEnd', 'actualStart', 'actualEnd', 'downtimeExpectedMinutes', 'cabNotes', 'implementationNotes', 'pirNotes', 'pirOutcome'] as const) if (patch[k] !== undefined) (values as Record<string, unknown>)[k] = patch[k];
  if (values.scheduledStart && values.scheduledEnd && values.scheduledEnd < values.scheduledStart) throw new ValidationError('Scheduled end must be after the start');
  if (patch.pirNotes !== undefined || patch.pirOutcome !== undefined) values.reviewedAt = new Date();
  values.updatedAt = new Date();
  let after;
  if (before) [after] = await ctx.tx.update(schema.changeDetails).set(values).where(eq(schema.changeDetails.ticketId, t.id)).returning();
  else [after] = await ctx.tx.insert(schema.changeDetails).values({ ticketId: t.id, customerId: t.customerId, ...values }).returning();
  const changes = diffChanges((before ?? {}) as Record<string, unknown>, values as Record<string, unknown>, ['updatedAt', 'reviewedAt']);
  if (Object.keys(changes).length) {
    await ctx.audit({ entityType: 'ticket', entityId: t.id, entityLabel: t.number, action: 'change.update', customerId: t.customerId, changes });
    await addActivity(ctx, t, { type: 'update', summary: `Change details updated (${Object.keys(changes).map((k) => k.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ')})`, data: { fields: Object.keys(changes) }, customerVisible: Object.keys(changes).some((k) => k.startsWith('scheduled')) });
    if (['scheduledStart', 'scheduledEnd', 'changeType'].some((k) => k in changes)) await recordConflicts(ctx, t);
  }
  return after;
}

// ---------------------------------------------------------------- bulk

export async function bulkAction(ctx: Ctx, input: { ids: string[]; action: 'assign' | 'status' | 'priority'; payload: { teamId?: string | null; assigneeId?: string | null; statusId?: string; priorityId?: string; comment?: string | null } }) {
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of input.ids) {
    // Savepoint per item so one failure does not poison the request transaction.
    await ctx.tx.execute(sql`SAVEPOINT bulk_item`);
    try {
      if (input.action === 'assign') await assignTicket(ctx, id, { teamId: input.payload.teamId, assigneeId: input.payload.assigneeId, comment: input.payload.comment });
      else if (input.action === 'status') {
        if (!input.payload.statusId) throw new ValidationError('statusId required');
        await changeStatus(ctx, id, { statusId: input.payload.statusId, comment: input.payload.comment });
      } else {
        if (!input.payload.priorityId) throw new ValidationError('priorityId required');
        await updateTicket(ctx, id, { priorityId: input.payload.priorityId });
      }
      await ctx.tx.execute(sql`RELEASE SAVEPOINT bulk_item`);
      results.push({ id, ok: true });
    } catch (err) {
      await ctx.tx.execute(sql`ROLLBACK TO SAVEPOINT bulk_item`);
      results.push({ id, ok: false, error: (err as Error).message });
    }
  }
  return { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

export type { TicketType };
