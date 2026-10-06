# Architecture

This document records the engineering decisions behind the MSP Service Management Platform: what was chosen, why, and what was deliberately left out.

## 1. Shape of the system

**A modular monolith, deployed as two processes (API + worker) over PostgreSQL and Redis.**

| Concern | Decision | Rationale |
| --- | --- | --- |
| Deployment unit | One container image, two commands (`server`, `worker`) | On-premise MSPs need something an infrastructure team can run, back up and restore. One image, two stateless processes and two stateful services (PostgreSQL, Redis) keeps the operational surface small while allowing horizontal scaling of API and worker replicas independently. |
| Code structure | Modules under `apps/api/src/modules/<name>` (routes + service + schemas), shared core | Clear ownership and boundaries without network hops. Modules communicate via service functions inside the same transaction, which keeps multi-entity operations (ticket + SLA + audit + notification) atomic. If one module ever needs independent scaling (e.g. event ingestion), its queue-based design allows extraction. |
| Language / runtime | TypeScript on Node.js 22 (Fastify 5) | One language across API, workers and UI; large ecosystem for SNMP, SMTP, PDF/CSV; strong typing for a wide domain model. |
| Database | PostgreSQL 16 | System of record for everything. JSONB for configurable fields, native full-text search + trigram indexes for global search, declarative partitioning for high-volume tables, row-level security for tenant isolation. |
| Queue / scheduling | Redis 7 + BullMQ | SLA timers, notification delivery, scheduled reports, discovery runs, event processing, housekeeping. Cron-style repeatable jobs live in the worker; jobs are idempotent and safe to retry. |
| Web UI | React 19 + Vite, served by the API | Single-page app with a focused operational layout. Built into the same image; no separate web server needed. |
| Search | PostgreSQL FTS (`tsvector` generated columns) + `pg_trgm` | Adequate for millions of tickets with GIN indexes; avoids operating a second search cluster. A `SearchProvider` abstraction (`modules/search`) allows OpenSearch/Meilisearch later. |
| Attachments | Filesystem volume via a `StorageDriver` interface | S3-compatible storage can be added without touching callers. |
| AI | Provider abstraction: Anthropic, OpenAI-compatible (on-prem models), or none | The assistant uses *tools* that call the same service layer with the caller's authorization context. AI can never see or do more than the user. |

Explicitly **not** chosen: microservices, Kafka, Elasticsearch, Kubernetes-only deployment, a separate BFF. None of them are needed to reach the target scale (1,000+ customers, 1,000+ tickets/day, millions of historical tickets) and each would add operational cost for an on-premise MSP.

## 2. Tenant isolation (customer data boundary)

Three layers, each sufficient on its own:

1. **Principal resolution.** Every request resolves a `Principal` with a `customerScope`: `'all'` (holds `tenant:all`) or an explicit list of customer IDs derived from customer-scoped role assignments, explicit access grants and team-to-customer assignments. Customer (portal) users always resolve to exactly their own customer.
2. **Application checks.** Services call `ctx.requireCustomer(id)` before touching a customer entity and `ctx.require(permission, customerId)` for actions.
3. **PostgreSQL row-level security.** Every request runs inside a transaction that sets `app.user_id`, `app.all_customers` and `app.customer_ids`. All tables that carry `customer_id` have a `FORCE ROW LEVEL SECURITY` policy evaluated through STABLE functions (`app_customer_ids()`), so even a bug in application code cannot leak another customer's rows. The runtime database role is a non-superuser without `BYPASSRLS`; migrations use the owner role.

Background jobs run with the system context (`app.all_customers = true`) and must pass explicit customer IDs into every notification/report they produce.

Rows with `customer_id IS NULL` are *shared* (global knowledge articles, platform-wide catalog items) and are visible to all.

## 3. Authorization model

