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

System roles ship with sensible areas (a NOC engineer sees tickets, CMDB, discovery, monitoring and knowledge; a field engineer sees tickets, assets, field service, maintenance and knowledge; account managers see customers, contracts, the catalog and reports). Adjust them under **Administration → Roles → Navigation areas**; the change applies at the next page load.
