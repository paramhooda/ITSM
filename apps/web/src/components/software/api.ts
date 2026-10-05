import { get, post, patch, del, download, buildQuery } from '@/api/client';
import type { CompliancePosition as Position, LicenceStatus, LicenceMetric, LicenceModel, LicenceTerm, InstallSource } from '@itsm/shared';
import type { SoftwareOverview } from '@/components/overview/types';

/**
 * Client for the software asset management module (apps/api/src/modules/software).
 * Query keys are rooted at ['software'] so the assistant's `software`
 * invalidation hint refreshes everything at once.
 */

export type { SoftwareOverview, LicenceStatus, Position as CompliancePositionKey };

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** A catalogue title with its counts (`fields=full`). */
export interface SoftwareProduct {
  id: string;
  key: string;
  customerId: string | null;
  publisher: string;
  name: string;
  versionFamily: string | null;
  categoryId: string | null;
  categoryLabel: string | null;
  licenceModel: LicenceModel | string;
  description: string | null;
  website: string | null;
  eolDate: string | null;
  isActive: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  installations: number;
  customers: number;
  licensedSeats: number;
  overDeployedCustomers: number;
  positions: Record<Position, number>;
}

export interface SoftwareProductMin {
  id: string;
  key: string;
  publisher: string;
  name: string;
  versionFamily: string | null;
  licenceModel: string;
  isActive: boolean;
}

export interface SoftwareInstallation {
  id: string;
  customerId: string;
  customerName: string | null;
  productId: string;
  productPublisher: string;
  productName: string;
  versionFamily: string | null;
  ciId: string | null;
  ciName: string | null;
  ciHostname: string | null;
  ciStatus: string | null;
  assetId: string | null;
  assetTag: string | null;
  assetName: string | null;
  siteName: string | null;
  hostName: string | null;
  assignedUser: string | null;
  version: string | null;
  edition: string | null;
  cores: number | null;
  installPath: string | null;
  installedAt: string | null;
  source: InstallSource | string;
  discoveredAt: string | null;
  lastSeenAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  /** Recorded by import or discovery and not seen for longer than software.stale_install_days. */
  stale: boolean;
}

export interface SoftwareLicence {
  id: string;
  customerId: string;
  customerName: string | null;
  productId: string;
  productPublisher: string;
  productName: string;
  versionFamily: string | null;
  contractId: string | null;
  contractNumber: string | null;
  name: string;
  metric: LicenceMetric | string;
  term: LicenceTerm | string;
  quantity: number;
  startDate: string | null;
  endDate: string | null;
  renewalDate: string | null;
  autoRenew: boolean;
  cost: number | null;
  currency: string | null;
  vendor: string | null;
  poNumber: string | null;
  invoiceNumber: string | null;
  licenceKey: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  notes: string | null;
  isActive: boolean;
  successorId: string | null;
  renewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  status: LicenceStatus;
  daysLeft: number | null;
  installed: number;
  entitled: number | null;
  utilisationPct: number | null;
  position: Position | null;
}

export interface CompliancePosition {
  /** Positions have no id of their own (the key is customer × title); tables key rows on that pair. */
  id?: string;
  customerId: string;
  customerName: string;
  productId: string;
  publisher: string;
  name: string;
  versionFamily: string | null;
  categoryLabel: string | null;
  licenceModel: string;
  metric: string;
  installed: number;
  entitled: number | null;
  unused: number | null;
  utilisationPct: number | null;
  position: Position;
  licencesActive: number;
  nextEndDate: string | null;
  expiringSeats: number;
  stale: number;
}

export interface LicenceLink {
  id: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
}

export interface SoftwareLicenceDetail extends Omit<SoftwareLicence, 'entitled' | 'position'> {
  licenceModel: string;
  customerCode: string | null;
  contract: { id: string; number: string; name: string; status: string; endDate: string | null } | null;
  successor: LicenceLink | null;
  predecessor: LicenceLink | null;
  compliance: CompliancePosition | null;
  installations: SoftwareInstallation[];
}

export interface SoftwareProductDetail extends Omit<SoftwareProduct, 'installations' | 'customers' | 'positions'> {
  categoryKey: string | null;
  installationCount: number;
  customerCount: number;
  compliance: CompliancePosition[];
  installations: SoftwareInstallation[];
  licences: SoftwareLicence[];
}

export interface ComplianceList extends Paginated<CompliancePosition> {
  totals: Record<Position, number> & { expiring: number };
  horizonDays: number;
}

export interface RenewalsList {
  items: SoftwareLicence[];
  days: number;
  status: 'expiring' | 'expired' | 'all';
  expired: number;
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; message: string }[];
}

export type Params = Record<string, unknown>;
const clean = (p: Params = {}) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== ''));

export const softwareKeys = {
  all: ['software'] as const,
  overview: (customerId?: string) => ['software', 'overview', customerId ?? ''] as const,
  products: (params: Params = {}) => ['software', 'products', clean(params)] as const,
  product: (id: string, customerId?: string) => ['software', 'product', id, customerId ?? ''] as const,
  installations: (params: Params = {}) => ['software', 'installations', clean(params)] as const,
  licences: (params: Params = {}) => ['software', 'licences', clean(params)] as const,
  licence: (id: string) => ['software', 'licence', id] as const,
  compliance: (params: Params = {}) => ['software', 'compliance', clean(params)] as const,
  renewals: (params: Params = {}) => ['software', 'renewals', clean(params)] as const,
};

