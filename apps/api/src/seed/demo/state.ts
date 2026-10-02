import { eq } from 'drizzle-orm';
import type { Permission } from '@itsm/shared';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import { buildCtx, type Ctx } from '@/core/context';
import type { Principal } from '@/core/principal';
import { Rng } from './rng';

/** Resolved ids of configuration data created by the default seed. */
export interface Refs {
  option(type: string, key: string): string;
  optionRow(type: string, key: string): typeof schema.configOptions.$inferSelect;
  optionsOf(type: string): (typeof schema.configOptions.$inferSelect)[];
  team(key: string): string;
  role(key: string): string;
  ciType(key: string): string;
  relType(key: string): string;
  kbCategory(key: string): string;
  calendar(name: string): string;
  policy(name: string): string;
  catalogItem(key: string): typeof schema.catalogItems.$inferSelect;
  workflow(name: string): string;
  holidayCalendarId: string | null;
}

export interface DemoUser {
  key: string;
  id: string;
  name: string;
  email: string;
  roleKey: string;
  teamKeys: string[];
  title: string;
}

export interface DemoSite {
  key: string;
  id: string;
  code: string;
  name: string;
  typeKey: string;
  /** Large sites get the full infrastructure topology. */
  size: 'large' | 'small';
  subnet: number;
}

export interface DemoContact {
  id: string;
  name: string;
  email: string;
  title: string;
  isPrimary: boolean;
  escalationLevel: number | null;
  userId: string | null;
}

export interface DemoPortalUser {
  id: string;
  name: string;
  email: string;
  roleKey: 'customer_admin' | 'customer_user';
  contactId: string;
}

export interface DemoEntitlement {
  id: string;
  typeKey: string;
  contractId: string;
  quantity: number;
  unit: string;
}

export interface DemoContract {
  key: string;
  id: string;
  number: string;
  name: string;
  typeKey: string;
  status: string;
  startDate: string;
  endDate: string;
  serviceKeys: string[];
  siteKeys: string[];
  entitlements: DemoEntitlement[];
}

export interface DemoCustomer {
  key: string;
  id: string;
  code: string;
  name: string;
  short: string;
  industryKey: string;
  timezone: string;
  index: number;
  domains: { soc: boolean; amc: boolean; cloud: boolean; eus: boolean };
  sites: DemoSite[];
  contacts: DemoContact[];
  portalUsers: DemoPortalUser[];
  contracts: DemoContract[];
  /** Field engineers with explicit access to this customer. */
  fieldEngineerKeys: string[];
  cis: DemoCi[];
  assets: DemoAsset[];
}

export interface DemoCi {
  id: string;
  customerKey: string;
  siteKey: string | null;
  typeKey: string;
  name: string;
  hostname: string | null;
  ipAddress: string | null;
  monitoringRef: string | null;
  assetId: string | null;
  attributes: Record<string, unknown>;
}

export interface DemoAsset {
  id: string;
  tag: string;
  name: string;
  customerKey: string;
  siteKey: string | null;
  categoryKey: string;
  ciId: string | null;
}

export interface DemoService {
  key: string;
  id: string;
  name: string;
  domain: string;
  teamKey: string;
  categoryKey: string | null;
}

export interface DemoState {
  now: Date;
  seedStartedAt: Date;
  rng: Rng;
  refs: Refs;
  admin: Principal;
  users: Map<string, DemoUser>;
  principals: Map<string, Principal>;
  customers: DemoCustomer[];
  services: Map<string, DemoService>;
  counts: Record<string, number>;
  /** Ticket ids by plan key, filled by the ticket phase. */
  tickets: Map<string, { id: string; number: string; customerKey: string; type: string; createdAt: Date; title: string; categoryKey: string; ciId: string | null; siteKey: string | null; resolvedAt: Date | null; open: boolean; priorityKey: string }>;
  /** Field visit ids created by the field phase. */
  visits: { id: string; number: string; customerKey: string; ticketId: string | null }[];
  /** Knowledge article ids by key. */
  articles: Map<string, string>;
  /** Integration ids by key. */
  integrations: Map<string, string>;
}

export const SEED_REQUEST_ID = 'demo-seed';

export function ctxFor(state: DemoState, tx: Tx, who: Principal, source: Ctx['source'] = 'ui'): Ctx {
  void state;
  return buildCtx(who, tx, { requestId: SEED_REQUEST_ID, ip: null, userAgent: null, source });
}

export function adminCtx(state: DemoState, tx: Tx): Ctx {
  return ctxFor(state, tx, state.admin, 'system');
}

export function user(state: DemoState, key: string): DemoUser {
  const u = state.users.get(key);
  if (!u) throw new Error(`demo user ${key} missing`);
  return u;
}

