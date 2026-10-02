import { eq, and, asc, sql, inArray, getTableColumns } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { NotFoundError, ValidationError, ConflictError, ForbiddenError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { isCustomerUser } from '@/core/authz';

/**
 * Service request catalog: request types with their own forms, approvals, SLA
 * and fulfilment team. Customer users see only active, portal-visible items
 * that are either global or explicitly offered to their organization.
 */

export const FORM_FIELD_TYPES = ['text', 'textarea', 'number', 'select', 'date', 'boolean', 'email'] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export interface FormField {
  key: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  options?: string[];
  helpText?: string;
  placeholder?: string;
}

export interface CatalogItemInput {
  key: string;
  name: string;
  description?: string | null;
  categoryId?: string | null;
  icon?: string | null;
  formSchema?: FormField[];
  slaPolicyId?: string | null;
  teamId?: string | null;
  approvalWorkflowId?: string | null;
  ticketCategoryId?: string | null;
  defaultPriorityId?: string | null;
  serviceId?: string | null;
  fulfilmentInstructions?: string | null;
  customerIds?: string[];
  portalVisible?: boolean;
  isActive?: boolean;
  sortOrder?: number;
}

export interface ListFilters {
  portal?: boolean;
  customerId?: string;
  categoryId?: string;
  active?: boolean;
  q?: string;
}

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/** Validates a request form definition: key format, types, select options, uniqueness. */
export function validateFormSchema(fields: unknown): FormField[] {
  if (fields === undefined || fields === null) return [];
  if (!Array.isArray(fields)) throw new ValidationError('formSchema must be an array of fields');
  const seen = new Set<string>();
  const out: FormField[] = [];
  fields.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new ValidationError(`Form field #${i + 1} is invalid`);
    const f = raw as Record<string, unknown>;
    const key = String(f.key ?? '').trim();
    const label = String(f.label ?? '').trim();
    const type = String(f.type ?? 'text') as FormFieldType;
    if (!KEY_RE.test(key)) throw new ValidationError(`Form field #${i + 1}: key "${key}" must start with a letter and contain only letters, digits and underscores`);
    if (!label) throw new ValidationError(`Form field "${key}" needs a label`);
    if (!(FORM_FIELD_TYPES as readonly string[]).includes(type)) throw new ValidationError(`Form field "${key}": unsupported type "${type}"`);
    if (seen.has(key.toLowerCase())) throw new ValidationError(`Form field key "${key}" is used more than once`);
    seen.add(key.toLowerCase());
    const field: FormField = { key, label, type, required: !!f.required };
    if (type === 'select') {
      const options = Array.isArray(f.options) ? f.options.map((o) => String(o).trim()).filter(Boolean) : [];
      if (!options.length) throw new ValidationError(`Select field "${key}" needs at least one option`);
      if (new Set(options).size !== options.length) throw new ValidationError(`Select field "${key}" has duplicate options`);
      field.options = options;
    }
    if (typeof f.helpText === 'string' && f.helpText.trim()) field.helpText = f.helpText.trim();
    if (typeof f.placeholder === 'string' && f.placeholder.trim()) field.placeholder = f.placeholder.trim();
    out.push(field);
  });
  return out;
}

async function assertOption(ctx: Ctx, id: string | null | undefined, type: string, what: string) {
  if (!id) return;
  const [row] = await ctx.tx.select({ type: schema.configOptions.type }).from(schema.configOptions).where(eq(schema.configOptions.id, id)).limit(1);
  if (!row || row.type !== type) throw new ValidationError(`${what} must reference a ${type.replace(/_/g, ' ')} option`);
}

async function assertRefs(ctx: Ctx, input: Partial<CatalogItemInput>) {
  await assertOption(ctx, input.categoryId, 'service_category', 'Catalog category');
  await assertOption(ctx, input.ticketCategoryId, 'ticket_category', 'Ticket category');
  await assertOption(ctx, input.defaultPriorityId, 'ticket_priority', 'Default priority');
  if (input.slaPolicyId) {
    const [p] = await ctx.tx.select({ id: schema.slaPolicies.id }).from(schema.slaPolicies).where(eq(schema.slaPolicies.id, input.slaPolicyId)).limit(1);
    if (!p) throw new ValidationError('SLA policy not found');
  }
  if (input.teamId) {
    const [t] = await ctx.tx.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.id, input.teamId)).limit(1);
    if (!t) throw new ValidationError('Team not found');
  }
  if (input.approvalWorkflowId) {
    const [w] = await ctx.tx.select({ id: schema.approvalWorkflows.id }).from(schema.approvalWorkflows).where(eq(schema.approvalWorkflows.id, input.approvalWorkflowId)).limit(1);
    if (!w) throw new ValidationError('Approval workflow not found');
  }
  if (input.serviceId) {
    const [s] = await ctx.tx.select({ id: schema.services.id }).from(schema.services).where(eq(schema.services.id, input.serviceId)).limit(1);
    if (!s) throw new ValidationError('Service not found');
  }
  if (input.customerIds?.length) {
    const ids = [...new Set(input.customerIds)];
    const rows = await ctx.tx.select({ id: schema.customers.id }).from(schema.customers).where(inArray(schema.customers.id, ids));
    if (rows.length !== ids.length) throw new ValidationError('One or more customers were not found');
  }
}

