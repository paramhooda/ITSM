import { eq, and, or, inArray, asc, desc, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Permission } from '@itsm/shared';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ForbiddenError, NotFoundError, ValidationError } from '@/core/errors';
import { createTicket, getTicket, reopenTicket } from '@/modules/tickets/service';
import { listTickets } from '@/modules/tickets/list';
import { addComment, timeline } from '@/modules/tickets/activity';
import * as approvalsSvc from '@/modules/tickets/approvals';
import { changeStatusCore, statusByKey } from '@/modules/tickets/status';
import { loadTicket, optionByKey, requireAction } from '@/modules/tickets/common';
import { listItems as listCatalogItems } from '@/modules/catalog/service';
import { listAttachments } from '@/modules/attachments/service';
import { customerEntitlements } from '@/modules/contracts/entitlements';
import { customerScope } from '@/modules/contracts/scope';
import { daysToExpiry, optionLabels, todayStr, addDays } from '@/modules/contracts/common';
import { COVERING_STATUSES } from '@/modules/contracts/schemas';
import { listAssetsFull } from '@/modules/assets/service';
import { assetsOverviewCore } from '@/modules/assets/overview';
import { listCisFull } from '@/modules/cmdb/service';
import { slaCompliance } from '@/modules/sla/policies';
import * as iam from '@/modules/iam/service';
import { acknowledgeVisit } from '@/modules/field/service';
import { PORTAL_ROLE_KEYS, type AcknowledgeBody, type AssetListQuery, type CiListQuery, type CreateTicketBody, type CreateUserBody, type PortalRoleKey, type TicketListQuery, type UpdateUserBody, type UserListQuery } from './schemas';

/**
 * Customer portal: a thin, customer-safe facade over the module services.
 *
 * Every function first resolves the customer the call is about through
 * `resolvePortalCustomer` and then forces that id into the underlying
 * service call; a customerId supplied by a customer user is never trusted.
 * Responses are shaped explicitly so internal data (work notes, internal
 * activities, hidden attachments, MSP user e-mails) never leaves the MSP side.
 */

const PORTAL_PERMISSIONS: Permission[] = ['portal:access', 'portal:tickets', 'portal:approve', 'portal:assets', 'portal:contracts', 'portal:reports', 'portal:manage_users'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_CATEGORIES = ['new', 'open', 'pending'];
const AWAITING_STATUS_KEY = 'pending_customer';
const CLOSE_CONFIRM_CODE = 'resolved_confirmed';

export interface PortalScope {
  customerId: string;
  /** True when an MSP user previews the portal of a customer (read-only). */
  preview: boolean;
}

/**
 * Which customer is this portal call about?
 * - Customer users: always their own customer; `perm` must be held for it.
 * - MSP users holding `tenant:all` (and customers:read) may preview a customer's
 *   portal read-only with `?customerId=` for support purposes. Mutations are refused.
 */
export function resolvePortalCustomer(ctx: Ctx, perm: Permission, requested?: string | null, opts: { mutation?: boolean } = {}): PortalScope {
  if (ctx.user.userType === 'customer') {
    const customerId = ctx.user.customerId;
    if (!customerId) throw new ForbiddenError('Your account is not linked to a customer organisation');
    if (!ctx.can('portal:access', customerId)) throw new ForbiddenError('Missing permission: portal:access');
    if (!ctx.can(perm, customerId)) throw new ForbiddenError(`Missing permission: ${perm}`);
    return { customerId, preview: false };
  }
  if (opts.mutation) throw new ForbiddenError('Portal actions are only available to customer users');
  if (!ctx.can('tenant:all') || !ctx.can('customers:read')) throw new ForbiddenError('Previewing a customer portal requires MSP-wide visibility');
  if (!requested) throw new ValidationError('customerId is required to preview a customer portal');
  ctx.requireCustomer(requested);
  return { customerId: requested, preview: true };
}

const isPortalUser = (ctx: Ctx) => ctx.user.userType === 'customer';

async function userNamesOnly(ctx: Ctx, ids: (string | null | undefined)[]) {
  const clean = [...new Set(ids.filter((x): x is string => !!x))];
  if (!clean.length) return new Map<string, string>();
  const rows = await ctx.tx.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, clean));
  return new Map(rows.map((r) => [r.id, r.name]));
}

const firstName = (name: string | null | undefined) => (name ? name.trim().split(/\s+/)[0] ?? name : null);

// ---------------------------------------------------------------- me

export async function me(ctx: Ctx, requested?: string | null) {
  const scope = resolvePortalCustomer(ctx, 'portal:access', requested);
  const cid = scope.customerId;
  const [customer] = await ctx.tx.select({ id: schema.customers.id, code: schema.customers.code, name: schema.customers.name, timezone: schema.customers.timezone, accountManagerId: schema.customers.accountManagerId, isActive: schema.customers.isActive }).from(schema.customers).where(eq(schema.customers.id, cid)).limit(1);
  if (!customer) throw new NotFoundError('Customer');
  const sites = await ctx.tx
    .select({ id: schema.sites.id, code: schema.sites.code, name: schema.sites.name, isPrimary: schema.sites.isPrimary, address: schema.sites.address, phone: schema.sites.phone, timezone: schema.sites.timezone })
    .from(schema.sites)
    .where(and(eq(schema.sites.customerId, cid), eq(schema.sites.isActive, true)))
    .orderBy(desc(schema.sites.isPrimary), asc(schema.sites.name));

  // Primary MSP contacts: the account manager (named contact) and the service desk team mailbox.
  const [am] = customer.accountManagerId ? await ctx.tx.select({ name: schema.users.name, email: schema.users.email, phone: schema.users.phone, title: schema.users.title, status: schema.users.status }).from(schema.users).where(eq(schema.users.id, customer.accountManagerId)).limit(1) : [];
  let [desk] = await ctx.tx.select({ name: schema.teams.name, email: schema.teams.email }).from(schema.teams).where(and(eq(schema.teams.isActive, true), or(eq(schema.teams.key, 'service_desk'), eq(schema.teams.teamType, 'service_desk')))).orderBy(asc(schema.teams.name)).limit(1);
  if (!desk) {
    [desk] = await ctx.tx.select({ name: schema.teams.name, email: schema.teams.email }).from(schema.customerTeams).innerJoin(schema.teams, eq(schema.teams.id, schema.customerTeams.teamId)).where(and(eq(schema.customerTeams.customerId, cid), eq(schema.teams.isActive, true))).orderBy(asc(schema.teams.name)).limit(1);
  }
  const assignedTeams = await ctx.tx.select({ id: schema.teams.id, name: schema.teams.name, teamType: schema.teams.teamType }).from(schema.customerTeams).innerJoin(schema.teams, eq(schema.teams.id, schema.customerTeams.teamId)).where(and(eq(schema.customerTeams.customerId, cid), eq(schema.teams.isActive, true))).orderBy(asc(schema.teams.name));

  const counts = await ticketCounts(ctx, cid, {});
  const pendingApprovals = scope.preview ? 0 : (await approvalsSvc.listMine(ctx)).items.filter((a) => a.customerId === cid).length;
  const horizon = new Date(Date.now() + 90 * 86_400_000);
  const [visits] = await ctx.tx
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.fieldVisits)
    .where(and(eq(schema.fieldVisits.customerId, cid), inArray(schema.fieldVisits.status, ['requested', 'scheduled', 'in_progress']), sql`${schema.fieldVisits.scheduledStart} >= now()`, sql`${schema.fieldVisits.scheduledStart} <= ${horizon}`));
  const permissions = scope.preview ? PORTAL_PERMISSIONS : PORTAL_PERMISSIONS.filter((p) => ctx.can(p, cid));

  return {
    user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email, phone: ctx.user.phone, timezone: ctx.user.timezone, roles: ctx.user.roles.filter((r) => !r.customerId || r.customerId === cid).map((r) => ({ key: r.key, name: r.name })) },
    customer: { id: customer.id, code: customer.code, name: customer.name, timezone: customer.timezone, isActive: customer.isActive },
    sites,
    serviceTeam: {
      accountManager: am && am.status === 'active' ? { name: am.name, email: am.email, phone: am.phone, title: am.title } : null,
      serviceDesk: desk ? { name: desk.name, email: desk.email } : null,
      teams: assignedTeams.map((t) => ({ id: t.id, name: t.name, teamType: t.teamType })),
    },
    permissions,
    counts: { ...counts, pendingApprovals, upcomingVisits: visits?.count ?? 0 },
    preview: scope.preview,
  };
}

