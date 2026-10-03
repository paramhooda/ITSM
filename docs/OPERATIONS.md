# Operations guide

## Deployment topology

Minimum (single host):

```
docker compose up -d        # postgres, redis, app (API+web), worker
```

Recommended for production (high availability):

| Component | Guidance |
| --- | --- |
| `app` | 2+ replicas behind a load balancer / reverse proxy terminating TLS (`APP_URL=https://...`, `COOKIE_SECURE=true`). The API is stateless; sessions live in PostgreSQL, rate-limit counters in memory per replica (acceptable) or Redis. |
| `worker` | 1–2 replicas. Jobs are idempotent and locked via Redis/BullMQ; SLA and scheduled jobs are safe to run with multiple workers. |
| PostgreSQL | Primary + streaming replica (or Patroni/pgBackRest for automated failover). Size: 4 vCPU / 16 GB RAM handles 1,000+ tickets/day comfortably; set `shared_buffers` to ~25% RAM. |
| Redis | Standalone with AOF persistence (as configured) or Sentinel. Loss of Redis data is non-fatal: schedulers re-register on worker start and the notification outbox is replayed from PostgreSQL. |
| Storage | `/data/storage` volume for attachments. Use a replicated filesystem or NFS/SAN for HA; S3-compatible object storage can be added through the `StorageDriver` interface. |

Environment variables are documented in `.env.example`. All services read the same set.

## First start and upgrades

1. The `app` container runs migrations (schema → platform SQL for RLS/partitions → grants) under an advisory lock, then seeds defaults and the initial administrator (`ADMIN_EMAIL`/`ADMIN_PASSWORD`, only if no users exist).
2. Upgrades: pull the new image, `docker compose up -d`. Migrations are forward-only and idempotent; replicas can be rolled one at a time.
3. Rollback: restore the database backup taken before the upgrade and start the previous image.

## Backup and disaster recovery

* **PostgreSQL**: nightly `pg_dump -Fc` plus continuous WAL archiving (pgBackRest/WAL-G) for point-in-time recovery. RPO ≤ 5 minutes with WAL shipping; RTO is the time to restore and start containers.
* **Attachments**: snapshot the `storage-data` volume on the same schedule; attachments are referenced by `storage_key` so a restore of both database and volume is consistent (a newer volume than database is harmless; the reverse leaves dangling references that the download endpoint reports as missing).
* **Redis**: no backup required.
* Test restores quarterly: restore into a staging stack and run `GET /api/health` plus a login.

## WhatsApp notifications

WhatsApp is configured once under **Administration → WhatsApp** (Meta WhatsApp Cloud API): phone number id, a permanent system-user access token, the app secret (so delivery callbacks can be verified), a webhook verify token and the approved message templates. Business-initiated messages must use templates Meta has approved, so create one (the default is `progression_update` with three body parameters: subject, text, link) and map it on that page; event groups (ticket, sla, incident, page, handover, briefing) can map to their own templates and otherwise fall back to the default. The page sends a test message and lists recent WhatsApp rows of the outbox with their delivery state.

Everyone else opts in on their profile with a mobile number (ten-digit numbers get the default country code, India by default); customer administrators can do it for their users, and staff can tick it on customer contacts. A notification rule reaches WhatsApp only when the rule includes the WhatsApp channel and the recipient has opted in. Rows are written to `notification_outbox` with channel `whatsapp` inside the business transaction, delivered by the `deliver-outbox` job with retries, and marked failed at once on permanent provider errors (unknown template, invalid number). Register `/api/webhooks/whatsapp` in the Meta app (field `messages`) so sent, delivered, read and failed states flow back; `WHATSAPP_API_BASE` overrides the Graph host for tests. Sent and failed outbox rows are purged after `notifications.outbox_retention_days` (90 by default) by the nightly `outbox-purge` job.

## Major incidents

