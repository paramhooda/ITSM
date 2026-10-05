import { z } from 'zod';
import { LICENCE_MODELS, LICENCE_METRICS, LICENCE_TERMS, INSTALL_SOURCES, COMPLIANCE_POSITIONS, LICENCE_STATUSES } from '@itsm/shared';
import { paginationSchema } from '@/core/pagination';

const uuid = z.string().uuid();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const nullableDate = dateStr.nullable().optional();
const nullableText = (max = 200) => z.string().max(max).nullable().optional();
/** Boolean query flags. Never `z.coerce.boolean()`: it turns "false" into true. */
const bool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional());

// ---------------------------------------------------------------- products (the catalogue)

export const productListQuery = paginationSchema.extend({
  q: z.string().max(200).optional(),
  customerId: uuid.optional(),
  categoryId: uuid.optional(),
  publisher: z.string().max(120).optional(),
  licenceModel: z.enum(LICENCE_MODELS).optional(),
  includeInactive: bool,
  /** Only titles with an installation or a licence visible to the caller (narrowed to `customerId` when given). */
  inUseOnly: bool,
  sort: z.enum(['name', 'publisher', 'installations', 'customers', 'createdAt', 'updatedAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  fields: z.enum(['min', 'full']).optional(),
});
export type ProductListQuery = z.infer<typeof productListQuery>;

export const productBody = z.object({
  publisher: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200),
  versionFamily: nullableText(60),
  categoryId: uuid.nullable().optional(),
  licenceModel: z.enum(LICENCE_MODELS).optional(),
  description: nullableText(2000),
  website: nullableText(500),
  eolDate: nullableDate,
  isActive: z.boolean().optional(),
  tags: z.array(z.string().max(50)).max(50).optional(),
});
export type ProductBody = z.infer<typeof productBody>;
export const productPatch = productBody.partial();
export type ProductPatch = z.infer<typeof productPatch>;

// ---------------------------------------------------------------- installations

export const installationListQuery = paginationSchema.extend({
  q: z.string().max(200).optional(),
  customerId: uuid.optional(),
  productId: uuid.optional(),
  ciId: uuid.optional(),
  assetId: uuid.optional(),
  siteId: uuid.optional(),
  source: z.enum(INSTALL_SOURCES).optional(),
  /** Linked to a CI, to an asset, or to neither. */
  host: z.enum(['ci', 'asset', 'unlinked']).optional(),
  stale: bool,
  sort: z.enum(['product', 'host', 'customer', 'version', 'lastSeenAt', 'createdAt', 'updatedAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});
export type InstallationListQuery = z.infer<typeof installationListQuery>;

// The plain field object is the base and the refinement is added last, separately for the create body and for the
// patch: Zod 4 refuses `.omit()` / `.partial()` on an object that already carries a refinement.
const installationFields = z.object({
  customerId: uuid,
  productId: uuid,
  ciId: uuid.nullable().optional(),
  assetId: uuid.nullable().optional(),
  hostName: nullableText(253),
  assignedUser: nullableText(200),
  version: nullableText(60),
  edition: nullableText(60),
  cores: z.coerce.number().int().min(1).max(4096).nullable().optional(),
  installPath: nullableText(500),
  installedAt: nullableDate,
  source: z.enum(INSTALL_SOURCES).optional(),
  notes: nullableText(2000),
});
export const NEEDS_HOST = 'An installation needs a CI, an asset, a host name or a user';
export const installationBody = installationFields.refine((v) => v.ciId || v.assetId || v.hostName || v.assignedUser, { message: NEEDS_HOST });
export type InstallationBody = z.infer<typeof installationBody>;
/** The service re-checks the host rule on the merged row. */
export const installationPatch = installationFields.omit({ customerId: true, productId: true }).partial();
export type InstallationPatch = z.infer<typeof installationPatch>;

// ---------------------------------------------------------------- licences

export const licenceListQuery = paginationSchema.extend({
  q: z.string().max(200).optional(),
  customerId: uuid.optional(),
  productId: uuid.optional(),
  contractId: uuid.optional(),
  status: z.enum(LICENCE_STATUSES).optional(),
  endingWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  metric: z.enum(LICENCE_METRICS).optional(),
  /** Only licences in term today (active, started, not ended), whatever their status reads. */
  inTerm: bool,
  sort: z.enum(['name', 'customer', 'product', 'quantity', 'endDate', 'renewalDate', 'createdAt', 'updatedAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});
export type LicenceListQuery = z.infer<typeof licenceListQuery>;

const licenceFields = z.object({
  customerId: uuid,
  productId: uuid,
  contractId: uuid.nullable().optional(),
  name: z.string().trim().min(1).max(200),
  metric: z.enum(LICENCE_METRICS).optional(),
  term: z.enum(LICENCE_TERMS).optional(),
  quantity: z.coerce.number().min(0).max(1_000_000),
  startDate: nullableDate,
  endDate: nullableDate,
  renewalDate: nullableDate,
  autoRenew: z.boolean().optional(),
  cost: z.coerce.number().min(0).nullable().optional(),
  currency: nullableText(8),
  vendor: nullableText(200),
  poNumber: nullableText(100),
  invoiceNumber: nullableText(100),
  licenceKey: nullableText(500),
  ownerUserId: uuid.nullable().optional(),
  notes: nullableText(5000),
  isActive: z.boolean().optional(),
});
export const DATES_IN_ORDER = 'The licence must end after it starts';
export const endAfterStart = (v: { startDate?: string | null; endDate?: string | null }) => !v.startDate || !v.endDate || v.endDate >= v.startDate;
export const licenceBody = licenceFields.refine(endAfterStart, { message: DATES_IN_ORDER });
export type LicenceBody = z.infer<typeof licenceBody>;
/** The service re-checks the dates and the site rule on the merged row. */
export const licencePatch = licenceFields.omit({ customerId: true }).partial().refine(endAfterStart, { message: DATES_IN_ORDER });
export type LicencePatch = z.infer<typeof licencePatch>;
export const renewBody = licenceFields.pick({ startDate: true, endDate: true, renewalDate: true, quantity: true, cost: true, name: true }).partial().refine(endAfterStart, { message: DATES_IN_ORDER });
export type RenewBody = z.infer<typeof renewBody>;

// ---------------------------------------------------------------- compliance, renewals, overview

export const complianceQuery = z.object({
  customerId: uuid.optional(),
  productId: uuid.optional(),
  position: z.enum(COMPLIANCE_POSITIONS).optional(),
  metric: z.enum(LICENCE_METRICS).optional(),
  q: z.string().max(200).optional(),
  expiringOnly: bool,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});
export type ComplianceQuery = z.infer<typeof complianceQuery>;

export const renewalsQuery = z.object({
  days: z.coerce.number().int().min(0).max(3650).default(90),
  customerId: uuid.optional(),
  status: z.enum(['expiring', 'expired', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type RenewalsQuery = z.infer<typeof renewalsQuery>;

export const overviewQuery = z.object({ customerId: uuid.optional() });

export const SOFTWARE_IMPORT_COLUMNS = ['publisher', 'product', 'versionFamily', 'version', 'edition', 'hostname', 'assetTag', 'serialNumber', 'user', 'cores', 'installedAt', 'source', 'notes'] as const;
