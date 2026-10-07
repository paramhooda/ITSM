#!/usr/bin/env node
/**
 * UI consistency guard. Fails when a page breaks the contract in docs/DESIGN.md:
 *   - full page reloads (window.location.href) instead of router navigation
 *   - arbitrary hex colours in class names instead of tokens
 *   - the retired "secondary" button variant
 *   - an <h1> outside the shared headers
 *   - a page file without a shared header (PageHeader, RecordHeader, DashboardHero, DashboardFrame, ListShell, AdminLayout) or redirect
 *   - a ListShell page without an empty state
 *   - a page rendering a ConfigTable without the ConfigToolbar (search, filters, breadcrumb, count); a small
 *     sub-panel table opts out with a `// ui-lint: no-toolbar` comment
 * Run: node scripts/ui-lint.mjs   (also `npm run lint:ui` from apps/web, part of the root `verify`)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(name)) files.push(p);
  }
};
walk(root);

/** Files allowed to own an <h1>: the shared headers and the logged-out pages. */
const H1_ALLOWED = [/components\/ui\/index\.tsx$/, /components\/record\/RecordHeader\.tsx$/, /components\/dashboards\/Hero\.tsx$/, /pages\/auth\//];
/** Page files that are not pages in the contract's sense (redirects, logged-out, tab bodies hosted by a page). */
const PAGE_EXEMPT = [/Redirect\.tsx$/, /pages\/auth\//, /Tab\.tsx$/, /FindingsTable\.tsx$/];
const HEADER_MARKERS = ['<PageHeader', '<RecordHeader', '<DashboardHero', '<DashboardFrame', '<ListShell', '<AdminLayout', '<SectionHeader', '<Navigate', '<RecordLayout'];
/** A page that only renders another page (a module alias such as /portal/services/sla) inherits that page's header. */
const isAlias = (src) => /^import \w+Page from '\.\/\w+Page';/m.test(src) && /return <\w+Page\b/.test(src);

const problems = [];
const report = (file, line, rule, text) => problems.push(`${relative(process.cwd(), file)}:${line}  ${rule}  ${text.trim().slice(0, 110)}`);

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const rel = relative(root, file);
  lines.forEach((l, i) => {
    const n = i + 1;
    if (/window\.location\.href\s*=/.test(l)) report(file, n, 'no-reload', l);
    if (/(bg|text|border|ring|from|to|via)-\[#[0-9a-fA-F]{3,8}\]/.test(l)) report(file, n, 'no-hex-colour', l);
    if (/variant=["']secondary["']/.test(l)) report(file, n, 'no-secondary-variant', l);
    if (/<h1[\s>]/.test(l) && !H1_ALLOWED.some((re) => re.test(file))) report(file, n, 'h1-outside-header', l);
  });
  const isPage = /\/pages\/.*Page\.tsx$/.test(file) && !PAGE_EXEMPT.some((re) => re.test(file));
  if (isPage) {
    if (!HEADER_MARKERS.some((m) => src.includes(m)) && !isAlias(src)) report(file, 1, 'page-without-shared-header', rel);
    if (src.includes('<ListShell')) {
      // The table may live in a sibling component (./FindingsTable); its empty state counts.
      const siblings = [...src.matchAll(/from '\.\/(\w+)'/g)].map((m) => join(file, '..', `${m[1]}.tsx`)).filter((p) => { try { return statSync(p).isFile(); } catch { return false; } });
      const sources = [src, ...siblings.map((p) => readFileSync(p, 'utf8'))];
      if (!sources.some((t) => /EmptyState|empty=/.test(t))) report(file, 1, 'list-without-empty-state', rel);
    }
    // Every configuration list gets the same toolbar (search, filters, breadcrumb, count); a page whose
    // ConfigTable is a small sub-panel says so with `// ui-lint: no-toolbar`.
    if (src.includes('<ConfigTable') && !src.includes('<ConfigToolbar') && !/\/\/ ui-lint: no-toolbar\b/.test(src)) report(file, 1, 'config-table-without-toolbar', rel);
  }
}

if (problems.length) {
  console.error(`ui-lint: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n` + problems.map((p) => `  ${p}`).join('\n'));
  process.exit(1);
}
console.log(`ui-lint: ${files.length} files, no problems`);
