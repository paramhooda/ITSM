/**
 * Content templates for the demo tickets. Everything that reads like a human
 * wrote it lives here; the generator in tickets.ts only decides who, when and
 * what happened next.
 */
import type { DemoCi, DemoCustomer, DemoSite } from './state';
import type { Rng } from './rng';

export interface Vars {
  rng: Rng;
  cust: DemoCustomer;
  site: DemoSite | null;
  ci: DemoCi | null;
  host: string;
  ip: string;
  user: string;
  app: string;
  n: number;
}

type Level = 'high' | 'medium' | 'low';
type Text = (v: Vars) => string;

export interface IncidentTemplate {
  key: string;
  categoryKey: string;
  subcategoryKey?: string;
  domain: 'noc' | 'soc' | 'amc' | 'service_desk' | 'general';
  serviceKey: string | null;
  ciTypes: string[];
  impact: Level;
  urgency: Level;
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'informational';
  sources: [string, number][];
  weight: number;
  isMajor?: boolean;
  title: Text;
  description: Text;
  firstResponse: Text;
  workNotes: Text[];
  customerComment?: Text;
  resolutionCode: string;
  resolution: Text;
  pendingVendor?: number;
  pendingCustomer?: number;
  tags: string[];
  tasks?: string[];
  fieldVisit?: boolean;
  hardwareReplacement?: boolean;
}

const MON: [string, number][] = [['monitoring', 0.85], ['email', 0.1], ['phone', 0.05]];
const HUMAN: [string, number][] = [['portal', 0.45], ['email', 0.3], ['phone', 0.25]];
const SIEM: [string, number][] = [['siem', 0.9], ['email', 0.1]];

const greet = (v: Vars) => `Hi ${v.user.split(' ')[0]},`;

