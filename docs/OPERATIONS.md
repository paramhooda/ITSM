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

Everyone else opts in on their profile with a mobile number (ten-digit numbers get the default country code, India by default); customer administrators can do it for their users, and staff can tick it on customer contacts. A notification rule reaches WhatsApp only when the rule includes the WhatsApp channel and the recipient has opted in. Rows are written to `notification_outbox` with channel `whatsapp` inside the business transaction, delivered by the `deliver-outbox` job with retries, and marked failed at once on permanent provider errors (unknown template, invalid number). Register `/api/webhooks/whatsapp` in the Meta app (field `messages`) so sent, delivered, read and failed states flow back. The admin page shows the URL to register, derived from `APP_URL`; when the platform runs on localhost (Meta cannot reach it) enter the public URL of a tunnel such as ngrok in the **Webhook URL** field instead (`whatsapp.webhook_url`; an origin alone gets the webhook path appended, **Use default** goes back to the platform URL, and the page lists a local URL under "Still needed"). The override only changes what the page shows and copies: Meta calls whatever URL is subscribed there, and links inside messages still come from `APP_URL`. `WHATSAPP_API_BASE` overrides the Graph host for tests. Sent and failed outbox rows are purged after `notifications.outbox_retention_days` (90 by default) by the nightly `outbox-purge` job.

## Major incidents

An incident becomes a major incident from its actions menu (**Declare major incident…**, permission `tickets:major`, incidents only) or by ticking the flag while raising it. Declaring writes a `major_incidents` row next to the ticket: bridge link and notes, incident commander (defaults to the assignee), communications lead, update cadence (30 minutes by default) and whether the customer portal shows a banner. The response team hears about it through the `incident.major_declared` rule (assignee, team, manager, account manager and the NOC, SOC and service managers over email, in-app and WhatsApp).

The **Major incident** tab on the ticket is the command view: stakeholder updates go to a chosen audience (requester, customer contacts, watchers, account manager, assignee, team, manager) over chosen channels and land in the communication log with how many people they reached; bridge notes join the log without notifying anyone; Grady drafts either kind from the record and the latest notes (`POST /api/ai/tickets/:id/major/draft-update`). Other incidents for the same outage are linked as children (`child_of` links, visible from both ends). Every stakeholder update resets the cadence; the `major-update-reminder` job (every 5 minutes) reminds the communications lead, or the commander, or the assignee, once per missed slot through `incident.major_update_due`. Resolving or closing the ticket resolves the major record, stops the cadence and sends `incident.major_resolved` to the requester, contacts, watchers and account manager; reopening re-activates it. After resolution the same tab holds the post-incident review (what happened, impact, root cause, owned actions); completing it closes the record. **Not a major incident…** demotes: the flag and the banner drop, the record stays for the audit trail.

**Operations → Major incidents** lists every major incident the viewer can see (active first, overdue updates flagged) and the NOC dashboard shows the active ones with their bridge. Customers see active incidents with the banner switched on above every portal page (`GET /api/portal/banners`) together with the latest stakeholder update, and the ticket itself carries the badge.

## On-call and paging

**Operations → On-call** (`oncall:read`; editing needs `oncall:manage`) is where a team's cover is defined and read. A **rota** belongs to a team and lists people in rotation order: the first starts on the start date at the handoff time (`09:00` by default) and the rota hands over every week, every day or every N days, in the rota's own timezone, so a handoff stays at 09:00 local across a daylight-saving change. A rota may cover a daily window only (for example `18:00`–`08:00`); outside it nobody from that rota is on call. A team can have several rotas (primary, secondary); the lowest order is paged first. **Cover** (an override) puts a named person on a rota between two instants whatever the rotation says; managers add cover for anyone, everyone else only for themselves, from the calendar. The Schedule tab shows who is on call now for every team with a rota (name, phone, email, until when, cover marked), the week calendar for one team and the cover entries; `GET /api/oncall/now` and `GET /api/oncall/schedule?teamId&from&to` (62 days at most) serve the same data, and the NOC and SOC dashboards carry an **On call now** panel.

