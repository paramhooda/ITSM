import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import { customer, type DemoState } from './state';
import { addDays, addMinutes } from './rng';

interface ArticleSeed {
  key: string;
  title: string;
  summary: string;
  categoryKey: string;
  type: 'sop' | 'runbook' | 'troubleshooting' | 'faq' | 'known_error' | 'resolution' | 'procedure';
  domain: 'general' | 'noc' | 'soc' | 'amc' | 'service_desk';
  visibility: 'internal' | 'public' | 'customer';
  customerKey?: string;
  serviceKey?: string;
  ciTypeKey?: string;
  authorKey: string;
  reviewerKey: string;
  tags: string[];
  /** Ticket categories whose tickets are linked as related. */
  relatedCategories?: string[];
  versions?: number;
  ageDays: number;
  body: string;
}

const ARTICLES: ArticleSeed[] = [
  {
    key: 'p1_major_incident', title: 'SOP: Major incident (P1) handling', summary: 'Who does what in the first 60 minutes of a P1, the communication cadence and how the incident is closed out.', categoryKey: 'noc_procedures', type: 'sop', domain: 'noc', visibility: 'internal', authorKey: 'rajesh', reviewerKey: 'ananya', tags: ['p1', 'major-incident', 'communication'], relatedCategories: ['network', 'server'], versions: 3, ageDays: 210,
    body: `# Major incident (P1) handling

## Scope
Applies to every incident classified **P1 - Critical** or flagged *major*, for all customers.

## Roles
| Role | Who | Responsibility |
| --- | --- | --- |
| Incident manager | NOC shift lead | Owns the bridge, timeline and communication |
| Technical lead | Assigned engineer | Diagnosis and restoration |
| Communication lead | Service desk | Customer updates every 30 minutes |

## First 15 minutes
1. Acknowledge the ticket and set **Is major** on the record.
2. Open the incident bridge (Teams channel \`#mi-<ticket number>\`) and invite the customer escalation contact (level 1).
3. Confirm impact with the customer: sites, users, business processes.
4. Engage the technical lead; if hardware is suspected, pre-alert the field engineer on duty.

## Cadence
- Customer update every **30 minutes** on the ticket (public comment) and by phone to the escalation contact.
- Management update at 1 hour and 4 hours (service manager + head of managed services).
- Vendor case opened within 30 minutes when a vendor is involved (reference captured in *External ref*).

## Restoration and closure
1. Declare *restored* when service is confirmed by the customer; the restoration clock stops here.
2. Resolve the ticket with the resolution code and a summary written for the customer.
3. Produce the RCA within **2 business days** using the RCA template; link the problem record.
4. Close after customer confirmation or auto-close after 5 days.

> Never resolve a P1 without a customer-facing summary and a linked problem or change where follow-up is required.`,
  },
  {
    key: 'prtg_alert_triage', title: 'Runbook: PRTG alert triage', summary: 'How to triage PRTG Down / Warning / Unusual alarms, when a ticket is auto-created and how to acknowledge in PRTG.', categoryKey: 'runbooks', type: 'runbook', domain: 'noc', visibility: 'internal', serviceKey: 'noc_monitoring', authorKey: 'priya', reviewerKey: 'rajesh', tags: ['prtg', 'monitoring', 'triage'], relatedCategories: ['availability', 'performance'], versions: 2, ageDays: 150,
    body: `# PRTG alert triage

## How alarms reach the platform
The PRTG core server posts HTTP notifications to \`/api/integrations/prtg/events\`. The integration matches the device to a CI by **monitoring reference** (PRTG device id), then hostname, then IP. Rules on the integration decide whether a ticket is created:

- \`Down\` → P2 incident (P1 when the CI is *critical* and the customer has a 24x7 policy)
- \`Down (Partial)\` → P3
- \`Warning\` / \`Unusual\` → P4, or ignored when below the auto-create threshold

Duplicate alarms inside the 30-minute dedupe window are attached to the open ticket.

## Triage steps
1. Open the ticket from the NOC queue; the matched CI and the last 10 events are on the **Integration** tab.
2. Check the device from the NOC jump host:
   \`\`\`
   ping -c 4 <ip>
   snmpwalk -v2c -c <community> <ip> sysUpTime
   \`\`\`
3. If the device responds, check the sensor that fired (interface errors, disk free, service state) and the device log for a reboot.
4. If the device is down, check the upstream switch port (\`show interface status\`) and power (UPS sensor on the same site).
5. Update the ticket with a first response within the SLA; set *pending vendor* when an ISP or OEM case is opened.

## Acknowledging in PRTG
Acknowledge the alarm in PRTG with the ticket number as the message so the sensor stops re-notifying; the integration mirrors the acknowledgement to the ticket.`,
  },
  {
    key: 'switch_unreachable', title: 'Troubleshooting: switch unreachable (Cisco Catalyst)', summary: 'Decision tree for an unreachable access or core switch, from console access to RMA.', categoryKey: 'troubleshooting', type: 'troubleshooting', domain: 'noc', visibility: 'internal', serviceKey: 'network_management', ciTypeKey: 'network_switch', authorKey: 'priya', reviewerKey: 'rajesh', tags: ['cisco', 'switch', 'outage'], relatedCategories: ['network'], ageDays: 180,
    body: `# Switch unreachable

## 1. Confirm scope
- Is only management unreachable (SVI) or is traffic also down? Ask the site contact whether users are affected.
- Check neighbours: \`show cdp neighbors\` / \`show lldp neighbors\` on the upstream device.

## 2. Console / out-of-band
Connect through the site console server (\`ssh noc@<site>-cons01\`, port = stack position).
- **ROMMON prompt**: boot failed. Run \`boot flash:packages.conf\` (install mode) or \`boot flash:<image>.bin\`.
- **Boot loop**: check PSU LEDs; a brownout can leave the switch in a loop. Power-cycle with one PSU removed.
- **No console output**: suspect the power supply or the supervisor; proceed to RMA.

## 3. Common fixes
| Symptom | Fix |
| --- | --- |
| Stack split (two masters) | Reload the lower-priority member; verify \`show switch\` |
| High CPU, management slow | \`show processes cpu sorted\`; look for ARP storms, disable the offending port |
| Port errors (CRC) | Replace SFP/fibre; verify with \`show interface <x> counters errors\` |

## 4. RMA
Open the TAC case with \`show tech\` from the console and the serial number from the asset record. Pre-configure the cold spare from the configuration backup (\`/backups/network/<hostname>/latest.cfg\`) before dispatching the field engineer.`,
  },
  {
    key: 'veeam_vss', title: 'Known error: Veeam backup fails with VSS snapshot timeout', summary: 'VSS freeze timeouts on Windows guests when antivirus scans overlap the backup window; workaround and permanent fix.', categoryKey: 'known_errors', type: 'known_error', domain: 'noc', visibility: 'internal', serviceKey: 'backup_management', ciTypeKey: 'backup_system', authorKey: 'arjun', reviewerKey: 'rajesh', tags: ['veeam', 'vss', 'backup'], relatedCategories: ['backup'], versions: 2, ageDays: 95,
    body: `# Veeam: "VSSControl: Failed to freeze guest, wait timeout"

## Symptoms
- Job fails on the first attempt with the VSS timeout; retries usually succeed.
- Affected guests are SQL or file servers with the antivirus full scan scheduled at 02:00.

## Root cause
The antivirus full scan increases the VSS freeze time beyond the 60-second default timeout.

## Workaround
Rerun the failed job after 04:00, or temporarily disable the AV scan for the guest:
\`\`\`powershell
Set-MpPreference -ScanScheduleTime 22:00
\`\`\`

## Permanent fix
1. Move the AV full scan to 22:00 on all guests in the job.
2. Add the Veeam agent and VSS writer processes to the AV exclusions.
3. Verify \`vssadmin list writers\` shows all writers *Stable* before the next run.

Tracked as problem **PRB** (linked). Apply the fix through the standard change for each customer.`,
  },
  {
    key: 'phishing_response', title: 'SOP: Phishing report handling', summary: 'Steps for reported phishing emails: purge, block, check for compromise and close the loop with the reporter.', categoryKey: 'soc_procedures', type: 'sop', domain: 'soc', visibility: 'internal', serviceKey: 'security_monitoring', authorKey: 'sneha', reviewerKey: 'sneha', tags: ['phishing', 'email', 'soc'], relatedCategories: ['phishing'], ageDays: 160,
    body: `# Phishing report handling

## Intake
Reports arrive via the portal (category *Phishing*), the report-phishing button or the SIEM email security feed. Classify severity:
- **Medium**: credential harvesting link, no evidence of submission
- **High**: user submitted credentials or opened an attachment
- **Critical**: payload executed (see the malware SOP)

## Steps
1. Capture headers and the URL in a work note (defang: \`hxxps://\`).
2. Search and purge the message from all mailboxes (Microsoft 365 content search → *Purge*).
3. Block the sender domain and URL on the email gateway and the firewall web filter.
4. Check proxy and identity logs for clicks and successful sign-ins; if credentials were submitted:
   - reset the password, revoke sessions and tokens;
   - review mailbox rules for forwarding/deletion rules.
5. Reply to the reporter with the outcome and thank them (public comment).
6. Close with resolution code *Fixed* or *No fault found* for benign reports.

## Metrics
Reporter feedback within 4 business hours; purge within 1 hour for High and above.`,
  },
  {
    key: 'ransomware_playbook', title: 'Runbook: Ransomware containment', summary: 'Immediate containment, evidence preservation and recovery steps for ransomware indicators detected by the EDR or SIEM.', categoryKey: 'soc_procedures', type: 'runbook', domain: 'soc', visibility: 'internal', serviceKey: 'security_monitoring', authorKey: 'karan', reviewerKey: 'sneha', tags: ['ransomware', 'ir', 'edr'], relatedCategories: ['malware'], versions: 2, ageDays: 120,
    body: `# Ransomware containment

**Treat as P1 / major incident. Engage the SOC incident commander immediately.**

## Contain (first 15 minutes)
1. Isolate the host in the EDR console (*Network isolation*). Do **not** power off - memory is evidence.
2. Disable the affected user account and any service accounts seen in the EDR timeline.
3. Block the C2 indicators on the firewall and DNS filter.
4. If a file share is affected, take it offline (remove the share) to stop encryption spreading.

## Investigate
- Pull the EDR process tree and identify the initial access (email attachment, RDP, USB).
- Collect: EDR timeline export, firewall logs for the host, mail trace for the user.
- Identify the ransomware family from the note / extension (ID Ransomware).

## Recover
1. Re-image the host from the golden image; do not clean in place.
2. Restore affected shares from the last clean backup; verify the restore point predates the first encrypted file.
3. Rotate credentials for every account that logged on to the host in the last 7 days.
4. Re-enable the host only after a full EDR scan and SOC sign-off.

## Report
Deliver the incident report within 2 business days: timeline, scope, root cause, actions, lessons learned.`,
  },
  {
    key: 'siem_rule_tuning', title: 'Procedure: FortiSIEM rule tuning and false-positive handling', summary: 'When and how to tune SIEM rules, with the approval and documentation required.', categoryKey: 'soc_procedures', type: 'procedure', domain: 'soc', visibility: 'internal', serviceKey: 'security_monitoring', authorKey: 'fatima', reviewerKey: 'sneha', tags: ['fortisiem', 'tuning'], relatedCategories: ['suspicious_activity'], ageDays: 75,
    body: `# FortiSIEM rule tuning

## When to tune
- The same rule fires more than 5 times a week for confirmed benign activity.
- A legitimate business process triggers a detection (e.g. backup replication flagged as exfiltration).

## Procedure
1. Document the false positive in the ticket: rule name, source, destination, business justification from the customer.
2. Get written confirmation from the customer ISO (public comment or email attached to the ticket).
3. Prefer an **exception** (source/destination/time window) over disabling the rule.
4. Record the exception in the customer's tuning register (knowledge article per customer) with an expiry date (max 12 months).
5. Review exceptions in the monthly SOC report.

## Never
- Disable rules mapped to critical MITRE techniques (T1486, T1021, T1078) without SOC manager approval.`,
  },
  {
    key: 'pm_checklist', title: 'SOP: Preventive maintenance visit checklist', summary: 'Standard PM checklist for server rooms under AMC, with acceptance criteria and reporting requirements.', categoryKey: 'amc_procedures', type: 'sop', domain: 'amc', visibility: 'internal', serviceKey: 'preventive_maintenance', authorKey: 'suresh', reviewerKey: 'ananya', tags: ['pm', 'amc', 'checklist'], relatedCategories: ['preventive_maintenance'], versions: 2, ageDays: 200,
    body: `# Preventive maintenance visit

## Before the visit
- Confirm the date with the site contact at least **14 days** ahead (PM program lead time).
- Download the asset list for the site and the previous PM report.
- Carry: ESD kit, replacement filters, label printer, spare patch cords, laptop with console cable.

## Checklist
| # | Item | Acceptance |
| --- | --- | --- |
| 1 | Racks, cabling, labelling | No unlabelled cords; cable management intact |
| 2 | Filters and airflow | Inlet temperature 18-27 C; filters cleaned |
| 3 | UPS runtime test | Runtime >= 80% of specification at current load |
| 4 | Firmware baseline | Versions match the customer baseline or a change is raised |
| 5 | RAID / disk health | No degraded arrays; predictive failures logged as tickets |
| 6 | Backup status | Last 7 jobs successful; test restore of one file |
| 7 | Switch ports | No interfaces with rising error counters |
| 8 | Asset register | Serials, locations and photos updated |

## After the visit
1. Complete the checklist on the field visit with findings and recommendations.
2. Obtain the customer acknowledgement (name, title, signature or rating) on the visit.
3. Generate the PM report; the service manager reviews before it is shared through the portal.
4. Any defect found becomes an incident linked to the visit.`,
  },
  {
    key: 'amc_part_replacement', title: 'Procedure: Hardware part replacement under AMC', summary: 'Entitlement checks, OEM case handling and documentation for part replacements under an AMC contract.', categoryKey: 'amc_procedures', type: 'procedure', domain: 'amc', visibility: 'internal', serviceKey: 'amc_support', authorKey: 'neha', reviewerKey: 'lakshmi', tags: ['amc', 'rma', 'parts'], relatedCategories: ['hardware_support', 'breakdown_support'], ageDays: 140,
    body: `# Part replacement under AMC

## Check entitlement first
1. Open the asset: confirm the AMC contract and that today is inside the AMC dates.
2. On the contract, check the **Hardware replacements** entitlement - remaining quantity and whether overage is allowed.
3. Verify the scope: the device type must be an in-scope item (batteries and consumables are excluded by default).

If the asset is out of AMC, inform the customer and get approval for a billable replacement before dispatch.

## OEM / spares
- Devices under OEM warranty: open the OEM case and attach the case number to the ticket (*External ref*).
- Otherwise use the spares pool; raise a replenishment request when a spare is consumed.

## On site
1. Record the part number and serial of the removed and installed part on the field visit (**Parts** tab).
2. Update the asset's serial number if the whole unit was replaced; link the new serial to the CI.
3. Consume the entitlement from the field visit (quantity 1 per replacement).

## Close out
Resolution code *Hardware replaced*; attach the OEM RMA shipping label for the faulty part.`,
  },
  {
    key: 'portal_raise_ticket', title: 'How to raise and track a ticket in the customer portal', summary: 'Step-by-step guide for customer users: raising incidents and requests, attachments, approvals and reopening.', categoryKey: 'faq', type: 'faq', domain: 'general', visibility: 'public', authorKey: 'rohan', reviewerKey: 'ananya', tags: ['portal', 'getting-started'], ageDays: 220,
    body: `# Raising and tracking tickets in the portal

## Raising an incident
1. Sign in to the portal and choose **New ticket → Report an issue**.
2. Pick the affected site and, if known, the device from the list.
3. Describe what is not working, since when and how many people are affected - this sets the priority.
4. Attach screenshots or error messages.

## Requesting something
Use **New ticket → Request** and pick a catalog item (access, new user, software, firewall change...). Some requests need approval from your organisation's administrator before we start.

## Following progress
- Every update by our engineers is visible on the ticket timeline; you receive an email as well.
- The **SLA** panel shows the response and resolution targets for your contract.
- You can add comments at any time; replying to the email also adds a comment.

## When the ticket is resolved
We mark the ticket *Resolved* with a summary. If the issue persists, use **Reopen** within 14 days; otherwise the ticket closes automatically after 5 days.`,
  },
  {
    key: 'priority_matrix_faq', title: 'FAQ: How ticket priority is decided', summary: 'The impact x urgency matrix and what each priority means for response and resolution.', categoryKey: 'faq', type: 'faq', domain: 'general', visibility: 'public', authorKey: 'ananya', reviewerKey: 'ananya', tags: ['priority', 'sla'], ageDays: 230,
    body: `# How priority is decided

Priority is calculated from **impact** (how much of the organisation is affected) and **urgency** (how quickly it must be fixed).

| Impact \\ Urgency | High | Medium | Low |
| --- | --- | --- | --- |
| High (site / organisation) | P1 | P2 | P3 |
| Medium (department) | P2 | P3 | P4 |
| Low (single user) | P3 | P4 | P4 |

## What the priorities mean (Standard SLA)
- **P1** - complete outage of a critical service: response 30 min, restore 4 h, resolve 8 h, 24x7.
- **P2** - major degradation: response 1 h, resolve 24 h, 24x7.
- **P3** - limited impact, workaround available: response 4 business hours, resolve 1 business day.
- **P4** - minor: response 8 business hours, resolve 2 business days.

Premium contracts run every priority on a 24x7 clock with tighter targets. Your contract page in the portal shows the policy that applies to you.`,
  },
  {
    key: 'vpn_tunnel_down', title: 'Troubleshooting: FortiGate IPsec tunnel down', summary: 'Phase 1 / phase 2 diagnostics for site-to-site tunnels after firmware upgrades or ISP changes.', categoryKey: 'troubleshooting', type: 'troubleshooting', domain: 'noc', visibility: 'internal', serviceKey: 'network_management', ciTypeKey: 'firewall', authorKey: 'priya', reviewerKey: 'rajesh', tags: ['fortigate', 'ipsec', 'vpn'], relatedCategories: ['network', 'connectivity'], ageDays: 110,
    body: `# IPsec tunnel down (FortiGate)

## Quick checks
\`\`\`
diagnose vpn ike gateway list name <tunnel>
diagnose vpn tunnel list name <tunnel>
get router info routing-table all | grep <remote subnet>
\`\`\`

## Phase 1 fails
- Peer unreachable: check the WAN interface and the ISP (ping the peer public IP).
- *No proposal chosen*: compare IKE version, encryption, DH group and lifetimes on both ends. Firmware upgrades change defaults (7.4 removed DH group 5).
- *Invalid ID*: local/remote ID mismatch on the dialup side.

## Phase 2 fails
- Selector mismatch: the phase 2 quick-mode selectors must mirror each other.
- *Replay detected*: clock drift - verify NTP.

## Traffic not flowing with tunnel up
- Missing route or policy: a static route to the remote subnet via the tunnel interface and firewall policies in both directions.
- Overlapping subnets: use NAT on one side.

Document the final working proposals in the customer's network baseline article.`,
  },
  {
    key: 'esxi_disconnect', title: 'Known error: ESXi host disconnects from vCenter (hostd memory leak)', summary: 'ESXi 8.0 U2 hosts with the i40en driver disconnect from vCenter every ~2 weeks; agent restart restores management.', categoryKey: 'known_errors', type: 'known_error', domain: 'noc', visibility: 'internal', serviceKey: 'virtualization_management', ciTypeKey: 'hypervisor', authorKey: 'deepak', reviewerKey: 'rajesh', tags: ['vmware', 'esxi', 'hostd'], relatedCategories: ['virtualization'], ageDays: 60,
    body: `# ESXi host "Not responding" in vCenter

## Symptoms
Host shows *Not responding*; VMs keep running; \`hostd\` memory usage above 1.5 GB in \`esxtop\`.

## Workaround
\`\`\`
/etc/init.d/hostd restart
/etc/init.d/vpxa restart
\`\`\`
Reconnect the host in vCenter afterwards. No VM impact.

## Permanent fix
Upgrade to ESXi 8.0 U3 (VMware KB 93423). Raise a normal change per customer; use the cluster rolling upgrade with DRS in fully automated mode.

## Monitoring
A PRTG sensor on \`hostd\` memory (threshold 1.2 GB) warns before the disconnect so the restart can be done proactively.`,
  },
  {
    key: 'storage_capacity', title: 'Procedure: Storage capacity management (NetApp / Dell PowerStore)', summary: 'Thresholds, snapshot housekeeping and volume extension procedure with customer approval points.', categoryKey: 'noc_procedures', type: 'procedure', domain: 'noc', visibility: 'internal', serviceKey: 'storage_management', ciTypeKey: 'storage_array', authorKey: 'arjun', reviewerKey: 'rajesh', tags: ['storage', 'capacity'], relatedCategories: ['storage'], ageDays: 130,
    body: `# Storage capacity management

## Thresholds
| Level | Volume used | Action |
| --- | --- | --- |
| Warning | 80% | Review snapshot reserve and growth trend |
| Critical | 90% | Ticket auto-created (P4); extend within 5 business days |
| Emergency | 95% | P3; extend immediately, inform the customer |

## Housekeeping before extending
1. \`volume snapshot show -volume <vol>\` - delete snapshots older than the policy retention.
2. Check for orphaned LUNs and old VM templates on the datastore.
3. Verify the aggregate has free space; otherwise plan a shelf expansion (normal change).

## Extending a volume (ONTAP)
\`\`\`
volume modify -vserver <svm> -volume <vol> -size +500G
volume show -volume <vol> -fields size,used,percent-used
\`\`\`
Customer approval is required when the extension exceeds the committed capacity in the contract. Record the new size in the CI attributes (capacityTb).`,
  },
  {
    key: 'ups_runtime', title: 'Troubleshooting: UPS on battery and runtime alarms (APC)', summary: 'What to do when a site UPS goes on battery, including the shutdown sequence and generator coordination.', categoryKey: 'troubleshooting', type: 'troubleshooting', domain: 'noc', visibility: 'internal', serviceKey: 'noc_monitoring', ciTypeKey: 'ups', authorKey: 'arjun', reviewerKey: 'rajesh', tags: ['ups', 'power', 'apc'], relatedCategories: ['hardware'], ageDays: 170,
    body: `# UPS on battery

## Immediate actions
1. Note the estimated runtime from the UPS sensor (PRTG *UPS Runtime*).
2. Call the site facilities contact (contract escalation matrix) to confirm the utility status and generator.
3. If runtime < 10 minutes and no generator: start the **graceful shutdown sequence**:
   - VMs (non-critical first) via vCenter
   - ESXi hosts
   - storage array (\`system node halt\` / PowerStore shutdown from the manager)
   - network devices last

## After power returns
- Start in reverse order; verify datastores mount before powering on VMs.
- Check the UPS event log for the transfer reason and the battery health.
- Update the ticket with the outage window for the customer's records.

## Preventive
Battery replacement is **excluded** from AMC; issue a quotation when the runtime test is below 80% of specification.`,
  },
  {
    key: 'abc_gur_access', title: 'ABC Manufacturing - Gurgaon plant access and site procedures', summary: 'Site access, safety induction, shift timings and plant contacts for engineers visiting the Gurgaon plant.', categoryKey: 'customer_procedures', type: 'procedure', domain: 'amc', visibility: 'customer', customerKey: 'abc', authorKey: 'suresh', reviewerKey: 'ananya', tags: ['abc', 'site-access', 'gurgaon'], ageDays: 190,
    body: `# ABC Manufacturing - Gurgaon plant

## Access
- Gate 2 security desk; carry a government ID and the visit confirmation (field visit number).
- Safety induction (20 minutes) is mandatory for first visits; safety shoes and vest provided at the gate.
- Server room keys are held by the shift IT executive; sign the server room register on entry and exit.

## Timings
Production runs in 3 shifts. Network changes on the plant VLANs (VLAN 20/21) require approval from the plant head and are done between **13:00 and 14:00** (shift change) or on Sunday mornings.

## Contacts
| Role | Name | Note |
| --- | --- | --- |
| IT executive (shift) | Pooja Deshmukh | First call for site access |
| Plant head | Sanjay Bhatt | Approves production network changes |
| IT manager | Manish Agarwal | Escalation level 1 |

## Equipment notes
- The core switch stack is in rack R1; the OOB console server is reachable at \`abc-gur-cons01\` through the MPLS management VLAN.
- Spare SFPs and patch cords are in the cabinet drawer (inventory sheet inside).`,
  },
  {
    key: 'meridian_change_windows', title: 'Meridian Bank - change windows and DR site rules', summary: 'Approved change windows, CAB requirements and DR site procedures for Meridian Bank.', categoryKey: 'customer_procedures', type: 'procedure', domain: 'noc', visibility: 'customer', customerKey: 'meridian', authorKey: 'rajesh', reviewerKey: 'ananya', tags: ['meridian', 'change', 'dr'], ageDays: 160,
    body: `# Meridian Bank - change windows

## Windows
| Scope | Window | Approval |
| --- | --- | --- |
| Branch network | Mon-Sat 20:00-06:00 | CAB |
| Head office servers | Sat 22:00 - Sun 06:00 | CAB + bank CIO office |
| DR site | Sunday 02:00-06:00 | CAB + DR coordinator (Kavita Joshi) |
| Emergency security patch | Any time | SOC manager + bank ISO (phone) |

## Requirements
- Every change needs a backout plan validated on the DR replica before approval.
- Evidence (before/after configs, test results) is attached to the change for the quarterly RBI audit.
- No changes during month-end (last 2 business days) or quarter-end week.

## DR site specifics
- Replication status (\`snapmirror show\`) must be *Idle / InSync* before and after any storage change.
- Rack access at the data center needs a 24-hour-ahead access request through the colo portal; the DR coordinator submits it.`,
  },
  {
    key: 'sterling_maintenance', title: 'Sterling Hospitals - maintenance windows and clinical sign-off', summary: 'Rules for working on hospital infrastructure: ICU sign-off, PACS/HIS freeze and after-hours windows.', categoryKey: 'customer_procedures', type: 'procedure', domain: 'noc', visibility: 'customer', customerKey: 'sterling', authorKey: 'neha', reviewerKey: 'ananya', tags: ['sterling', 'healthcare'], ageDays: 100,
    body: `# Sterling Hospitals - maintenance rules

- Maintenance windows: **02:00-05:00** daily; ICU and OT areas need written sign-off from the COO office (Dr. Meenakshi Sundaram) for any network change on the clinical VLAN.
- HIS and PACS are life-critical: any change touching \`stl-main-app01\`, \`stl-main-db01\` or the PACS storage volume is a **normal change with CAB** - never a standard change.
- Printing in wards depends on the print server; treat printer-related incidents in wards as P2.
- Biomedical devices (monitors, infusion pumps) are **out of scope**; refer to the biomedical team through Lavanya Krishnan.
- The on-site engineer must wear the hospital visitor badge and follow infection-control instructions in clinical areas.`,
  },
  {
    key: 'office365_outlook', title: 'Troubleshooting: Outlook "Trying to connect" / autodiscover issues', summary: 'Service desk guide for Outlook connectivity problems with Microsoft 365.', categoryKey: 'troubleshooting', type: 'troubleshooting', domain: 'service_desk', visibility: 'public', serviceKey: 'end_user_support', authorKey: 'meera', reviewerKey: 'ananya', tags: ['outlook', 'm365', 'service-desk'], relatedCategories: ['email_collab'], ageDays: 85,
    body: `# Outlook "Trying to connect"

## Quick checks (user)
1. Does webmail work? If yes, the mailbox is fine; the problem is the client or the network path.
2. Hold **Ctrl** and right-click the Outlook tray icon → *Test E-mail AutoConfiguration*; untick Guessmart and run.

## Common causes
| Cause | Fix |
| --- | --- |
| Proxy/PAC blocking autodiscover | Add \`autodiscover.<domain>\` and \`outlook.office365.com\` to the PAC exceptions |
| Corrupt profile | Create a new profile from *Control Panel → Mail* |
| Cached credentials | Remove Office entries in Credential Manager, sign in again |
| Modern auth disabled | Check the registry \`EnableADAL\` and the tenant setting |

## Escalate when
More than one user at a site is affected at the same time (likely network/proxy) - raise to the NOC with the site and a traceroute to \`outlook.office365.com\`.`,
  },
  {
    key: 'new_user_onboarding', title: 'Procedure: New user onboarding (service desk)', summary: 'Account creation, licensing, device enrolment and handover steps for the New User Onboarding catalog item.', categoryKey: 'runbooks', type: 'runbook', domain: 'service_desk', visibility: 'internal', serviceKey: 'end_user_support', authorKey: 'rohan', reviewerKey: 'ananya', tags: ['onboarding', 'intune', 'service-desk'], relatedCategories: ['access'], ageDays: 140,
    body: `# New user onboarding

Triggered by the **New User Onboarding** catalog item after customer approval.

1. **Identity**: create the AD user from the department template (\`New-ADUser\` script), add to the department groups, sync to Entra ID.
2. **Mailbox and licences**: assign the licence bundle defined for the customer (E3 / Business Premium); verify the mailbox provisions.
3. **Device** (when *Laptop required* is set): take a laptop from stock, record the asset against the user (assigned contact), enrol in Intune with the customer's Autopilot profile.
4. **Applications**: deploy the department application set; confirm VPN/MFA enrolment instructions.
5. **Handover**: send credentials to the manager (never to the new user's personal email); schedule a 15-minute welcome call on day one.
6. Fulfil the request with the checklist completed; the asset record and the CI (if the device is monitored) are linked to the ticket.`,
  },
  {
    key: 'firewall_rule_request', title: 'Procedure: Firewall rule change requests', summary: 'Standards for implementing customer firewall change requests: least privilege, logging, documentation and testing.', categoryKey: 'noc_procedures', type: 'procedure', domain: 'noc', visibility: 'internal', serviceKey: 'network_management', ciTypeKey: 'firewall', authorKey: 'priya', reviewerKey: 'sneha', tags: ['firewall', 'change', 'policy'], relatedCategories: ['firewall', 'network'], ageDays: 115,
    body: `# Firewall rule changes

## Before implementing
- The request must come from an authorised contact (customer admin) through the **Configuration Request** catalog item and be approved.
- Reject *any/any* rules; ask for source, destination, port and business justification.
- Inbound rules exposing services require the SOC review (IPS profile, geo restrictions, logging to SIEM).

## Implementation standard
- Address objects named \`<customer>-<purpose>-<n>\`; policies named after the ticket number.
- Logging enabled on every policy (all sessions for inbound).
- Configuration backup before and after; attach the diff to the ticket.

## Testing
Test with the requester on the call; record the test result in the ticket. Temporary rules get an expiry comment and a task to remove them.`,
  },
  {
    key: 'cloud_ec2_recovery', title: 'Runbook: AWS EC2 instance failed status checks', summary: 'Recovery steps and preventive settings for EC2 instances failing system or instance status checks.', categoryKey: 'runbooks', type: 'runbook', domain: 'noc', visibility: 'internal', serviceKey: 'cloud_support', ciTypeKey: 'cloud_resource', authorKey: 'deepak', reviewerKey: 'rajesh', tags: ['aws', 'ec2', 'cloud'], relatedCategories: ['cloud'], ageDays: 90,
    body: `# EC2 failed status checks

## System status check failed (AWS hardware)
\`\`\`
aws ec2 stop-instances --instance-ids <id>
aws ec2 start-instances --instance-ids <id>
\`\`\`
A stop/start migrates the instance to healthy hardware (EBS-backed only). Verify the application after the restart.

## Instance status check failed (guest OS)
- Check the system log: \`aws ec2 get-console-output --instance-id <id>\`
- Common causes: full root volume, kernel panic after an update, misconfigured network.
- Use the EC2 serial console or attach the volume to a rescue instance to repair.

## Prevent
- Enable the *auto-recovery* CloudWatch alarm on all production instances.
- Keep root volumes with at least 20% free; alarm at 85%.
- Tag instances with \`customer\` and \`service\` so alarms map to the right ticket queue.`,
  },
  {
    key: 'entitlement_tracking', title: 'FAQ: How AMC visits and support hours are tracked', summary: 'For customers: how entitlements are consumed by visits and time entries, and where to see the balance.', categoryKey: 'faq', type: 'faq', domain: 'amc', visibility: 'public', authorKey: 'lakshmi', reviewerKey: 'ananya', tags: ['amc', 'entitlements', 'portal'], ageDays: 180,
    body: `# Entitlements: visits and hours

Your contract page in the portal lists the entitlements included (for example *12 breakdown site visits per year* or *200 remote support hours per year*).

- **Site visits** are consumed when a field visit is completed and acknowledged.
- **PM visits** are consumed by completed preventive maintenance occurrences.
- **Support hours** are consumed by time logged on your tickets; the engineer records the minutes and the work type.
- **Hardware replacements** are consumed per replaced part under the AMC.

The balance is shown per period (yearly / quarterly) with a warning when 80% is used; your account manager is notified at the same time. Consumption beyond the entitlement is billed at the overage rate in the contract unless overage is disabled.`,
  },
  {
    key: 'sla_pause_rules', title: 'FAQ: Which statuses pause the SLA clock', summary: 'Explains the statuses that pause SLA clocks and how pauses affect the due date.', categoryKey: 'faq', type: 'faq', domain: 'general', visibility: 'internal', authorKey: 'ananya', reviewerKey: 'ananya', tags: ['sla', 'status'], ageDays: 205,
    body: `# SLA clocks and pausing statuses

The following statuses pause the response and resolution clocks:
- **Pending customer** - waiting for information or action from the customer.
- **Pending vendor** - waiting for an ISP / OEM / software vendor.
- **On hold** - agreed hold with the customer.
- **Awaiting approval** - requests and changes waiting for an approval decision.

When the ticket leaves a pausing status, the paused working time is added to the target, and the due date moves accordingly. Pauses are recorded as events on the SLA panel and in the ticket timeline.

> Use pending statuses only when the ball is genuinely in someone else's court. Always add a customer-visible comment explaining what is awaited.`,
  },
  {
    key: 'wifi_disconnects', title: 'Known error: Wireless disconnects in warehouses (DFS channels)', summary: 'Handheld scanners drop when access points change channel on radar detection; pin non-DFS channels and add coverage.', categoryKey: 'known_errors', type: 'known_error', domain: 'noc', visibility: 'internal', serviceKey: 'network_management', ciTypeKey: 'access_point', authorKey: 'priya', reviewerKey: 'rajesh', tags: ['wifi', 'dfs', 'aruba'], relatedCategories: ['network'], ageDays: 70,
    body: `# Wireless disconnects on DFS channel changes

## Symptoms
Clients drop for 10-20 seconds several times a day; controller logs show *radar detected, channel change* on 5 GHz radios.

## Workaround
- Pin the APs in the affected area to non-DFS channels (36-48, 149-165).
- Set handheld scanners to prefer 2.4 GHz while the fix is pending.

## Permanent fix
Increase AP density in the loading bay (two additional APs) and enable **802.11r** fast roaming on the corporate SSID. Validate with a roaming walk test (< 50 ms handoff).`,
  },
  {
    key: 'rca_template', title: 'Template: Root cause analysis (RCA) report', summary: 'Structure for the customer-facing RCA delivered after P1 incidents and problem closures.', categoryKey: 'noc_procedures', type: 'procedure', domain: 'general', visibility: 'internal', authorKey: 'rajesh', reviewerKey: 'ananya', tags: ['rca', 'template', 'problem'], ageDays: 215,
    body: `# RCA report template

1. **Summary** - one paragraph: what happened, who was affected, for how long.
2. **Timeline** - table of detection, response, escalation, restoration and resolution (UTC and local time).
3. **Impact** - services, sites, users; SLA status (met/breached with minutes).
4. **Root cause** - the technical cause and the contributing factors (process, monitoring, change).
5. **Resolution** - what restored service; what fixes it permanently.
6. **Preventive actions** - owner, due date, ticket/change reference for each action.
7. **Lessons learned** - what worked, what did not.

Attach the RCA to the problem record and share through the portal within 2 business days for P1 incidents.`,
  },
  {
    key: 'apex_store_support', title: 'Apex Retail - store support procedure', summary: 'How store incidents are handled: POS priority, store hours, spare switch logistics and store contacts.', categoryKey: 'customer_procedures', type: 'procedure', domain: 'service_desk', visibility: 'customer', customerKey: 'apex', authorKey: 'meera', reviewerKey: 'ananya', tags: ['apex', 'retail', 'pos'], ageDays: 95,
    body: `# Apex Retail - store support

- Stores operate **10:00-22:00 including weekends**; support hours for the network contract are Mon-Sat 08:00-20:00 (extended hours calendar).
- POS outage at a store = **P2** (revenue impacting); escalate to the store operations manager (Prakash Shetty) if not restored within 2 hours.
- Each store has one access switch and one AP; a pre-configured spare switch is kept at the head office stock room. The field engineer (Amit Joshi) can be at any Bengaluru store within 2 hours.
- ISP issues at stores are **out of scope**: log the ticket, run diagnostics, and hand over to the store's ISP with the circuit ID from the router CI.
- End user issues (POS client, Office, printers) go to the service desk under the End User Support contract.`,
  },
  {
    key: 'edr_stale_agents', title: 'Procedure: EDR stale agent handling', summary: 'Monthly hygiene for endpoints that stop reporting to the EDR console.', categoryKey: 'soc_procedures', type: 'procedure', domain: 'soc', visibility: 'internal', serviceKey: 'security_monitoring', ciTypeKey: 'endpoint', authorKey: 'fatima', reviewerKey: 'sneha', tags: ['edr', 'endpoint', 'hygiene'], relatedCategories: ['endpoint_security'], ageDays: 50,
    body: `# EDR stale agents

1. Export the *not seen in 14+ days* list from the EDR console on the first business day of the month.
2. Match against the CMDB: retired or disposed assets are removed from the console; active assets get a ticket (category *Endpoint security*, P4).
3. For active devices: check with the user (laptop in a drawer, on leave) and repair the agent:
   \`\`\`
   sc query <agent service>
   <installer>.exe /repair /quiet
   \`\`\`
4. Devices not seen for 60+ days without a reason are disabled in AD and reported to the customer ISO.`,
  },
  {
    key: 'crestline_uk_hours', title: 'Crestline Hotels - UK support hours and escalation', summary: 'Support hours, holidays and escalation for the UK hotel group supported remotely.', categoryKey: 'customer_procedures', type: 'procedure', domain: 'noc', visibility: 'customer', customerKey: 'crestline', authorKey: 'rohan', reviewerKey: 'ananya', tags: ['crestline', 'uk'], ageDays: 120,
    body: `# Crestline Hotels - support notes

- Support runs on **UK business hours (Mon-Fri 09:00-17:30 London)**; the SLA calendar for the contract is *UK Business Hours*. UK bank holidays are not working days.
- Head office hosts the Opera PMS; Opera application support is provided by the vendor, we support the infrastructure (servers, network, backups).
- Hotel front desks operate 24x7: a front-desk network outage outside support hours is logged and worked on a best-effort basis; call-out is billable.
- Escalation: James Whitfield (level 1), Emily Carter for day-to-day coordination.
- Time zone reminder: tickets show times in the viewer's time zone; coordinate maintenance in UK time.`,
  },
];