export const INCIDENT_TEMPLATES: IncidentTemplate[] = [
  // ------------------------------------------------------------ NOC / network
  {
    key: 'core_switch_down', categoryKey: 'network', subcategoryKey: 'switch', domain: 'noc', serviceKey: 'network_management', ciTypes: ['network_switch'], impact: 'high', urgency: 'high', sources: MON, weight: 3, isMajor: true,
    title: (v) => `Core switch ${v.host} unreachable - ${v.site?.name ?? 'site'} network down`,
    description: (v) => `PRTG reports device ${v.host} (${v.ip}) down since the last 3 polling cycles (ping + SNMP). All downstream access switches at ${v.site?.name ?? 'the site'} are also unreachable. Users report complete loss of LAN and ERP access.`,
    firstResponse: (v) => `${greet(v)} we have confirmed the outage on ${v.host} and engaged the NOC bridge. An engineer is checking the device console and power status. Updates every 30 minutes.`,
    workNotes: [(v) => `Console via OOB: ${v.host} stuck in ROMMON after power event. PSU1 amber, PSU2 OK. Attempting boot from flash.`, (v) => `Boot succeeded on second attempt. Stack rebuilt, all 48 ports up. Monitoring ${v.host} for 60 minutes before declaring restored.`],
    customerComment: (v) => `Production line 2 is down because of this. Please treat as top priority. - ${v.user}`,
    resolutionCode: 'hardware_replaced', resolution: (v) => `Root cause: failed PSU1 on ${v.host} caused a reboot loop during a brownout. PSU replaced from spares, firmware verified, stack stable for 2 hours. Recommend UPS runtime review (see linked change).`,
    tags: ['outage', 'switch'], tasks: ['Replace PSU1 from spares', 'Verify stack and spanning-tree after recovery', 'Update RCA document'], hardwareReplacement: true,
  },
  {
    key: 'crc_errors', categoryKey: 'network', subcategoryKey: 'switch', domain: 'noc', serviceKey: 'network_management', ciTypes: ['network_switch'], impact: 'medium', urgency: 'medium', sources: MON, weight: 5,
    title: (v) => `High CRC error rate on uplink of ${v.host}`,
    description: (v) => `Interface Gi1/0/48 on ${v.host} (${v.ip}) shows ${v.n * 120} CRC errors in the last hour (PRTG sensor "Uplink errors"). Users on the floor report intermittent slowness.`,
    firstResponse: (v) => `${greet(v)} we see the error counters on the uplink of ${v.host} and are investigating the physical link. No action is needed from your side for now.`,
    workNotes: [(v) => `Counters increasing on ${v.host} Gi1/0/48 only; peer side clean. Likely SFP or fibre patch issue.`, () => 'Requested site contact to reseat the fibre patch; counters still rising. SFP swap scheduled.'],
    resolutionCode: 'hardware_replaced', resolution: () => 'Faulty 10G SFP+ replaced on the uplink; CRC counters clean for 24 hours. Spare consumed from site stock.',
    tags: ['uplink', 'physical'],
  },
  {
    key: 'wan_flap', categoryKey: 'network', subcategoryKey: 'wan_link', domain: 'noc', serviceKey: 'network_management', ciTypes: ['router'], impact: 'high', urgency: 'medium', sources: MON, weight: 4, pendingVendor: 0.7,
    title: (v) => `WAN link flapping on ${v.host} (MPLS circuit)`,
    description: (v) => `The MPLS circuit terminated on ${v.host} (${v.ip}) has gone down and up ${v.n + 4} times in the last two hours. Traffic is failing over to the ILL backup; branch application sessions are resetting.`,
    firstResponse: (v) => `${greet(v)} we have logged a case with the ISP for the circuit on ${v.host} and are keeping traffic on the backup link meanwhile.`,
    workNotes: [() => 'Interface errors on the NNI side; ISP NOC confirms a fibre cut being repaired. ISP ticket reference captured in custom fields.', () => 'ISP reports splice complete; link stable, moving back to primary path.'],
    resolutionCode: 'vendor_fixed', resolution: () => 'ISP repaired the damaged fibre segment. Circuit stable for 6 hours; traffic restored to the primary MPLS path and backup link verified.',
    tags: ['wan', 'isp'],
  },
  {
    key: 'wifi_down', categoryKey: 'network', subcategoryKey: 'wifi', domain: 'noc', serviceKey: 'network_management', ciTypes: ['access_point'], impact: 'medium', urgency: 'high', sources: HUMAN, weight: 4,
    title: (v) => `Wireless clients cannot connect at ${v.site?.name ?? 'site'} - AP ${v.host} offline`,
    description: (v) => `Staff at ${v.site?.name ?? 'the site'} report that the corporate SSID is not visible. The access point ${v.host} (${v.ip}) shows as down in the controller. Handheld devices are affected.`,
    firstResponse: (v) => `${greet(v)} thanks for reporting. We can see ${v.host} offline from our side and are checking PoE on the switch port.`,
    workNotes: [(v) => `Switch port for ${v.host} shows PoE fault (power denied). Bounced port; AP rebooted and joined the controller.`],
    resolutionCode: 'fixed', resolution: () => 'PoE power budget exceeded on the access switch after an additional camera was connected; AP moved to a different port and PoE budget documented. Wireless service restored.',
    tags: ['wifi', 'poe'],
  },
  {
    key: 'vpn_down', categoryKey: 'network', subcategoryKey: 'vpn', domain: 'noc', serviceKey: 'network_management', ciTypes: ['firewall'], impact: 'high', urgency: 'medium', sources: MON, weight: 3,
    title: (v) => `Site-to-site VPN tunnel down between ${v.site?.name ?? 'branch'} and head office`,
    description: (v) => `The IPsec tunnel from ${v.host} (${v.ip}) to the head office firewall is down (phase 2 not established). Branch users cannot reach central applications.`,
    firstResponse: (v) => `${greet(v)} we are re-negotiating the tunnel on ${v.host} and checking the ISP path.`,
    workNotes: [() => 'Phase 1 OK, phase 2 proposal mismatch after the head office firmware upgrade changed the default DH group.', () => 'Aligned IPsec phase 2 proposals on both ends; tunnel up and traffic flowing.'],
    resolutionCode: 'config_change', resolution: () => 'IPsec phase 2 proposal re-aligned (DH group 14, AES256/SHA256) following the head office firewall upgrade. Tunnel stable; configuration baseline updated.',
    tags: ['vpn', 'ipsec'],
  },
  {
    key: 'packet_loss', categoryKey: 'network', subcategoryKey: 'lan', domain: 'noc', serviceKey: 'network_management', ciTypes: ['network_switch'], impact: 'medium', urgency: 'medium', sources: HUMAN, weight: 3,
    title: (v) => `Intermittent packet loss on VLAN 20 behind ${v.host}`,
    description: (v) => `Users connected through ${v.host} experience 5-8% packet loss to the server VLAN during peak hours. Video calls freeze and ERP sessions time out.`,
    firstResponse: (v) => `${greet(v)} we are capturing interface statistics on ${v.host} and the uplink to isolate the loss.`,
    workNotes: [() => 'Output drops on the uplink queue during 10:00-11:30; a backup job was traversing the access layer.', () => 'Moved the backup traffic to the storage VLAN and applied QoS trust boundary.'],
    resolutionCode: 'config_change', resolution: () => 'Packet loss caused by a misrouted backup job saturating the access uplink. Backup traffic re-homed to the storage VLAN; QoS policy applied. No loss observed for 3 days.',
    tags: ['lan', 'qos'],
  },
  // ------------------------------------------------------------ NOC / server
  {
    key: 'server_bsod', categoryKey: 'server', subcategoryKey: 'os', domain: 'noc', serviceKey: 'server_management', ciTypes: ['virtual_machine', 'server'], impact: 'medium', urgency: 'high', sources: MON, weight: 4,
    title: (v) => `${v.host} rebooted unexpectedly (bugcheck 0x000000D1)`,
    description: (v) => `Windows server ${v.host} (${v.ip}) rebooted at ${String(v.n % 24).padStart(2, '0')}:${String((v.n * 7) % 60).padStart(2, '0')} with a bugcheck. PRTG reported a 4-minute outage; services recovered after reboot. Memory dump available.`,
    firstResponse: (v) => `${greet(v)} the server is back online; we are analysing the memory dump to find the faulting driver.`,
    workNotes: [() => 'Dump analysis: faulting module is the NIC driver (vmxnet3) version 1.8.17. VMware KB recommends updating VMware Tools.', () => 'VMware Tools updated in the maintenance window; driver 1.9.x in place.'],
    resolutionCode: 'fixed', resolution: () => 'Bugcheck caused by an outdated vmxnet3 driver. VMware Tools upgraded and server stable since. Added the driver version check to the monthly patch checklist.',
    tags: ['windows', 'crash'],
  },
  {
    key: 'raid_degraded', categoryKey: 'server', subcategoryKey: 'server_hardware', domain: 'noc', serviceKey: 'server_management', ciTypes: ['hypervisor', 'server', 'backup_system'], impact: 'medium', urgency: 'medium', sources: MON, weight: 4, pendingVendor: 0.5,
    title: (v) => `Predictive disk failure on ${v.host} - RAID array degraded`,
    description: (v) => `iDRAC/iLO on ${v.host} reports physical disk 0:1:${v.n % 8} in predictive failure state. Virtual disk 0 is degraded but online; rebuild pending.`,
    firstResponse: (v) => `${greet(v)} we have raised a hardware case with the OEM for ${v.host}; the array remains online with redundancy reduced.`,
    workNotes: [() => 'OEM case opened; dispatch of replacement disk confirmed for next business day.', () => 'Replacement disk installed by field engineer; RAID rebuild completed (100%), array optimal.'],
    resolutionCode: 'hardware_replaced', resolution: () => 'Failed SAS disk replaced under warranty; RAID rebuilt and verified optimal. Firmware of the RAID controller checked against the OEM matrix.',
    tags: ['raid', 'hardware'], fieldVisit: true, hardwareReplacement: true,
  },
  {
    key: 'patch_failure', categoryKey: 'server', subcategoryKey: 'patching', domain: 'noc', serviceKey: 'server_management', ciTypes: ['virtual_machine'], impact: 'low', urgency: 'medium', sources: HUMAN, weight: 3,
    title: (v) => `Print spooler not starting on ${v.host} after monthly patching`,
    description: (v) => `After the ${v.n % 2 ? 'September' : 'August'} cumulative update, the Print Spooler service fails to start on ${v.host}. Users cannot print from the application server.`,
    firstResponse: (v) => `${greet(v)} we are checking the update history and event log on ${v.host}.`,
    workNotes: [() => 'Known issue with the cumulative update and a third-party print driver; applied the Microsoft out-of-band fix.'],
    resolutionCode: 'fixed', resolution: () => 'Out-of-band hotfix installed and the incompatible print driver updated. Spooler stable; printing verified by the requester.',
    tags: ['patching', 'windows'],
  },
  {
    key: 'high_cpu', categoryKey: 'server', subcategoryKey: 'server_performance', domain: 'noc', serviceKey: 'server_management', ciTypes: ['virtual_machine', 'server'], impact: 'medium', urgency: 'medium', sources: MON, weight: 5,
    title: (v) => `Sustained CPU above 95% on ${v.host}`,
    description: (v) => `PRTG CPU sensor on ${v.host} (${v.ip}) has been above 95% for 45 minutes. Application response time has doubled according to the HTTP sensor.`,
    firstResponse: (v) => `${greet(v)} we are looking at the top processes on ${v.host}; a report scheduler appears to be consuming the CPU.`,
    workNotes: [() => 'A runaway reporting job (java) consumed 6 of 8 vCPUs; killed the process and informed the application owner.', () => 'Added 2 vCPUs as interim measure; application team to fix the report query.'],
    resolutionCode: 'workaround', resolution: () => 'Runaway report job terminated and vCPU increased from 8 to 10 as a workaround. The application vendor is fixing the query (tracked in the linked problem).',
    tags: ['performance', 'cpu'],
  },
  {
    key: 'service_down', categoryKey: 'server', subcategoryKey: 'service_down', domain: 'noc', serviceKey: 'server_management', ciTypes: ['application', 'virtual_machine'], impact: 'high', urgency: 'high', sources: MON, weight: 3, isMajor: true,
    title: (v) => `${v.app} not responding - HTTP 503 on ${v.host}`,
    description: (v) => `The HTTP sensor for ${v.app} returns 503 from ${v.host}. Users at all sites cannot log in. The database server is reachable; the application service appears hung.`,
    firstResponse: (v) => `${greet(v)} we have confirmed the application outage and are restarting the service on ${v.host}. Major incident process initiated.`,
    workNotes: [() => 'Application pool stopped after exhausting worker threads; thread dump captured before restart.', () => 'Service restarted; logins OK. Thread dump shared with the vendor for RCA.'],
    resolutionCode: 'fixed', resolution: () => 'Application service restarted after thread pool exhaustion. Vendor identified a connection leak in the latest build; fix scheduled via change. Monitoring threshold for worker threads added.',
    tags: ['major', 'application'], tasks: ['Capture thread dump before restart', 'Send RCA to customer within 2 business days'],
  },
  // ------------------------------------------------------------ NOC / storage & backup
  {
    key: 'volume_capacity', categoryKey: 'storage', subcategoryKey: 'capacity', domain: 'noc', serviceKey: 'storage_management', ciTypes: ['storage_array', 'nas'], impact: 'medium', urgency: 'low', sources: MON, weight: 4,
    title: (v) => `Volume vol_data02 on ${v.host} at ${90 + (v.n % 8)}% capacity`,
    description: (v) => `Capacity sensor for ${v.host} reports vol_data02 at ${90 + (v.n % 8)}% used (threshold 90%). Growth rate suggests the volume will be full within ${5 + (v.n % 10)} days.`,
    firstResponse: (v) => `${greet(v)} we are reviewing snapshot retention and free aggregate space on ${v.host} to extend the volume.`,
    workNotes: [() => 'Snapshot reserve consumed 18% of the volume; deleted snapshots older than 30 days per policy and extended the volume by 500 GB.'],
    resolutionCode: 'config_change', resolution: () => 'Volume extended by 500 GB and snapshot policy aligned to 30-day retention. Utilisation now 71%. Capacity forecast shared in the monthly report.',
    tags: ['capacity'],
  },
  {
    key: 'disk_failed_array', categoryKey: 'storage', subcategoryKey: 'disk_failure', domain: 'noc', serviceKey: 'storage_management', ciTypes: ['storage_array'], impact: 'medium', urgency: 'medium', sources: MON, weight: 2, pendingVendor: 0.8,
    title: (v) => `Disk failure in storage array ${v.host} - shelf 1 bay ${v.n % 24}`,
    description: (v) => `${v.host} raised an alert for a failed disk in shelf 1 bay ${v.n % 24}. The spare disk has been assigned automatically and reconstruction is in progress.`,
    firstResponse: (v) => `${greet(v)} the array is protected by the hot spare; we have opened a case with the vendor to replace the failed disk.`,
    workNotes: [() => 'Vendor case opened with log bundle; replacement disk shipped.', () => 'Disk replaced on site; new disk assigned as spare.'],
    resolutionCode: 'vendor_fixed', resolution: () => 'Failed disk replaced by the vendor under support contract. Reconstruction completed, spare pool restored.',
    tags: ['storage', 'hardware'], fieldVisit: true,
  },
  {
    key: 'backup_job_failed', categoryKey: 'backup', subcategoryKey: 'job_failure', domain: 'noc', serviceKey: 'backup_management', ciTypes: ['virtual_machine', 'backup_system'], impact: 'medium', urgency: 'medium', sources: MON, weight: 6,
    title: (v) => `Nightly backup job failed for ${v.host} - VSS snapshot timeout`,
    description: (v) => `Veeam job "Daily-${v.site?.code ?? 'SITE'}-VMs" failed for ${v.host}: "Error: VSSControl: Failed to freeze guest, wait timeout". Retry also failed. Last good backup was 1 day ago.`,
    firstResponse: (v) => `${greet(v)} we are checking the VSS writers on ${v.host} and will rerun the job once stable.`,
    workNotes: [(v) => `vssadmin list writers on ${v.host} shows the SQL writer in a failed state; restarted the SQL VSS Writer service.`, () => 'Manual job rerun completed successfully (full chain verified).'],
    resolutionCode: 'fixed', resolution: () => 'SQL VSS writer was in a failed state after a pending Windows update. Writer service restarted and the backup rerun completed. Backup chain healthy.',
    tags: ['veeam', 'backup'],
  },
  {
    key: 'backup_retention', categoryKey: 'backup', subcategoryKey: 'backup_policy', domain: 'noc', serviceKey: 'backup_management', ciTypes: ['backup_system'], impact: 'low', urgency: 'low', sources: HUMAN, weight: 2,
    title: (v) => `Backup retention on ${v.host} does not match policy (30 days expected)`,
    description: () => 'The monthly backup report shows only 14 restore points for the file server job while the agreed policy is 30 days. Please verify repository configuration.',
    firstResponse: (v) => `${greet(v)} we are verifying the retention settings on ${v.host} against the agreed policy.`,
    workNotes: [() => 'The job was cloned from a template with 14-day retention during the repository migration. Corrected to 30 days; GFS weekly enabled.'],
    resolutionCode: 'config_change', resolution: () => 'Retention corrected to 30 restore points with GFS weeklies; backup copy job verified. Policy document updated.',
    tags: ['backup', 'policy'],
  },
  {
    key: 'restore_failed', categoryKey: 'backup', subcategoryKey: 'restore', domain: 'noc', serviceKey: 'backup_management', ciTypes: ['virtual_machine'], impact: 'medium', urgency: 'high', sources: HUMAN, weight: 2,
    title: (v) => `File-level restore failing for ${v.host} - backup chain error`,
    description: (v) => `A restore of the finance share from ${v.host} fails with "Backup chain is broken: increment missing". The requester needs files from ${7 + (v.n % 10)} days ago.`,
    firstResponse: (v) => `${greet(v)} we are repairing the backup chain and will restore from the backup copy repository.`,
    workNotes: [() => 'Primary chain missing an increment deleted by a failed merge. Restored the requested folder from the offsite copy job instead.'],
    resolutionCode: 'workaround', resolution: () => 'Files restored from the backup copy repository and verified by the requester. Primary chain re-seeded with a new active full.',
    tags: ['restore'],
  },
  // ------------------------------------------------------------ NOC / virtualization & connectivity & hardware
  {
    key: 'vm_frozen', categoryKey: 'virtualization', subcategoryKey: 'vm', domain: 'noc', serviceKey: 'virtualization_management', ciTypes: ['virtual_machine'], impact: 'medium', urgency: 'high', sources: MON, weight: 3,
    title: (v) => `VM ${v.host} unresponsive - console shows kernel panic`,
    description: (v) => `${v.host} stopped responding to ping and SSH; the vSphere console shows a kernel panic (soft lockup on CPU#1). Guest reset required.`,
    firstResponse: (v) => `${greet(v)} we are resetting ${v.host} and collecting the panic output for analysis.`,
    workNotes: [() => 'Guest reset; services came back. Panic correlates with a datastore latency spike at the same time.'],
    resolutionCode: 'fixed', resolution: () => 'VM reset; the kernel panic was triggered by a datastore latency spike during the backup window. Linked to the storage latency problem record.',
    tags: ['vm'],
  },
  {
    key: 'esxi_disconnected', categoryKey: 'virtualization', subcategoryKey: 'hypervisor', domain: 'noc', serviceKey: 'virtualization_management', ciTypes: ['hypervisor'], impact: 'high', urgency: 'medium', sources: MON, weight: 3,
    title: (v) => `ESXi host ${v.host} disconnected from vCenter`,
    description: (v) => `vCenter shows ${v.host} as "Not responding". VMs continue to run (verified via direct host access) but HA/DRS is impaired.`,
    firstResponse: (v) => `${greet(v)} VMs on ${v.host} are running; we are restarting the host management agents.`,
    workNotes: [() => 'services.sh restart on the host; vpxa reconnected to vCenter. hostd log showed memory pressure in the management agent.'],
    resolutionCode: 'fixed', resolution: () => 'Management agents restarted and host reconnected to vCenter. hostd memory leak is a known issue fixed in the next ESXi patch (change raised).',
    tags: ['vmware'],
  },
  {
    key: 'internet_down', categoryKey: 'connectivity', subcategoryKey: 'internet', domain: 'noc', serviceKey: 'network_management', ciTypes: ['firewall', 'router'], impact: 'high', urgency: 'high', sources: [['phone', 0.5], ['monitoring', 0.4], ['portal', 0.1]], weight: 3, pendingVendor: 0.8,
    title: (v) => `Internet connectivity down at ${v.site?.name ?? 'site'} (primary ISP)`,
    description: (v) => `Primary internet link on ${v.host} (${v.ip}) is down; no DHCP from the ISP router. Backup 4G link is active but saturated. Email and SaaS applications are slow.`,
    firstResponse: (v) => `${greet(v)} we have logged the outage with the ISP and moved critical traffic to the backup link.`,
    workNotes: [() => 'ISP confirms an outage in the area affecting multiple customers; ETR 4 hours.', () => 'ISP link restored; failback to primary verified.'],
    resolutionCode: 'vendor_fixed', resolution: () => 'ISP outage resolved by the provider. Primary link restored and monitored for stability. Recommended upgrading the backup link capacity.',
    tags: ['isp', 'outage'],
  },
  {
    key: 'branch_unreachable', categoryKey: 'connectivity', subcategoryKey: 'site_to_site', domain: 'noc', serviceKey: 'network_management', ciTypes: ['firewall'], impact: 'high', urgency: 'medium', sources: MON, weight: 3,
    title: (v) => `${v.site?.name ?? 'Branch'} cannot reach data center applications`,
    description: (v) => `Users at ${v.site?.name ?? 'the branch'} cannot reach ERP and file services. ${v.host} is reachable from the NOC; the WAN route to the data center is missing from the routing table.`,
    firstResponse: (v) => `${greet(v)} connectivity to the data center from ${v.site?.name ?? 'the branch'} is being restored; we found a routing issue on ${v.host}.`,
    workNotes: [() => 'BGP session with the MPLS PE reset; static backup route was missing after the last config change. Added route and verified.'],
    resolutionCode: 'config_change', resolution: () => 'Missing backup static route re-added on the branch firewall; routing verified in both directions. Change control gap addressed with the engineer.',
    tags: ['routing'],
  },
  {
    key: 'ups_on_battery', categoryKey: 'hardware', subcategoryKey: 'power', domain: 'noc', serviceKey: 'noc_monitoring', ciTypes: ['ups'], impact: 'high', urgency: 'high', sources: MON, weight: 3,
    title: (v) => `UPS ${v.host} on battery - utility power failure at ${v.site?.name ?? 'site'}`,
    description: (v) => `${v.host} (${v.ip}) switched to battery at ${String(v.n % 24).padStart(2, '0')}:${String((v.n * 11) % 60).padStart(2, '0')}; estimated runtime ${12 + (v.n % 20)} minutes. Generator did not start automatically.`,
    firstResponse: (v) => `${greet(v)} we are tracking the UPS runtime on ${v.host} and have alerted the site facilities contact to start the generator.`,
    workNotes: [() => 'Facilities started the generator manually; UPS back on mains after 9 minutes. No equipment shutdown required.'],
    resolutionCode: 'self_recovered', resolution: () => 'Utility power restored and UPS recharged. Generator auto-start failure handed over to the facilities vendor. Shutdown sequence tested successfully.',
    tags: ['power', 'ups'],
  },
  {
    key: 'fan_failure', categoryKey: 'hardware', subcategoryKey: 'component_failure', domain: 'noc', serviceKey: 'server_management', ciTypes: ['hypervisor', 'server', 'network_switch'], impact: 'low', urgency: 'medium', sources: MON, weight: 3,
    title: (v) => `Fan ${1 + (v.n % 4)} failure alarm on ${v.host}`,
    description: (v) => `Hardware health sensor on ${v.host} reports fan ${1 + (v.n % 4)} failed; inlet temperature rising slowly (currently ${28 + (v.n % 6)} C).`,
    firstResponse: (v) => `${greet(v)} the device remains operational with redundant cooling; we have ordered a replacement fan module.`,
    workNotes: [() => 'Replacement fan module received; installed during the Saturday window. Temperatures normal.'],
    resolutionCode: 'hardware_replaced', resolution: () => 'Faulty fan module replaced; all fans nominal and inlet temperature back to 22 C.',
    tags: ['hardware'], fieldVisit: true, hardwareReplacement: true,
  },
  {
    key: 'slow_erp', categoryKey: 'performance', domain: 'noc', serviceKey: 'server_management', ciTypes: ['application', 'database'], impact: 'medium', urgency: 'medium', sources: HUMAN, weight: 4,
    title: (v) => `Slow ${v.app} response for users at ${v.site?.name ?? 'site'}`,
    description: (v) => `Multiple users at ${v.site?.name ?? 'the site'} report that ${v.app} screens take 20-30 seconds to load since this morning. Other applications are fine.`,
    firstResponse: (v) => `${greet(v)} we are checking the database and application server performance for ${v.app}.`,
    workNotes: [() => 'Database wait events show lock contention from a month-end batch job running during business hours.', () => 'Batch job rescheduled to 22:00 with the application owner.'],
    resolutionCode: 'workaround', resolution: () => 'Month-end batch job rescheduled outside business hours; response time back to under 2 seconds. Index recommendation shared with the application vendor.',
    tags: ['performance'],
  },
  {
    key: 'app_503', categoryKey: 'availability', domain: 'noc', serviceKey: 'noc_monitoring', ciTypes: ['application'], impact: 'medium', urgency: 'high', sources: [['monitoring', 0.6], ['portal', 0.4]], weight: 3,
    title: (v) => `${v.app} intermittent HTTP 503 errors`,
    description: (v) => `The HTTP sensor for ${v.app} intermittently returns 503 (${v.n % 12} failures in the last hour). Users see "Service unavailable" and have to retry.`,
    firstResponse: (v) => `${greet(v)} we are investigating the intermittent errors on ${v.app}; the load balancer health checks are being reviewed.`,
    workNotes: [() => 'One of two application nodes failing health checks due to disk full on /var/log. Cleared logs and fixed rotation.'],
    resolutionCode: 'fixed', resolution: () => 'Node 2 had a full log partition causing failed health checks. Log rotation corrected and a disk-space sensor added. No errors since.',
    tags: ['availability'],
  },
  {
    key: 'cloud_instance', categoryKey: 'cloud', domain: 'noc', serviceKey: 'cloud_support', ciTypes: ['cloud_resource'], impact: 'medium', urgency: 'high', sources: MON, weight: 4,
    title: (v) => `Cloud instance ${v.host} failed status checks`,
    description: (v) => `CloudWatch/Azure Monitor reports instance ${v.host} failing system status checks; the application behind it is unreachable. Auto-recovery did not trigger.`,
    firstResponse: (v) => `${greet(v)} we are stopping and starting ${v.host} to move it to healthy underlying hardware.`,
    workNotes: [() => 'Instance stop/start completed; status checks passing. Enabled auto-recovery alarm for the instance.'],
    resolutionCode: 'fixed', resolution: () => 'Instance recovered by stop/start (underlying host degraded). Auto-recovery alarm enabled for all production instances.',
    tags: ['cloud'],
  },
  {
    key: 'cloud_db_storage', categoryKey: 'cloud', domain: 'noc', serviceKey: 'cloud_support', ciTypes: ['cloud_resource'], impact: 'medium', urgency: 'low', sources: MON, weight: 2,
    title: (v) => `Managed database ${v.host} storage above 85%`,
    description: (v) => `Storage utilisation on ${v.host} reached 85% (allocated ${200 + (v.n % 5) * 100} GB). Autoscaling is disabled per the cost policy.`,
    firstResponse: (v) => `${greet(v)} we will propose a storage increase for ${v.host} and review table growth with your application team.`,
    workNotes: [() => 'Largest table is the audit log (62%); application team agreed to archive data older than 12 months.'],
    resolutionCode: 'config_change', resolution: () => 'Storage increased by 100 GB after customer approval and audit log archiving scheduled monthly. Utilisation at 58%.',
    tags: ['cloud', 'capacity'],
  },
  // ------------------------------------------------------------ SOC
  {
    key: 'unauthorized_access', categoryKey: 'security_incident', subcategoryKey: 'unauthorized_access', domain: 'soc', serviceKey: 'security_monitoring', ciTypes: ['virtual_machine', 'server', 'hypervisor'], impact: 'high', urgency: 'high', severity: 'critical', sources: SIEM, weight: 2, isMajor: true,
    title: (v) => `Successful admin login after multiple failures on ${v.host}`,
    description: (v) => `FortiSIEM rule "Brute force followed by success" fired for ${v.host} (${v.ip}): 47 failed logons for account "administrator" from 185.220.${v.n % 255}.${(v.n * 3) % 255} followed by a successful logon via RDP.`,
    firstResponse: (v) => `${greet(v)} the SOC has isolated ${v.host} from the network and disabled the affected account as a containment measure. Investigation in progress; we will call the ISO.`,
    workNotes: [() => 'RDP exposed through a NAT rule added last week without change control. Source IP is a known Tor exit node.', () => 'No lateral movement found in the EDR timeline; credential reset for all local admins; NAT rule removed.'],
    resolutionCode: 'fixed', resolution: () => 'Containment: host isolated, account disabled, exposed RDP NAT rule removed. Eradication: credentials rotated, EDR full scan clean. Recovery: host reconnected after verification. Report delivered to the ISO.',
    tags: ['security', 'ir', 'major'], tasks: ['Isolate host via EDR', 'Reset local admin credentials', 'Deliver incident report'],
  },
  {
    key: 'ransomware', categoryKey: 'malware', subcategoryKey: 'ransomware', domain: 'soc', serviceKey: 'security_monitoring', ciTypes: ['endpoint', 'virtual_machine'], impact: 'high', urgency: 'high', severity: 'critical', sources: SIEM, weight: 1, isMajor: true,
    title: (v) => `Ransomware indicators on ${v.host} - mass file encryption activity`,
    description: (v) => `EDR detected rapid file renames with extension .lockbit on ${v.host} and a suspicious process (svch0st.exe) spawning from an Office macro. The device was automatically isolated.`,
    firstResponse: (v) => `${greet(v)} ${v.host} has been isolated by the EDR and the SOC incident commander is engaged. Please do not power off the device; we are preserving evidence.`,
    workNotes: [() => 'Encrypted files limited to the local profile and one mapped share (finance). Share restored from last night\'s backup.', () => 'Initial access via a phishing attachment; user awareness session scheduled. IOCs blocked at the firewall and EDR.'],
    resolutionCode: 'fixed', resolution: () => 'Device re-imaged, affected share restored from backup (RPO 1 day), IOCs blocked, macro execution policy hardened via GPO. Incident report and lessons learned shared with the customer.',
    tags: ['security', 'ransomware', 'major'],
  },
  {
    key: 'trojan', categoryKey: 'malware', subcategoryKey: 'trojan', domain: 'soc', serviceKey: 'security_monitoring', ciTypes: ['endpoint', 'virtual_machine'], impact: 'medium', urgency: 'medium', severity: 'medium', sources: SIEM, weight: 3,
    title: (v) => `EDR quarantined trojan on ${v.host} (Trojan.GenericKD.${40000 + v.n})`,
    description: (v) => `The EDR agent on ${v.host} quarantined a file downloaded through the browser (invoice_${v.n}.pdf.exe). No execution observed.`,
    firstResponse: (v) => `${greet(v)} the file was quarantined before execution; we are verifying there is no persistence on ${v.host}.`,
    workNotes: [() => 'Full EDR scan clean; browser download history shows a malvertising redirect. URL category blocked at the firewall.'],
    resolutionCode: 'fixed', resolution: () => 'Quarantine confirmed, no execution or persistence. Malicious domain blocked at the perimeter; user informed.',
    tags: ['security', 'malware'],
  },
  {
    key: 'phishing', categoryKey: 'phishing', subcategoryKey: 'credential_phishing', domain: 'soc', serviceKey: 'security_monitoring', ciTypes: [], impact: 'medium', urgency: 'medium', severity: 'medium', sources: [['portal', 0.5], ['email', 0.4], ['phone', 0.1]], weight: 3,
    title: (v) => `Phishing email reported by ${v.user} - credential harvesting link`,
    description: (v) => `${v.user} reported an email "Your mailbox storage is full" with a link to a fake Microsoft login page (hxxps://m365-verify-${v.n}.example). ${v.n % 3} other users received the same message.`,
    firstResponse: (v) => `${greet(v)} thank you for reporting. We are checking whether anyone entered credentials and removing the message from all mailboxes.`,
    workNotes: [() => 'Message purged from 4 mailboxes via content search. One user clicked but did not submit credentials (proxy logs).', () => 'Sender domain and URL added to the block list; phishing simulation feedback shared.'],
    resolutionCode: 'fixed', resolution: () => 'Phishing campaign contained: emails purged, URL blocked, no credential compromise confirmed. Affected user passwords reset as a precaution.',
    tags: ['security', 'phishing'],
  },
  {
    key: 'brute_force', categoryKey: 'authentication', subcategoryKey: 'brute_force', domain: 'soc', serviceKey: 'security_monitoring', ciTypes: ['firewall'], impact: 'medium', urgency: 'high', severity: 'high', sources: SIEM, weight: 3,
    title: (v) => `Brute force attempts against SSL-VPN on ${v.host}`,
    description: (v) => `FortiSIEM correlated ${800 + v.n * 10} failed SSL-VPN logins against ${v.host} (${v.ip}) in 30 minutes from 23 source IPs (credential stuffing pattern). No successful logins.`,
    firstResponse: (v) => `${greet(v)} we have applied geo-blocking and rate limiting on ${v.host} and are monitoring for any success.`,
    workNotes: [() => 'Source IPs added to the threat feed block list; MFA enforcement verified for all VPN groups.'],
    resolutionCode: 'config_change', resolution: () => 'Attack blocked via geo-IP policy and automatic banning of offending sources. MFA confirmed on all VPN accounts. No compromise.',
    tags: ['security', 'vpn'],
  },
  {
    key: 'mfa_fatigue', categoryKey: 'authentication', subcategoryKey: 'mfa_bypass', domain: 'soc', serviceKey: 'security_monitoring', ciTypes: [], impact: 'medium', urgency: 'medium', severity: 'medium', sources: SIEM, weight: 2,
    title: (v) => `MFA push fatigue attempts for account ${v.user.toLowerCase().replace(/\s+/g, '.')}`,
    description: (v) => `${8 + (v.n % 10)} MFA push notifications were sent to ${v.user} within 5 minutes from an unfamiliar location. The user denied all prompts and called the helpdesk.`,
    firstResponse: (v) => `${greet(v)} well done for denying the prompts. We have reset the password and revoked active sessions as a precaution.`,
    workNotes: [() => 'Password found in a public credential dump (2024 breach); number matching enabled for MFA tenant-wide.'],
    resolutionCode: 'fixed', resolution: () => 'Credential rotated, sessions revoked and MFA number matching enforced for all users. Awareness note sent to the customer.',
    tags: ['security', 'mfa'],
  },
  {
    key: 'ips_sqli', categoryKey: 'firewall', subcategoryKey: 'ips_alert', domain: 'soc', serviceKey: 'security_monitoring', ciTypes: ['application', 'firewall'], impact: 'medium', urgency: 'medium', severity: 'medium', sources: SIEM, weight: 3,
    title: (v) => `IPS signature triggered: SQL injection attempt against ${v.app}`,
    description: (v) => `FortiGate IPS blocked ${30 + v.n} SQL injection attempts (signature "SQL.Injection.Generic") targeting ${v.app} from a single source. Requests were dropped.`,
    firstResponse: (v) => `${greet(v)} the attempts were blocked by the IPS; we are validating the application input handling and blocking the source.`,
    workNotes: [() => 'Source blocked; application logs show no successful queries. Recommended WAF rule tuning to the application owner.'],
    resolutionCode: 'no_fault_found', resolution: () => 'Attack blocked inline by IPS; no impact to the application. Source IP blacklisted and WAF recommendation shared.',
    tags: ['security', 'ips'],
  },
  {
    key: 'fw_rule_change', categoryKey: 'firewall', subcategoryKey: 'rule_change', domain: 'soc', serviceKey: 'security_monitoring', ciTypes: ['firewall'], impact: 'high', urgency: 'medium', severity: 'high', sources: SIEM, weight: 2,
    title: (v) => `Unauthorized firewall policy change detected on ${v.host}`,
    description: (v) => `Configuration audit on ${v.host} shows a new policy "any-any-allow" on the DMZ interface added at ${String(v.n % 24).padStart(2, '0')}:15 by a local admin account outside change control.`,
    firstResponse: (v) => `${greet(v)} the policy has been disabled pending review and the local account has been locked. Please confirm whether this was an authorised activity.`,
    workNotes: [() => 'Customer confirmed a vendor engineer added the rule for testing. Rule removed; vendor access now via time-bound accounts only.'],
    resolutionCode: 'config_change', resolution: () => 'Unauthorised policy removed and configuration restored to baseline. Local admin accounts replaced by SSO-backed named accounts with change-control approval.',
    tags: ['security', 'firewall'], pendingCustomer: 0.6,
  },
  {
    key: 'av_outdated', categoryKey: 'endpoint_security', domain: 'soc', serviceKey: 'security_monitoring', ciTypes: ['endpoint'], impact: 'low', urgency: 'low', severity: 'low', sources: SIEM, weight: 2,
    title: (v) => `Endpoint ${v.host} has not reported to EDR for ${15 + (v.n % 20)} days`,
    description: (v) => `The EDR console shows ${v.host} as stale (no check-in for ${15 + (v.n % 20)} days) with outdated definitions. The device is still active on the network.`,
    firstResponse: (v) => `${greet(v)} we need the device online with the agent repaired; could the user keep the laptop connected today?`,
    workNotes: [() => 'Agent service was disabled by a third-party cleanup tool; reinstalled and policy re-applied.'],
    resolutionCode: 'fixed', resolution: () => 'EDR agent reinstalled and checking in; definitions current. Cleanup tool removed from the device.',
    tags: ['security', 'endpoint'], pendingCustomer: 0.5,
  },
  {
    key: 'critical_cve', categoryKey: 'vulnerability', subcategoryKey: 'critical_cve', domain: 'soc', serviceKey: 'security_monitoring', ciTypes: ['firewall', 'virtual_machine'], impact: 'medium', urgency: 'high', severity: 'high', sources: [['siem', 0.5], ['engineer', 0.5]], weight: 2,
    title: (v) => `Critical CVE-2026-${1000 + v.n * 7} affects ${v.host} - patch required`,
    description: (v) => `Vendor advisory published for a critical vulnerability (CVSS 9.8, remote code execution) affecting the firmware/version running on ${v.host}. Exploitation in the wild reported.`,
    firstResponse: (v) => `${greet(v)} we have applied the vendor workaround on ${v.host} and raised an emergency change for the patch.`,
    workNotes: [() => 'Workaround (disable affected administrative interface on WAN) applied; patch scheduled in the emergency change window.'],
    resolutionCode: 'fixed', resolution: () => 'Patched to the fixed version via emergency change; vulnerability scan confirms remediation.',
    tags: ['security', 'vulnerability'],
  },
  {
    key: 'suspicious_outbound', categoryKey: 'suspicious_activity', domain: 'soc', serviceKey: 'security_monitoring', ciTypes: ['virtual_machine', 'endpoint'], impact: 'medium', urgency: 'medium', severity: 'medium', sources: SIEM, weight: 3,
    title: (v) => `Unusual outbound traffic from ${v.host} to unknown external IP`,
    description: (v) => `${v.host} (${v.ip}) sent ${2 + (v.n % 6)} GB to 45.${v.n % 255}.12.${(v.n * 5) % 255}:443 overnight. The destination is not a known SaaS provider and has a low reputation score.`,
    firstResponse: (v) => `${greet(v)} we are investigating the destination and the process responsible on ${v.host}; outbound traffic to the IP is blocked meanwhile.`,
    workNotes: [() => 'Process is a legitimate backup client syncing to a new offsite provider configured by the customer\'s team. Reputation false positive.'],
    resolutionCode: 'no_fault_found', resolution: () => 'Traffic confirmed as legitimate backup replication to a newly contracted provider. Destination whitelisted and the SIEM rule tuned.',
    tags: ['security'],
  },
  {
    key: 'usb_policy', categoryKey: 'policy_violation', domain: 'soc', serviceKey: 'security_monitoring', ciTypes: ['endpoint'], impact: 'low', urgency: 'low', severity: 'informational', sources: SIEM, weight: 2,
    title: (v) => `USB mass storage usage detected on ${v.host}`,
    description: (v) => `Device control logged a USB storage device (SanDisk Ultra, serial ${v.n * 991}) connected to ${v.host}; ${v.n % 40} files copied. Policy requires encrypted drives only.`,
    firstResponse: (v) => `${greet(v)} we have logged the policy violation and need confirmation from the line manager whether the transfer was approved.`,
    workNotes: [() => 'Manager confirmed the transfer was business related; user reminded of the encrypted-drive policy.'],
    resolutionCode: 'user_error', resolution: () => 'Transfer confirmed as authorised business activity; user counselled on policy. No data exfiltration concern.',
    tags: ['security', 'policy'], pendingCustomer: 0.7,
  },
  // ------------------------------------------------------------ AMC / field
  {
    key: 'server_no_power', categoryKey: 'breakdown_support', subcategoryKey: 'emergency_visit', domain: 'amc', serviceKey: 'amc_support', ciTypes: ['hypervisor', 'server', 'backup_system'], impact: 'high', urgency: 'high', sources: [['phone', 0.6], ['portal', 0.3], ['email', 0.1]], weight: 3,
    title: (v) => `Server ${v.host} not powering on - on-site engineer required`,
    description: (v) => `${v.host} in the server room at ${v.site?.name ?? 'site'} does not power on after a planned shutdown. Power LED blinks amber; iDRAC unreachable.`,
    firstResponse: (v) => `${greet(v)} a field engineer has been dispatched to ${v.site?.name ?? 'the site'} with a replacement power supply; ETA 2 hours.`,
    workNotes: [() => 'On site: both PSUs test OK; system board fault LED. Replaced system board under AMC with the spare unit.', () => 'Server booted, hosts rejoined cluster, VMs migrated back.'],
    resolutionCode: 'hardware_replaced', resolution: () => 'System board replaced on site under AMC; server restored and cluster healthy. Hardware replacement entitlement consumed.',
    tags: ['amc', 'onsite'], fieldVisit: true, hardwareReplacement: true,
  },
  {
    key: 'psu_replace', categoryKey: 'hardware_support', subcategoryKey: 'part_replacement', domain: 'amc', serviceKey: 'amc_support', ciTypes: ['network_switch', 'storage_array'], impact: 'medium', urgency: 'medium', sources: [['monitoring', 0.5], ['portal', 0.5]], weight: 3,
    title: (v) => `Replace failed redundant PSU on ${v.host}`,
    description: (v) => `${v.host} reports PSU2 failed; the device is running on PSU1 only. Replacement under AMC requested.`,
    firstResponse: (v) => `${greet(v)} replacement PSU is being arranged; a site visit will be scheduled once the part arrives.`,
    workNotes: [() => 'Part received from OEM; visit scheduled with the site contact.', () => 'PSU2 replaced on site; both supplies green.'],
    resolutionCode: 'hardware_replaced', resolution: () => 'Redundant PSU replaced under AMC during a site visit; both power supplies healthy.',
    tags: ['amc', 'hardware'], fieldVisit: true, hardwareReplacement: true,
  },
  {
    key: 'pm_visit', categoryKey: 'preventive_maintenance', subcategoryKey: 'scheduled_pm', domain: 'amc', serviceKey: 'preventive_maintenance', ciTypes: ['ups', 'storage_array', 'hypervisor'], impact: 'low', urgency: 'low', sources: [['engineer', 0.8], ['portal', 0.2]], weight: 3,
    title: (v) => `Preventive maintenance visit - ${v.site?.name ?? 'site'} server room`,
    description: (v) => `Scheduled preventive maintenance for the server room at ${v.site?.name ?? 'the site'}: cleaning, firmware review, UPS battery test, cabling and rack audit per the AMC checklist.`,
    firstResponse: (v) => `${greet(v)} the PM visit is confirmed; our engineer will arrive at 10:00 and needs access to the server room for about 4 hours.`,
    workNotes: [() => 'PM completed: filters cleaned, firmware baseline recorded, UPS battery test passed (runtime 18 min), two loose patch cords re-dressed.'],
    resolutionCode: 'fixed', resolution: () => 'Preventive maintenance completed per checklist; report attached to the field visit. Recommendation: replace UPS batteries within 6 months.',
    tags: ['amc', 'pm'], fieldVisit: true,
  },
  {
    key: 'rack_inspection', categoryKey: 'inspection', domain: 'amc', serviceKey: 'amc_support', ciTypes: ['network_switch'], impact: 'low', urgency: 'low', sources: [['portal', 0.7], ['email', 0.3]], weight: 2,
    title: (v) => `Rack cabling inspection requested after office relocation at ${v.site?.name ?? 'site'}`,
    description: () => 'Following the relocation of the network cabinet to the new server room, please inspect cabling, labelling and earthing before we move production traffic.',
    firstResponse: (v) => `${greet(v)} inspection scheduled for next week; the engineer will share a report with photos and findings.`,
    workNotes: [() => 'Inspection done: 6 unlabelled patch cords, earthing strap missing on cabinet door. Fixed on the spot; report issued.'],
    resolutionCode: 'fixed', resolution: () => 'Inspection completed; cabling labelled, earthing corrected and report delivered.',
    tags: ['amc', 'inspection'], fieldVisit: true,
  },
  {
    key: 'ups_health', categoryKey: 'health_check', domain: 'amc', serviceKey: 'preventive_maintenance', ciTypes: ['ups'], impact: 'low', urgency: 'low', sources: [['engineer', 0.6], ['portal', 0.4]], weight: 2,
    title: (v) => `UPS battery health check - ${v.host}`,
    description: (v) => `Annual battery health check for ${v.host}: runtime test, internal resistance measurement and visual inspection of the battery strings.`,
    firstResponse: (v) => `${greet(v)} the health check is scheduled; we will need a 30-minute window where the UPS runs on battery.`,
    workNotes: [() => 'Runtime at 50% load: 14 minutes (spec 20). Two cells with high internal resistance in string B.'],
    resolutionCode: 'fixed', resolution: () => 'Health check completed; battery degradation found in string B. Replacement quotation issued (batteries are excluded from AMC).',
    tags: ['amc', 'ups'], fieldVisit: true,
  },
  {
    key: 'store_switch_replace', categoryKey: 'network_support', domain: 'amc', serviceKey: 'amc_support', ciTypes: ['network_switch'], impact: 'medium', urgency: 'high', sources: [['phone', 0.6], ['portal', 0.4]], weight: 2,
    title: (v) => `Replace faulty switch ${v.host} at ${v.site?.name ?? 'site'}`,
    description: (v) => `${v.host} keeps rebooting every 20-30 minutes; POS terminals and the Wi-Fi go down each time. Needs an on-site swap.`,
    firstResponse: (v) => `${greet(v)} a field engineer is on the way with a pre-configured spare switch.`,
    workNotes: [() => 'Swapped the switch with the cold spare (config restored from backup); faulty unit brought back for RMA.'],
    resolutionCode: 'hardware_replaced', resolution: () => 'Switch replaced on site from spares; configuration restored; RMA raised for the faulty unit.',
    tags: ['amc', 'onsite'], fieldVisit: true, hardwareReplacement: true,
  },
  // ------------------------------------------------------------ Service desk
  {
    key: 'password_reset', categoryKey: 'access', subcategoryKey: 'password_reset', domain: 'service_desk', serviceKey: 'end_user_support', ciTypes: [], impact: 'low', urgency: 'high', sources: [['phone', 0.6], ['portal', 0.4]], weight: 5,
    title: (v) => `Password reset and account unlock for ${v.user}`,
    description: (v) => `${v.user} is locked out of Active Directory after several failed attempts on a new phone. Needs the account unlocked and password reset before a client call.`,
    firstResponse: (v) => `${greet(v)} your account has been unlocked and a temporary password shared over the phone. Please change it at first login.`,
    workNotes: [() => 'Identity verified via callback to the registered mobile number; account unlocked and password reset.'],
    resolutionCode: 'fixed', resolution: () => 'Account unlocked and password reset after identity verification; user confirmed access.',
    tags: ['service-desk', 'access'],
  },
  {
    key: 'outlook_sync', categoryKey: 'email_collab', domain: 'service_desk', serviceKey: 'end_user_support', ciTypes: [], impact: 'medium', urgency: 'medium', sources: HUMAN, weight: 4,
    title: (v) => `Outlook not syncing for the ${v.n % 2 ? 'finance' : 'sales'} team`,
    description: (v) => `Since this morning Outlook shows "Trying to connect" for ${3 + (v.n % 5)} users in the ${v.n % 2 ? 'finance' : 'sales'} team. Webmail works.`,
    firstResponse: (v) => `${greet(v)} we are checking the Outlook connectivity; webmail remains available meanwhile.`,
    workNotes: [() => 'A proxy PAC file update was blocking the autodiscover endpoint; corrected PAC exception and recreated one corrupt profile.'],
    resolutionCode: 'fixed', resolution: () => 'Proxy PAC exception for autodiscover restored and a corrupt Outlook profile recreated. All users syncing.',
    tags: ['service-desk', 'email'],
  },
  {
    key: 'laptop_not_booting', categoryKey: 'end_user_device', domain: 'service_desk', serviceKey: 'end_user_support', ciTypes: ['endpoint'], impact: 'low', urgency: 'medium', sources: HUMAN, weight: 4,
    title: (v) => `Laptop not booting - ${v.user}`,
    description: (v) => `${v.user}'s laptop shows a blue screen "INACCESSIBLE_BOOT_DEVICE" after a Windows update and will not boot into the desktop.`,
    firstResponse: (v) => `${greet(v)} we will attempt a remote recovery through the recovery environment; if that fails a loaner laptop will be issued.`,
    workNotes: [() => 'Uninstalled the last quality update from WinRE; device booted. BitLocker recovery key retrieved from Intune.'],
    resolutionCode: 'fixed', resolution: () => 'Faulty update rolled back from the recovery environment; device boots normally. Update deferred for this model until the fix ships.',
    tags: ['service-desk', 'endpoint'],
  },
  {
    key: 'office_activation', categoryKey: 'software', subcategoryKey: 'license', domain: 'service_desk', serviceKey: 'end_user_support', ciTypes: ['endpoint'], impact: 'low', urgency: 'low', sources: HUMAN, weight: 3,
    title: (v) => `Microsoft 365 apps show "Unlicensed product" for ${v.user}`,
    description: (v) => `Word and Excel on ${v.user}'s laptop display an unlicensed product banner since the licence reassignment last week.`,
    firstResponse: (v) => `${greet(v)} we are checking the licence assignment in the admin centre and will re-activate the apps.`,
    workNotes: [() => 'Licence was removed during the departmental move; re-assigned and signed the user out/in of Office.'],
    resolutionCode: 'user_error', resolution: () => 'Licence re-assigned and activation refreshed; apps fully functional.',
    tags: ['service-desk', 'licensing'],
  },
  {
    key: 'projector', categoryKey: 'other', domain: 'general', serviceKey: null, ciTypes: [], impact: 'low', urgency: 'low', sources: HUMAN, weight: 2,
    title: (v) => `Conference room projector not working at ${v.site?.name ?? 'site'}`,
    description: () => 'The boardroom projector shows "No signal" with both HDMI and wireless casting. Needed for the client meeting tomorrow.',
    firstResponse: (v) => `${greet(v)} this is outside our standard scope but we will take a look remotely and advise.`,
    workNotes: [() => 'Projector input was set to VGA; guided the admin assistant to switch inputs. Advised customer to log AV equipment with their facilities vendor.'],
    resolutionCode: 'out_of_scope_advised', resolution: () => 'Resolved by switching the projector input; customer advised that AV equipment is not covered under the contract.',
    tags: ['service-desk'],
  },
];

