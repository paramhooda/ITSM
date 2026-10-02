# Security model

## Authentication

* Email + password (argon2id hashing, lockout after 5 failed attempts for 15 minutes, audit of failures).
* Short-lived JWT access tokens (`ACCESS_TOKEN_TTL`, default 15 minutes) sent as a Bearer header; rotating refresh tokens stored hashed in `sessions` and delivered as an `httpOnly`, `SameSite=Lax` cookie scoped to `/api/auth`. Sessions can be listed and revoked by the user and are revoked on password change/reset and account disable.
* Password reset by single-use, time-limited token sent by email; the API never reveals whether an address exists.
* API keys (`X-API-Key`) for integrations with explicit permission lists, optional customer scope and expiry; stored hashed.
* Designed for stronger authentication later: `users.auth_provider`/`external_id` and `mfa_enabled` exist; an OIDC/SAML provider plugs into `modules/auth` without changing the authorization model.

## Authorization

Permissions → roles → scoped assignments (see `docs/ARCHITECTURE.md` §3). Checks happen in route `preHandler`s (coarse) and in services (`ctx.require`, `ctx.requireCustomer`, fine-grained). Customer portal users only hold `portal:*` (and `ai:*`) permissions and cannot be granted MSP permissions.

## Tenant isolation

PostgreSQL row-level security with `FORCE ROW LEVEL SECURITY` on every customer-owned table; policies evaluated from per-transaction settings that default to "no customers" (fail closed). The runtime role is `NOSUPERUSER NOBYPASSRLS`. See `drizzle/sql/platform.sql`.

Attachments are stored under a customer-partitioned key and every download re-checks the owning entity's visibility. Search, dashboards, reports and the AI assistant run under the same context.

## AI safety

The assistant can only call registered tools, each of which invokes the service layer with the caller's `Ctx`. Tool inputs are validated with zod; tool outputs are the same DTOs the UI receives. Actions (creating tickets, adding comments) require `ai:act` and are recorded in the audit log with `source = 'ai'` and in the conversation. Prompts include only data the user may see. Provider credentials never leave the server.

## Transport and headers

Run behind TLS. `@fastify/helmet` sets a strict Content-Security-Policy in production (self-only scripts, no inline scripts), `frame-ancestors 'none'`, and standard hardening headers. CORS is disabled in production (same origin). Rate limiting applies to all `/api` routes with stricter limits on login and password reset.

## Secrets

`JWT_SECRET` and `ENCRYPTION_KEY` must be strong random values (`openssl rand -hex 32`). Secrets stored in configuration (SNMP communities, SMTP passwords) are encrypted with AES-256-GCM using `ENCRYPTION_KEY` and masked in API responses.

## Audit

`audit_log` records user, timestamp, action, entity, old/new values, source (ui/api/ai/integration/system), IP, user agent and request ID for every mutation including configuration and permission changes. Partitioned monthly, retained per `audit.retention_months`, exportable as CSV, viewable by `admin:audit`.

## Uploads

Size limit (`MAX_UPLOAD_MB`), extension deny-list for executables, content type recorded, SHA-256 computed. Files are never served from a path under user control.

## Dependencies

Node.js 22 LTS, maintained libraries only; run `npm audit` as part of the release process. The runtime image runs as the unprivileged `node` user with `tini` as PID 1.
