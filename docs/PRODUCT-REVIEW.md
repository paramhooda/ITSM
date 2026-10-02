# Product review: Progression against ServiceNow ITSM and SymphonyAI Summit

A functional review of the platform as it stands, what this round changed, and what is still missing compared with the two products most MSP buyers measure against. Priorities are set for a managed-service provider running NOC, SOC, AMC, service desk and field service for many customers.

## Method

The inventory was taken from the code (routes, navigator, API modules, schema, permissions) and compared with the public feature sets of ServiceNow ITSM and Employee Center and SymphonyAI Summit (ITSM + ITAM + ITOM). Priorities: **P1** expected by every MSP buyer, **P2** differentiating or frequently asked, **P3** nice to have. Effort: S (days), M (one to two weeks), L (a release).

## What the platform has today

- **Service desk**: incidents, requests, problems and changes in one record model with configurable statuses, four SLA clocks on business calendars, approvals with workflows, escalation (manual and rule-based), assignment rules, links, watchers, tasks, time entries, attachments, bulk actions, saved views, scope classification against contracts, the Grady assistant with grounded figures and confirmed actions.
- **Accounts**: customers with sites, contacts, escalation contacts, teams and portal users; contracts with services, sites, entitlements, scope rules, SLA policy, escalation matrix and documents; a service catalog; service levels.
- **Infrastructure**: a CMDB with classes, relationships with impact direction, business services, a service map, discovery (network scan with SNMP) and monitoring ingestion (PRTG, FortiSIEM, generic webhooks) with a correlation pipeline.
- **Assets**: inventory with lifecycle stages, warranty and AMC cover, EOL dates, CSV import and export, asset to CI links.
- **Delivery**: field visits (schedule, start, complete, parts, notes, customer acknowledgement, report) and preventive-maintenance programmes with generated occurrences.
- **Knowledge**: typed articles with visibility (internal, per customer, public), versions, feedback counts, expiry, suggestions on ticket creation.
- **Insight**: six role dashboards, seventeen report definitions with scheduled delivery, audit trail.
- **Portal**: tickets, approvals, services and contracts, assets, maintenance and visits, knowledge, reports, users.

## Changed in this round

- Every customer user now sees their asset inventory in the portal (the Customer User role lacked the permission; only administrators had it). The portal Assets area is a module with Overview, Inventory and Warranty & AMC.
- Every major area is now a module with an Overview, like the CMDB: Assets (Overview, Inventory, Warranty & AMC, Lifecycle), Customers (Overview, Accounts), Contracts & Scope (Overview, Contracts, Entitlements, Service levels), Field Service (Overview, Visits, Calendar, Preventive maintenance), Knowledge (Overview, Articles, Categories); and in the portal Assets, Services & Contracts (Services, Service levels, Contracts) and Maintenance & Visits (Upcoming, History). Tickets stay a single list by design.
- One filter system everywhere: a quiet filter rail on the left with search and grouped options, the results on the right with the applied filters spelled out as removable chips and a count. The rail collapses and becomes a drawer on small screens.
- Dashboard drill-downs into the ticket list now apply every parameter they send (mine, unassigned, domain, severity, category, engineer, resolved).
- Service levels has a place in the navigator (under Contracts & Scope).

## Gaps, by area

### Service desk

| Gap | Why it matters | Priority | Effort |
|---|---|---|---|
| Inbound email to ticket (reply threading, attachments, auto-acknowledge) | The most used channel after the portal; ServiceNow and Summit both ingest mail | P1 | M |
| Customer satisfaction survey on resolution and closure, with CSAT on dashboards and reports | Standard in both products; the only rating today is on field visits | P1 | S |
| Staff approvals inbox ("My approvals") and sequential approval steps honouring all-or-any per step | The API has an inbox endpoint with no screen, and steps currently run in parallel with "any" ignored | P1 | S |
| Change calendar with conflict and blackout-window checks, CAB meeting with agenda and decisions, standard (pre-approved) change catalog, risk questionnaire that scores risk | Change today is a record with free-text CAB notes; the calendar exists only as a report | P1 | M |
| Major incident workflow: declare or demote on the record, communication log, stakeholder updates, bridge details, post-incident review | Today it is a flag set only at creation | P2 | M |
| Known error database view for the desk and the portal (problem workarounds searchable) | Problem records carry workarounds but nothing surfaces them | P2 | S |
| Ticket templates and quick-create for common incidents | Request catalog covers requests; incidents have none | P2 | S |
| On-call schedules and rota-based escalation | Escalation rules notify roles and teams, not whoever is on call | P2 | M |
| Notification channels beyond email and in-app: SMS, Microsoft Teams, Slack, push | Worker currently rejects any other channel | P2 | M |
| Announcements and outage banners for staff and portal | Employee Center's most used widget | P2 | S |
| Visual task boards for engineers and shift handover notes | Common in modern desks | P3 | M |
| Comment editing in the UI (API exists) | Small polish | P3 | S |