* **Permissions** are flat strings (`tickets:resolve`, `contracts:manage`, `portal:approve`...), catalogued in `packages/shared/src/permissions.ts`.
* **Roles** bundle permissions. Sixteen system roles ship by default (Administrator, NOC Engineer, SOC Analyst, Service Manager, Account Manager, CMDB Administrator, Contract Administrator, Management, Auditor, Customer Administrator, Customer User...). Administrators can create more.
* **Role assignments** are global or scoped to one customer. A user may be *Engineer* globally and *Service Manager* for one strategic customer.
* **Visibility** (which customers) is separate from **capability** (which actions). `tenant:all` grants MSP-wide visibility; otherwise visibility is the union of scoped assignments, explicit grants and team assignments.
* The three initial categories map to roles: Customer → `customer_user`/`customer_admin`, Engineer → `engineer`/`noc_engineer`/..., Admin → `admin`.

## 4. Domain model (summary)

```
Customer ─┬─ Sites ─┬─ Assets ──── CIs ──┬── CI Relationships
          │         └─ Contacts          ├── Tickets (incident/request/problem/change)
          │                              │    └── Known errors (problem_details)
          │                              └── Software installations (per CI / asset / user) ── Software catalogue (shared titles)
          ├─ Contracts ─┬─ Covered services (→ Service catalog) ─ SLA policy override
          │             ├─ Covered sites
          │             ├─ Entitlements ── Consumptions (field visits, time entries, PM visits)
          │             ├─ Scope items (in/out of scope definitions)
          │             └─ Software licences (seats, metric, term, cost, proof of purchase)
          ├─ Field visits ── parts, notes, acknowledgement
          ├─ PM programs ── occurrences
          ├─ Knowledge (customer-specific) / shared knowledge
          └─ Report schedules / runs
```

* **Tickets** are one table with a `type` discriminator (`incident`, `request`, `problem`, `change`) plus extension tables (`problem_details`, `change_details`) and `form_data` for catalog request forms. Shared behaviour (comments, activities, links, SLAs, tasks, time, attachments, watchers) is implemented once. `problem_details` also carries the known error database: status, fix change, customer-facing wording and portal publication; the portal reads only the customer fields.
* **Statuses, categories, priorities, sources, codes, contract types, scope headers, entitlement types, asset categories, visit types, CI types and relationship types are data** (`config_options`, `ci_types`, `ci_relationship_types`), seeded with sensible NOC/SOC/AMC defaults and editable in Administration. Every status maps to a *status category* (`new/open/pending/resolved/closed/cancelled`) so SLA logic and reports work with any custom status.
* **Scope** is a classification (`in_scope`, `out_of_scope`, `unknown`) computed from the customer's contracts, services, sites, ticket category and CI type and recorded on the ticket. It is informational: nothing in the ticket workflow is blocked by scope.
* **SLA**: policies contain targets per ticket type × priority × metric (acknowledgement, response, restoration, resolution). Each ticket gets one `ticket_slas` row per applicable metric with the calendar snapshot used, `due_at`, pause accounting and an event trail. Policy selection order: catalog item → contract service override → contract → service default → platform default.
* **Assets vs CIs**: assets hold the financial/lifecycle view (purchase, warranty, AMC, location, ownership); CIs hold the operational/relationship view. They may link 1:1 but either can exist alone.
* **Changes**: `change_details` extends a change ticket (window, plans, risk answers and score, template, CAB meeting); `change_templates` (standard changes), `change_risk_questions`, `change_blackout_windows` (global or per customer) and `cab_meetings` / `cab_meeting_items` are the change-management tables; conflicts are computed, never stored (an activity records them); `change-window-reminder` runs hourly on the `sla` queue. The three definition tables carry no customer column and are fenced to staff by an explicit row-level policy; the portal reads planned changes from `tickets` and `change_details` only.
* **Satisfaction surveys**: one `ticket_surveys` row per ticket (the recipient, the hashed and encrypted token behind the email links, the rating, the comment, the channel and a snapshot of the engineer and team at the time), `survey_configs` overrides per customer or contract over the `surveys.*` settings; `tickets.csat_rating` denormalises the answer for lists and filters. CSAT figures are computed live from the surveys table.
* **Software**: a shared catalogue of titles (`software_products`, no customer); installations (`software_installations`, on a CI, an asset, a host name or a user) and licences (`software_licences`, with a self-reference to the licence that continues a renewed one) belong to one customer; the compliance position is computed live (never stored) from live hosts and licences in term; `software_notifications` records the once-only notification milestones.
* **Task boards** are views over tickets and `ticket_tasks` (lanes by status or assignee, scoped by person, team or engineer); every move runs the ticket's own status, assignment and task transitions. Only `board_notes` (one person's sticky notes, per-user row-level security) is new; board layout lives in `users.preferences`.
* **Custom report definitions** (`report_definitions`) are MSP artefacts: an entity key and a whitelisted specification (columns, filters, grouping, aggregates, sort, period field) compiled into parameterised SQL by `modules/reports/builder/compile.ts` over the field catalogue; they run through the same executor, renderers and schedules as built-in definitions under the caller's row-level security context, carry `scope_customer_id` (not `customer_id`) so the tenant policy does not apply to the definition itself, and an explicit policy lets staff read every row and portal users only the rows published for their organisation.
* **Notification preferences**: `notification_categories` holds the administrator's default and lock per category and channel (fifteen rows seeded from the shared catalogue in `packages/shared`, readable by everyone and written by staff under an explicit policy); a person's choices sit in `users.preferences.notifications` (only the cells they set); `queueNotification` applies rule ∩ person ∩ opt-in for every recipient with an account and never vetoes in-app; `phone_verifications` (hashed one-time codes, per-user row-level security) and `users.whatsapp_verified_at` with the partial unique index `users_whatsapp_verified_phone_idx` record proof of ownership of a mobile number (one account per verified number).