// ---------------------------------------------------------------- tickets

const T = schema.tickets;
const st = alias(schema.configOptions, 'portal_st');

async function ticketCounts(ctx: Ctx, customerId: string, f: { type?: 'incident' | 'request'; mine?: boolean }) {
  const conds: SQL[] = [eq(T.customerId, customerId)];
  if (f.type) conds.push(eq(T.type, f.type));
  if (f.mine) conds.push(eq(T.requesterUserId, ctx.user.id));
  const [row] = await ctx.tx
    .select({
      open: sql<number>`count(*) filter (where ${st.statusCategory} in ('new','open','pending'))::int`,
      awaiting: sql<number>`count(*) filter (where ${st.key} = ${AWAITING_STATUS_KEY})::int`,
      resolved: sql<number>`count(*) filter (where ${st.statusCategory} = 'resolved')::int`,
      closed: sql<number>`count(*) filter (where ${st.statusCategory} in ('closed','cancelled'))::int`,
      all: sql<number>`count(*)::int`,
    })
    .from(T)
    .innerJoin(st, eq(st.id, T.statusId))
    .where(and(...conds));
  return { open: row?.open ?? 0, awaiting: row?.awaiting ?? 0, resolved: row?.resolved ?? 0, closed: row?.closed ?? 0, all: row?.all ?? 0 };
}

export async function listPortalTickets(ctx: Ctx, q: TicketListQuery) {
  const scope = resolvePortalCustomer(ctx, 'portal:tickets', q.customerId);
  const cid = scope.customerId;
  let statusCategory: string | undefined;
  let statusId: string | undefined;
  if (q.status === 'open') statusCategory = OPEN_CATEGORIES.join(',');
  else if (q.status === 'resolved') statusCategory = 'resolved';
  else if (q.status === 'closed') statusCategory = 'closed,cancelled';
  else if (q.status === 'awaiting') {
    const awaiting = await optionByKey(ctx.tx, 'ticket_status', AWAITING_STATUS_KEY);
    if (awaiting) statusId = awaiting.id;
    else statusCategory = 'pending';
  }
  let priorityId: string | undefined;
  if (q.priority) {
    const prio = UUID_RE.test(q.priority) ? { id: q.priority } : await optionByKey(ctx.tx, 'ticket_priority', q.priority.toLowerCase());
    priorityId = prio?.id ?? '00000000-0000-0000-0000-000000000000';
  }
  const res = await listTickets(ctx, {
    page: q.page,
    pageSize: q.pageSize,
    sort: q.sort ?? 'lastActivityAt',
    order: q.order ?? 'desc',
    customerId: cid,
    type: q.type,
    statusCategory,
    statusId,
    priorityId,
    siteId: q.siteId,
    createdFrom: q.createdFrom,
    createdTo: q.createdTo,
    q: q.q,
    requesterUserId: q.mine ? ctx.user.id : undefined,
    // boolean flags of the MSP list (never set from the portal)
    unassigned: undefined,
    mine: undefined,
    watching: undefined,
    isMajor: undefined,
    open: undefined,
  });
  const requesterNames = await userNamesOnly(ctx, res.items.map((r) => r.requesterUserId));
  const items = res.items.map((r) => ({
    id: r.id,
    number: r.number,
    type: r.type,
    typeLabel: r.typeLabel,
    title: r.title,
    status: r.status,
    priority: r.priority,
    siteId: r.siteId,
    siteName: r.siteName,
    serviceName: r.serviceName,
    categoryLabel: r.categoryLabel,
    requesterUserId: r.requesterUserId,
    requesterName: r.requesterUserId ? requesterNames.get(r.requesterUserId) ?? null : null,
    isMine: r.requesterUserId === ctx.user.id,
    assigneeName: firstName(r.assigneeName),
    teamName: r.teamName,
    approvalStatus: r.approvalStatus,
    awaitingCustomer: r.status.key === AWAITING_STATUS_KEY,
    dueAt: r.dueAt,
    resolvedAt: r.resolvedAt,
    closedAt: r.closedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastActivityAt: r.lastActivityAt,
    sla: r.sla,
  }));
  const counts = await ticketCounts(ctx, cid, { type: q.type, mine: q.mine });
  return { items, total: res.total, page: res.page, pageSize: res.pageSize, counts };
}

function scopeLabel(status: string, contract: { number: string; name: string } | null) {
  if (status === 'in_scope') return contract ? `Covered by contract ${contract.number} (${contract.name})` : 'Covered by your contract';
  if (status === 'out_of_scope') return 'Outside contract scope — the MSP will advise';
  return 'Being assessed';
}

async function reopenWindowDays(ctx: Ctx) {
  const [row] = await ctx.tx.select({ value: schema.systemSettings.value }).from(schema.systemSettings).where(eq(schema.systemSettings.key, 'tickets.reopen_window_days')).limit(1);
  const n = Number(row?.value ?? 14);
  return isNaN(n) ? 14 : n;
}

type ApprovalView = Awaited<ReturnType<typeof approvalsSvc.listForTicket>>['items'][number];