An **escalation policy** is an ordered list of steps: whom to reach (whoever is on call for the team, a named person, every member, or the team manager), over which channels (email, in-app, WhatsApp) and how many minutes to wait before the next step; the whole list can repeat, and a policy can hand an unassigned ticket to whoever acknowledges. Each team has a default policy (Administration → Teams, or the Rotas tab of the on-call page). A **page** starts from a ticket's actions menu (**Page on-call…**, `tickets:escalate`), from an escalation rule (Administration → Escalation rules: *Notify on-call engineer* adds the on-call person to the notification; *Page on-call through* starts a page through the team's policy or a named one), or from Grady (`page_on_call`, confirmed first). The first step's people get `page.sent` with a one-tap acknowledgement link (`/api/oncall/ack/<token>`; the WhatsApp message carries that link, the email a button); the link shows a confirmation page on GET, since messaging apps prefetch links, and acknowledges on POST. When the step's timeout passes without an acknowledgement the step is marked escalated and the next one starts; when the last step times out the page expires and the team manager plus the NOC, SOC and service managers get `page.expired`. Acknowledging from the link or from the ticket's **Paging** tab closes the chain, records who took it, assigns the ticket when the policy says so and tells whoever paged (`page.acknowledged`). Resolving, closing or cancelling the ticket calls a waiting page off. Every step is an activity on the ticket and an audit entry (`ticket.page`, `ticket.page_ack`, `ticket.page_expired`, `ticket.page_cancel`); `GET /api/oncall/pages` lists them.

Timeouts are enforced twice: `page-timeout` on the `paging` queue is enqueued with a delay when a step starts, and `page-sweep` (every minute) moves on any waiting step whose deadline passed, so a lost Redis never loses a page. Tokens are stored hashed; the acknowledgement endpoints are rate limited per IP and reveal only the ticket number and title.

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

## Triage on arrival

Every new incident or request is triaged by Grady a moment after it is created (`triage-ticket` on the `ai` queue; the worker must be running). The job classifies the ticket, recommends an owner and looks for duplicates; above `ai.triage.auto_apply_confidence` the category and the owner are applied, otherwise they wait as proposals the engineer accepts from the chips under the ticket's attention strip. Monitoring and SIEM tickets that look like an open one are linked as duplicates of the oldest (`ai.triage.storm_auto_link`); `ai.triage.storm_threshold` look-alikes within `ai.triage.storm_window_minutes` is reported as an alert storm. The switch and the thresholds live on **Administration → AI assistant** (feature *Triage on arrival*, the Limits card); each run is a `Grady triage: …` activity on the ticket and an `ai.triage` audit entry. Without an AI provider the keyword heuristic still runs.

## Change management

