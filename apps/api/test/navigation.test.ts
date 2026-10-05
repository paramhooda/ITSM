import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// The navigator imports lucide icons; the factory needs a `has` trap because vitest checks
// `key in mock` before every named import and throws with a get-only Proxy.
vi.mock('lucide-react', () => {
  const icon = () => null;
  return new Proxy({}, { has: (_t, k) => typeof k === 'string', get: (_t, k) => (typeof k === 'string' && k !== 'then' && k !== '__esModule' ? icon : undefined) });
});
import { APP_PAGES, APPLICATIONS, SYSTEM_ROLES, SYSTEM_ROLE_AREAS, matchRoute, pageAllowed, type Permission } from '@itsm/shared';
import { MSP_NAV, PORTAL_NAV, NAV_SECTIONS, PORTAL_SECTIONS, visibleNav, isAppActive, groupNav, type NavItem } from '../../web/src/layouts/nav';
import * as strips from '../../web/src/layouts/modules';

/**
 * The navigator, the module strips and the administration rail must agree with the
 * application map and the role areas: every link is a real page the permission opens,
 * labels and order follow APPLICATIONS, strips mirror the navigator children.
 */
const path = (to: string) => to.split('?')[0]!;
const roleCan = (key: string) => {
  const set = new Set<string>(SYSTEM_ROLES[key]!.permissions);
  return (...p: Permission[]) => p.some((x) => set.has(x));
};
const roleAreas = (key: string) => SYSTEM_ROLE_AREAS[key] ?? null;
const labels = (items: NavItem[]) => items.map((i) => i.label);
const can1 = (p: Permission) => (...x: Permission[]) => x.includes(p);
/** Strip ↔ application pairs (case 8). A plain array: #5 pushes `['PORTAL_STATUS_MODULES', 'Service status']` here. */
const PAIRS: [keyof typeof strips, string][] = [
  ['OPERATIONS_MODULES', 'Operations'], ['CHANGE_MODULES', 'Changes'], ['CMDB_MODULES', 'Configuration (CMDB)'], ['ASSET_MODULES', 'Assets'], ['CUSTOMER_MODULES', 'Customers'], ['CONTRACT_MODULES', 'Contracts & scope'], ['FIELD_MODULES', 'Field service'], ['KNOWLEDGE_MODULES', 'Knowledge'], ['REPORT_MODULES', 'Reports'],
  ['PORTAL_ASSET_MODULES', 'Assets'], ['PORTAL_SERVICE_MODULES', 'Services & contracts'], ['PORTAL_MAINTENANCE_MODULES', 'Maintenance & visits'], ['PORTAL_KNOWLEDGE_MODULES', 'Knowledge'], ['PORTAL_STATUS_MODULES', 'Service status'],
];
const itemOf = (tree: NavItem[], label: string) => {
  const item = tree.find((i) => i.label === label);
  expect(item, `navigator item ${label}`).toBeDefined();
  return item!;
};
const pageOf = (to: string) => {
  const hit = matchRoute(path(to));
  expect(hit, `${to} is a page of the application map`).not.toBeNull();
  return hit!.page;
};
const adminSource = readFileSync(resolve(__dirname, '../../web/src/components/admin/AdminLayout.tsx'), 'utf8');