function approvalLabel(a: ApprovalView) {
  if (a.approverUser) return a.approverUser.name;
  if (a.approverTeam) return `Team ${a.approverTeam.name}`;
  if (a.approverRole) return a.approverRole.name;
  return 'Approver';
}

const safeApproval = (a: ApprovalView) => ({
  id: a.id,
  ticketId: a.ticketId,
  step: a.step,
  stepName: a.stepName,
  status: a.status,
  approverLabel: approvalLabel(a),
  decidedByName: a.decidedByUser?.name ?? null,
  decidedAt: a.decidedAt,
  comment: a.comment,
  createdAt: a.createdAt,
  canDecide: a.canDecide,
});

export async function getPortalTicket(ctx: Ctx, id: string, requested?: string | null) {
  const scope = resolvePortalCustomer(ctx, 'portal:tickets', requested);
  const t = await getTicket(ctx, id);
  if (t.customerId !== scope.customerId) throw new NotFoundError('Ticket');
  const [tl, att, appr, windowDays] = [await timeline(ctx, t.id), await listAttachments(ctx, 'ticket', t.id), await approvalsSvc.listForTicket(ctx, t.id), await reopenWindowDays(ctx)];
  // Customer users already get a filtered timeline / attachment list; filter again for MSP previews.
  const timelineItems = tl.items.filter((i) => !i.isInternal && i.customerVisible).map(({ minutesSpent: _m, ...rest }) => rest);
  const attachments = att.items.filter((a) => a.customerVisible || !scope.preview).map((a) => ({ id: a.id, filename: a.filename, title: a.title, contentType: a.contentType, size: a.size, uploadedByName: a.uploadedByName, createdAt: a.createdAt, canDelete: a.canDelete && !scope.preview }));
  const latestApprovals = appr.items.filter((a) => a.status !== 'superseded').map(safeApproval);
  const cat = t.status?.category ?? 'open';
  const ref = t.closedAt ?? t.resolvedAt;
  const withinWindow = !ref || Date.now() - new Date(ref).getTime() <= windowDays * 86_400_000;
  const canAct = !scope.preview && ctx.can('portal:tickets', t.customerId);
  const scopeContract = t.scopeContract ?? (t.contract ? { id: t.contract.id, number: t.contract.number, name: t.contract.name } : null);
  const formSchema = (t.catalogItem?.formSchema ?? []) as { key: string; label?: string; type?: string }[];
  const form = t.catalogItem
    ? (formSchema.length ? formSchema.map((f) => ({ key: f.key, label: f.label ?? f.key, type: f.type ?? 'text', value: t.formData?.[f.key] ?? null })) : Object.entries(t.formData ?? {}).map(([k, v]) => ({ key: k, label: k, type: 'text', value: v })))
    : [];

  return {
    id: t.id,
    number: t.number,
    type: t.type,
    typeLabel: t.typeLabel,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    impact: t.impact,
    urgency: t.urgency,
    category: t.category,
    site: t.site,
    service: t.service,
    requester: t.requester ? { id: t.requester.id, name: t.requester.name } : null,
    requesterContact: t.requesterContact ? { name: t.requesterContact.name } : null,
    isMine: t.requesterUserId === ctx.user.id,
    assignee: t.assignee ? { name: t.assignee.name, firstName: firstName(t.assignee.name) } : null,
    team: t.team ? { id: t.team.id, name: t.team.name } : null,
    catalogItem: t.catalogItem ? { id: t.catalogItem.id, name: t.catalogItem.name } : null,
    form,
    cis: t.cis.map((c) => ({ id: c.id, name: c.name, hostname: c.hostname, ipAddress: c.ipAddress, role: c.role })),
    assets: t.assets.map((a) => ({ id: a.id, tag: a.tag, name: a.name, serialNumber: a.serialNumber })),
    scope: { status: t.scopeStatus, label: scopeLabel(t.scopeStatus, scopeContract), contract: scopeContract },
    contract: t.contract ? { id: t.contract.id, number: t.contract.number, name: t.contract.name, slaPolicyName: t.contract.slaPolicyName, endDate: t.contract.endDate } : null,
    slaPolicy: t.slaPolicy,
    slas: t.slas,
    sla: t.sla,
    resolutionNotes: cat === 'resolved' || cat === 'closed' ? t.resolutionNotes : null,
    resolutionCode: t.resolutionCode,
    closureCode: t.closureCode,
    approvalStatus: t.approvalStatus,
    approvals: latestApprovals,
    pendingForMe: latestApprovals.filter((a) => a.status === 'pending' && a.canDecide),
    reopenCount: t.reopenCount,
    firstResponseAt: t.firstResponseAt,
    resolvedAt: t.resolvedAt,
    closedAt: t.closedAt,
    dueAt: t.dueAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    lastActivityAt: t.lastActivityAt,
    timeline: timelineItems,
    attachments: { items: attachments, canUpload: canAct },
    actions: {
      comment: canAct,
      reopen: canAct && (cat === 'resolved' || cat === 'closed') && withinWindow,
      confirmClose: canAct && cat === 'resolved',
      approve: !scope.preview && ctx.can('portal:approve', t.customerId) && latestApprovals.some((a) => a.status === 'pending' && a.canDecide),
      reopenWindowDays: windowDays,
    },
  };
}

export async function createPortalTicket(ctx: Ctx, input: CreateTicketBody) {
  const scope = resolvePortalCustomer(ctx, 'portal:tickets', null, { mutation: true });
  if (input.type === 'request' && !input.catalogItemId && !input.title) throw new ValidationError('Pick a request type or give the request a title');
  const ticket = await createTicket(ctx, {
    type: input.type,
    customerId: scope.customerId,
    siteId: input.siteId ?? null,
    serviceId: input.serviceId ?? null,
    title: input.title,
    description: input.description ?? null,
    impactId: input.impactId ?? null,
    urgencyId: input.urgencyId ?? null,
    catalogItemId: input.type === 'request' ? (input.catalogItemId ?? null) : null,
    formData: input.type === 'request' ? (input.formData ?? {}) : {},
    primaryCiId: input.ciId ?? null,
    ciIds: input.ciId ? [input.ciId] : [],
    primaryAssetId: input.assetId ?? null,
    assetIds: input.assetId ? [input.assetId] : [],
    requesterUserId: ctx.user.id,
  });
  return getPortalTicket(ctx, ticket.id);
}

export async function commentOnTicket(ctx: Ctx, id: string, body: string) {
  resolvePortalCustomer(ctx, 'portal:tickets', null, { mutation: true });
  const comment = await addComment(ctx, id, { kind: 'comment', body });
  return { id: comment.id, body: comment.body, createdAt: comment.createdAt, authorName: comment.authorName };
}