**Calendar and conflicts.** Operations → Change calendar shows every scheduled change on a week or month grid (`GET /changes/calendar`). When a change is created with a window, its window or type is edited, or its configuration items change, `recordConflicts` (`apps/api/src/modules/changes/service.ts`) looks for another change of the same customer overlapping the window on a shared configuration item or on the same business service (through the dependency map), and for an active blackout window (global or the customer's; emergency changes pass when the window allows them). Conflicts are recorded once as an internal `change_conflict` activity and a `change.conflict` audit entry, never a block; the change plan tab, the calendar chips and Grady's change impact show them. `POST /changes/conflicts` previews the clashes of a window before the change exists. The setting `changes.conflict_warnings` turns the activity off.

**Blackout windows** (Administration → Blackout windows, `admin:config`): a name, an optional customer (empty = everyone), the window, the reason shown on the warning and whether emergency changes may go ahead.

**Risk questionnaire** (Administration → Change risk questions): weighted questions with scored answers. On a change's plan tab the implementer answers them and presses Assess risk (`POST /changes/:id/assess-risk`): the weighted total is scaled to 0–100 against the questionnaire's maximum and mapped to low, medium or high with `changes.risk_thresholds` (`{ "medium": 35, "high": 65 }`); the level also sets the change's Risk field and is recorded as an activity and a `change.risk_assessed` audit entry. A high-risk change that is not yet approved is flagged in the attention strip.

**Standard change templates** (Administration → Standard change templates): repeatable changes with their plans; on the new-change form the template prefills the type, risk, category, service, title, description and plans, and a pre-approved template sets the ticket's approval status to `not_required` (shown as Pre-approved) so no workflow is needed. Templates may be limited to named customers. The API takes `changeTemplateId` on `POST /tickets`.

**CAB meetings** (Operations → CAB, permission `changes:cab`; `changes:approve` and `changes:manage` may read): a meeting has a chair, a time and an agenda of changes. Approving or rejecting an item records the decision on the change (`cab` activity, CAB notes) and, when a step is pending, decides the change's pending approval step (the CAB step first) through the approvals module; deferring records only the decision. Closing a meeting marks what was not reached as deferred and keeps the minutes. The requester and the assignee are notified (`change.cab_decision`).

**Window reminder.** `change-window-reminder` runs hourly on the `sla` queue: open changes whose window opens within `changes.reminder_hours` (24) are reminded once (`change.window_reminder`, assignee, requester and team; `change_details.window_reminder_at` prevents repeats).

Grady: `change_calendar` answers "what is scheduled this week" with the windows, conflicts and blackout windows; the change impact analysis includes the conflicts and the questionnaire's verdict.

## Shift handover

Operations teams (NOC, SOC, service desk) hand a shift over on **Operations → Shift handover** (`handover:write`; people with `oncall:manage` see and may write for every team). A team's shifts (name, start and end time of day, weekdays, timezone; an end at or before the start crosses midnight) are edited under **Administration → Teams → Shifts**; the seed gives the NOC and SOC a Day (08:00–20:00) and a Night shift and the service desk three, all in Asia/Kolkata. The page shows the shift running now and the next one, the live digest for the team (open tickets, P1/P2, breached and at-risk SLAs, unassigned, waiting on the customer, active major incidents, changes in the next 12 hours, who is on call now and at the next shift start, tickets opened and resolved since the shift began) and the lists behind each count. "Draft with Grady" writes the note from that digest and the engineer's own notes under fixed headings (Watch first, Open and at risk, Major incidents, Scheduled next, On call, Notes); without a provider, or with the `handover` feature switch off, the same headings are filled deterministically. The model is called outside the database transaction. Publishing stores the note with the facts it was written from and sends `handover.published` (email, in-app and WhatsApp for people who opted in) to whoever is on call when the next shift starts, or to every active member of the team when nobody is on a rota, never to the author. The incoming engineer opens it from the notification link and acknowledges it (with an optional note); the author cannot acknowledge their own handover. Drafts belong to their author; published handovers are kept and only an on-call manager deletes one. Everything is audited (`shift_handover` create, update, publish, acknowledge, delete; `team_shift` changes). Customer users and API keys never reach these tables (row-level security on `team_shifts` and `shift_handovers` admits staff only). Grady's `shift_handover` tool answers "what should the night shift watch" from the same digest.

## Status page and announcements

**Announcements** (Operations → Announcements, permission `announcements:manage`) are banners shown above every page to their audience: everyone, customers only or staff only, optionally for one or more customer organisations, inside a window (show from, take down at), pinned or dismissible. Types: notice, planned maintenance, service disruption. Customers see them above every portal page and on their status page; staff see them under the shell header. "Draft with Grady" writes the title and the message from a ticket or from the text typed so far (a template without an AI provider); a major incident's command card offers **Draft announcement** pre-aimed at that customer. Grady can also propose `create_announcement` in chat (outbound tier, confirmed as written). The rows are shared (no customer column): `platform.sql` carries a hand-written policy (`app_is_msp()` plus the audience and customer list) so a customer scope only ever reads what is aimed at it; writes are staff-only. Audit actions `announcement.create|update|delete`.

**Service health and the status page.** `status-health` runs every two minutes on the `sla` queue (`apps/api/src/modules/status/health.ts`): for every business service (a CI of type `business_service`) it walks the dependency map and rates the service `down` (an active major incident on anything it relies on), `maintenance` (a PM visit in progress, a change inside its window or a dependency marked in maintenance), `degraded` (an open P1/P2 ticket or critical/high monitoring alerts in the last two hours on a dependency) or `good`, with the reasons, into `service_health_snapshots`. The portal's **Service status** page (`portal:status`, `GET /portal/status`) shows the customer's services with those reasons, planned maintenance for the next 14 days (PM occurrences and change windows), the announcements aimed at them and the major incidents being announced. Staff with `tenant:all` preview a customer's page with `?customerId=`.

**Public status pages.** On the Status pages tab (permission `customers:manage`) a link per customer is minted: the token is shown once, stored hashed, and listed by its prefix; revoke it to close the page. `GET /public/status/:token` (rate-limited, no sign-in) and `/status/:token` in the web return aggregate words only: service names and health, reasons in plain language, maintenance titles and windows, announcements, incident notices with the latest stakeholder update, never ids, ticket links or customer lists. Audit actions `status_token.create|revoke|delete`.

## Breach risk and customer sentiment

Two signals the queue reads at a glance, both staff-only (never in the portal, the customer dashboard or a customer's API responses).

**Breach risk.** `risk-score` runs every five minutes on the `sla` queue (`apps/api/src/modules/sla/risk.ts`). For every open ticket with an open SLA clock it takes the worst clock (percent of the target used, working minutes left), the median time to resolution of tickets of the same type, category and priority resolved in the last 180 days (the priority alone when the category has fewer than three samples), and the state of the ticket: no owner adds to the score, a paused clock caps it, waiting on the customer takes from it, an escalation or an earlier reopen adds a little. The result is `low`, `medium` or `high` with a 0 to 100 score and a one-line reason, written on the ticket (`breach_risk`, `breach_risk_score`, `breach_risk_reason`, `breach_risk_at`) only when it moved, and cleared when the clocks are done. The first rise to high adds an internal `Breach risk high: …` activity without touching the ticket's last-activity time. It shows as the **Risk** column and filter on the ticket list, the **Likely to breach** tile on the list and the NOC dashboard (linking to `/tickets?breachRisk=high`), the **Outlook** card in the ticket rail, the attention strip (when no clock is already breached or at risk) and the `breachRisk` predicate of Grady's `query_tickets`.

**Customer sentiment.** After every customer-written comment the `comment-sentiment` job on the `ai` queue labels it `positive`, `neutral`, `negative` or `angry` with a score from −100 to 100 (the model when a provider is configured, a word list with capitals and exclamation marks otherwise), on the comment (`ticket_comments.sentiment`) and as the ticket's last mood (`last_sentiment`, `last_sentiment_at`). A negative or angry comment adds an internal activity, an `ai.sentiment` audit entry and notifies the assignee and the team manager (`ticket.sentiment_negative`, in-app and email, with the usual notification rules on top) at most once per ticket every six hours. `sentiment-sweep` every ten minutes labels anything a lost job missed and marks staff comments `n/a`. The feature switch is *Customer sentiment on comments* on **Administration → AI assistant**. The mood shows beside the risk on the list, in the rail, in the attention strip (with a Reply action) and through the `sentiment` predicate of `query_tickets` (`unhappy` = negative or angry).

## Reports

Every report runs on screen (JSON preview) or as a stored file attached to a run: CSV, printable HTML, PDF and Excel. PDF and Excel were added with the service review pack; the earlier formats are unchanged.

- **PDF** is produced by a Chromium binary in the container (`apps/api/src/lib/pdf.ts`): one headless process per document, `--print-to-pdf` on A4 with the report's own `@page` rule, at most one render at a time in the API process and a 60-second limit. The lookup takes `PDF_CHROMIUM_PATH` first, then the usual locations (`/usr/bin/chromium`, `/usr/bin/chromium-browser`, `/usr/bin/google-chrome`). The production image ships **without** Chromium, so "Download PDF", the PDF and "PDF + Excel" schedule formats and PDF field visit reports stay off until you install it: add to the runtime stage of the `Dockerfile` (or an image built from it)

  ```dockerfile
  RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-dejavu-core fonts-liberation && rm -rf /var/lib/apt/lists/*
  ENV PDF_CHROMIUM_PATH=/usr/bin/chromium
  ```

  and restart. `GET /api/reports/definitions` returns `pdf: true` once a binary is found; the Reports page enables the buttons from that flag and a schedule in a PDF format is refused with a clear message while it is false. A render failure (a crash, the time limit) marks the run `failed` with the Chromium message in its error column and, on a schedule, counts as a failure for that target. Field visit reports (`POST /api/field/visits/:id/report`) are stored as PDF when Chromium is present and as printable HTML otherwise.
- **Excel** needs nothing extra (`exceljs`). The workbook has a Summary sheet (report, customer, period, the summary figures, the parameters, a contents list), a Detail sheet with the main table, one sheet per section and a Charts sheet with the chart data; numbers, percentages and dates are typed cells, the header row is frozen and filtered, sheet names are cut to Excel's 31 characters and kept unique.
- **Branding**: `platform.name`, `platform.logo_url` (an https URL or an inline `data:image/...` URI; anything else is ignored) and `platform.brand_color` (a six-digit hex) set the header, the Excel header rows and the cover page of HTML and PDF output. Reports flagged with a cover (the service review pack and PDF output of any report) open with a cover page listing the contents.
- **The service review pack** (`service_review_pack`, category Customers, portal-visible) is the monthly review for one customer: a scorecard (SLA compliance, breaches, volume, major incidents, entitlements over threshold, expiring asset cover and, for staff, out-of-scope work), then the SLA breakdown and breached tickets, ticket volume by week, major incidents, entitlement utilisation, assets whose warranty or AMC ends within 90 days and the out-of-scope tickets, each as a section (a sheet in Excel). Recommendations come from fixed rules over those figures; when a provider is configured and the `recommendations` feature switch is on, the model rephrases and prioritises them (`REVIEW_SYSTEM`, at most six, every evidence clause quoting the input), falling back to the rules on any failure. The customer is required; portal users get their own organisation without the out-of-scope part. A schedule in the **PDF + Excel** format produces both files on one run and attaches both to the delivery email; "Save as schedule" from the Reports page prefills it.

## AI assistant troubleshooting

The assistant uses the provider set by `AI_PROVIDER` (`anthropic`, `openai_compatible` or `none`), the model in `AI_MODEL` and, for OpenAI-compatible endpoints, `OPENAI_COMPATIBLE_BASE_URL` plus `OPENAI_COMPATIBLE_API_KEY`. Environment variables are read when the container starts, so run `docker compose up -d` after changing `.env`.

Setting only `OPENAI_API_KEY=sk-...` is enough: the provider, `https://api.openai.com/v1` and `gpt-4o-mini` are inferred and the choice is logged at startup as `AI assistant enabled` (with notes explaining any inferred value). The explicit combination is:

```
AI_PROVIDER=openai_compatible
OPENAI_COMPATIBLE_BASE_URL=https://api.openai.com/v1
OPENAI_COMPATIBLE_API_KEY=sk-...
AI_MODEL=gpt-4o-mini
```

Check the configuration from the product first: **Administration → AI assistant → Test connection** sends a one-line prompt and shows the latency, or the exact status and message the provider returned. The same page holds the kill switch, the feature switches, the autonomy mode (`ai.autonomy`: confirm every change, or auto-apply low-risk internal writes), the reasoning effort, the daily token budget per person (`ai.daily_token_budget`, 0 = unlimited), the reply timeout (`ai.turn_timeout_seconds`), the conversation retention (`ai.conversation_retention_days`; the nightly `conversation-purge` job on the `ai` queue deletes older conversations, 0 keeps them forever) and the usage report (replies, tokens and cache share, tool calls, feedback, fenced and denied events, per-tool counts). The same information is logged by the API as `AI endpoint error` with the provider, model and endpoint (never the key).

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
3. **Assistant (Grady).** Customer users are offered only the self-service tools (every one scoped to their own organisation by the service layer); the operating context names the organisation and the rules instruct the model to answer for it only; the worked examples use placeholder names that exist nowhere; every tool result is passed through a *tenant fence* that removes any record naming another organisation before the model sees it (a removal is logged and audited as `ai.tenant_fence`; under normal operation the count is always zero); the reply may only name tickets and link records the conversation has shown (`ai.answer_fence`); navigation is validated against the portal's pages; conversations are stored under the organisation and cannot be continued by the same account from another one.
4. **Browser.** The web client drops everything it cached for one person when another signs in, including the assistant's screen context.

`apps/api/test/ai-isolation.test.ts` exercises every assistant tool a portal user can reach with inputs that ask for a different customer and asserts that only the user's own organisation comes back.

### Customer replies on waiting tickets

A ticket in **Pending Customer** is the service desk waiting on the customer. When the customer answers (a portal comment, or a comment added through the assistant), the ticket returns to the working status for its type (Incident → In progress, Request → In fulfilment), the SLA clocks resume with the paused time credited, the timeline shows "Customer replied · back with the service desk", and the ticket leaves the customer's "Awaiting your reply" list. An engineer's own comment on a waiting ticket does not change its status.