const itemColumns = () => ({
  ...getTableColumns(schema.catalogItems),
  categoryLabel: schema.configOptions.label,
  slaPolicyName: schema.slaPolicies.name,
  teamName: schema.teams.name,
  approvalWorkflowName: schema.approvalWorkflows.name,
  serviceName: schema.services.name,
  ticketCount: sql<number>`(select count(*)::int from ${schema.tickets} t where t.catalog_item_id = ${schema.catalogItems.id})`,
});

function baseQuery(ctx: Ctx) {
  return ctx.tx
    .select(itemColumns())
    .from(schema.catalogItems)
    .leftJoin(schema.configOptions, eq(schema.configOptions.id, schema.catalogItems.categoryId))
    .leftJoin(schema.slaPolicies, eq(schema.slaPolicies.id, schema.catalogItems.slaPolicyId))
    .leftJoin(schema.teams, eq(schema.teams.id, schema.catalogItems.teamId))
    .leftJoin(schema.approvalWorkflows, eq(schema.approvalWorkflows.id, schema.catalogItems.approvalWorkflowId))
    .leftJoin(schema.services, eq(schema.services.id, schema.catalogItems.serviceId));
}

const offeredTo = (customerId: string) => sql`(cardinality(${schema.catalogItems.customerIds}) = 0 OR ${customerId}::uuid = ANY(${schema.catalogItems.customerIds}))`;

async function loadTicketCategoryLabels(ctx: Ctx, rows: { ticketCategoryId: string | null; defaultPriorityId: string | null }[]) {
  const ids = [...new Set(rows.flatMap((r) => [r.ticketCategoryId, r.defaultPriorityId]).filter((x): x is string => !!x))];
  if (!ids.length) return new Map<string, string>();
  const opts = await ctx.tx.select({ id: schema.configOptions.id, label: schema.configOptions.label }).from(schema.configOptions).where(inArray(schema.configOptions.id, ids));
  return new Map(opts.map((o) => [o.id, o.label]));
}

export async function listItems(ctx: Ctx, f: ListFilters = {}) {
  const conds = [];
  const customerUser = isCustomerUser(ctx.user);
  if (customerUser) {
    if (!ctx.user.customerId) throw new ForbiddenError('Customer context required');
    conds.push(eq(schema.catalogItems.isActive, true), eq(schema.catalogItems.portalVisible, true), offeredTo(ctx.user.customerId));
  } else {
    if (f.portal) conds.push(eq(schema.catalogItems.isActive, true), eq(schema.catalogItems.portalVisible, true));
    if (f.customerId) {
      ctx.requireCustomer(f.customerId);
      conds.push(offeredTo(f.customerId));
    }
    if (f.active !== undefined) conds.push(eq(schema.catalogItems.isActive, f.active));
  }
  if (f.categoryId) conds.push(eq(schema.catalogItems.categoryId, f.categoryId));
  if (f.q?.trim()) {
    const pattern = `%${f.q.trim().replace(/[%_]/g, (m) => `\\${m}`)}%`;
    conds.push(sql`(${schema.catalogItems.name} ILIKE ${pattern} OR ${schema.catalogItems.description} ILIKE ${pattern} OR ${schema.catalogItems.key} ILIKE ${pattern})`);
  }
  const rows = await baseQuery(ctx)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(schema.catalogItems.sortOrder), asc(schema.catalogItems.name));
  const labels = await loadTicketCategoryLabels(ctx, rows);
  const items = rows.map((r) => ({ ...r, ticketCategoryLabel: r.ticketCategoryId ? labels.get(r.ticketCategoryId) ?? null : null, defaultPriorityLabel: r.defaultPriorityId ? labels.get(r.defaultPriorityId) ?? null : null }));
  // Customer users never see internal fulfilment details.
  return { items: customerUser ? items.map(({ fulfilmentInstructions: _f, customerIds: _c, ticketCount: _t, ...rest }) => rest) : items };
}