export const softwareApi = {
  overview: (customerId?: string) => get<SoftwareOverview>('/software/overview', { customerId: customerId || undefined }),
  products: (params: Params = {}) => get<Paginated<SoftwareProduct>>('/software/products', clean(params)),
  productsMin: (params: Params = {}) => get<Paginated<SoftwareProductMin>>('/software/products', { ...clean(params), fields: 'min' }),
  product: (id: string, customerId?: string) => get<SoftwareProductDetail>(`/software/products/${id}`, { customerId: customerId || undefined }),
  createProduct: (body: Params) => post<SoftwareProductDetail>('/software/products', body),
  updateProduct: (id: string, body: Params) => patch<SoftwareProductDetail>(`/software/products/${id}`, body),
  deleteProduct: (id: string) => del(`/software/products/${id}`),
  installations: (params: Params = {}) => get<Paginated<SoftwareInstallation>>('/software/installations', clean(params)),
  createInstallation: (body: Params) => post<SoftwareInstallation>('/software/installations', body),
  updateInstallation: (id: string, body: Params) => patch<SoftwareInstallation>(`/software/installations/${id}`, body),
  deleteInstallation: (id: string) => del(`/software/installations/${id}`),
  exportInstallations: (params: Params = {}) => download(`/software/installations/export.csv${buildQuery(clean(params))}`, `software-installations-${new Date().toISOString().slice(0, 10)}.csv`),
  licences: (params: Params = {}) => get<Paginated<SoftwareLicence>>('/software/licences', clean(params)),
  licence: (id: string) => get<SoftwareLicenceDetail>(`/software/licences/${id}`),
  createLicence: (body: Params) => post<SoftwareLicenceDetail>('/software/licences', body),
  updateLicence: (id: string, body: Params) => patch<SoftwareLicenceDetail>(`/software/licences/${id}`, body),
  deleteLicence: (id: string) => del(`/software/licences/${id}`),
  renewLicence: (id: string, body: Params) => post<SoftwareLicenceDetail>(`/software/licences/${id}/renew`, body),
  compliance: (params: Params = {}) => get<ComplianceList>('/software/compliance', clean(params)),
  renewals: (params: Params = {}) => get<RenewalsList>('/software/renewals', clean(params)),
};

// ---------------------------------------------------------------- labels

export const LICENCE_MODEL_LABELS: Record<string, string> = { per_device: 'Per device', per_user: 'Per user', per_core: 'Per core', subscription: 'Subscription', perpetual: 'Perpetual' };
export const LICENCE_METRIC_LABELS: Record<string, string> = { per_device: 'Per device', per_user: 'Per user', per_core: 'Per core', site: 'Site (unlimited)' };
export const LICENCE_TERM_LABELS: Record<string, string> = { subscription: 'Subscription', perpetual: 'Perpetual' };
export const POSITION_LABELS: Record<string, string> = { compliant: 'Compliant', under_deployed: 'Under-deployed', over_deployed: 'Over-deployed', unlicensed: 'Unlicensed', unlimited: 'Unlimited' };
export const STATUS_LABELS: Record<string, string> = { active: 'Active', expiring: 'Expiring', expired: 'Expired', future: 'Future', renewed: 'Renewed', inactive: 'Inactive' };
export const SOURCE_LABELS: Record<string, string> = { manual: 'Recorded by hand', csv: 'CSV import', discovery: 'Discovery', agent: 'Agent' };
/** Short unit for seat counts by metric ("250 users", "48 cores", "40 devices"). */
export const SEAT_UNITS: Record<string, string> = { per_device: 'devices', per_user: 'users', per_core: 'cores', site: 'site' };

/** "Microsoft Office LTSC 2021" from the three naming columns. */
export const titleOf = (p: { publisher?: string | null; name?: string | null; versionFamily?: string | null } | { productPublisher?: string | null; productName?: string | null; versionFamily?: string | null }) => {
  // Licence and installation rows carry the product under productPublisher / productName (their own `name` is the licence name).
  const x = p as { publisher?: string | null; name?: string | null; productPublisher?: string | null; productName?: string | null; versionFamily?: string | null };
  const publisher = (x.productName !== undefined ? x.productPublisher : x.publisher) ?? '';
  const name = (x.productName !== undefined ? x.productName : x.name) ?? '';
  const named = name.toLowerCase().startsWith(`${publisher.toLowerCase()} `) ? name : `${publisher} ${name}`;
  return `${named}${x.versionFamily ? ` ${x.versionFamily}` : ''}`.trim();
};

/** The host a row is recorded on, in display order: CI name, asset tag, host name, user. */
export const hostOf = (i: Pick<SoftwareInstallation, 'ciName' | 'assetTag' | 'hostName' | 'assignedUser'>) => i.ciName ?? i.assetTag ?? i.hostName ?? i.assignedUser ?? '—';

/** Countdown text for a licence end date: "ended 20d ago", "ends today", "45d left", or "no end date". */
export const daysLeftText = (daysLeft: number | null | undefined, endDate?: string | null) => {
  if (daysLeft === null || daysLeft === undefined) return endDate ? '' : 'no end date';
  if (daysLeft < 0) return `ended ${Math.abs(daysLeft)}d ago`;
  if (daysLeft === 0) return 'ends today';
  return `${daysLeft}d left`;
};
export const daysLeftClass = (daysLeft: number | null | undefined) => (daysLeft === null || daysLeft === undefined ? 'text-subtle' : daysLeft < 0 ? 'text-red-600' : daysLeft <= 30 ? 'text-amber-600' : 'text-muted');

/** Local calendar date as YYYY-MM-DD, shifted by `days`. */
export const shiftDate = (iso: string, days: number) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