## 5. Scale and reliability

* **Indexes** on every foreign key used in filters, composite `(customer_id, created_at)` for tenant time-series, GIN on search vectors and trigram columns.
* **Partitioning** by month for `audit_log` and `integration_events`; a maintenance job creates partitions ahead and drops expired ones per retention settings. Tickets stay unpartitioned (indexes suffice into the tens of millions); the path to partition by `created_at` is documented in `OPERATIONS.md`.
* **Dashboards** read from `metric_rollups_daily` (computed nightly per customer) plus live counts for "today", keeping management views fast regardless of history size.
* **Transactions per request** keep multi-table changes atomic; the audit record is part of the same transaction.
* **Outbox pattern** for notifications: emails are written to `notification_outbox` inside the business transaction and delivered by the worker with retries. Nothing is sent for a rolled-back operation. The `survey-sweep` job (`notifications` queue, hourly) sends the one reminder for unanswered satisfaction surveys and marks the expired ones.
* **Task boards** read `ticket_tasks` through the `(assignee_id, status)` and `(team_id, status)` indexes and cap the cards at `boards.card_limit` with exact lane counts from one grouped query; the nightly `board-notes-purge` job (`maintenance` queue) removes done sticky notes past `boards.note_retention_days`.
* **Software** positions come from two grouped queries (installations on live hosts, licences in term) joined in memory per customer and title; the `software-daily` job (`maintenance` queue, 06:30) sends the licence expiry and over-deployment notifications once per milestone.
* **Report documents** are rendered server-side (SVG charts, the embedded wordmark and typeface, no browser script) and printed by one Chromium process at a time; a compared report runs its definition twice inside one transaction, the narrative phrasing is the only model call and runs between the report's two transactions, and the file is stored in the second.
* **Idempotent jobs** with Redis-backed schedulers; API replicas can start concurrently (migrations use an advisory lock).
* **Health endpoint** `/api/health`, structured JSON logs, request IDs, graceful shutdown.
* Backups: PostgreSQL base backups + WAL (see `OPERATIONS.md`); attachments volume snapshot; Redis is reconstructible (jobs are re-derived from the database on worker start).

## 6. Integration model

