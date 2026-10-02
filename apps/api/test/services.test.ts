/**
 * Service catalog tests (DB-backed): the two-level categorisation and the grouped catalog view.
 * Run with the dev environment sourced (DATABASE_URL etc., default seed applied):
 *   npx vitest run test/services.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { withSystem, schema, closeDb } from '@/db/client';
import { runAs } from '@/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '@/core/principal';
import { config } from '@/config';
import { ValidationError } from '@/core/errors';
import * as services from '@/modules/services/service';
import * as options from '@/modules/config/service';

const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
let admin: Principal;
const as = <T>(fn: Parameters<typeof runAs<T>>[2]) => runAs(admin, { requestId: 'test', source: 'api' }, fn);
const opt = { managedInfrastructure: '', managedSecurity: '', amcField: '', networkManagement: '', securityMonitoring: '', hardwareAmc: '' };
const createdServiceIds: string[] = [];
const createdOptionIds: string[] = [];

async function seededOption(type: string, key: string) {
  const [row] = await withSystem((tx) => tx.select({ id: schema.configOptions.id, parentId: schema.configOptions.parentId }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1));
  expect(row, `${type}:${key} must be seeded`).toBeTruthy();
  return row;
}

beforeAll(async () => {
  const [user] = await withSystem((tx) => tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, config.ADMIN_EMAIL.toLowerCase())).limit(1));
  expect(user, 'admin user must exist (run the seed)').toBeTruthy();
  invalidatePrincipal(user.id);
  admin = (await loadPrincipal(user.id))!;
  opt.managedInfrastructure = (await seededOption('service_category', 'managed_infrastructure')).id;
  opt.managedSecurity = (await seededOption('service_category', 'managed_security')).id;
  opt.amcField = (await seededOption('service_category', 'amc_field')).id;
  opt.networkManagement = (await seededOption('service_subcategory', 'network_management')).id;
  opt.securityMonitoring = (await seededOption('service_subcategory', 'security_monitoring')).id;
  opt.hardwareAmc = (await seededOption('service_subcategory', 'hardware_amc')).id;
});

afterAll(async () => {
  await withSystem(async (tx) => {
    if (createdServiceIds.length) await tx.delete(schema.services).where(inArray(schema.services.id, createdServiceIds));
    if (createdOptionIds.length) await tx.delete(schema.configOptions).where(inArray(schema.configOptions.id, createdOptionIds));
  });
  await closeDb();
});

describe('service catalog taxonomy', () => {
  it('seeds the two-level taxonomy with every subcategory parented to its category', async () => {
    const net = await seededOption('service_subcategory', 'network_management');
    expect(net.parentId).toBe(opt.managedInfrastructure);
    expect((await seededOption('service_subcategory', 'consulting_audits')).parentId).toBe((await seededOption('service_category', 'professional_services')).id);
    const subs = await withSystem((tx) => tx.select({ key: schema.configOptions.key, parentId: schema.configOptions.parentId }).from(schema.configOptions).where(eq(schema.configOptions.type, 'service_subcategory')));
    expect(subs.length).toBeGreaterThanOrEqual(17);
    expect(subs.every((r) => !!r.parentId)).toBe(true);
    const cats = (await withSystem((tx) => tx.select({ key: schema.configOptions.key }).from(schema.configOptions).where(eq(schema.configOptions.type, 'service_category')))).map((c) => c.key);
    expect(cats).toEqual(expect.arrayContaining(['managed_infrastructure', 'managed_security', 'amc_field', 'service_desk', 'professional_services']));
  });

  it('creating a service with only a subcategory sets the parent category automatically', async () => {
    const svc = await as((ctx) => services.createService(ctx, { name: `Cat net ${suffix}`, subcategoryId: opt.networkManagement }));
    createdServiceIds.push(svc.id);
    expect(svc.categoryId).toBe(opt.managedInfrastructure);
    expect(svc.subcategoryId).toBe(opt.networkManagement);
    expect(svc.categoryLabel).toBe('Managed Infrastructure (NOC)');
    expect(svc.subcategoryLabel).toBe('Network Management');
  });

  it('corrects a mismatched category to the subcategory parent, on create and on update', async () => {
    const svc = await as((ctx) => services.createService(ctx, { name: `Cat mismatch ${suffix}`, categoryId: opt.managedSecurity, subcategoryId: opt.networkManagement }));
    createdServiceIds.push(svc.id);
    expect(svc.categoryId).toBe(opt.managedInfrastructure);
    expect(svc.subcategoryId).toBe(opt.networkManagement);

    // moving to a subcategory of another category moves the category along
    const moved = await as((ctx) => services.updateService(ctx, svc.id, { subcategoryId: opt.securityMonitoring }));
    expect(moved.categoryId).toBe(opt.managedSecurity);
    expect(moved.subcategoryLabel).toBe('Security Monitoring & SIEM');

    // changing only the category drops a subcategory that no longer belongs to it
    const recat = await as((ctx) => services.updateService(ctx, svc.id, { categoryId: opt.amcField }));
    expect(recat.categoryId).toBe(opt.amcField);
    expect(recat.subcategoryId).toBeNull();

    // re-stating the same category keeps a matching subcategory
    await as((ctx) => services.updateService(ctx, svc.id, { subcategoryId: opt.hardwareAmc }));
    const same = await as((ctx) => services.updateService(ctx, svc.id, { categoryId: opt.amcField }));
    expect(same.subcategoryId).toBe(opt.hardwareAmc);

    // clearing the subcategory leaves the category in place
    const cleared = await as((ctx) => services.updateService(ctx, svc.id, { subcategoryId: null }));
    expect(cleared.subcategoryId).toBeNull();
    expect(cleared.categoryId).toBe(opt.amcField);
  });

  it('rejects category / subcategory ids of the wrong option type', async () => {
    await expect(as((ctx) => services.createService(ctx, { name: `Bad sub ${suffix}`, subcategoryId: opt.managedInfrastructure }))).rejects.toBeInstanceOf(ValidationError);
    await expect(as((ctx) => services.createService(ctx, { name: `Bad cat ${suffix}`, categoryId: opt.networkManagement }))).rejects.toBeInstanceOf(ValidationError);
  });

  it('filters the flat list by subcategory', async () => {
    const list = await as((ctx) => services.listServices(ctx, { q: suffix, subcategoryId: opt.networkManagement }));
    expect(list.items.map((i) => i.name)).toEqual([`Cat net ${suffix}`]);
    expect(list.items[0].subcategoryLabel).toBe('Network Management');
    const byCategory = await as((ctx) => services.listServices(ctx, { q: suffix, categoryId: opt.amcField }));
    expect(byCategory.items.map((i) => i.name)).toEqual([`Cat mismatch ${suffix}`]);
  });

  it('groups services by category and subcategory in the catalog view', async () => {
    const loose = await as((ctx) => services.createService(ctx, { name: `Cat loose ${suffix}`, categoryId: opt.managedSecurity }));
    const none = await as((ctx) => services.createService(ctx, { name: `Cat none ${suffix}` }));
    createdServiceIds.push(loose.id, none.id);

    const tree = await as((ctx) => services.serviceCatalog(ctx, { q: suffix }));
    expect(tree.totals).toEqual({ services: 4, subscribedCustomers: 0, openTickets: 0, incidents30d: 0 });
    expect(tree.uncategorised.map((s) => s.id)).toEqual([none.id]);
    // only categories / subcategories holding a matching service are returned, in sort order
    expect(tree.categories.map((c) => c.key)).toEqual(['managed_infrastructure', 'managed_security', 'amc_field']);
    const infra = tree.categories.find((c) => c.key === 'managed_infrastructure')!;
    expect(infra).toMatchObject({ label: 'Managed Infrastructure (NOC)', icon: 'server', color: 'blue' });
    expect(infra.services).toEqual([]);
    expect(infra.subcategories.map((s) => s.key)).toEqual(['network_management']);
    expect(infra.subcategories[0].services.map((s) => s.name)).toEqual([`Cat net ${suffix}`]);
    const sec = tree.categories.find((c) => c.key === 'managed_security')!;
    expect(sec.services.map((s) => s.id)).toEqual([loose.id]);
    expect(sec.subcategories).toEqual([]);
    const amc = tree.categories.find((c) => c.key === 'amc_field')!;
    expect(amc.services.map((s) => s.name)).toEqual([`Cat mismatch ${suffix}`]);

    // includeEmpty returns the whole taxonomy
    const full = await as((ctx) => services.serviceCatalog(ctx, { q: suffix, includeEmpty: 'true' }));
    expect(full.totals.services).toBe(4);
    expect(full.categories.map((c) => c.key)).toEqual(expect.arrayContaining(['managed_infrastructure', 'managed_security', 'amc_field', 'service_desk', 'professional_services']));
    expect(full.categories.find((c) => c.key === 'managed_security')!.subcategories.map((s) => s.key)).toEqual(['security_monitoring', 'endpoint_security', 'perimeter_security', 'vulnerability_management']);
    const orders = full.categories.map((c) => c.sortOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it('requires a service category parent when subcategories are configured', async () => {
    await expect(as((ctx) => options.createOption(ctx, { type: 'service_subcategory', key: `nop_${suffix}`, label: 'No parent' }))).rejects.toBeInstanceOf(ValidationError);
    await expect(as((ctx) => options.createOption(ctx, { type: 'service_subcategory', key: `wp_${suffix}`, label: 'Wrong parent', parentId: opt.networkManagement }))).rejects.toBeInstanceOf(ValidationError);
    const ok = await as((ctx) => options.createOption(ctx, { type: 'service_subcategory', key: `ok_${suffix}`, label: 'Custom line', parentId: opt.managedSecurity }));
    createdOptionIds.push(ok.id);
    expect(ok.parentId).toBe(opt.managedSecurity);
    await expect(as((ctx) => options.updateOption(ctx, ok.id, { parentId: null }))).rejects.toBeInstanceOf(ValidationError);
    const moved = await as((ctx) => options.updateOption(ctx, ok.id, { parentId: opt.amcField }));
    expect(moved.parentId).toBe(opt.amcField);
  });
});
