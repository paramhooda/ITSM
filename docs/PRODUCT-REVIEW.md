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
- One filter system everywhere: a horizontal filter bar above the data (search plus one pill per filter that shows its chosen value, in the style of Vercel's deployment filters), and under it the conditions in effect as a breadcrumb ("All open > Incidents > Unassigned", each chip removable, the root chip resets) with a "1–25 of 148 open incidents" count; the bar wraps on small screens. Every home page, staff and customer, opens on the same hero band with a 7, 30 or 90-day period control and, for staff, a customer scope; charts carry at most three local controls in their headers that change only that chart. Stat tiles follow one rule everywhere: on a list they toggle one condition in place without moving the other tiles or scrolling; on a dashboard they are links that open the list with the exact conditions the number was counted with, so the list shows the same number (a guard test holds every dashboard to it). The contract is in docs/DESIGN.md.
- Dashboard drill-downs into the ticket list now apply every parameter they send (mine, unassigned, domain, severity, category, engineer, resolved).
- Service levels has a place in the navigator (under Contracts & Scope).
- The ticket record is laid out like ServiceNow's incident form: Details in two columns, Description, Attachments, Resolution information, Related records, then the related lists as tabs; the portal ticket follows the same order in customer wording. Files can be attached while raising a ticket and while replying (pick, drop or paste), on both sides.

## Gaps, by area

### Service desk

| Gap | Why it matters | Priority | Effort |
|---|---|---|---|
| Inbound email to ticket (reply threading, attachments, auto-acknowledge) | The most used channel after the portal; ServiceNow and Summit both ingest mail | P1 | M |
| Ticket templates and quick-create for common incidents | Request catalog covers requests; incidents have none | P2 | S |
| Notification channels beyond email, in-app and WhatsApp: SMS, Microsoft Teams, Slack, push | WhatsApp shipped with a provider interface the others plug into; two-way WhatsApp chat with the assistant shipped | P3 | M |
| Announcements and outage banners for staff and portal | Employee Center's most used widget | P2 | S |
| Comment editing in the UI (API exists) | Small polish | P3 | S |
| Attachments linked to the note they came with (a `comment_id` on attachments) | Today the note names its files; a link would let the stream show them inline | P3 | S |

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
| SLA credits and penalties tracking (operational, not commercial) | Some contracts carry them | P3 | S |

### Platform

| Gap | Why it matters | Priority | Effort |
|---|---|---|---|
| Single sign-on (SAML or OpenID Connect) and SCIM user provisioning | Expected by every enterprise customer and by MSP staff with Microsoft 365 | P1 | M |
| Low-code workflow designer (conditions and actions on ticket events) | Flow Designer is ServiceNow's platform pitch; assignment and escalation rules cover the common cases today | P3 | L |
| Multi-language user interface | Needed outside English-speaking markets | P3 | M |
| Data retention and export tooling | Audit and event partitions exist; policies are manual | P3 | S |

## Suggested order

1. **Shipped since this review**: the staff approvals inbox with sequential steps, WhatsApp notifications (one business account, personal opt-in), the major incident workflow (declare or demote, bridge and roles, stakeholder updates on a cadence with reminders, child incidents, post-incident review, portal banner, Operations list and NOC tile), on-call schedules and paging (rotas with handoffs and windows, cover, escalation policies with timed steps, pages from tickets, rules and Grady, one-tap acknowledgement, the Operations page and dashboard panel), Grady in the composer and triage on arrival (drafted replies with a tone, knowledge suggestions, drafted resolution notes, handover summaries; automatic classification, owner and duplicate triage with a confidence threshold and alert-storm linking), SLA breach risk and customer sentiment (a five-minute forecast from the clock, how long similar tickets take and who owns the ticket, shown on the list, the rail, the attention strip and the NOC dashboard; the mood of every customer comment with a once-per-six-hours nudge to the assignee; both staff-only and filterable, also through Grady), the status page and announcements (banners by type, audience, customer and window, drafted by Grady from a ticket; business service health computed every two minutes from major incidents, maintenance windows, P1/P2 tickets and monitoring alerts on the dependency map; the portal Service status page; public, token-only status pages per customer), the change management upgrade (a change calendar with conflict detection on shared systems, business services and blackout windows; a weighted risk questionnaire with thresholds; standard change templates that prefill and pre-approve; CAB meetings whose decisions decide the approval step; an hourly window reminder; Grady's change calendar and impact with conflicts), the report document (a light Progression-branded A4 document for every report: cover, running header and footer with page numbers and a confidentiality line, an executive summary with previous-period deltas and sparklines, what went well, what needs attention and next steps derived from the figures and rephrased by the assistant outside the transaction, seven kinds of server-side charts, zebra tables with totals, callouts and an appendix of definitions and data notes; typed Excel workbooks with the insights; a PDF + Excel schedule format; field visit reports as real PDFs; the service review pack grown into a full monthly review with demand, responsiveness, first-contact resolution, reopen rate, backlog ageing, an arrival heatmap, problems and known errors, change success, customer satisfaction, contracts, assets and software, field service and numbered recommendations), shift handover for the NOC, SOC and service desk (shifts per team, the live digest of what is open, breached, at risk, unassigned, major and scheduled next with who is on call now and next, a note drafted by Grady or by hand, published to the incoming shift with email, in-app and WhatsApp, acknowledged by whoever takes over, the history and Grady's `shift_handover` tool), the daily briefing (opt-in per person with a local time, a role and channels; five role briefings built from exact figures under the person's own identity, phrased by Grady when a provider is on, delivered by email and in-app at the chosen time and shown on the dashboard with "Brief me now"), the navigator reorganised to the application architecture (six collapsible sections — Insight, Service desk, Service operations, Accounts, Infrastructure, System — a Changes application for the calendar, CAB and catalog, Dashboards views as modules, Monitoring & SIEM under the CMDB, the same grouping in the portal and the administration rail, and a test that keeps navigator, strips and application map in step), and the Progression mark in the minimised navigator and as the browser icon set (SVG favicon with ICO and PNG fallbacks, a touch icon and a web manifest), and the change management gap closure (a standard change catalog engineers raise from, seeded questions and templates, blackout refusal and attention flags on the record, change filters on the ticket list, the CAB queue, agenda order, notes, meeting edits, cancellation and generated minutes, CAB meetings on the calendar, the portal's planned changes page and the CAB decisions report, six change tools), and the known error database (problems flagged as known errors with a status, workaround, root cause, permanent-fix change and linked incidents; a searchable Knowledge page for staff; matches suggested while an incident is raised or triaged and linked from the incident; customer-safe wording published to the portal with a notification to the organisation's users; counts on the problem list, the Knowledge overview and the management, NOC and customer dashboards; two reports; Grady's known_errors, get_known_error, match_known_errors, mark_known_error and publish_known_error), and customer satisfaction surveys (a one-question survey sent by email, WhatsApp and the portal when a ticket is resolved or closed, with one-click rating links that need no sign-in, a reminder and a closure resend, sampling and fatigue rules per customer or contract, the rating and comment on both ticket records, low-rating alerts to the account manager, team manager and assignee, CSAT on the management, AMC, engineer and customer dashboards, a Customer satisfaction page, two reports and the service review pack, and Grady's `csat_summary`, `csat_low_ratings`, `rate_ticket` and `send_survey`), and task boards for engineers (kanban lanes by status or by engineer over tickets and ticket tasks for my work, a team or one person; drag and drop that performs the record's own status, assignment and task transitions with a snap-back on refusal; WIP indicators per lane and per engineer; the team's current shift handover with acknowledgement and personal sticky notes beside the board; layout saved per person; Grady's `my_board`, `team_board` and `add_board_note`), software asset management (a shared software catalogue with publisher, version family, category and licence model; installations per CI, asset or user recorded by hand or by CSV import matched on asset tag, serial and host name; licence entitlements per customer with seats, metric, term, cost, contract and proof of purchase; a live compliance position per title and customer (compliant, under-deployed, over-deployed, unlicensed, unlimited) with stale-install and expiring-seat signals; a renewals view with notifications at 90, 30 and 7 days and on expiry, and an over-deployment alert; the portal software page for customer administrators; software inventory and licence compliance reports; Grady's software_inventory, software_compliance, licence_renewals, get_licence, record_licence and record_installation tools), and the custom report builder (an entity, column, filter, grouping and sort editor over a whitelisted field catalogue for tickets, changes, problems, SLA clocks, time entries, field visits, assets, configuration items, contracts, entitlements, surveys and software; live preview with summary tiles and a chart; saved reports that sit in the catalogue, run, export and schedule like built-in ones, shared privately, with roles or teams, or published to the portal with portal-safe fields only; row caps and a query time limit; deletion that retires a report and keeps its history; Grady's `report_catalog` and `build_report` and a "Describe it" box), and notification preferences (a per-person matrix on the profile, for staff and for customers under Account → Profile & notifications, of fifteen categories by email and WhatsApp that only ever removes a channel, with in-app always on and customer wording in the portal; the administrator's Notification defaults page with a default and a lock per category and channel; dispatch applying rule, default, person and opt-in for every recipient with an account; a mobile number proved with a one-time code over WhatsApp, one account per verified number, shown on the Users pages; Grady's `my_notification_preferences` and `set_notification_preference`), and Grady on WhatsApp (a verified number linked from the profile by a code sent to the phone or typed to the business number, the same assistant turn, tools, fences, confirmations and audit as the web rendered as WhatsApp text, yes/no confirmations, STOP and START from the phone, audiences, daily caps, an unknown-number reply, replies recorded in the outbox with delivery states, an admin card with readiness checks and the inbound log, revocation by administrators and customer administrators, and the `whatsapp_chat_status` tool), and one ticket vocabulary with drill-down links that reproduce their number (breached is the SLA the engine flagged and at risk a running clock it has warned on, on the ticket list, every dashboard, the customer overview and the reports; every dashboard tile, panel link and breakdown row opens the ticket list with the exact conditions its number was counted with, held by a guard test; the list's conditions read as a breadcrumb with a root chip, a "1–25 of 148 open incidents" count, an Any status chip and saved views as pills; list tiles that never move each other and never scroll the page).
2. **Now**: inbound email, SSO.
3. **Next**: Teams and SMS channels, portal preview.
4. **Later**: stockroom, more adapters, and organisation-level notification defaults that a customer administrator sets for their own users (today each person chooses on their profile and the customer administrator's lever is the opt-in of their users).

## Bugs found during the review

- Dashboard links to the ticket list dropped most of their filters (fixed this round).
- Approval steps run in parallel and ignore the all-or-any setting (listed above as P1).
- Service levels had no navigator entry (fixed).
- The field visit report was HTML served under a .pdf file name in the portal download (fixed: a real PDF when Chromium is installed, HTML under its own name otherwise).
- The portal reports endpoint and the portal ticket attachments endpoint exist but the portal uses the generic ones.

## Sources

- [SymphonyAI Summit product overview](https://www.getapp.com/it-management-software/a/summit/), [Summit on Software Advice](https://www.softwareadvice.com/it-management/summitai-profile), [SymphonyAI IT Service Management on TrustRadius](https://tr-web.dev.trustradius.com/products/symphony-summitai/reviews)
- [ServiceNow incident management](https://www.servicenow.com/products/incident-management.html), [ServiceNow ITSM Advanced release notes](https://www.servicenow.com/docs/r/store-release-notes/store-rn-itsm-advanced.html), [Key ServiceNow features in 2026](https://www.desk365.io/blog/servicenow-features/)
- [ServiceNow Employee Center Pro features](https://www.servicenow.com/docs/r/xGHm5nN1KlkEq58WJHJoPw/tzx9Xyvw3iAeHaE9OQ~Xkw), [Employee Center release notes](https://www.servicenow.com/docs/r/zurich/release-notes/employee-center-rn.html)