// ---------------------------------------------------------------- requests

export interface RequestTemplate {
  key: string;
  catalogKey: string;
  serviceKey: string | null;
  weight: number;
  sources: [string, number][];
  title: Text;
  description: Text;
  formData: (v: Vars) => Record<string, unknown>;
  firstResponse: Text;
  workNotes: Text[];
  resolution: Text;
  tags: string[];
}

const PORTAL: [string, number][] = [['portal', 0.75], ['email', 0.2], ['phone', 0.05]];

export const REQUEST_TEMPLATES: RequestTemplate[] = [
  { key: 'access_share', catalogKey: 'access_request', serviceKey: 'end_user_support', weight: 5, sources: PORTAL, title: (v) => `Access to ${v.n % 2 ? 'Finance' : 'Projects'} shared drive for ${v.user}`, description: (v) => `Please grant ${v.user} read/write access to the ${v.n % 2 ? 'Finance' : 'Projects'} share on the file server. Approved by the department head.`, formData: (v) => ({ system: `${v.n % 2 ? 'Finance' : 'Projects'} shared drive (${v.cust.short}-fs01)`, accessLevel: v.n % 3 ? 'write' : 'read', justification: `${v.user} joined the ${v.n % 2 ? 'finance' : 'projects'} team and needs the shared folders for month-end work.` }), firstResponse: (v) => `${greet(v)} the request has been approved; we are adding the account to the security group now.`, workNotes: [() => 'Added user to the AD security group; verified NTFS permissions on the share.'], resolution: () => 'Access granted via security group membership; user confirmed access.', tags: ['request', 'access'] },
  { key: 'access_vpn', catalogKey: 'access_request', serviceKey: 'network_management', weight: 3, sources: PORTAL, title: (v) => `VPN access for ${v.user}`, description: (v) => `${v.user} needs SSL-VPN access to work from home for the next quarter.`, formData: (v) => ({ system: 'SSL-VPN (FortiClient)', accessLevel: 'read', justification: `${v.user} is working remotely for the next quarter.` }), firstResponse: (v) => `${greet(v)} approval received; the VPN profile and MFA enrolment instructions are on the way.`, workNotes: [() => 'Created VPN user in the remote-access group; MFA enrolled; FortiClient profile sent.'], resolution: () => 'VPN account created with MFA; connection tested successfully with the user.', tags: ['request', 'vpn'] },
  { key: 'new_user', catalogKey: 'new_user', serviceKey: 'end_user_support', weight: 4, sources: PORTAL, title: (v) => `New joiner onboarding - ${v.user} (${v.n % 2 ? 'Operations' : 'Sales'})`, description: (v) => `New employee ${v.user} starting next Monday. Needs AD account, mailbox, Teams and a laptop with the standard image.`, formData: (v) => ({ fullName: v.user, department: v.n % 2 ? 'Operations' : 'Sales', startDate: '2026-10-13', needsLaptop: true }), firstResponse: (v) => `${greet(v)} onboarding approved; accounts will be ready one day before the start date.`, workNotes: [() => 'AD account, mailbox and licences created; laptop imaged and enrolled in Intune.'], resolution: () => 'User account, mailbox, Teams and laptop provisioned; credentials shared with the manager.', tags: ['request', 'onboarding'] },
  { key: 'software_install', catalogKey: 'software_install', serviceKey: 'end_user_support', weight: 4, sources: PORTAL, title: (v) => `Install ${v.n % 2 ? 'Adobe Acrobat Pro' : 'AutoCAD LT 2026'} for ${v.user}`, description: (v) => `Please install ${v.n % 2 ? 'Adobe Acrobat Pro' : 'AutoCAD LT 2026'} on ${v.user}'s laptop. Licence available in the volume agreement.`, formData: (v) => ({ software: v.n % 2 ? 'Adobe Acrobat Pro DC' : 'AutoCAD LT 2026', device: `${v.cust.short}-lt-${String(v.n % 90).padStart(3, '0')}`, licenseAvailable: true }), firstResponse: (v) => `${greet(v)} we will push the installation through the software center; it needs the laptop online for 30 minutes.`, workNotes: [() => 'Deployed via Intune; installation confirmed on the device.'], resolution: () => 'Software installed and licence activated; user verified.', tags: ['request', 'software'] },
  { key: 'fw_rule', catalogKey: 'config_change', serviceKey: 'network_management', weight: 4, sources: PORTAL, title: (v) => `Firewall rule for new ${v.n % 2 ? 'SFTP' : 'API'} integration with ${v.n % 2 ? 'bank' : 'logistics partner'}`, description: (v) => `Allow outbound ${v.n % 2 ? 'SFTP (22)' : 'HTTPS (443)'} from the application server ${v.host} to the partner endpoint ${v.n % 2 ? 'sftp.partner.example' : 'api.partner.example'}.`, formData: (v) => ({ system: `Firewall ${v.cust.short}-fw01`, change: `Allow ${v.n % 2 ? 'TCP/22' : 'TCP/443'} from ${v.host} to partner endpoint`, window: 'Any time (no downtime expected)' }), firstResponse: (v) => `${greet(v)} approved; the rule will be added today and tested with your application team.`, workNotes: [() => 'Rule added with logging enabled; connectivity test successful from the application server.'], resolution: () => 'Firewall policy added and verified; configuration backup taken.', tags: ['request', 'firewall'] },
  { key: 'vlan_change', catalogKey: 'config_change', serviceKey: 'network_management', weight: 2, sources: PORTAL, title: (v) => `Create VLAN for new ${v.n % 2 ? 'CCTV' : 'IoT sensors'} at ${v.site?.name ?? 'site'}`, description: (v) => `Please create a dedicated VLAN for the new ${v.n % 2 ? 'CCTV cameras' : 'IoT sensors'} at ${v.site?.name ?? 'the site'} with internet access blocked except the vendor cloud.`, formData: (v) => ({ system: `${v.host} and site firewall`, change: `New VLAN ${200 + (v.n % 50)} with DHCP scope and restricted firewall policy`, window: 'Saturday 10:00-12:00' }), firstResponse: (v) => `${greet(v)} the VLAN design is ready; implementation in the requested Saturday window.`, workNotes: [() => 'VLAN, SVI, DHCP scope and firewall policy configured; vendor cloud reachable, internet blocked.'], resolution: () => 'VLAN created with DHCP and restrictive policy; ports assigned per the camera list.', tags: ['request', 'vlan'] },
  { key: 'restore_files', catalogKey: 'backup_restore', serviceKey: 'backup_management', weight: 3, sources: PORTAL, title: (v) => `Restore deleted folder "${v.n % 2 ? 'Q2 Audit' : 'Tender 2026'}" from backup`, description: (v) => `The folder was deleted accidentally from the shared drive ${v.n % 5 + 1} days ago. Please restore the latest version to the original location.`, formData: (v) => ({ what: `Shared drive folder "${v.n % 2 ? 'Q2 Audit' : 'Tender 2026'}"`, pointInTime: `${v.n % 5 + 1} days ago, end of day`, target: 'Original location' }), firstResponse: (v) => `${greet(v)} we have located the restore point and are restoring the folder now.`, workNotes: [() => 'Restored from the nightly backup; 1,240 files, 3.2 GB.'], resolution: () => 'Folder restored to the original location from the backup taken before the deletion; requester verified contents.', tags: ['request', 'restore'] },
  { key: 'new_device', catalogKey: 'new_device', serviceKey: 'end_user_support', weight: 2, sources: PORTAL, title: (v) => `Provision ${2 + (v.n % 4)} laptops for the ${v.n % 2 ? 'sales' : 'engineering'} team`, description: (v) => `Please provision ${2 + (v.n % 4)} standard laptops with the corporate image for new team members joining next month.`, formData: (v) => ({ deviceType: 'Laptop - standard (ThinkPad T14)', quantity: 2 + (v.n % 4), site: v.site?.name ?? 'Head office' }), firstResponse: (v) => `${greet(v)} approved; devices will be imaged and delivered to the site in 5 working days.`, workNotes: [() => 'Devices received from stock, imaged, enrolled in Intune and asset-tagged.'], resolution: () => 'Laptops provisioned, asset-tagged and handed over; assets added to the register.', tags: ['request', 'hardware'] },
  { key: 'cert_renewal', catalogKey: 'certificate_renewal', serviceKey: 'server_management', weight: 3, sources: [['portal', 0.5], ['monitoring', 0.3], ['email', 0.2]], title: (v) => `Renew TLS certificate for ${v.app} (expires in ${10 + (v.n % 20)} days)`, description: (v) => `The public certificate for ${v.app} expires in ${10 + (v.n % 20)} days. Please renew with the same SAN list and install on the load balancer.`, formData: (v) => ({ domain: `${v.app.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${v.cust.short}.example`, expiry: '2026-10-25' }), firstResponse: (v) => `${greet(v)} CSR generated; the renewed certificate will be installed in the next maintenance window.`, workNotes: [() => 'Certificate issued by the CA; installed on the load balancer and verified with SSL Labs (A rating).'], resolution: () => 'Certificate renewed and installed; expiry monitoring updated.', tags: ['request', 'certificate'] },
  { key: 'report_request', catalogKey: 'report_request', serviceKey: null, weight: 2, sources: PORTAL, title: (v) => `${v.n % 2 ? 'SLA compliance' : 'Asset inventory'} report for the ${v.n % 2 ? 'quarterly review' : 'audit'}`, description: (v) => `Please share the ${v.n % 2 ? 'SLA compliance report for last quarter' : 'full asset inventory with warranty status'} for our ${v.n % 2 ? 'quarterly service review' : 'internal audit'}.`, formData: (v) => ({ report: v.n % 2 ? 'SLA compliance by priority and service' : 'Asset inventory with warranty and AMC dates', period: v.n % 2 ? 'Last quarter' : 'Current' }), firstResponse: (v) => `${greet(v)} the report is being prepared and will be shared through the portal.`, workNotes: [() => 'Report generated from the platform and uploaded to the portal documents.'], resolution: () => 'Report delivered through the portal and by email.', tags: ['request', 'report'] },
  { key: 'maintenance_window', catalogKey: 'maintenance_request', serviceKey: 'amc_support', weight: 2, sources: PORTAL, title: (v) => `Maintenance window for server room ${v.n % 2 ? 'AC servicing' : 'electrical work'} at ${v.site?.name ?? 'site'}`, description: (v) => `Facilities need to ${v.n % 2 ? 'service the server room air conditioning' : 'replace the distribution board'} next weekend. Please plan a controlled shutdown and start-up of the equipment.`, formData: (v) => ({ scope: `Controlled shutdown and start-up of the ${v.site?.name ?? 'site'} server room`, preferredDate: '2026-10-18' }), firstResponse: (v) => `${greet(v)} we have scheduled an engineer for the shutdown and start-up with a documented sequence.`, workNotes: [() => 'Shutdown sequence executed at 08:00, start-up at 14:30; all services verified.'], resolution: () => 'Maintenance window completed; all systems started and verified.', tags: ['request', 'maintenance'] },
];