### Customer portal

| Gap | Why it matters | Priority | Effort |
|---|---|---|---|
| Asset detail in the portal with ticket history and "report an issue with this asset" | Delivered partly this round (inventory, cover, detail drawer); the ticket link closes the loop | P1 | S |
| Service health page (business services with current status from monitoring) | What customers open first during an outage | P2 | M |
| "My items" widget: requests, approvals and tasks in one place | Employee Center pattern | P2 | S |
| Staff preview of the portal as a given customer | The API already accepts a customer id for tenant-wide users | P2 | S |
| Knowledge topics and recommendations by role or site | Employee Center taxonomy | P3 | M |
| Mobile-first portal (installable web app) | Field managers on phones | P3 | M |

### Asset management (Summit's strongest area)

| Gap | Why it matters | Priority | Effort |
|---|---|---|---|
| Software asset management: software inventory, licence entitlements against installs, compliance position | Summit sells on this; today there is only a software licence category | P2 | L |
| Stockroom and spare parts: stock per site, consumption from field-visit parts, reorder points | Parts used on visits never reduce stock | P2 | M |
| Barcode or QR labels and a physical audit mode (scan to verify) | Annual audits for AMC customers | P3 | M |
| Procurement requests with approval and receiving into stock | Summit has it; many MSPs run it outside the tool | P3 | M |

Note: financial depreciation and contract value tracking were removed by request and stay out of scope.

### Infrastructure and monitoring

| Gap | Why it matters | Priority | Effort |
|---|---|---|---|
| More monitoring adapters (Zabbix, SolarWinds, Nagios, SNMP traps, syslog, Microsoft Defender, cloud alerts) and outbound webhooks | Each MSP has a different stack | P2 | M per adapter |
| Service health from CI events (business service status, availability history) | Turns the service map into a live view | P2 | M |
| Discovery beyond network scan: WMI, SSH, vCenter, cloud accounts, agents | Server and cloud estates | P3 | L |

### Reporting and analytics

| Gap | Why it matters | Priority | Effort |
|---|---|---|---|
| PDF and Excel output, branded monthly service report | Customers ask for a PDF to forward | P2 | M |
| Custom report builder (pick fields, filters, grouping) | Seventeen fixed definitions cover most needs; ad-hoc questions go to the assistant today | P3 | L |
| SLA credits and penalties tracking (operational, not commercial) | Some contracts carry them | P3 | S |

### Platform

| Gap | Why it matters | Priority | Effort |
|---|---|---|---|
| Single sign-on (SAML or OpenID Connect) and SCIM user provisioning | Expected by every enterprise customer and by MSP staff with Microsoft 365 | P1 | M |
| Low-code workflow designer (conditions and actions on ticket events) | Flow Designer is ServiceNow's platform pitch; assignment and escalation rules cover the common cases today | P3 | L |
| Multi-language user interface | Needed outside English-speaking markets | P3 | M |
| Data retention and export tooling | Audit and event partitions exist; policies are manual | P3 | S |

## Suggested order

1. **Now**: approvals inbox and sequential steps (a correctness fix), CSAT survey, inbound email, SSO.
2. **Next**: change calendar with conflicts and CAB, major incident workflow, announcements and service health page, SMS and Teams notifications, PDF reports, portal preview.
3. **Later**: software asset management, stockroom, on-call rotas, more adapters, custom report builder.

## Bugs found during the review

- Dashboard links to the ticket list dropped most of their filters (fixed this round).
- Approval steps run in parallel and ignore the all-or-any setting (listed above as P1).
- Service levels had no navigator entry (fixed).
- The field visit report is HTML served under a .pdf file name in the portal download.
- The portal reports endpoint and the portal ticket attachments endpoint exist but the portal uses the generic ones.

## Sources

- [SymphonyAI Summit product overview](https://www.getapp.com/it-management-software/a/summit/), [Summit on Software Advice](https://www.softwareadvice.com/it-management/summitai-profile), [SymphonyAI IT Service Management on TrustRadius](https://tr-web.dev.trustradius.com/products/symphony-summitai/reviews)
- [ServiceNow incident management](https://www.servicenow.com/products/incident-management.html), [ServiceNow ITSM Advanced release notes](https://www.servicenow.com/docs/r/store-release-notes/store-rn-itsm-advanced.html), [Key ServiceNow features in 2026](https://www.desk365.io/blog/servicenow-features/)
- [ServiceNow Employee Center Pro features](https://www.servicenow.com/docs/r/xGHm5nN1KlkEq58WJHJoPw/tzx9Xyvw3iAeHaE9OQ~Xkw), [Employee Center release notes](https://www.servicenow.com/docs/r/zurich/release-notes/employee-center-rn.html)