An incident becomes a major incident from its actions menu (**Declare major incident…**, permission `tickets:major`, incidents only) or by ticking the flag while raising it. Declaring writes a `major_incidents` row next to the ticket: bridge link and notes, incident commander (defaults to the assignee), communications lead, update cadence (30 minutes by default) and whether the customer portal shows a banner. The response team hears about it through the `incident.major_declared` rule (assignee, team, manager, account manager and the NOC, SOC and service managers over email, in-app and WhatsApp).

The **Major incident** tab on the ticket is the command view: stakeholder updates go to a chosen audience (requester, customer contacts, watchers, account manager, assignee, team, manager) over chosen channels and land in the communication log with how many people they reached; bridge notes join the log without notifying anyone; Grady drafts either kind from the record and the latest notes (`POST /api/ai/tickets/:id/major/draft-update`). Other incidents for the same outage are linked as children (`child_of` links, visible from both ends). Every stakeholder update resets the cadence; the `major-update-reminder` job (every 5 minutes) reminds the communications lead, or the commander, or the assignee, once per missed slot through `incident.major_update_due`. Resolving or closing the ticket resolves the major record, stops the cadence and sends `incident.major_resolved` to the requester, contacts, watchers and account manager; reopening re-activates it. After resolution the same tab holds the post-incident review (what happened, impact, root cause, owned actions); completing it closes the record. **Not a major incident…** demotes: the flag and the banner drop, the record stays for the audit trail.

**Operations → Major incidents** lists every major incident the viewer can see (active first, overdue updates flagged) and the NOC dashboard shows the active ones with their bridge. Customers see active incidents with the banner switched on above every portal page (`GET /api/portal/banners`) together with the latest stakeholder update, and the ticket itself carries the badge.

## Monitoring

* `GET /api/health` → `{status, db, latencyMs}`; the Docker healthcheck uses it.
* Logs are JSON on stdout (`LOG_LEVEL`), with `reqId`, route, latency and errors; ship them with your existing log pipeline.
* Suggested alerts: health check failing; `notification_outbox` rows in `failed` status; `ticket_slas` rows breached but not yet notified (`warned_at`/`breached_at` null past due); worker not running (BullMQ schedulers stop advancing); PostgreSQL replication lag; disk usage on the attachments volume.
* Administration → System shows outbox status and audit activity.

## Data growth

| Table | Strategy |
| --- | --- |
| `audit_log`, `integration_events` | Monthly range partitions created 3 months ahead by the maintenance job; dropped after `audit.retention_months` / `events.retention_months`. |
| `tickets`, `ticket_comments`, `ticket_activities`, `ticket_slas` | Indexed on `(customer_id, created_at)`, status, assignee, team, search vector. Millions of rows perform well. To partition tickets by month later: create `tickets_p` partitioned by `created_at`, copy, swap names in a maintenance window; application code does not change. |
| `metric_rollups_daily` | Nightly per-customer aggregates for dashboards and reports so they never scan history. |
| Attachments | Stored outside the database; metadata only in PostgreSQL. |

Routine maintenance: autovacuum is sufficient; run `REINDEX` on GIN indexes yearly if bloat is observed.

## Security operations

See `SECURITY.md`. Rotate `JWT_SECRET` to invalidate all access tokens (users re-authenticate via refresh cookie, which stays valid), rotate API keys from Administration → API keys, and review Administration → Audit log for privileged actions.

## Capacity planning (reference)

1,000 customers · 1,000 tickets/day · 10 comments/ticket · 3 SLA rows/ticket ≈ 5 M tickets, 50 M comments, 15 M SLA rows over 5 years, ~80 GB including indexes. A single PostgreSQL primary with 8 vCPU / 32 GB RAM and NVMe storage is adequate; scale reads with a replica if reporting load grows.

## AI assistant troubleshooting

The assistant uses the provider set by `AI_PROVIDER` (`anthropic`, `openai_compatible` or `none`), the model in `AI_MODEL` and, for OpenAI-compatible endpoints, `OPENAI_COMPATIBLE_BASE_URL` plus `OPENAI_COMPATIBLE_API_KEY`. Environment variables are read when the container starts, so run `docker compose up -d` after changing `.env`.