export async function seedKnowledge(state: DemoState, tx: Tx) {
  const { refs, rng, now } = state;
  const res = await tx.execute(sql`SELECT nextval('kb_article_seq')::int AS n FROM generate_series(1, ${ARTICLES.length})`);
  const numbers = (res.rows as { n: number }[]).map((r) => `KB-${String(r.n).padStart(6, '0')}`);
  const tickets = [...state.tickets.values()];
  for (const [i, a] of ARTICLES.entries()) {
    const author = state.users.get(a.authorKey)!;
    const reviewer = state.users.get(a.reviewerKey)!;
    const createdAt = addDays(now, -a.ageDays);
    const versions = a.versions ?? 1;
    const publishedAt = addDays(createdAt, rng.int(1, 5));
    const updatedAt = versions > 1 ? addDays(publishedAt, rng.int(10, Math.max(11, a.ageDays - 10))) : publishedAt;
    const related = a.relatedCategories?.length ? rng.sample(tickets.filter((t) => a.relatedCategories!.includes(t.categoryKey) && (!a.customerKey || t.customerKey === a.customerKey)), rng.int(1, 3)).map((t) => t.id) : [];
    const [row] = await tx
      .insert(schema.kbArticles)
      .values({
        number: numbers[i]!,
        title: a.title,
        summary: a.summary,
        body: a.body,
        categoryId: refs.kbCategory(a.categoryKey),
        articleType: a.type,
        domain: a.domain,
        visibility: a.visibility,
        customerId: a.customerKey ? customer(state, a.customerKey).id : null,
        serviceId: a.serviceKey ? state.services.get(a.serviceKey)!.id : null,
        ciTypeKey: a.ciTypeKey ?? null,
        status: 'published',
        version: versions,
        authorId: author.id,
        reviewerId: reviewer.id,
        reviewedAt: addMinutes(publishedAt, -30),
        publishedAt,
        expiresAt: addDays(publishedAt, 365),
        tags: a.tags,
        relatedTicketIds: related,
        viewCount: rng.int(12, 420),
        helpfulCount: rng.int(2, 40),
        notHelpfulCount: rng.int(0, 4),
        metadata: { readingMinutes: Math.max(2, Math.round(a.body.split(/\s+/).length / 180)) },
        createdAt,
        updatedAt,
      })
      .returning({ id: schema.kbArticles.id });
    state.articles.set(a.key, row!.id);
    const versionRows: (typeof schema.kbArticleVersions.$inferInsert)[] = [];
    for (let v = 1; v <= versions; v++) {
      versionRows.push({
        articleId: row!.id,
        customerId: a.customerKey ? customer(state, a.customerKey).id : null,
        version: v,
        title: a.title,
        body: v === versions ? a.body : `${a.body}\n\n<!-- revision ${v}: superseded -->`,
        summary: a.summary,
        changedBy: v === 1 ? author.id : rng.pick([author.id, reviewer.id]),
        changeNote: v === 1 ? 'Initial version' : v === versions ? 'Updated after review; clarified steps and added acceptance criteria' : 'Minor corrections',
        createdAt: v === 1 ? createdAt : v === versions ? updatedAt : addDays(createdAt, rng.int(3, 20)),
      });
    }
    await tx.insert(schema.kbArticleVersions).values(versionRows);
  }
  // Problems that became known errors reference the matching article.
  const keArticle = { backup: 'veeam_vss', virtualization: 'esxi_disconnect', network: 'wifi_disconnects' } as Record<string, string>;
  for (const t of tickets.filter((t) => t.type === 'problem')) {
    const key = keArticle[t.categoryKey];
    if (key && state.articles.get(key)) await tx.execute(sql`UPDATE problem_details SET kb_article_id = ${state.articles.get(key)}::uuid WHERE ticket_id = ${t.id}::uuid AND is_known_error = true`);
  }
  state.counts.kbArticles = ARTICLES.length;
}