describe('staff navigator', () => {
  it('links only to staff pages, and only the Operations row points at a hidden (redirect) page', () => {
    for (const item of MSP_NAV) {
      const page = pageOf(item.to);
      expect(page.staff, `${item.label} (${item.to}) is a staff page`).not.toBe(false);
      for (const c of item.children ?? []) {
        const child = pageOf(c.to);
        expect(child.staff, `${item.label} → ${c.label} (${c.to}) is a staff page`).not.toBe(false);
        expect(child.hidden, `${item.label} → ${c.label} (${c.to}) is not a hidden page`).toBeFalsy();
      }
    }
    expect(MSP_NAV.filter((i) => pageOf(i.to).hidden).map((i) => i.to)).toEqual(['/operations']);
  });

  it('labels and order match the application map', () => {
    const seen: string[] = [];
    for (const item of MSP_NAV) {
      const app = APPLICATIONS.find((a) => a.key === pageOf(item.to).app);
      expect(app, `${item.to} belongs to a listed application`).toBeDefined();
      expect(item.label, `${item.to} label`).toBe(app!.label);
      if (seen[seen.length - 1] !== app!.key) seen.push(app!.key);
    }
    expect(seen).toEqual(APPLICATIONS.map((a) => a.key).filter((k) => k !== 'portal'));
  });

  it('groups applications into contiguous sections, Insight first and System last', () => {
    const sections = groupNav(MSP_NAV).map((g) => g.section);
    expect(new Set(sections).size).toBe(sections.length);
    expect(sections[0]).toBe(NAV_SECTIONS.insight);
    expect(sections[sections.length - 1]).toBe(NAV_SECTIONS.system);
    expect(sections).toEqual(Object.values(NAV_SECTIONS));
    for (const item of MSP_NAV) expect(item.section, `${item.label} carries a section`).toBeTruthy();
  });

  it('every navigator permission opens the page it unlocks', () => {
    for (const item of MSP_NAV) {
      const page = pageOf(item.to);
      for (const c of item.children ?? []) {
        const child = pageOf(c.to);
        for (const perm of c.perm ?? []) expect(pageAllowed(child, can1(perm), false), `${item.label} → ${c.label}: ${perm} opens ${c.to}`).toBe(true);
      }
      // a row's permission must lead somewhere it opens: its own page or one of its modules
      for (const perm of item.perm ?? []) {
        const opens = pageAllowed(page, can1(perm), false) || (item.children ?? []).some((c) => pageAllowed(pageOf(c.to), can1(perm), false));
        expect(opens, `${item.label}: ${perm} opens ${item.to} or one of its modules`).toBe(true);
      }
    }
  });

  it('shows each system role the applications of its areas', () => {
    expect(labels(visibleNav(MSP_NAV, roleCan('noc_engineer'), roleAreas('noc_engineer')))).toEqual(['Dashboards', 'Tickets', 'Knowledge', 'Operations', 'Changes', 'Teams', 'Configuration (CMDB)']);
    expect(labels(visibleNav(MSP_NAV, roleCan('account_manager'), roleAreas('account_manager')))).toEqual(['Dashboards', 'Reports', 'Tickets', 'Teams', 'Customers', 'Contracts & scope', 'Service catalog']);
    expect(labels(visibleNav(MSP_NAV, roleCan('admin'), roleAreas('admin')))).toEqual(['Dashboards', 'Reports', 'Tickets', 'Knowledge', 'Operations', 'Changes', 'Field service', 'Teams', 'Customers', 'Contracts & scope', 'Service catalog', 'Configuration (CMDB)', 'Assets', 'Administration']);
    expect(labels(visibleNav(MSP_NAV, roleCan('admin'), roleAreas('admin')))).toHaveLength(MSP_NAV.length);
  });

  it('lists modules only when at least two are visible', () => {
    const cmdbAdmin = visibleNav(MSP_NAV, roleCan('cmdb_admin'), roleAreas('cmdb_admin'));
    expect(itemOf(cmdbAdmin, 'Dashboards').children).toBeUndefined(); // only My work would be visible
    const noc = visibleNav(MSP_NAV, roleCan('noc_engineer'), roleAreas('noc_engineer'));
    expect(itemOf(noc, 'Dashboards').children?.map((c) => c.label)).toEqual(['Network operations', 'My work']);
    expect(itemOf(noc, 'Configuration (CMDB)').children?.map((c) => c.label)).toContain('Monitoring & SIEM');
    const am = visibleNav(MSP_NAV, roleCan('account_manager'), roleAreas('account_manager'));
    expect(am.find((i) => i.label === 'Configuration (CMDB)')).toBeUndefined();
    // Reports lists its modules once the report builder (reports:build) and Customer satisfaction (surveys:read) sit next to the catalogue.
    const reportsFor = (role: string) => visibleNav(MSP_NAV, roleCan(role), roleAreas(role)).find((i) => i.label === 'Reports');
    if (strips.REPORT_MODULES.length === 1) {
      for (const role of Object.keys(SYSTEM_ROLES)) {
        const reports = reportsFor(role);
        if (reports) expect(reports.children, `${role}: Reports has no modules while only the catalogue exists`).toBeUndefined();
      }
    } else {
      expect(strips.REPORT_MODULES.find((m) => m.to === '/reports/csat')?.perm).toEqual(['surveys:read']);
      expect(strips.REPORT_MODULES.find((m) => m.to === '/reports/builder')?.perm).toEqual(['reports:build']);
      // a service manager holds reports:build and surveys:read, so all three modules show in this order
      expect(reportsFor('service_manager')?.children?.map((c) => c.label)).toEqual(['Catalogue', 'Report builder', 'Customer satisfaction']);
      // management holds both as well; a contract administrator builds reports and reads CSAT too
      expect(reportsFor('management')?.children?.map((c) => c.label)).toEqual(['Catalogue', 'Report builder', 'Customer satisfaction']);
      // engineers run reports but neither build them nor hold surveys:read, so the catalogue stands alone and no module list is shown
      expect(reportsFor('engineer')?.children).toBeUndefined();
    }
  });

  it('highlights the application that owns the path', () => {
    const changes = itemOf(MSP_NAV, 'Changes');
    const operations = itemOf(MSP_NAV, 'Operations');
    expect(isAppActive(changes, '/operations/cab/abc')).toBe(true);
    expect(isAppActive(operations, '/operations/cab/abc')).toBe(false);
    expect(isAppActive(changes, '/operations/change-calendar')).toBe(true);
    expect(isAppActive(operations, '/operations/handover')).toBe(true);
    expect(isAppActive(operations, '/operations')).toBe(true);
    expect(isAppActive(itemOf(MSP_NAV, 'Contracts & scope'), '/sla/123')).toBe(true);
    expect(isAppActive(itemOf(MSP_NAV, 'Field service'), '/maintenance')).toBe(true);
    expect(isAppActive(itemOf(MSP_NAV, 'Configuration (CMDB)'), '/admin/integrations')).toBe(true);
    expect(isAppActive(itemOf(MSP_NAV, 'Administration'), '/admin/integrations')).toBe(true);
    expect(isAppActive(itemOf(MSP_NAV, 'Dashboards'), '/')).toBe(true);
    expect(isAppActive(itemOf(MSP_NAV, 'Dashboards'), '/tickets')).toBe(false);
    expect(isAppActive(itemOf(MSP_NAV, 'Tickets'), '/operations')).toBe(false);
    expect(isAppActive(itemOf(MSP_NAV, 'Tickets'), '/tickets/abc')).toBe(true);
  });

  it('phone bar labels are one short word and the first five applications read well', () => {
    for (const item of [...MSP_NAV, ...PORTAL_NAV]) {
      if (item.short) expect(item.short, `${item.label} short label`).toMatch(/^[A-Za-z]{1,10}$/);
    }
    const phone = (items: NavItem[]) => items.slice(0, 5).map((i) => i.short ?? i.label.split(' ')[0]);
    expect(phone(visibleNav(MSP_NAV, roleCan('admin'), roleAreas('admin')))).toEqual(['Home', 'Reports', 'Tickets', 'Knowledge', 'Operations']);
    expect(phone(visibleNav(PORTAL_NAV, roleCan('customer_user'), roleAreas('customer_user')))).toEqual(['Overview', 'Status', 'Tickets', 'Knowledge', 'Services']);
  });
});

