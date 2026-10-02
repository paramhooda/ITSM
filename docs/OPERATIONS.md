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
