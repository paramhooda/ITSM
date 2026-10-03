import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_PAGES, APPLICATIONS, matchRoute, pageAllowed, buildPath, pagesFor } from '@itsm/shared';

/** The application map must describe exactly the routes the web app has, so the assistant never names a page that does not exist. */
const routesSource = readFileSync(resolve(__dirname, '../../web/src/routes.tsx'), 'utf8');
const adminSource = readFileSync(resolve(__dirname, '../../web/src/pages/admin/AdminPage.tsx'), 'utf8');
/** Top-level routes plus the administration sub-routes (nested under /admin, optional segments dropped). */
const webRoutes = [
  ...[...routesSource.matchAll(/path: '([^']+)'/g)].map((m) => m[1]!),
  '/admin',
  ...[...adminSource.matchAll(/<Route path="([^"*]+)"/g)].map((m) => `/admin/${m[1]!.replace(/\/:[a-z]+\?$/, '')}`),
];
const portalRoutes = [...routesSource.matchAll(/path: '([^']+)'[^}]*portal: true/g)].map((m) => m[1]!);

describe('application map', () => {
  it('has an entry for every web route and no entry without a route', () => {
    const mapped = new Set(APP_PAGES.map((p) => p.route));
    for (const r of webRoutes) expect(mapped.has(r), `route ${r} is not in the application map`).toBe(true);
    const real = new Set(webRoutes);
    for (const p of APP_PAGES) expect(real.has(p.route), `page ${p.key} (${p.route}) has no web route`).toBe(true);
    expect(new Set(APP_PAGES.map((p) => p.key)).size).toBe(APP_PAGES.length);
  });

  it('flags portal pages the way the router does, and every page belongs to a listed application', () => {
    const apps = new Set(APPLICATIONS.map((a) => a.key));
    for (const p of APP_PAGES) {
      expect(apps.has(p.app), `${p.key} → unknown application ${p.app}`).toBe(true);
      if (!p.hidden) expect(!!p.portal, `${p.key} portal flag`).toBe(portalRoutes.includes(p.route));
      expect(p.purpose.length).toBeGreaterThan(10);
    }
  });

  it('matches literal routes before parameterised ones and validates filters', () => {
    expect(matchRoute('/tickets/new')?.page.key).toBe('tickets.new');
    expect(matchRoute('/tickets/abc')?.page.key).toBe('tickets.detail');
    expect(matchRoute('/tickets/abc')?.params).toEqual({ id: 'abc' });
    expect(matchRoute('/nope')).toBeNull();
    const tickets = matchRoute('/tickets')!.page;
    expect(buildPath(tickets, {}, { priority: 'p1', evil: 'x' })).toBe('/tickets?priority=p1');
    const can = (...perms: string[]) => perms.includes('tickets:read');
    expect(pageAllowed(tickets, can as never, false)).toBe(true);
    expect(pageAllowed(matchRoute('/admin/users')!.page, can as never, false)).toBe(false);
    expect(pagesFor(can as never, true).every((p) => p.portal)).toBe(true);
  });
});