export async function getItem(ctx: Ctx, id: string) {
  const [row] = await baseQuery(ctx).where(eq(schema.catalogItems.id, id)).limit(1);
  if (!row) throw new NotFoundError('Catalog item');
  if (isCustomerUser(ctx.user)) {
    const visible = row.isActive && row.portalVisible && (!row.customerIds.length || (ctx.user.customerId ? row.customerIds.includes(ctx.user.customerId) : false));
    if (!visible) throw new NotFoundError('Catalog item');
    const { fulfilmentInstructions: _f, customerIds: _c, ticketCount: _t, ...rest } = row;
    const labels = await loadTicketCategoryLabels(ctx, [row]);
    return { ...rest, ticketCategoryLabel: row.ticketCategoryId ? labels.get(row.ticketCategoryId) ?? null : null, defaultPriorityLabel: row.defaultPriorityId ? labels.get(row.defaultPriorityId) ?? null : null };
  }
  const labels = await loadTicketCategoryLabels(ctx, [row]);
  return { ...row, ticketCategoryLabel: row.ticketCategoryId ? labels.get(row.ticketCategoryId) ?? null : null, defaultPriorityLabel: row.defaultPriorityId ? labels.get(row.defaultPriorityId) ?? null : null };
}

const KEY_FORMAT = /^[a-z0-9_]+$/;

export async function createItem(ctx: Ctx, input: CatalogItemInput) {
  const key = input.key.trim().toLowerCase();
  if (!KEY_FORMAT.test(key)) throw new ValidationError('Key may contain only lowercase letters, digits and underscores');
  const [exists] = await ctx.tx.select({ id: schema.catalogItems.id }).from(schema.catalogItems).where(eq(schema.catalogItems.key, key)).limit(1);
  if (exists) throw new ConflictError(`A catalog item with key "${key}" already exists`);
  const formSchema = validateFormSchema(input.formSchema);
  await assertRefs(ctx, input);
  const [row] = await ctx.tx
    .insert(schema.catalogItems)
    .values({
      key,
      name: input.name.trim(),
      description: input.description ?? null,
      categoryId: input.categoryId ?? null,
      icon: input.icon ?? null,
      formSchema: formSchema as unknown as Record<string, unknown>[],
      slaPolicyId: input.slaPolicyId ?? null,
      teamId: input.teamId ?? null,
      approvalWorkflowId: input.approvalWorkflowId ?? null,
      ticketCategoryId: input.ticketCategoryId ?? null,
      defaultPriorityId: input.defaultPriorityId ?? null,
      serviceId: input.serviceId ?? null,
      fulfilmentInstructions: input.fulfilmentInstructions ?? null,
      customerIds: [...new Set(input.customerIds ?? [])],
      portalVisible: input.portalVisible ?? true,
      isActive: input.isActive ?? true,
      sortOrder: input.sortOrder ?? 0,
    })
    .returning();
  await ctx.audit({ entityType: 'catalog_item', entityId: row.id, entityLabel: row.name, action: 'create', metadata: { key: row.key, fields: formSchema.length } });
  return getItem(ctx, row.id);
}

export async function updateItem(ctx: Ctx, id: string, patch: Partial<CatalogItemInput>) {
  const [before] = await ctx.tx.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, id)).limit(1);
  if (!before) throw new NotFoundError('Catalog item');
  const values: Partial<typeof schema.catalogItems.$inferInsert> = { updatedAt: new Date() };
  if (patch.key !== undefined) {
    const key = patch.key.trim().toLowerCase();
    if (!KEY_FORMAT.test(key)) throw new ValidationError('Key may contain only lowercase letters, digits and underscores');
    if (key !== before.key) {
      const [exists] = await ctx.tx.select({ id: schema.catalogItems.id }).from(schema.catalogItems).where(eq(schema.catalogItems.key, key)).limit(1);
      if (exists) throw new ConflictError(`A catalog item with key "${key}" already exists`);
    }
    values.key = key;
  }
  if (patch.name !== undefined) values.name = patch.name.trim();
  if (patch.formSchema !== undefined) values.formSchema = validateFormSchema(patch.formSchema) as unknown as Record<string, unknown>[];
  await assertRefs(ctx, patch);
  for (const k of ['description', 'categoryId', 'icon', 'slaPolicyId', 'teamId', 'approvalWorkflowId', 'ticketCategoryId', 'defaultPriorityId', 'serviceId', 'fulfilmentInstructions', 'portalVisible', 'isActive', 'sortOrder'] as const) {
    if (patch[k] !== undefined) (values as Record<string, unknown>)[k] = patch[k];
  }
  if (patch.customerIds !== undefined) values.customerIds = [...new Set(patch.customerIds)];
  const [after] = await ctx.tx.update(schema.catalogItems).set(values).where(eq(schema.catalogItems.id, id)).returning();
  await ctx.audit({ entityType: 'catalog_item', entityId: id, entityLabel: after.name, action: 'update', changes: diffChanges(before as Record<string, unknown>, values as Record<string, unknown>) });
  return getItem(ctx, id);
}