Setting only `OPENAI_API_KEY=sk-...` is enough: the provider, `https://api.openai.com/v1` and `gpt-4o-mini` are inferred and the choice is logged at startup as `AI assistant enabled` (with notes explaining any inferred value). The explicit combination is:

```
AI_PROVIDER=openai_compatible
OPENAI_COMPATIBLE_BASE_URL=https://api.openai.com/v1
OPENAI_COMPATIBLE_API_KEY=sk-...
AI_MODEL=gpt-4o-mini
```

Check the configuration from the product first: **Administration → Settings → Assistant connection → Test connection** sends a one-line prompt and shows the latency, or the exact status and message the provider returned. The same information is logged by the API as `AI endpoint error` with the provider, model and endpoint (never the key).

From the Docker host:

```bash
docker compose exec app env | grep -E '^(AI_|OPENAI_)'          # what the container actually sees
docker compose logs app --tail 200 | grep -i "AI endpoint"       # upstream status and message
curl https://api.openai.com/v1/chat/completions \                # the same call outside the platform
  -H "authorization: Bearer $OPENAI_COMPATIBLE_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
```

Common causes:

| Symptom | Cause | Fix |
|---|---|---|
| HTTP 400 `Unsupported parameter: max_tokens` | Newer OpenAI models only accept `max_completion_tokens` | Handled automatically (the app retries in the modern shape); upgrade if you see it in the logs |
| HTTP 404 `model_not_found` / `The model ... does not exist` | `AI_MODEL` is not a model of that provider (default is a Claude id) | Set `AI_MODEL` to a model the endpoint serves |
| HTTP 401 `Incorrect API key` | Wrong or truncated key, or the key is in the wrong variable | Put the key in `OPENAI_COMPATIBLE_API_KEY` (or `ANTHROPIC_API_KEY` for Anthropic) |
| HTTP 404 on the endpoint itself | Base URL missing `/v1` or pointing at a UI page | Use the API base; `/chat/completions` is appended by the app and stripped if pasted |
| "could not be reached" | Container cannot resolve or reach the host (proxy, firewall, Ollama not published) | Test with `docker compose exec app wget -qO- <base url>/models` and fix networking |
| Assistant says it is not configured | `AI_PROVIDER` is `none` or the matching key / URL is empty | Set the variables and restart |
| Browser shows `POST /api/ai/chat` → 400 `Request validation failed` | Versions before this release rejected a new conversation from the panel (`conversationId: null`); nothing reached the provider | Upgrade (`docker compose build && docker compose up -d`) |

## Who sees what

Permissions decide what a user may do; **navigation areas** decide what their navigator shows. Each role carries a list of areas (Tickets, Customers, Contracts & scope, Service catalog, Teams, Assets, CMDB, Discovery, Monitoring & SIEM, Field service, Preventive maintenance, Knowledge, Reports). The navigator shows an application only when the user holds a permission for it **and** one of their roles lists its area; roles with no areas configured show everything their permissions allow. Administrators always see everything.

The navigator follows the ServiceNow shape: applications grouped by section, each expandable into its modules (Tickets → Open, Assigned to me, Unassigned, Incidents, Requests, Problems, Changes, Create new; Configuration (CMDB) → Overview, Configuration items, Business services, Service map, CI classes, Discovery), with a *Filter navigator* box at the top. Monitoring & SIEM lives under **Administration → Monitoring & SIEM** (the old `/integrations` and `/discovery` links redirect). Record pages share one layout: breadcrumb trail and number/title in the header with at most two primary actions (the rest under "…"), a two-column field form, related lists as tabs, and an activity stream in the right rail.

The ticket record follows the ServiceNow incident form, top to bottom: the header (number, title, state and priority controls, scope, two primary actions) with an at-a-glance strip (assigned to, age, first response, next SLA target, due, reopens); an attention strip for staff; **Details** in two columns (left: customer, site, requester, service, contract, configuration item, asset, category and subcategory, tags; right: source, opened, status, impact, urgency, priority, team, assigned to, due); **Description** with the catalog form when the ticket came from the catalog; **Attachments**; **Resolution information** once there is any; **Related records** (parent and typed links); then the related lists as tabs (problem analysis or change plan, approvals, tasks, affected CIs and assets, SLA targets, time worked, linked tickets). The right rail holds the activity stream with the composer on top, the context cards and the assistant. The portal ticket uses the same order with customer wording (Details, Resolution, Description, Request details, Attachments) and a conversation rail.