export function principalOf(state: DemoState, key: string): Principal {
  const p = state.principals.get(key);
  if (!p) throw new Error(`principal ${key} not loaded`);
  return p;
}

export function customer(state: DemoState, key: string): DemoCustomer {
  const c = state.customers.find((x) => x.key === key);
  if (!c) throw new Error(`demo customer ${key} missing`);
  return c;
}

export function service(state: DemoState, key: string): DemoService {
  const s = state.services.get(key);
  if (!s) throw new Error(`demo service ${key} missing`);
  return s;
}

/** Synthetic principal for integration-created tickets (looks like an API key principal). */
export function integrationPrincipal(name: string, apiKeyId: string, customerId: string | null): Principal {
  const perms: Permission[] = ['tenant:all', 'tickets:create', 'tickets:read', 'tickets:update', 'cmdb:read', 'integrations:events', 'soc:read'];
  return {
    id: apiKeyId,
    email: `apikey:${name.toLowerCase().replace(/\s+/g, '-')}`,
    name,
    phone: null,
    userType: 'msp',
    customerId,
    status: 'active',
    timezone: 'UTC',
    preferences: {},
    globalPermissions: new Set<Permission>(perms),
    customerPermissions: new Map(),
    customerScope: customerId ? [customerId] : 'all',
    roles: [],
    teams: [],
    apiKeyId,
  };
}

export async function loadRefs(tx: Tx): Promise<Refs> {
  const options = await tx.select().from(schema.configOptions);
  const byTypeKey = new Map(options.map((o) => [`${o.type}:${o.key}`, o]));
  const byType = new Map<string, (typeof options)[number][]>();
  for (const o of options) byType.set(o.type, [...(byType.get(o.type) ?? []), o]);
  const teams = new Map((await tx.select().from(schema.teams)).map((t) => [t.key, t.id]));
  const roles = new Map((await tx.select().from(schema.roles)).map((r) => [r.key, r.id]));
  const ciTypes = new Map((await tx.select().from(schema.ciTypes)).map((t) => [t.key, t.id]));
  const relTypes = new Map((await tx.select().from(schema.ciRelationshipTypes)).map((t) => [t.key, t.id]));
  const kbCats = new Map((await tx.select().from(schema.kbCategories)).map((c) => [c.key, c.id]));
  const calendars = new Map((await tx.select().from(schema.businessCalendars)).map((c) => [c.name, c.id]));
  const policies = new Map((await tx.select().from(schema.slaPolicies)).map((p) => [p.name, p.id]));
  const catalog = new Map((await tx.select().from(schema.catalogItems)).map((c) => [c.key, c]));
  const workflows = new Map((await tx.select().from(schema.approvalWorkflows)).map((w) => [w.name, w.id]));
  const [hol] = await tx.select({ id: schema.holidayCalendars.id }).from(schema.holidayCalendars).limit(1);
  const need = <T>(map: Map<string, T>, key: string, what: string): T => {
    const v = map.get(key);
    if (v === undefined) throw new Error(`default seed missing ${what} "${key}"`);
    return v;
  };
  return {
    option: (type, key) => need(byTypeKey, `${type}:${key}`, 'option').id,
    optionRow: (type, key) => need(byTypeKey, `${type}:${key}`, 'option'),
    optionsOf: (type) => byType.get(type) ?? [],
    team: (key) => need(teams, key, 'team'),
    role: (key) => need(roles, key, 'role'),
    ciType: (key) => need(ciTypes, key, 'CI type'),
    relType: (key) => need(relTypes, key, 'relationship type'),
    kbCategory: (key) => need(kbCats, key, 'KB category'),
    calendar: (name) => need(calendars, name, 'calendar'),
    policy: (name) => need(policies, name, 'SLA policy'),
    catalogItem: (key) => need(catalog, key, 'catalog item'),
    workflow: (name) => need(workflows, name, 'approval workflow'),
    holidayCalendarId: hol?.id ?? null,
  };
}

export async function findAdminUserId(tx: Tx, email: string): Promise<string> {
  const [row] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email.toLowerCase())).limit(1);
  if (!row) throw new Error(`administrator ${email} not found; run the default seed first`);
  return row.id;
}

export const CAL_24X7 = '24x7';
export const CAL_BUSINESS = 'Business Hours (Mon-Fri 09:00-18:00 IST)';
export const CAL_EXTENDED = 'Extended Hours (Mon-Sat 08:00-20:00 IST)';
export const CAL_UK = 'UK Business Hours (Mon-Fri 09:00-17:30 London)';
export const POLICY_STANDARD = 'Standard SLA';
export const POLICY_PREMIUM = 'Premium 24x7 SLA';
export const POLICY_BUSINESS = 'Business Hours SLA';
