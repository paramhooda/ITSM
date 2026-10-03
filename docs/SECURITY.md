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

The assistant can only call registered tools, each of which invokes the service layer with the caller's `Ctx`. Tool inputs are validated with zod; tool outputs are the same DTOs the UI receives, scrubbed of values under secret-looking keys, fenced to the customer user's organisation and with people-written text wrapped as data the model must not take instructions from. Actions require `ai:act` and run only after the person confirms a preview bound to the action's id (tiers: low-risk internal writes may auto-apply under an administrator's autonomy setting; outbound, configuration and destructive actions always confirm); the confirmation locks the conversation row so it runs exactly once, and every side effect carries the action and conversation ids in its audit metadata. Each turn is audited as `ai.chat` and each tool call as `ai.tool` with an input fingerprint, never the input; fences are audited as `ai.tenant_fence` and `ai.answer_fence`. People, roles, permissions and keys are read-only through the assistant; `security.*`, `smtp.*` and secret-named settings are never read or written. Per-person rate limits, a daily token budget, a reply deadline and administrator kill switches bound the exposure; conversations are deleted after the retention period. Prompts include only data the user may see and never credentials; provider credentials never leave the server. See docs/AI-ASSISTANT.md.

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