describe('portal navigator', () => {
  it('links only to portal pages', () => {
    for (const item of PORTAL_NAV) {
      expect(pageOf(item.to).portal, `${item.label} (${item.to}) is a portal page`).toBe(true);
      for (const c of item.children ?? []) {
        const child = pageOf(c.to);
        expect(child.portal, `${item.label} → ${c.label} (${c.to}) is a portal page`).toBe(true);
        expect(child.hidden, `${item.label} → ${c.label} (${c.to}) is not a hidden page`).toBeFalsy();
      }
      for (const perm of item.perm ?? []) expect(pageAllowed(pageOf(item.to), can1(perm), true), `${item.label}: ${perm} opens ${item.to}`).toBe(true);
      for (const c of item.children ?? []) for (const perm of c.perm ?? []) expect(pageAllowed(pageOf(c.to), can1(perm), true), `${item.label} → ${c.label}: ${perm} opens ${c.to}`).toBe(true);
    }
    expect(PORTAL_NAV.flatMap((i) => [i.to, ...(i.children ?? []).map((c) => c.to)]).some((to) => /^\/(tickets|admin|operations|customers|cmdb|assets|contracts|field)(\/|$)/.test(to))).toBe(false);
  });

  it('has Overview above the first heading, then Support, Your services and Account', () => {
    const groups = groupNav(PORTAL_NAV);
    expect(groups[0]!.section).toBeUndefined();
    expect(labels(groups[0]!.items)).toEqual(['Overview']);
    expect(groups.slice(1).map((g) => g.section)).toEqual(Object.values(PORTAL_SECTIONS));
  });

  it('shows customer users their own items', () => {
    expect(labels(visibleNav(PORTAL_NAV, roleCan('customer_user'), roleAreas('customer_user')))).toEqual(['Overview', 'Service status', 'My tickets', 'Knowledge', 'Services & contracts', 'Assets', 'Maintenance & visits']);
    expect(labels(visibleNav(PORTAL_NAV, roleCan('customer_admin'), roleAreas('customer_admin')))).toEqual(['Overview', 'Service status', 'My tickets', 'Approvals', 'Knowledge', 'Services & contracts', 'Assets', 'Maintenance & visits', 'Reports', 'Users']);
  });
});