export async function reopenPortalTicket(ctx: Ctx, id: string, reason: string) {
  resolvePortalCustomer(ctx, 'portal:tickets', null, { mutation: true });
  await reopenTicket(ctx, id, { comment: reason });
  return getPortalTicket(ctx, id);
}

/** Customer confirms a resolution: the ticket closes with the `resolved_confirmed` closure code. */
export async function confirmResolution(ctx: Ctx, id: string, comment?: string | null) {
  resolvePortalCustomer(ctx, 'portal:tickets', null, { mutation: true });
  const t = await loadTicket(ctx, id);
  requireAction(ctx, t, 'tickets:resolve', 'portal:tickets');
  const [current] = await ctx.tx.select({ statusCategory: schema.configOptions.statusCategory }).from(schema.configOptions).where(eq(schema.configOptions.id, t.statusId)).limit(1);
  if (current?.statusCategory !== 'resolved') throw new ValidationError('Only resolved tickets can be confirmed and closed');
  const closed = await statusByKey(ctx, 'closed', t.type);
  const code = await optionByKey(ctx.tx, 'closure_code', CLOSE_CONFIRM_CODE);
  await changeStatusCore(ctx, t, closed, { closureCodeId: code?.id ?? undefined, comment: comment || `Resolution confirmed by ${ctx.user.name}`, action: 'close' });
  return getPortalTicket(ctx, id);
}

export async function portalTicketAttachments(ctx: Ctx, id: string, requested?: string | null) {
  const scope = resolvePortalCustomer(ctx, 'portal:tickets', requested);
  const t = await loadTicket(ctx, id);
  if (t.customerId !== scope.customerId) throw new NotFoundError('Ticket');
  const res = await listAttachments(ctx, 'ticket', t.id);
  return { items: res.items.filter((a) => a.customerVisible || !scope.preview), access: { canUpload: res.access.canUpload && !scope.preview } };
}

// ---------------------------------------------------------------- approvals

export async function listPortalApprovals(ctx: Ctx, requested?: string | null) {
  const scope = resolvePortalCustomer(ctx, 'portal:approve', requested);
  const cid = scope.customerId;
  let rows: { approval: typeof schema.approvals.$inferSelect; ticket: { id: string; number: string; title: string; type: string; priorityId: string | null; statusId: string; createdAt: Date; requesterUserId: string | null; description: string | null; catalogItemId: string | null; formData: Record<string, unknown> } }[];
  if (scope.preview) {
    // Pending steps addressed to the customer's portal roles.
    rows = await ctx.tx
      .select({ approval: schema.approvals, ticket: { id: T.id, number: T.number, title: T.title, type: T.type, priorityId: T.priorityId, statusId: T.statusId, createdAt: T.createdAt, requesterUserId: T.requesterUserId, description: T.description, catalogItemId: T.catalogItemId, formData: T.formData } })
      .from(schema.approvals)
      .innerJoin(T, eq(T.id, schema.approvals.ticketId))
      .where(and(eq(schema.approvals.customerId, cid), eq(schema.approvals.status, 'pending'), inArray(schema.approvals.approverRoleKey, [...PORTAL_ROLE_KEYS])))
      .orderBy(asc(schema.approvals.createdAt));
  } else {
    const mine = await approvalsSvc.listMine(ctx);
    const ticketIds = [...new Set(mine.items.filter((a) => a.customerId === cid).map((a) => a.ticketId))];
    const extra = ticketIds.length ? await ctx.tx.select({ id: T.id, catalogItemId: T.catalogItemId, formData: T.formData }).from(T).where(inArray(T.id, ticketIds)) : [];
    rows = mine.items
      .filter((a) => a.customerId === cid)
      .map(({ ticket, ...approval }) => {
        const x = extra.find((e) => e.id === ticket.id);
        return { approval: approval as typeof schema.approvals.$inferSelect, ticket: { ...ticket, catalogItemId: x?.catalogItemId ?? null, formData: x?.formData ?? {} } };
      });
  }
  const optIds = rows.flatMap((r) => [r.ticket.priorityId, r.ticket.statusId]);
  const labels = await optionLabels(ctx.tx, optIds);
  const names = await userNamesOnly(ctx, rows.map((r) => r.ticket.requesterUserId));
  const catalogIds = [...new Set(rows.map((r) => r.ticket.catalogItemId).filter((x): x is string => !!x))];
  const catalog = catalogIds.length ? await ctx.tx.select({ id: schema.catalogItems.id, name: schema.catalogItems.name, formSchema: schema.catalogItems.formSchema }).from(schema.catalogItems).where(inArray(schema.catalogItems.id, catalogIds)) : [];
  const items = rows.map(({ approval: a, ticket: t }) => {
    const item = t.catalogItemId ? catalog.find((c) => c.id === t.catalogItemId) : undefined;
    const fields = (item?.formSchema ?? []) as { key: string; label?: string }[];
    const form = fields.length ? fields.map((f) => ({ label: f.label ?? f.key, value: t.formData?.[f.key] ?? null })) : Object.entries(t.formData ?? {}).map(([k, v]) => ({ label: k, value: v }));
    const pr = t.priorityId ? labels.get(t.priorityId) : undefined;
    const stt = labels.get(t.statusId);
    return {
      id: a.id,
      step: a.step,
      stepName: a.stepName,
      status: a.status,
      createdAt: a.createdAt,
      ticket: {
        id: t.id,
        number: t.number,
        title: t.title,
        type: t.type,
        description: t.description,
        createdAt: t.createdAt,
        requesterName: t.requesterUserId ? names.get(t.requesterUserId) ?? null : null,
        priority: pr ? { id: pr.id, key: pr.key, label: pr.label, color: pr.color } : null,
        status: stt ? { id: stt.id, key: stt.key, label: stt.label, color: stt.color } : null,
        catalogItemName: item?.name ?? null,
        form,
      },
    };
  });
  return { items, total: items.length };
}

export async function decidePortalApproval(ctx: Ctx, ticketId: string, approvalId: string, decision: 'approved' | 'rejected', comment?: string | null) {
  resolvePortalCustomer(ctx, 'portal:approve', null, { mutation: true });
  const res = await approvalsSvc.decide(ctx, ticketId, approvalId, decision, comment);
  return { items: res.items.filter((a) => a.status !== 'superseded').map(safeApproval), approvalStatus: res.approvalStatus };
}

// ---------------------------------------------------------------- services & contracts

