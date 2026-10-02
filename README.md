# MSP Service Management Platform

Enterprise ITSM, helpdesk, asset management and CMDB platform for Managed Services Providers running mission-critical customer environments. ITIL 4 aligned, multi-customer by design, deployable on-premise with one command.

**Capabilities**: customers & sites · contracts, entitlements (AMC) & scope · service catalog · SLA management with business calendars · incidents, service requests, problems, changes · NOC and SOC operating models · asset register · CMDB with relationships and network discovery · PRTG / FortiSIEM event ingestion · field service & preventive maintenance · knowledge base · customer portal · scheduled reports · role-specific dashboards · global search · full audit trail · AI assistant that respects every permission boundary.

## Quick start

```bash
cp .env.example .env     # optional: set passwords, SMTP, AI provider
docker compose up -d
```

Open http://localhost:8080 and sign in with `admin@msp.local` / `Admin@12345` (change these in `.env` before the first start for production). The first start creates the schema, seeds the NOC/SOC/AMC operating defaults and, when `SEED_DEMO_DATA=true` (default), a realistic sample MSP with customers, contracts, assets, CIs and tickets.

Everything is downloaded and built inside Docker: no local Node.js, database or build tooling is required.

### Demo accounts

When the demo dataset is loaded (`SEED_DEMO_DATA=true`), these accounts exist in addition to the administrator. Password for all demo users: `Demo@12345`.

| Role | Account |
| --- | --- |
| Service manager | `ananya.krishnan@msp.local` |
| Account manager | `vikram.mehta@msp.local` |
| NOC manager / NOC engineer | `rajesh.kumar@msp.local` / `priya.sharma@msp.local` |
| SOC manager / SOC analyst | `sneha.iyer@msp.local` / `fatima.siddiqui@msp.local` |
| Service desk | `meera.pillai@msp.local` |
| Field engineer (scoped to assigned customers) | `suresh.reddy@msp.local` |
| CMDB / contract administrators | `daniel.fernandes@msp.local` / `lakshmi.narayanan@msp.local` |
| Management / auditor | `sarah.thompson@msp.local` / `nikhil.bose@msp.local` |
| Customer portal administrator (ABC Manufacturing) | `manish.agarwal@abc-manufacturing.example` |
| Customer portal user (Meridian Bank) | `imran.shaikh@meridianbank.example` |

The dataset contains 10 customers, 22 contracts with entitlements and scope, ~290 configuration items with relationships, ~450 tickets with 120 days of SLA history, field visits, maintenance programs, knowledge articles and monitoring/SIEM events. Set `SEED_DEMO_DATA=false` for a clean production start.

* API documentation: http://localhost:8080/api/docs
* Health: http://localhost:8080/api/health
* Local email sink (dev profile): `docker compose --profile dev up -d` then http://localhost:8025

## Services

| Service | Role |
| --- | --- |
| `app` | API + web UI (stateless; scale with replicas behind a load balancer) |
| `worker` | SLA monitoring, notifications, scheduled reports, discovery, maintenance jobs |
| `postgres` | PostgreSQL 16, system of record, row-level security per customer |
| `redis` | Job queues and rate limiting |

## Documentation

* [Architecture and design decisions](docs/ARCHITECTURE.md)
* [Operations: backup, HA, upgrades, monitoring](docs/OPERATIONS.md)
* [Security model](docs/SECURITY.md)
* [Development guide](docs/DEVELOPMENT.md)

## Technology

TypeScript · Node.js 22 · Fastify · PostgreSQL 16 · Redis · BullMQ · Drizzle ORM · React 19 · Vite · Tailwind CSS. See the architecture document for the reasoning behind each choice.