// ---------------------------------------------------------------- problems

export interface ProblemTemplate {
  key: string;
  categoryKey: string;
  subcategoryKey?: string;
  serviceKey: string;
  ciTypes: string[];
  relatedIncidentKeys: string[];
  title: Text;
  description: Text;
  symptoms: Text;
  investigation: Text;
  rootCause: Text;
  workaround: Text;
  permanentFix: Text;
  impactSummary: Text;
  resolution: Text;
  /** Customer-facing wording of the known error, as the portal shows it once published. */
  customerSummary: string;
  customerWorkaround: string;
  tags: string[];
}

export const PROBLEM_TEMPLATES: ProblemTemplate[] = [
  { key: 'wan_flaps', categoryKey: 'network', subcategoryKey: 'wan_link', serviceKey: 'network_management', ciTypes: ['router'], relatedIncidentKeys: ['wan_flap', 'branch_unreachable'], title: (v) => `Recurring MPLS link flaps on ${v.host}`, description: (v) => `Three incidents in the last month for the MPLS circuit on ${v.host}; each time the ISP reported a transient issue. Problem opened to find the underlying cause.`, symptoms: () => 'Link goes down for 30-90 seconds several times per week, mostly in the afternoon; BGP resets; branch sessions drop.', investigation: () => 'Correlated flap times with the ISP NNI logs and the building power logs; found the media converter in the comms room restarts when the AC compressor starts (shared socket).', rootCause: () => 'ISP media converter powered from an unprotected socket shared with the air-conditioning unit; voltage dips reboot it.', workaround: () => 'Media converter moved to the UPS-backed power strip.', permanentFix: () => 'ISP to replace the media converter with a UPS-fed managed unit; building electrical circuit to be separated.', impactSummary: () => 'Branch productivity loss ~2 hours/week; 3 incidents, 1 SLA breach.', resolution: () => 'Root cause confirmed and permanent fix implemented by the ISP; no flaps in 30 days. Known error closed.', customerSummary: 'The site\'s WAN link drops for a minute or two several times a week, mostly in the afternoon; branch applications disconnect briefly.', customerWorkaround: 'Wait a minute and reconnect; the link recovers on its own. Keep the comms room socket free of other equipment until the permanent fix is in place.', tags: ['problem', 'wan'] },
  { key: 'backup_vss', categoryKey: 'backup', subcategoryKey: 'job_failure', serviceKey: 'backup_management', ciTypes: ['backup_system'], relatedIncidentKeys: ['backup_job_failed'], title: (v) => `Repeated VSS snapshot failures in backup jobs on ${v.host}`, description: () => 'Backup jobs fail two or three times a week with VSS freeze timeouts on SQL and file servers; manual reruns succeed.', symptoms: () => 'VSSControl timeout errors on the first attempt; retries succeed; backup window extends past 06:00.', investigation: () => 'Timeouts coincide with the antivirus full scan schedule on the guests (02:00); VSS freeze exceeds 60 seconds when the scan runs.', rootCause: () => 'Antivirus full scan overlapping with the backup window increases VSS freeze time beyond the timeout.', workaround: () => 'Rerun failed jobs after 04:00 when the scan completes.', permanentFix: () => 'Move the antivirus full scan to 22:00 and exclude the backup agent processes.', impactSummary: () => '11 incidents in 2 months; extended backup window; RPO at risk on affected nights.', resolution: () => 'Antivirus scan schedule moved and exclusions applied; no VSS timeouts in 3 weeks.', customerSummary: 'Nightly backups of some servers report a failure on the first attempt and succeed on retry; backup windows run late.', customerWorkaround: 'No action is needed on your side; our team reruns failed jobs after 04:00 and verifies the backup before the working day.', tags: ['problem', 'backup'] },
  { key: 'app_memory_leak', categoryKey: 'server', subcategoryKey: 'service_down', serviceKey: 'server_management', ciTypes: ['application'], relatedIncidentKeys: ['service_down', 'app_503', 'high_cpu'], title: (v) => `Memory leak in ${v.app} service causing weekly restarts`, description: (v) => `${v.app} degrades after ~6 days of uptime (thread pool exhaustion, 503 errors). Vendor engaged.`, symptoms: () => 'Heap usage climbs steadily; worker threads exhausted; HTTP 503 until the service is restarted.', investigation: () => 'Heap dumps show unreleased database connections from the reporting module introduced in build 12.4.', rootCause: () => 'Connection leak in the reporting module of the vendor application (build 12.4).', workaround: () => 'Scheduled weekly restart on Sunday 03:00 via the automation platform.', permanentFix: () => 'Vendor hotfix 12.4.2 (ETA next month) to be deployed through a normal change.', impactSummary: () => '4 outages with business impact in 6 weeks; major incident process invoked twice.', resolution: () => 'Vendor hotfix deployed; heap stable for 21 days. Weekly restart job removed.', customerSummary: 'The application slows down and shows errors after about six days of running.', customerWorkaround: 'A scheduled restart every Sunday at 03:00 keeps the service healthy; if errors appear earlier, raise a ticket and we restart it within the hour.', tags: ['problem', 'application', 'known-error'] },
  { key: 'wifi_disconnects', categoryKey: 'network', subcategoryKey: 'wifi', serviceKey: 'network_management', ciTypes: ['access_point'], relatedIncidentKeys: ['wifi_down'], title: (v) => `Intermittent wireless disconnects at ${v.site?.name ?? 'site'}`, description: () => 'Users report Wi-Fi drops several times a day; handheld scanners lose session state. Multiple incidents logged.', symptoms: () => 'Clients roam between APs and drop for 10-20 seconds; worst near the loading bay.', investigation: () => 'RF survey shows DFS channel changes triggered by nearby radar and co-channel interference from a neighbouring warehouse network.', rootCause: () => 'DFS events on 5 GHz channels plus insufficient AP density in the loading bay.', workaround: () => 'APs pinned to non-DFS channels; scanners set to prefer 2.4 GHz.', permanentFix: () => 'Add two APs in the loading bay and enable 802.11r fast roaming (change raised).', impactSummary: () => 'Warehouse picking slowed; 6 incidents in one month.', resolution: () => 'Additional APs installed and fast roaming enabled; no disconnects reported in 4 weeks.', customerSummary: 'Wireless clients, especially handheld scanners near the loading bay, drop for 10-20 seconds.', customerWorkaround: 'Set handheld scanners to prefer the 2.4 GHz network; additional access points are planned.', tags: ['problem', 'wifi'] },
  { key: 'storage_latency', categoryKey: 'storage', subcategoryKey: 'san', serviceKey: 'storage_management', ciTypes: ['storage_array'], relatedIncidentKeys: ['vm_frozen', 'slow_erp'], title: (v) => `Storage latency spikes on ${v.host} during the backup window`, description: () => 'Datastore latency exceeds 50 ms between 01:00 and 03:00, causing VM stalls and a kernel panic on one VM.', symptoms: () => 'High write latency on the SATA aggregate; VMs with heavy IO stall; alerts from vCenter.', investigation: () => 'Backup proxy uses hot-add on the same aggregate; concurrent backup and ERP batch jobs saturate the disks.', rootCause: () => 'Backup proxy hot-add traffic and ERP batch jobs competing for the same SATA aggregate.', workaround: () => 'Backup jobs staggered; ERP batch moved 1 hour earlier.', permanentFix: () => 'Move the backup repository and ERP data to the SSD aggregate (capacity expansion approved).', impactSummary: () => 'Nightly performance degradation; 2 VM incidents.', resolution: () => 'Data moved to the SSD aggregate; latency under 5 ms during the backup window.', customerSummary: 'Some systems respond slowly between 01:00 and 03:00.', customerWorkaround: 'Schedule heavy batch jobs outside 01:00-03:00 until the storage capacity expansion completes.', tags: ['problem', 'storage'] },
  { key: 'esxi_hostd', categoryKey: 'virtualization', subcategoryKey: 'hypervisor', serviceKey: 'virtualization_management', ciTypes: ['hypervisor'], relatedIncidentKeys: ['esxi_disconnected'], title: (v) => `ESXi management agent memory leak on ${v.host} (hosts disconnect from vCenter)`, description: () => 'Hosts disconnect from vCenter roughly every two weeks; VMs keep running. Agent restart restores management.', symptoms: () => 'Host "Not responding" in vCenter; hostd memory high; VMs unaffected.', investigation: () => 'VMware KB 93423 matches the hostd memory leak in ESXi 8.0 U2 with a specific NIC driver.', rootCause: () => 'Known hostd memory leak in ESXi 8.0 U2 with the i40en driver version in use.', workaround: () => 'Restart management agents when memory exceeds threshold (monitored).', permanentFix: () => 'Upgrade hosts to ESXi 8.0 U3 (normal change).', impactSummary: () => 'HA/DRS unavailable during disconnects; 5 incidents.', resolution: () => 'Hosts upgraded to ESXi 8.0 U3; no disconnects since.', customerSummary: 'Management of some virtual servers is briefly unavailable about every two weeks; the servers themselves keep running.', customerWorkaround: 'No action needed; our monitoring restarts the management agent automatically. Maintenance to upgrade the hosts is scheduled.', tags: ['problem', 'vmware', 'known-error'] },
];