export async function portalServices(ctx: Ctx, requested?: string | null) {
  const scope = resolvePortalCustomer(ctx, 'portal:contracts', requested);
  const cid = scope.customerId;
  const [coverage, entitlements] = [await customerScope(ctx, cid), await customerEntitlements(ctx, cid)];
  const contractIds = coverage.map((c) => c.contract.id);
  const rows = contractIds.length
    ? await ctx.tx
        .select({ id: schema.contracts.id, typeId: schema.contracts.typeId, renewalDate: schema.contracts.renewalDate, autoRenew: schema.contracts.autoRenew, supportHoursCalendarId: schema.contracts.supportHoursCalendarId, slaPolicyId: schema.contracts.slaPolicyId, escalationMatrix: schema.contracts.escalationMatrix, responseCommitment: schema.contracts.responseCommitment, resolutionCommitment: schema.contracts.resolutionCommitment, exclusions: schema.contracts.exclusions, description: schema.contracts.description })
        .from(schema.contracts)
        .where(inArray(schema.contracts.id, contractIds))
    : [];
  const typeLabels = await optionLabels(ctx.tx, rows.map((r) => r.typeId));
  const calendars = new Map((await ctx.tx.select({ id: schema.businessCalendars.id, name: schema.businessCalendars.name, timezone: schema.businessCalendars.timezone, is24x7: schema.businessCalendars.is24x7, hours: schema.businessCalendars.hours, isDefault: schema.businessCalendars.isDefault }).from(schema.businessCalendars)).map((c) => [c.id, c]));
  const [defaultPolicy] = await ctx.tx.select({ id: schema.slaPolicies.id, name: schema.slaPolicies.name, calendarId: schema.slaPolicies.calendarId }).from(schema.slaPolicies).where(and(eq(schema.slaPolicies.isDefault, true), eq(schema.slaPolicies.isActive, true))).limit(1);
  const policyIds = [...new Set([...rows.map((r) => r.slaPolicyId), ...coverage.flatMap((c) => c.services.map((s) => s.effectiveSlaPolicyId)), defaultPolicy?.id].filter((x): x is string => !!x))];
  const policies = policyIds.length ? await ctx.tx.select({ id: schema.slaPolicies.id, name: schema.slaPolicies.name, calendarId: schema.slaPolicies.calendarId }).from(schema.slaPolicies).where(inArray(schema.slaPolicies.id, policyIds)) : [];
  const prio = alias(schema.configOptions, 'portal_prio');
  const targets = policyIds.length
    ? await ctx.tx
        .select({ policyId: schema.slaTargets.policyId, ticketType: schema.slaTargets.ticketType, priorityId: schema.slaTargets.priorityId, priorityKey: prio.key, priorityLabel: prio.label, priorityLevel: prio.level, priorityColor: prio.color, metric: schema.slaTargets.metric, minutes: schema.slaTargets.minutes, calendarTime: schema.slaTargets.calendarTime })
        .from(schema.slaTargets)
        .leftJoin(prio, eq(prio.id, schema.slaTargets.priorityId))
        .where(inArray(schema.slaTargets.policyId, policyIds))
        .orderBy(asc(prio.level), asc(schema.slaTargets.metric))
    : [];
  const matrixContactIds = rows.flatMap((r) => ((r.escalationMatrix ?? []) as { contactId?: string | null }[]).map((m) => m.contactId).filter((x): x is string => !!x));
  const contacts = matrixContactIds.length ? await ctx.tx.select({ id: schema.contacts.id, name: schema.contacts.name, email: schema.contacts.email, phone: schema.contacts.phone, mobile: schema.contacts.mobile, title: schema.contacts.title }).from(schema.contacts).where(and(inArray(schema.contacts.id, matrixContactIds), eq(schema.contacts.customerId, cid))) : [];
  const matrixUserNames = await userNamesOnly(ctx, rows.flatMap((r) => ((r.escalationMatrix ?? []) as { userId?: string | null }[]).map((m) => m.userId)));
  const docs = contractIds.length
    ? await ctx.tx
        .select({ id: schema.attachments.id, entityId: schema.attachments.entityId, filename: schema.attachments.filename, title: schema.attachments.title, docType: schema.attachments.docType, contentType: schema.attachments.contentType, size: schema.attachments.size, createdAt: schema.attachments.createdAt })
        .from(schema.attachments)
        .where(and(eq(schema.attachments.entityType, 'contract'), inArray(schema.attachments.entityId, contractIds), eq(schema.attachments.customerVisible, true)))
        .orderBy(desc(schema.attachments.createdAt))
    : [];

  const policyView = (policyId: string | null) => {
    const p = policyId ? policies.find((x) => x.id === policyId) : undefined;
    if (!p) return null;
    const cal = p.calendarId ? calendars.get(p.calendarId) : undefined;
    return { id: p.id, name: p.name, calendarName: cal?.name ?? null, targets: targets.filter((t) => t.policyId === p.id).map(({ policyId: _p, ...t }) => t) };
  };

  const defaultCalendar = [...calendars.values()].find((c) => c.isDefault) ?? null;
  const contracts = coverage.map((c) => {
    const row = rows.find((r) => r.id === c.contract.id);
    const effectivePolicyId = c.contract.slaPolicyId ?? defaultPolicy?.id ?? null;
    const policyCalendarId = policies.find((p) => p.id === effectivePolicyId)?.calendarId ?? null;
    // Support hours: the contract's calendar, else the SLA policy's calendar, else the platform default.
    const cal = (row?.supportHoursCalendarId ? calendars.get(row.supportHoursCalendarId) : undefined) ?? (policyCalendarId ? calendars.get(policyCalendarId) : undefined) ?? defaultCalendar ?? undefined;
    const matrix = ((row?.escalationMatrix ?? []) as { level?: number; name?: string; contactId?: string | null; userId?: string | null; afterMinutes?: number | null }[]).map((m) => {
      const contact = m.contactId ? contacts.find((x) => x.id === m.contactId) : undefined;
      return {
        level: m.level ?? null,
        name: m.name ?? null,
        afterMinutes: m.afterMinutes ?? null,
        // Customer-side contact (their own people) with details; MSP-side escalation point by name only.
        contact: contact ? { name: contact.name, title: contact.title, email: contact.email, phone: contact.mobile ?? contact.phone } : null,
        mspContactName: m.userId ? matrixUserNames.get(m.userId) ?? null : null,
      };
    });
    return {
      id: c.contract.id,
      number: c.contract.number,
      name: c.contract.name,
      status: c.contract.status,
      typeLabel: row?.typeId ? typeLabels.get(row.typeId)?.label ?? null : null,
      startDate: c.contract.startDate,
      endDate: c.contract.endDate,
      renewalDate: row?.renewalDate ?? null,
      autoRenew: row?.autoRenew ?? false,
      daysToExpiry: daysToExpiry(c.contract.endDate),
      supportHours: cal ? { name: cal.name, timezone: cal.timezone, is24x7: cal.is24x7, hours: cal.hours } : null,
      slaPolicyName: policies.find((p) => p.id === effectivePolicyId)?.name ?? null,
      description: row?.description ?? null,
      responseCommitment: row?.responseCommitment ?? null,
      resolutionCommitment: row?.resolutionCommitment ?? null,
      exclusions: row?.exclusions ?? null,
      slaPolicy: policyView(effectivePolicyId),
      services: c.services.map((s) => ({ id: s.serviceId, name: s.serviceName, domain: s.domain, teamName: s.teamName, slaPolicyName: s.effectiveSlaPolicyName, supportHoursCalendarName: s.supportHoursCalendarName })),
      sites: c.sites,
      allSites: c.sites.length === 0,
      scopeGroups: c.groups.map((g) => ({
        headerId: g.headerId,
        headerLabel: g.headerLabel,
        items: g.items.map((i) => ({ id: i.id, name: i.name, description: i.description, classification: i.classification, serviceName: i.serviceName, siteName: i.siteName, ciTypeName: i.ciTypeName, ticketCategoryLabel: i.ticketCategoryLabel, categoryLabel: i.categoryLabel, typeLabel: i.typeLabel })),
      })),
      escalationMatrix: matrix,
      documents: docs.filter((d) => d.entityId === c.contract.id).map(({ entityId: _e, ...d }) => d),
    };
  });

  const serviceIds = [...new Set(coverage.flatMap((c) => c.services.map((s) => s.serviceId)))];
  const serviceRows = serviceIds.length ? await ctx.tx.select({ id: schema.services.id, name: schema.services.name, description: schema.services.description, domain: schema.services.domain }).from(schema.services).where(inArray(schema.services.id, serviceIds)).orderBy(asc(schema.services.name)) : [];
  const coveredServices = serviceRows.map((s) => {
    const via = coverage.flatMap((c) => c.services.filter((x) => x.serviceId === s.id).map((x) => ({ contractNumber: c.contract.number, teamName: x.teamName, slaPolicyName: x.effectiveSlaPolicyName ?? contracts.find((k) => k.id === c.contract.id)?.slaPolicyName ?? null })));
    return { id: s.id, name: s.name, description: s.description, domain: s.domain, teamName: via.find((v) => v.teamName)?.teamName ?? null, slaPolicyName: via.find((v) => v.slaPolicyName)?.slaPolicyName ?? null, contractNumbers: [...new Set(via.map((v) => v.contractNumber))] };
  });

  return {
    contracts,
    services: coveredServices,
    entitlements: entitlements.map((e) => ({ id: e.id, name: e.name, typeLabel: e.typeLabel, unit: e.unit, period: e.period, quantity: e.quantity, serviceName: e.serviceName, contractNumber: e.contractNumber, contractName: e.contractName, utilization: e.utilization })),
    preview: scope.preview,
  };
}