PRTG and FortiSIEM are modelled as **integrations** with an API key, a customer mapping and rules. Events arrive at `/api/integrations/:id/events` (generic JSON) or the PRTG/FortiSIEM-specific webhook adapters, are stored in `integration_events`, correlated to a customer and CI (by monitoring reference, hostname or IP) and, if `auto_create_tickets` is enabled, become incidents through the *same* ticket service used by the UI (SLA, assignment rules, notifications included). Deduplication uses the external event ID and a configurable window. Adapters are small translation functions; adding Zabbix, email ingestion or an EDR is a new adapter, not a redesign.

Discovery follows the same pattern: `discovery_sources` of a given `source_type` produce `discovery_findings` which are reconciled into CIs (automatically or after review).

## 7. AI model

* `lib/ai/provider.ts` defines `AiProvider.chat(messages, tools)`; implementations exist for Anthropic and OpenAI-compatible endpoints. With `AI_PROVIDER=none`, conversational features are hidden and rule-based assistance (similar incidents by full-text similarity, knowledge suggestions, priority from the impact/urgency matrix) still works.
* The assistant (`modules/ai/`) exposes a registry of **tools** (`tools/`, 158 of them across every module) that call module services with the caller's `Ctx`, so authorization and tenant isolation apply identically to AI and UI actions. The prompt is assembled from fixed sections (`prompt/`: identity, rules, style, skill playbooks in a cacheable stable block; operating context and capabilities in a volatile block). Toolsets (`toolsets.ts`) keep each model call small and are enabled by the page, a keyword router, the skill or the model itself. A chat turn (`service.ts`) runs the model outside any transaction and each tool call in its own short transaction; actions are proposed with a preview and executed exactly once on confirmation. `POST /ai/chat` answers JSON or a server-sent event stream; `admin.ts` serves the control page. The application map (`packages/shared/appmap.ts`) describes every page for the guide, validated navigation and page-aware toolsets.
* Recommendations (classification, priority, assignment, similar incidents, KB) are stored as `ai_suggestions` and shown as proposals; a human accepts or rejects them. No silent operational decisions.
* Drafting features (triage, resolution notes, handover notes, briefings, known-error wording, report builder suggestions, report narratives) call `llmJson` with a JSON-only prompt outside any transaction, validate the answer and fall back to a deterministic result; a report narrative is additionally checked figure by figure against the report's own numbers.

## 8. Configuration over hard-coding

`config_options` (typed option lists), `priority_matrix`, `custom_field_definitions`, `business_calendars`/`holidays`, `sla_policies`/`sla_targets`, `assignment_rules`, `escalation_rules`, `notification_templates`/`notification_rules`, `approval_workflows`, `catalog_items` (with JSON form schemas), `ci_types` (with attribute schemas), `ci_relationship_types`, `report_schedules`, `report_definitions` and `system_settings` are all data with administration screens. The seed provides a working NOC/SOC/AMC operating model on first start.

## 9. Repository layout

```
apps/api        Fastify API, workers, migrations, seeds   (see src/modules/* for each capability; software/ holds the catalogue, installations, licences, compliance, import and overview)
apps/web        React SPA (pages per module, shared UI kit)
apps/web/public Static brand assets: wordmark, mark, favicon set, web manifest (generated by apps/web/scripts/make-icons.mjs)
packages/shared Permissions catalogue, constants, DTO types shared by API and web
deploy/         Docker entrypoint, PostgreSQL init (application role)
docs/           Architecture, operations, security, API notes
```

**Navigation.** `packages/shared/src/appmap.ts` holds `APPLICATIONS` and `APP_PAGES`, the one list of applications and pages shared by the web navigator (`apps/web/src/layouts/nav.ts`, grouped into Insight, Service desk, Service operations, Accounts, Infrastructure and System, with the portal's Support, Your services and Account), the module strips (`apps/web/src/layouts/modules.ts`), the administration rail (`apps/web/src/components/admin/AdminLayout.tsx`), the assistant's guide and navigation tools, and the tests (`ai-appmap.test.ts`, `navigation.test.ts`). Adding a page means a route, an `APP_PAGES` entry, a navigator child under its application and a strip entry; the tests fail until all four agree.