// ---------------------------------------------------------------- changes

export interface ChangeTemplate {
  key: string;
  changeType: 'standard' | 'normal' | 'emergency';
  riskKey: 'low' | 'medium' | 'high' | 'very_high';
  categoryKey: string;
  serviceKey: string;
  ciTypes: string[];
  downtimeMinutes: number;
  title: Text;
  description: Text;
  justification: Text;
  riskAssessment: Text;
  impactAssessment: Text;
  implementationPlan: Text;
  testPlan: Text;
  backoutPlan: Text;
  communicationPlan: Text;
  implementationNotes: Text;
  pirNotes: Text;
  tags: string[];
  relatedIncidentKeys?: string[];
}

export const CHANGE_TEMPLATES: ChangeTemplate[] = [
  { key: 'fw_firmware', changeType: 'normal', riskKey: 'high', categoryKey: 'network', serviceKey: 'network_management', ciTypes: ['firewall'], downtimeMinutes: 20, title: (v) => `Firewall firmware upgrade on ${v.host} to FortiOS 7.4.5`, description: (v) => `Upgrade ${v.host} from the current FortiOS build to 7.4.5 to address published vulnerabilities and the SSL-VPN stability issues.`, justification: () => 'Security advisory (critical CVE) and vendor end-of-support for the current build.', riskAssessment: () => 'HA pair: upgrade is performed node by node; risk of policy incompatibility is low (release notes reviewed).', impactAssessment: () => 'Up to 20 minutes of VPN disconnection during the HA failover; LAN traffic unaffected.', implementationPlan: () => '1. Backup configuration. 2. Upgrade secondary node and verify. 3. Failover, upgrade primary. 4. Validate policies, VPN tunnels and logging.', testPlan: () => 'Verify HA sync, run connectivity tests for VPN tunnels, SSL-VPN login, IPS logging to SIEM.', backoutPlan: () => 'Revert to previous firmware partition on each node and restore the saved configuration.', communicationPlan: () => 'Customer IT notified 48 hours ahead; status updates on the ticket during the window.', implementationNotes: () => 'Upgrade completed in 35 minutes; one tunnel required a manual re-key. All checks passed.', pirNotes: () => 'Successful. Lesson: pre-stage firmware on both nodes to shorten the window.', tags: ['change', 'firmware'], relatedIncidentKeys: ['critical_cve', 'vpn_down'] },
  { key: 'core_ios_upgrade', changeType: 'normal', riskKey: 'high', categoryKey: 'network', serviceKey: 'network_management', ciTypes: ['network_switch'], downtimeMinutes: 30, title: (v) => `Core switch software upgrade on ${v.host}`, description: (v) => `Upgrade ${v.host} to the recommended release train to fix the PSU/boot issue seen in the recent outage and enable ISSU.`, justification: () => 'Recommended release by TAC after the recent outage RCA.', riskAssessment: () => 'Stack reload required; full site outage of ~30 minutes if ISSU is not possible.', impactAssessment: () => 'All users at the site lose connectivity during the reload; scheduled outside production hours.', implementationPlan: () => 'Stage image, verify checksum, install mode upgrade, reload during window, validate stack and uplinks.', testPlan: () => 'Verify stack members, spanning-tree, uplink LACP, server reachability and PRTG sensors.', backoutPlan: () => 'Boot the previous image from flash; configuration unchanged.', communicationPlan: () => 'Plant head and IT notified; shift supervisor on site during the window.', implementationNotes: () => 'Completed with ISSU; no downtime observed.', pirNotes: () => 'Successful; ISSU validated for future upgrades.', tags: ['change', 'network'], relatedIncidentKeys: ['core_switch_down'] },
  { key: 'storage_expand', changeType: 'normal', riskKey: 'medium', categoryKey: 'storage', serviceKey: 'storage_management', ciTypes: ['storage_array'], downtimeMinutes: 0, title: (v) => `Add 2 x 7.68 TB SSD shelf to ${v.host} and migrate backup repository`, description: (v) => `Install the new SSD shelf on ${v.host}, create an SSD aggregate and migrate the backup repository and ERP volumes to it.`, justification: () => 'Resolves the storage latency problem and the capacity warnings.', riskAssessment: () => 'Non-disruptive; shelf installation is hot-add; data moved with volume move.', impactAssessment: () => 'No downtime; temporary performance impact during volume moves (scheduled at night).', implementationPlan: () => 'Rack shelf, cable, assign disks, create aggregate, volume move vol_backup and vol_erp, verify.', testPlan: () => 'Check latency dashboards during the backup window; verify backups succeed.', backoutPlan: () => 'Volume move back to the original aggregate.', communicationPlan: () => 'Customer IT informed; no user communication needed.', implementationNotes: () => 'Shelf installed by the field engineer; volume moves completed in 6 hours.', pirNotes: () => 'Successful; latency reduced from 50 ms to under 5 ms.', tags: ['change', 'storage'] },
  { key: 'emergency_patch', changeType: 'emergency', riskKey: 'medium', categoryKey: 'server', serviceKey: 'server_management', ciTypes: ['virtual_machine', 'hypervisor'], downtimeMinutes: 15, title: (v) => `Emergency patch for critical vulnerability on ${v.host}`, description: (v) => `Apply the vendor emergency patch on ${v.host} for the actively exploited vulnerability announced today.`, justification: () => 'Exploitation in the wild; SOC advisory recommends immediate patching.', riskAssessment: () => 'Patch tested on the DR replica; reboot required.', impactAssessment: () => 'Service restart (~15 minutes) outside peak hours.', implementationPlan: () => 'Snapshot, apply patch, reboot, validate service.', testPlan: () => 'Vulnerability scan after patching; application smoke test.', backoutPlan: () => 'Revert snapshot.', communicationPlan: () => 'Customer ISO informed by phone; ticket updates.', implementationNotes: () => 'Patched and rebooted; scan clean.', pirNotes: () => 'Successful; emergency process followed, CAB informed retrospectively.', tags: ['change', 'emergency', 'security'], relatedIncidentKeys: ['critical_cve'] },
  { key: 'vm_migration', changeType: 'normal', riskKey: 'medium', categoryKey: 'virtualization', serviceKey: 'virtualization_management', ciTypes: ['virtual_machine'], downtimeMinutes: 10, title: (v) => `Migrate ${v.host} to the new ESXi host cluster`, description: (v) => `Cold-migrate ${v.host} to the upgraded cluster and update VM hardware version and VMware Tools.`, justification: () => 'Consolidation onto the new cluster before the old hosts are decommissioned.', riskAssessment: () => 'Low; migration rehearsed with a test VM.', impactAssessment: () => '10 minutes downtime for the VM.', implementationPlan: () => 'Snapshot, power off, migrate, upgrade hardware version, power on, validate.', testPlan: () => 'Application login and integration checks.', backoutPlan: () => 'Migrate back to the original host; revert snapshot if needed.', communicationPlan: () => 'Application owner informed of the window.', implementationNotes: () => 'Migrated in 8 minutes; tools upgraded.', pirNotes: () => 'Successful.', tags: ['change', 'vmware'] },
  { key: 'ups_battery', changeType: 'normal', riskKey: 'high', categoryKey: 'hardware', serviceKey: 'amc_support', ciTypes: ['ups'], downtimeMinutes: 0, title: (v) => `Replace battery strings on ${v.host}`, description: (v) => `Replace both battery strings on ${v.host} following the health check findings (runtime below specification).`, justification: () => 'Runtime of 14 minutes against a required 20 minutes; batteries beyond service life.', riskAssessment: () => 'UPS in bypass during replacement; power protection unavailable for ~2 hours.', impactAssessment: () => 'No planned downtime; risk window during bypass.', implementationPlan: () => 'Transfer to maintenance bypass, replace strings, calibrate, runtime test, return to normal operation.', testPlan: () => 'Runtime test at 50% load; alarms clear; monitoring sensors green.', backoutPlan: () => 'Keep old strings on site until the test passes; reinstall if required.', communicationPlan: () => 'Facilities and IT informed; generator on standby.', implementationNotes: () => 'Completed; runtime now 24 minutes.', pirNotes: () => 'Pending review.', tags: ['change', 'ups', 'amc'], relatedIncidentKeys: ['ups_health'] },
  { key: 'monthly_patching', changeType: 'standard', riskKey: 'low', categoryKey: 'server', serviceKey: 'server_management', ciTypes: ['virtual_machine'], downtimeMinutes: 30, title: (v) => `Monthly Windows patching - ${v.site?.name ?? 'site'} servers (${v.n % 2 ? 'September' : 'October'} cycle)`, description: (v) => `Standard monthly patching of the Windows servers at ${v.site?.name ?? 'the site'} including ${v.host} per the approved patch baseline.`, justification: () => 'Standard pre-approved change (patch policy).', riskAssessment: () => 'Low; patches tested on the pilot group for one week.', impactAssessment: () => 'Reboots within the maintenance window; services unavailable for up to 30 minutes.', implementationPlan: () => 'Snapshot, install via WSUS, reboot in dependency order (DC, DB, app), validate.', testPlan: () => 'Service checks via PRTG and application smoke tests.', backoutPlan: () => 'Uninstall problematic KB or revert snapshot within 24 hours.', communicationPlan: () => 'Standard notice to customer IT 3 days ahead.', implementationNotes: () => 'All servers patched; one server required a second reboot.', pirNotes: () => 'Successful.', tags: ['change', 'patching', 'standard'] },
  { key: 'fw_rule_sap', changeType: 'normal', riskKey: 'medium', categoryKey: 'network', serviceKey: 'network_management', ciTypes: ['firewall'], downtimeMinutes: 0, title: (v) => `Firewall policy changes for the new ${v.app} integration`, description: (v) => `Add policies on ${v.host} for the new interface between ${v.app} and the partner API, including NAT and IPS profiles.`, justification: () => 'Business requirement for the partner integration go-live.', riskAssessment: () => 'Medium: new inbound NAT; mitigated with IPS and geo restrictions.', impactAssessment: () => 'None expected.', implementationPlan: () => 'Create address objects, policies, NAT; enable logging; test with the application team.', testPlan: () => 'Partner connectivity test; verify logs in SIEM.', backoutPlan: () => 'Disable the new policies.', communicationPlan: () => 'Application team on the test call.', implementationNotes: () => 'Implemented; partner test failed on first attempt due to a wrong port, corrected.', pirNotes: () => 'Successful after correction; port documented in the request.', tags: ['change', 'firewall'] },
  { key: 'ap_rollout', changeType: 'normal', riskKey: 'low', categoryKey: 'network', serviceKey: 'network_management', ciTypes: ['access_point'], downtimeMinutes: 0, title: (v) => `Install additional access points and enable fast roaming at ${v.site?.name ?? 'site'}`, description: () => 'Install two additional APs in the loading bay and enable 802.11r on the corporate SSID as the permanent fix for the wireless disconnects problem.', justification: () => 'Permanent fix for the known error on wireless disconnects.', riskAssessment: () => 'Low; SSID change may require older clients to reconnect.', impactAssessment: () => 'Brief client reconnects when 802.11r is enabled.', implementationPlan: () => 'Mount and cable APs, provision in the controller, enable 802.11r, validate coverage.', testPlan: () => 'Roaming test with scanners along the picking route; RF survey after.', backoutPlan: () => 'Disable 802.11r; APs can stay.', communicationPlan: () => 'Warehouse supervisor informed; done before the morning shift.', implementationNotes: () => 'Completed; roaming times under 50 ms.', pirNotes: () => 'Successful.', tags: ['change', 'wifi'] },
];