export async function portalSla(ctx: Ctx, q: { customerId?: string; days: number }) {
  const scope = resolvePortalCustomer(ctx, 'portal:contracts', q.customerId);
  const from = new Date(Date.now() - q.days * 86_400_000).toISOString();
  const [byMetric, byPriority] = [await slaCompliance(ctx, { customerId: scope.customerId, from, groupBy: 'metric' }), await slaCompliance(ctx, { customerId: scope.customerId, from, groupBy: 'priority' })];
  return { days: q.days, from, totals: byMetric.totals, byMetric: byMetric.groups, byPriority: byPriority.groups };
}

// ---------------------------------------------------------------- assets & CIs

export async function portalAssets(ctx: Ctx, q: AssetListQuery) {
  const scope = resolvePortalCustomer(ctx, 'portal:assets', q.customerId);
  const coverage: Partial<Parameters<typeof listAssetsFull>[1]> =
    q.expiring === 'warranty30' ? { warrantyExpiringDays: 30 }
    : q.expiring === 'warranty90' ? { warrantyExpiringDays: 90 }
    : q.expiring === 'amc30' ? { amcExpiringDays: 30 }
    : q.expiring === 'amc90' ? { amcExpiringDays: 90 }
    : q.expiring === 'expired' ? { expired: 'any' }
    : {};
  const res = await listAssetsFull(ctx, { page: q.page, pageSize: q.pageSize, customerId: scope.customerId, siteId: q.siteId, categoryId: q.categoryId, lifecycleStage: q.lifecycleStage, q: q.q, sort: q.sort ?? 'tag', order: q.order ?? 'asc', ...coverage });
  return {
    items: res.items.map((a) => ({ id: a.id, tag: a.tag, name: a.name, categoryLabel: a.categoryLabel, siteId: a.siteId, siteName: a.siteName, manufacturer: a.manufacturer, model: a.model, serialNumber: a.serialNumber, location: a.location, statusLabel: a.statusLabel, statusColor: a.statusColor, lifecycleStage: a.lifecycleStage, warrantyEnd: a.warrantyEnd, warranty: a.warranty, amcEnd: a.amcEnd, amc: a.amc, ciName: a.ciName })),
    total: res.total,
    page: res.page,
    pageSize: res.pageSize,
  };
}

/** GET /portal/assets/overview: the customer's own fleet (never another customer's) for the portal assets page. */
export async function portalAssetsOverview(ctx: Ctx, requested?: string | null) {
  const scope = resolvePortalCustomer(ctx, 'portal:assets', requested);
  const o = await assetsOverviewCore(ctx, eq(schema.assets.customerId, scope.customerId));
  return {
    total: o.total,
    byCategory: o.byCategory,
    byLifecycle: o.byLifecycle,
    bySite: o.bySite,
    warranty: o.warranty,
    amc: o.amc,
    expiringSoon: o.expiringSoon.map(({ customerName: _c, ...e }) => e),
    preview: scope.preview,
  };
}

export async function portalCis(ctx: Ctx, q: CiListQuery) {
  const scope = resolvePortalCustomer(ctx, 'portal:assets', q.customerId);
  const res = await listCisFull(ctx, { page: q.page, pageSize: q.pageSize, customerId: scope.customerId, siteId: q.siteId, typeId: q.typeId, status: q.status as never, criticality: q.criticality as never, q: q.q, sort: q.sort ?? 'name', order: q.order ?? 'asc' });
  return {
    items: res.items.map((c) => ({ id: c.id, name: c.name, typeName: c.typeName, typeKey: c.typeKey, typeColor: c.typeColor, hostname: c.hostname, ipAddress: c.ipAddress, siteId: c.siteId, siteName: c.siteName, status: c.status, criticality: c.criticality, environment: c.environment, manufacturer: c.manufacturer, model: c.model, serialNumber: c.serialNumber, assetTag: c.assetTag })),
    total: res.total,
    page: res.page,
    pageSize: res.pageSize,
  };
}

// ---------------------------------------------------------------- maintenance & visits

const VISIT_OPEN_STATUSES = ['requested', 'scheduled', 'in_progress'];

