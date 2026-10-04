# Development guide

## Running locally

```bash
npm install
# PostgreSQL 16 and Redis 7 available locally (or: docker compose up postgres redis)
cp .env.example .env            # adjust DATABASE_URL etc.
npm run db:migrate              # schema + RLS + partitions
npm run db:seed                 # defaults, admin user, optional demo data (SEED_DEMO_DATA=true)
npm run dev                     # API :8080, web :5173 (proxying /api), worker
```

Useful: `npm run typecheck`, `npm test` (API unit/integration tests, needs a database), `npm run db:generate` (new drizzle migration after editing `src/db/schema/*`).

## Backend module pattern (`apps/api/src/modules/<name>`)

```
routes.ts    Fastify routes: zod schemas, permission preHandlers, thin handlers
service.ts   Business logic. Functions take `ctx: Ctx` first.
schemas.ts   (optional) shared zod schemas / DTO shapes
```

Rules:

* Register routes with `app.auth(...permissions)` as `preHandler` and wrap handlers in `h(async (ctx, req, reply) => ...)` from `@/core/context`. `h` opens a tenant-scoped transaction (RLS enforced) and commits/rolls back around the handler.
* Services never import the pool directly; they use `ctx.tx` (Drizzle) so every query runs under the request's tenant context. Background jobs use `withSystem(tx => ...)` and must filter by customer explicitly.
* Check access with `ctx.requireCustomer(customerId)` for any customer-owned entity and `ctx.require('perm', customerId)` for actions. Customer users hold `portal:*` permissions only; portal endpoints live in `modules/portal`.
* Every mutation writes an audit entry via `ctx.audit({ entityType, entityId, action, customerId, changes })`. Use `diffChanges(before, patch)` for updates.
* Side effects that leave the system (email, in-app notifications) go through `queueNotification(ctx.tx, ...)` so they are transactional.
* Lists accept `page`, `pageSize`, `sort`, `order`, `q` (see `core/pagination.ts`, `core/query.ts`) and return `{ items, total, page, pageSize }`.
* Numbers: `nextTicketNumber(tx, type)` in `modules/tickets/numbers.ts`; never generate identifiers in the client.
* Errors: throw `NotFoundError`, `ForbiddenError`, `ValidationError`, `ConflictError` from `@/core/errors`.
* Configurable lists come from `config_options` (`type` + `key`). Look up by key only in seeds/tests; at runtime use IDs from the request or `optionsByIds`.

## Frontend pattern (`apps/web/src/pages/<module>`)

* Data fetching with TanStack Query and the `api` client (`get/post/put/patch/del`). Query keys start with the module name (`['tickets', id]`) and mutations invalidate them.
* Use the UI kit in `components/ui` (Button, Input, Select, Field, Badge, Card, DataTable, Pagination, Dialog, Drawer, Tabs, KeyValue, StatTile, EmptyState...) and `useLookups()` for option lists/teams/services; `useListState()` keeps filters in the URL.
* Permissions: `useAuthStore(s => s.can)('tickets:resolve')`. Hide what the user cannot do; the API enforces anyway.
* Keep screens dense and quick: one list page with filters + a detail page with a right-hand context panel is the standard layout. Avoid wizards and nested dialogs.
* Adding a page: the route in `routes.tsx` (or `AdminPage.tsx`), its `APP_PAGES` entry in `packages/shared/src/appmap.ts`, the navigator child under its application in `layouts/nav.ts` (sections are fixed; add an application only with an `APPLICATIONS` entry), the matching strip entry in `layouts/modules.ts` (or the administration rail group in `components/admin/AdminLayout.tsx`); `navigation.test.ts` and `ai-appmap.test.ts` fail until all four agree.

## Brand assets

`apps/web/public/mark.svg` is the single vector source of the favicon set. After editing it, regenerate the rasters with `node apps/web/scripts/make-icons.mjs` (needs Playwright's Chromium: `npx playwright install chromium`, or set `PLAYWRIGHT_MODULE` to an installed copy and `PLAYWRIGHT_CHROMIUM` to a Chromium binary; Playwright is deliberately not a dependency of the repository). The script writes `favicon-16.png`, `favicon-32.png`, `favicon.ico`, `apple-touch-icon.png`, `icon-192.png` and `icon-512.png` next to the SVG; `favicon.svg` is a copy of `mark.svg`. `apps/api/test/branding.test.ts` checks the files, their sizes and the links in `index.html`, so run it after regenerating.

## Adding a configurable option list

1. Add the type to `OPTION_TYPES` in `packages/shared/src/constants.ts`.
2. Seed defaults in `apps/api/src/seed/options.ts`.
3. Reference by `type` in forms via `useLookups().options('my_type')`.

## Adding an integration adapter

Implement `IntegrationAdapter` in `modules/integrations/adapters/<name>.ts` (parse payload → normalized event) and register it in `adapters/index.ts`. The pipeline (store → correlate → dedupe → optional ticket) is shared.