Files can be attached while creating a ticket (staff and portal: pick, drop or paste a screenshot into the description; they are uploaded to the new ticket right after it is created) and while replying (the composer's paperclip, a drop or a paste). A note's files follow its audience: a reply's files are visible to the customer, a work note's stay internal; portal uploads are always visible to the customer's organisation. Files are uploaded before the note is posted and the note names them, so the activity stream and the e-mail copy record what was attached.

Every major application opens on an **Overview** and offers its modules in a strip under the page header, like the CMDB: Assets (Overview, Inventory, Warranty & AMC, Lifecycle), Customers (Overview, Accounts), Contracts & Scope (Overview, Contracts, Entitlements, Service levels), Field Service (Overview, Visits, Calendar, Preventive maintenance), Knowledge (Overview, Articles, Categories); in the portal Assets (Overview, Inventory, Warranty & AMC), Services & Contracts (Services, Service levels, Contracts) and Maintenance & Visits (Upcoming, History). Tickets stay a single list; staff with approval rights get a **My approvals** inbox under Tickets, and approval workflows run their steps in order.

Every list page has the same shape: a horizontal filter bar on top (a search box and one pill per filter; a pill opens a small panel with its options, counts, select, date range or toggle, and shows the chosen value on itself) and the results underneath with a count and a Reset link. The bar sits on its own toolbar surface so filters never read as data. Stat tiles on a list page toggle a filter in place and scroll to the results; on overview pages and dashboards they link to the list with the filter applied. Dashboards carry their global filters (period, customer scope) in the hero's filter row and one to three local controls in a chart's header. Filter state lives in the URL, so a filtered view can be bookmarked or shared. The rules are written down in docs/DESIGN.md and checked by `npm run lint:ui`.

System roles ship with sensible areas (a NOC engineer sees tickets, CMDB, discovery, monitoring and knowledge; a field engineer sees tickets, assets, field service, maintenance and knowledge; account managers see customers, contracts, the catalog and reports). Adjust them under **Administration → Roles → Navigation areas**; the change applies at the next page load.

### Customer data isolation

A customer (portal) user is bound to exactly one organisation, and that binding is enforced in four layers that do not depend on each other:

1. **Database.** Every tenant table carries `customer_id` and has a forced row-level-security policy; the API sets the tenant context on every transaction (`app.customer_ids`), so a query that forgets a predicate still returns only that organisation's rows.
2. **Service layer.** List and lookup functions add the explicit `customer_id = <own customer>` predicate for portal users (tickets, search, knowledge, contracts, entitlements, SLA figures, maintenance), and a portal user asking for another customer by name or code is answered with their own data.
3. **Assistant (Grady).** The system prompt names the organisation the user belongs to and instructs the model to answer for it only; the worked examples use placeholder names that exist nowhere; every tool result is passed through a *tenant fence* that removes any record naming another organisation before the model sees it (a removal is logged and audited as `ai.tenant_fence`; under normal operation the count is always zero); conversations are stored under the organisation and cannot be continued by the same account from another one.
4. **Browser.** The web client drops everything it cached for one person when another signs in, including the assistant's screen context.

`apps/api/test/ai-isolation.test.ts` exercises every assistant tool a portal user can reach with inputs that ask for a different customer and asserts that only the user's own organisation comes back.

### Customer replies on waiting tickets

A ticket in **Pending Customer** is the service desk waiting on the customer. When the customer answers (a portal comment, or a comment added through the assistant), the ticket returns to the working status for its type (Incident → In progress, Request → In fulfilment), the SLA clocks resume with the paused time credited, the timeline shows "Customer replied · back with the service desk", and the ticket leaves the customer's "Awaiting your reply" list. An engineer's own comment on a waiting ticket does not change its status.