export async function portalMaintenance(ctx: Ctx, q: { customerId?: string; pastDays: number; futureDays: number }) {
  const scope = resolvePortalCustomer(ctx, 'portal:access', q.customerId);
  const cid = scope.customerId;
  const today = todayStr();
  const fromDay = addDays(today, -q.pastDays);
  const toDay = addDays(today, q.futureDays);
  const o = schema.pmOccurrences;
  const p = schema.pmPrograms;
  const engineer = alias(schema.users, 'portal_pm_engineer');
  const occDate = sql<string>`coalesce(${o.scheduledDate}, ${o.plannedDate})`;
  const occurrences = await ctx.tx
    .select({ id: o.id, programId: o.programId, programName: p.name, description: p.description, frequency: p.frequency, siteId: p.siteId, siteName: schema.sites.name, plannedDate: o.plannedDate, scheduledDate: o.scheduledDate, status: o.status, completedAt: o.completedAt, fieldVisitId: o.fieldVisitId, engineerName: engineer.name, requiresSiteVisit: p.requiresSiteVisit })
    .from(o)
    .innerJoin(p, eq(p.id, o.programId))
    .leftJoin(schema.sites, eq(schema.sites.id, p.siteId))
    .leftJoin(engineer, eq(engineer.id, sql`coalesce(${o.engineerId}, ${p.assignedEngineerId})`))
    .where(and(eq(o.customerId, cid), sql`${occDate} >= ${fromDay}::date`, sql`${occDate} <= ${toDay}::date`))
    .orderBy(asc(occDate));

  const v = schema.fieldVisits;
  const veng = alias(schema.users, 'portal_visit_engineer');
  const vtype = alias(schema.configOptions, 'portal_visit_type');
  const visitDate = sql`coalesce(${v.scheduledStart}, ${v.createdAt})`;
  const visitRows = await ctx.tx
    .select({ id: v.id, number: v.number, title: v.title, purpose: v.purpose, status: v.status, typeLabel: vtype.label, siteId: v.siteId, siteName: schema.sites.name, scheduledStart: v.scheduledStart, scheduledEnd: v.scheduledEnd, actualStart: v.actualStart, actualEnd: v.actualEnd, engineerName: veng.name, ticketId: v.ticketId, ticketNumber: T.number, pmOccurrenceId: v.pmOccurrenceId, workSummary: v.workSummary, recommendations: v.recommendations, customerAckAt: v.customerAckAt, customerAckName: v.customerAckName, customerRating: v.customerRating, reportGeneratedAt: v.reportGeneratedAt, createdAt: v.createdAt })
    .from(v)
    .leftJoin(veng, eq(veng.id, v.engineerId))
    .leftJoin(vtype, eq(vtype.id, v.typeId))
    .leftJoin(schema.sites, eq(schema.sites.id, v.siteId))
    .leftJoin(T, eq(T.id, v.ticketId))
    .where(and(eq(v.customerId, cid), sql`${visitDate} >= ${fromDay}::date`, sql`${visitDate} < (${toDay}::date + interval '1 day')`))
    .orderBy(asc(visitDate));
  const visitIds = visitRows.map((r) => r.id);
  const reports = visitIds.length
    ? await ctx.tx
        .select({ id: schema.attachments.id, entityId: schema.attachments.entityId, filename: schema.attachments.filename, docType: schema.attachments.docType, createdAt: schema.attachments.createdAt })
        .from(schema.attachments)
        .where(and(eq(schema.attachments.entityType, 'field_visit'), inArray(schema.attachments.entityId, visitIds), eq(schema.attachments.customerVisible, true)))
        .orderBy(desc(schema.attachments.createdAt))
    : [];
  const reportFor = (visitId: string) => {
    const mine = reports.filter((r) => r.entityId === visitId);
    return mine.find((r) => r.docType === 'report') ?? mine[0] ?? null;
  };
  const now = Date.now();
  const visits = visitRows.map((r) => {
    const report = reportFor(r.id);
    const done = !VISIT_OPEN_STATUSES.includes(r.status);
    const when = r.scheduledStart ?? r.createdAt;
    return {
      id: r.id,
      number: r.number,
      title: r.title,
      purpose: r.purpose,
      type: r.typeLabel,
      status: r.status,
      siteId: r.siteId,
      siteName: r.siteName,
      scheduledStart: r.scheduledStart,
      scheduledEnd: r.scheduledEnd,
      actualStart: r.actualStart,
      actualEnd: r.actualEnd,
      engineerName: r.engineerName,
      ticket: r.ticketId ? { id: r.ticketId, number: r.ticketNumber } : null,
      pmOccurrenceId: r.pmOccurrenceId,
      workSummary: r.status === 'completed' ? r.workSummary : null,
      recommendations: r.status === 'completed' ? r.recommendations : null,
      acknowledged: !!r.customerAckAt,
      acknowledgedAt: r.customerAckAt,
      acknowledgedBy: r.customerAckName,
      rating: r.customerRating,
      reportAttachmentId: report?.id ?? null,
      reportFilename: report?.filename ?? null,
      canAcknowledge: !scope.preview && r.status === 'completed' && !r.customerAckAt,
      upcoming: !done && when.getTime() >= now - 86_400_000,
    };
  });
  const pm = occurrences.map((r) => ({
    id: r.id,
    programId: r.programId,
    programName: r.programName,
    description: r.description,
    frequency: r.frequency,
    siteId: r.siteId,
    siteName: r.siteName,
    plannedDate: r.plannedDate,
    scheduledDate: r.scheduledDate,
    date: r.scheduledDate ?? r.plannedDate,
    status: r.status,
    completedAt: r.completedAt,
    fieldVisitId: r.fieldVisitId,
    engineerName: r.engineerName,
    requiresSiteVisit: r.requiresSiteVisit,
    upcoming: !['completed', 'cancelled', 'missed'].includes(r.status) && (r.scheduledDate ?? r.plannedDate) >= today,
  }));
  return {
    window: { from: fromDay, to: toDay },
    upcoming: { occurrences: pm.filter((x) => x.upcoming), visits: visits.filter((x) => x.upcoming) },
    past: { occurrences: pm.filter((x) => !x.upcoming).reverse(), visits: visits.filter((x) => !x.upcoming).reverse() },
    preview: scope.preview,
  };
}

export async function acknowledgePortalVisit(ctx: Ctx, visitId: string, input: AcknowledgeBody) {
  const scope = resolvePortalCustomer(ctx, 'portal:access', null, { mutation: true });
  const [visit] = await ctx.tx.select({ id: schema.fieldVisits.id, customerId: schema.fieldVisits.customerId }).from(schema.fieldVisits).where(eq(schema.fieldVisits.id, visitId)).limit(1);
  if (!visit || visit.customerId !== scope.customerId) throw new NotFoundError('Visit');
  await acknowledgeVisit(ctx, visitId, { name: input.name, title: input.title ?? undefined, notes: input.notes ?? undefined, rating: input.rating ?? undefined });
  const view = await portalMaintenance(ctx, { pastDays: 365, futureDays: 365 });
  return [...view.past.visits, ...view.upcoming.visits].find((x) => x.id === visitId) ?? { id: visitId, acknowledged: true };
}

