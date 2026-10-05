# Design contract

Progression looks and behaves like one product because every page follows the same small set of rules. This file is the contract; `npm run lint:ui` (apps/web/scripts/ui-lint.mjs) enforces the parts a script can check, and the route crawl in the verification notes checks the rest in a browser. Read this before adding a page or a panel.

## Look

Vercel and shadcn inspired: neutral zinc surfaces, 1px borders, Geist type, black primary actions, one blue accent for links, focus and selection. Colour is reserved for status, data and two decorative touches: the tinted icon chip on a KPI tile and the soft tint of an application icon in the navigator. No gradients. Tokens live in `apps/web/src/styles.css`; pages never use arbitrary hex colours, and status colours come from `apps/web/src/lib/statusColors.ts`.

**Brand.** The wordmark (`apps/web/public/logo.png`) sits top-left of the expanded navigator, in the phone top bar, on the login page and on the public status page. When the navigator is minimised to its 60 px rail only the mark (`mark.svg`, the red swoosh) remains, 28 px, centred, with the same tooltip the collapsed application icons use; the same vector is the favicon and the source of the touch and home-screen icons. The logo colours never become tokens: nothing in the UI paints in the logo red or navy, and the fade inside the mark is artwork, not a UI gradient.

## Four page kinds

| Kind | Where | Anatomy |
|---|---|---|
| Home dashboard | `/` staff views, portal home | `DashboardHero` (date, title, view switcher) with the global filter row, then the KPI row, then panels. Nothing else uses the hero. |
| Module overview | Customers, Contracts, Assets, CMDB, Field, Knowledge, Discovery, portal Assets; Operations, Changes and Reports carry the same strip on their pages | `PageHeader` + `ModuleNav` + KPI row + panels. Tiles and panel rows are links into the module's list. |
| List | the `ListShell` pages, the service catalog, the change catalog (cards instead of a table), the portal planned changes and Known errors (staff and portal) included | `PageHeader` + optional `ModuleNav` + filter bar + quick views + count line + `InsightBand` + results card. Tiles and breakdown rows are quick filters on the same page. |
| Record | the `RecordLayout` pages (a ticket, a CI, a customer, a contract, an asset, a visit, an article, a known error) | `RecordHeader` (two primary actions, an overflow menu), ribbon, form sections, related tabs, activity rail. |

Administration screens use `SectionHeader`, which renders the same `PageHeader` as everywhere else, inside `AdminLayout`.

## Navigator

The staff navigator has six sections in a fixed order, each a collapsible heading: Insight (Dashboards, Reports), Service desk (Tickets, Knowledge), Service operations (Operations, Changes, Field service, Teams), Accounts (Customers, Contracts & scope, Service catalog), Infrastructure (Configuration (CMDB), Assets) and System (Administration). The portal has Overview above three sections: Support (Service status, My tickets, Approvals, Knowledge), Your services (Services & contracts, Assets, Maintenance & visits) and Account (Reports, Users). The trees live in `apps/web/src/layouts/nav.ts`; an application's label is the label of its `APPLICATIONS` entry in the application map, and the applications appear in that map's order.

An application lists its modules only when two or more are visible to the person (the same rule `ModuleNav` applies to a strip), and the module strips in `apps/web/src/layouts/modules.ts` mirror the navigator's children entry for entry with the same permissions; `apps/api/test/navigation.test.ts` enforces both, together with the labels, the order, the role visibility and the administration rail. Sections collapse from their heading and the choice is remembered per browser (`localStorage`), while the application you are on stays visible inside a collapsed section; the *Filter navigator* box ignores headings and collapse state. The 60 px rail shows one icon per application with a tooltip and a divider between sections; the phone bar shows the first five visible applications with their `short` labels. Dashboards views and ticket quick views are modules with a query string, which are highlighted only on an exact match of path and query (adding a filter keeps the application row active and drops the module highlight).

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
- Customer-facing wording is edited in a `Dialog` with a Write-with-Grady helper and a notify checkbox; the record never shows internal fields to customer users.
- Ratings use `RatingStars` (five buttons in a radio group, 44 px targets on phones and the public page, colours from `CSAT_RATING_COLORS`) and `RatingBadge` in lists; the survey prompt is one `SurveyCard` shared by the portal ticket and the public page. The public survey and status pages render `PageHeader` under their own wordmark header, outside both shells.
- The assistant panel (`components/grady/`) never opens a dialog: a proposal is a card inside the thread (preview, change lines, record count, tier, expiry, Confirm primary and Cancel outline, bound to the server's action id), progress is one quiet line per tool, feedback is two thumbs under the reply with a one-line note in place, and navigation the assistant performs is announced with a toast. The window stays mounted while minimised.

## Checking it

`npm run verify` runs the typecheck and `lint:ui`. The lint fails on a page reload through `window.location`, an arbitrary hex colour, the retired `secondary` variant, an `<h1>` outside the shared headers, a page without a shared header, and a `ListShell` page without an empty state. The browser crawl (`r13-audit.cjs` in the session scratchpad, kept with the verification notes) opens every route as an administrator, a NOC engineer and a portal user at 1440 and 420 pixels wide and asserts the header kind, the filter bar on list pages, no horizontal overflow and no console errors.