describe('module strips', () => {
  it('mirror the navigator children of their application, with the same permissions', () => {
    for (const [name, label] of PAIRS) {
      const strip = strips[name] as strips.ModuleItem[];
      const item = itemOf(name.startsWith('PORTAL_') ? PORTAL_NAV : MSP_NAV, label);
      const children = item.children ?? [];
      expect(children.length, `${label} lists modules`).toBeGreaterThan(0);
      for (const m of strip) {
        const child = children.find((c) => c.to === m.to);
        expect(child, `${name}: ${m.to} is a module of ${label}`).toBeDefined();
        expect(m.perm, `${name}: ${m.to} permissions equal the navigator's`).toEqual(child!.perm);
        expect(m.label.length, `${name}: ${m.to} has a label`).toBeGreaterThan(0);
      }
      expect(new Set(strip.map((m) => m.to)).size).toBe(strip.length);
    }
  });
});

describe('administration rail', () => {
  const block = adminSource.slice(adminSource.indexOf('export const ADMIN_NAV'), adminSource.indexOf('];', adminSource.indexOf('export const ADMIN_NAV')));
  const live = block.replace(/^\s*\/\/.*$/gm, ''); // slot comments reserve places for pages that do not exist yet
  const railPaths = [...live.matchAll(/to: '(\/admin[^']*)'/g)].map((m) => m[1]!);
  const groupLabels = [...live.matchAll(/label: '([^']+)',\s*items: \[/g)].map((m) => m[1]!);

  it('lists every administration page exactly once and nothing that is not a page', () => {
    const routes = new Set(APP_PAGES.map((p) => p.route));
    for (const to of railPaths) expect(routes.has(to), `${to} is a page`).toBe(true);
    expect(new Set(railPaths).size).toBe(railPaths.length);
    const adminPages = APP_PAGES.filter((p) => p.app === 'admin' && !p.hidden && !/[:*]/.test(p.route) && p.route !== '/admin');
    expect(adminPages).toHaveLength(29);
    for (const p of adminPages) expect(railPaths, `${p.key} (${p.route}) is in the rail`).toContain(p.route);
    expect(railPaths).toContain('/admin');
  });

  it('groups the pages the way the navigator does', () => {
    expect(groupLabels).toEqual(['Overview', 'Operating model', 'Service levels', 'Workflow & automation', 'Change management', 'CMDB model', 'Notifications', 'Access', 'System']);
  });
});