export async function deleteItem(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, id)).limit(1);
  if (!row) throw new NotFoundError('Catalog item');
  const [{ count }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(schema.tickets).where(eq(schema.tickets.catalogItemId, id));
  if (count > 0) throw new ConflictError(`${count} ticket(s) were raised from this catalog item. Deactivate it instead of deleting it.`);
  await ctx.tx.delete(schema.catalogItems).where(eq(schema.catalogItems.id, id));
  await ctx.audit({ entityType: 'catalog_item', entityId: id, entityLabel: row.name, action: 'delete' });
  return { deleted: true };
}

export async function cloneItem(ctx: Ctx, id: string, opts: { key?: string; name?: string } = {}) {
  const [row] = await ctx.tx.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, id)).limit(1);
  if (!row) throw new NotFoundError('Catalog item');
  let key = opts.key?.trim().toLowerCase() || `${row.key}_copy`;
  if (!KEY_FORMAT.test(key)) throw new ValidationError('Key may contain only lowercase letters, digits and underscores');
  for (let i = 2; i < 100; i++) {
    const [exists] = await ctx.tx.select({ id: schema.catalogItems.id }).from(schema.catalogItems).where(eq(schema.catalogItems.key, key)).limit(1);
    if (!exists) break;
    if (opts.key) throw new ConflictError(`A catalog item with key "${key}" already exists`);
    key = `${row.key}_copy${i}`;
  }
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = row;
  const [copy] = await ctx.tx
    .insert(schema.catalogItems)
    .values({ ...rest, key, name: opts.name?.trim() || `Copy of ${row.name}`, isActive: false })
    .returning();
  await ctx.audit({ entityType: 'catalog_item', entityId: copy.id, entityLabel: copy.name, action: 'clone', metadata: { sourceId: id } });
  return getItem(ctx, copy.id);
}

export async function reorderItems(ctx: Ctx, ids: string[]) {
  for (let i = 0; i < ids.length; i++) await ctx.tx.update(schema.catalogItems).set({ sortOrder: (i + 1) * 10, updatedAt: new Date() }).where(eq(schema.catalogItems.id, ids[i]));
  await ctx.audit({ entityType: 'catalog_item', action: 'reorder', metadata: { ids } });
  return { ok: true };
}

/** Validates submitted form data against an item's form schema (used by ticket/portal creation). */
export function validateFormData(fields: FormField[], data: Record<string, unknown>) {
  const errors: Record<string, string> = {};
  const clean: Record<string, unknown> = {};
  for (const f of fields) {
    const v = data[f.key];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    if (f.required && empty && f.type !== 'boolean') {
      errors[f.key] = `${f.label} is required`;
      continue;
    }
    if (empty) {
      if (f.type === 'boolean') clean[f.key] = false;
      continue;
    }
    switch (f.type) {
      case 'number': {
        const n = Number(v);
        if (isNaN(n)) errors[f.key] = `${f.label} must be a number`;
        else clean[f.key] = n;
        break;
      }
      case 'boolean':
        clean[f.key] = v === true || v === 'true' || v === 1 || v === '1';
        break;
      case 'select':
        if (!f.options?.includes(String(v))) errors[f.key] = `${f.label} must be one of: ${f.options?.join(', ')}`;
        else clean[f.key] = String(v);
        break;
      case 'email':
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))) errors[f.key] = `${f.label} must be an email address`;
        else clean[f.key] = String(v).trim();
        break;
      case 'date':
        if (isNaN(new Date(String(v)).getTime())) errors[f.key] = `${f.label} must be a date`;
        else clean[f.key] = String(v);
        break;
      default:
        clean[f.key] = String(v);
    }
  }
  if (Object.keys(errors).length) throw new ValidationError('Request form is incomplete', errors);
  return clean;
}