// ---------------------------------------------------------------- reports

export async function portalReports(ctx: Ctx, requested?: string | null) {
  const scope = resolvePortalCustomer(ctx, 'portal:reports', requested);
  const r = schema.reportRuns;
  const rows = await ctx.tx
    .select({ id: r.id, name: r.name, reportKey: r.reportKey, parameters: r.parameters, format: r.format, status: r.status, attachmentId: r.attachmentId, rowCount: r.rowCount, startedAt: r.startedAt, finishedAt: r.finishedAt, createdAt: r.createdAt, filename: schema.attachments.filename, size: schema.attachments.size })
    .from(r)
    .leftJoin(schema.attachments, eq(schema.attachments.id, r.attachmentId))
    .where(and(eq(r.customerId, scope.customerId), eq(r.portalVisible, true)))
    .orderBy(desc(r.createdAt))
    .limit(200);
  return { items: rows.map((x) => ({ ...x, generatedAt: x.finishedAt ?? x.createdAt })), total: rows.length };
}

// ---------------------------------------------------------------- catalog

export async function portalCatalog(ctx: Ctx, requested?: string | null) {
  const scope = resolvePortalCustomer(ctx, 'portal:tickets', requested);
  const res = await listCatalogItems(ctx, scope.preview ? { portal: true, customerId: scope.customerId } : {});
  return {
    items: res.items.map((i) => ({ id: i.id, key: i.key, name: i.name, description: i.description, icon: i.icon, categoryId: i.categoryId, categoryLabel: i.categoryLabel, serviceId: i.serviceId, serviceName: i.serviceName, formSchema: i.formSchema, ticketCategoryId: i.ticketCategoryId, defaultPriorityId: i.defaultPriorityId, defaultPriorityLabel: i.defaultPriorityLabel, requiresApproval: !!i.approvalWorkflowId, slaPolicyName: i.slaPolicyName, sortOrder: i.sortOrder })),
  };
}

// ---------------------------------------------------------------- users

type IamUser = Awaited<ReturnType<typeof iam.getUser>>;
type IamListUser = Awaited<ReturnType<typeof iam.listUsers>>['items'][number];

function portalRoleOf(roles: { key: string }[]): PortalRoleKey | null {
  if (roles.some((r) => r.key === 'customer_admin')) return 'customer_admin';
  if (roles.some((r) => r.key === 'customer_user')) return 'customer_user';
  return null;
}

function safeUser(ctx: Ctx, u: IamUser | IamListUser) {
  return { id: u.id, email: u.email, name: u.name, phone: u.phone, whatsappOptIn: (u as { whatsappOptIn?: boolean }).whatsappOptIn ?? false, title: u.title, status: u.status, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, role: portalRoleOf(u.roles), roleName: u.roles.find((r) => r.key === portalRoleOf(u.roles))?.name ?? null, isSelf: u.id === ctx.user.id };
}

async function portalRole(ctx: Ctx, key: string) {
  if (!(PORTAL_ROLE_KEYS as readonly string[]).includes(key)) throw new ValidationError(`Portal users can only hold the ${PORTAL_ROLE_KEYS.join(' or ')} role`);
  const [role] = await ctx.tx.select({ id: schema.roles.id, key: schema.roles.key, userType: schema.roles.userType }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  if (!role || role.userType !== 'customer') throw new ValidationError('Portal role is not configured');
  return role;
}

async function loadOwnUser(ctx: Ctx, customerId: string, id: string) {
  const [u] = await ctx.tx.select({ id: schema.users.id, userType: schema.users.userType, customerId: schema.users.customerId }).from(schema.users).where(eq(schema.users.id, id)).limit(1);
  if (!u || u.userType !== 'customer' || u.customerId !== customerId) throw new NotFoundError('User');
  return u;
}

export async function listPortalUsers(ctx: Ctx, q: UserListQuery) {
  const scope = resolvePortalCustomer(ctx, 'portal:manage_users', q.customerId);
  const res = await iam.listUsers(ctx, { page: q.page, pageSize: q.pageSize, q: q.q, status: q.status, userType: 'customer', customerId: scope.customerId, sort: 'name', order: 'asc' });
  return { items: res.items.map((u) => safeUser(ctx, u)), total: res.total, page: res.page, pageSize: res.pageSize };
}

export async function createPortalUser(ctx: Ctx, input: CreateUserBody) {
  const scope = resolvePortalCustomer(ctx, 'portal:manage_users', null, { mutation: true });
  const role = await portalRole(ctx, input.role);
  const res = await iam.createUser(ctx, {
    email: input.email,
    name: input.name,
    phone: input.phone ?? undefined,
    title: input.title ?? undefined,
    userType: 'customer',
    customerId: scope.customerId,
    roleIds: [{ roleId: role.id, customerId: scope.customerId }],
    teamIds: [],
    customerAccess: [],
    sendWelcome: true,
  });
  return { user: safeUser(ctx, res.user), temporaryPassword: res.temporaryPassword ?? null };
}

export async function updatePortalUser(ctx: Ctx, id: string, patch: UpdateUserBody) {
  const scope = resolvePortalCustomer(ctx, 'portal:manage_users', null, { mutation: true });
  await loadOwnUser(ctx, scope.customerId, id);
  const fields: Parameters<typeof iam.updateUser>[2] = {};
  if (patch.name !== undefined) fields.name = patch.name;
  if (patch.phone !== undefined) fields.phone = patch.phone ?? undefined;
  if (patch.title !== undefined) fields.title = patch.title ?? undefined;
  if (patch.status !== undefined) fields.status = patch.status;
  if (patch.whatsappOptIn !== undefined) fields.whatsappOptIn = patch.whatsappOptIn;
  if (Object.keys(fields).length) await iam.updateUser(ctx, id, fields);
  if (patch.role !== undefined) {
    if (id === ctx.user.id) throw new ValidationError('You cannot change your own role');
    const role = await portalRole(ctx, patch.role);
    await iam.setUserRoles(ctx, id, [{ roleId: role.id, customerId: scope.customerId }]);
  }
  return safeUser(ctx, await iam.getUser(ctx, id));
}

export async function resetPortalUserPassword(ctx: Ctx, id: string) {
  const scope = resolvePortalCustomer(ctx, 'portal:manage_users', null, { mutation: true });
  await loadOwnUser(ctx, scope.customerId, id);
  const res = await iam.adminResetPassword(ctx, id);
  return { temporaryPassword: res.temporaryPassword ?? null };
}

export { COVERING_STATUSES, isPortalUser };
