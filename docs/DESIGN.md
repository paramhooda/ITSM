# Design contract

Progression looks and behaves like one product because every page follows the same small set of rules. This file is the contract; `npm run lint:ui` (apps/web/scripts/ui-lint.mjs) enforces the parts a script can check, and the route crawl in the verification notes checks the rest in a browser. Read this before adding a page or a panel.

## Look

Vercel and shadcn inspired: neutral zinc surfaces, 1px borders, Geist type, black primary actions, one blue accent for links, focus and selection. Colour is reserved for status, data and two decorative touches: the tinted icon chip on a KPI tile and the soft tint of an application icon in the navigator. No gradients. Tokens live in `apps/web/src/styles.css`; pages never use arbitrary hex colours, and status colours come from `apps/web/src/lib/statusColors.ts`.

## Four page kinds

| Kind | Where | Anatomy |
|---|---|---|
| Home dashboard | `/` staff views, portal home | `DashboardHero` (date, title, view switcher) with the global filter row, then the KPI row, then panels. Nothing else uses the hero. |
| Module overview | Customers, Contracts, Assets, CMDB, Field, Knowledge, Discovery, portal Assets | `PageHeader` + `ModuleNav` + KPI row + panels. Tiles and panel rows are links into the module's list. |
| List | the `ListShell` pages, the service catalog included | `PageHeader` + optional `ModuleNav` + filter bar + quick views + count line + `InsightBand` + results card. Tiles and breakdown rows are quick filters on the same page. |
| Record | the `RecordLayout` pages | `RecordHeader` (two primary actions, an overflow menu), ribbon, form sections, related tabs, activity rail. |

Administration screens use `SectionHeader`, which renders the same `PageHeader` as everywhere else, inside `AdminLayout`.

## Global and local filters

Global filters sit at the top of the page in one place: the filter bar on a list, the hero's filter row on a dashboard (Period 7 / 30 / 90 days, and Customer scope on staff views). Local filters sit in a panel's header (`Panel` `action` slot) as a small `Segmented` or one compact `Select`: one to three per panel, never a period, always client-side on data the page already holds. Filter state lives in the URL through `useListState`; changing a filter never changes the pathname and never remounts the page's content.

## Stat tiles and breakdown rows

A click always shows the matching records. On a list page the tile toggles its filter in place, shows an active ring and scrolls the results into view (`active` and `scrollTo` on `KpiItem`); clicking it again clears the filter, and the count line names the filters in effect with a Reset link. On an overview page or a dashboard the tile is a router link (`to` on `KpiItem`) that opens the list with the filter applied, with an arrow on hover and a hint naming the destination when it leaves the module ("View in Tickets"). A tile with nothing behind it has no hover. `window.location.href` is never used.

## Buttons, dialogs, tables, states

- Primary is black, at most one per header; `outline` for secondary actions; `ghost` for icon and minor actions; `danger` for destructive ones. `sm` inside cards and toolbars, `md` in page headers and dialogs.
- Records open on their record page. Short forms and confirmations use `Dialog` / `ConfirmDialog`; previews and long forms use `Drawer`. Destructive actions always confirm.
- `DataTable` with `dense` on lists, clickable rows open the record, identifiers in mono, the tinted header, pagination in the card footer.
- Loading uses `LoadingBlock` / `KpiSkeleton`, empty uses `EmptyState` with an icon and one next step, errors use `ErrorBlock` with retry.
- Enter animations run once when a page mounts, never when a filter changes.

## Checking it

`npm run verify` runs the typecheck and `lint:ui`. The lint fails on a page reload through `window.location`, an arbitrary hex colour, the retired `secondary` variant, an `<h1>` outside the shared headers, a page without a shared header, and a `ListShell` page without an empty state. The browser crawl (`r13-audit.cjs` in the session scratchpad, kept with the verification notes) opens every route as an administrator, a NOC engineer and a portal user at 1440 and 420 pixels wide and asserts the header kind, the filter bar on list pages, no horizontal overflow and no console errors.
