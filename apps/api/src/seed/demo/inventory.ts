import { eq, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import { type DemoCustomer, type DemoSite, type DemoState } from './state';
import { addDays, hashHex, isoDate, type Rng } from './rng';

interface AssetSpec {
  categoryKey: string;
  manufacturer: string;
  model: string;
  partNumber?: string;
  cost: number;
  lifecycle?: string;
  statusKey?: string;
  rack?: string;
}

interface CiSpec {
  key: string;
  typeKey: string;
  name: string;
  hostname?: string;
  ip?: string;
  siteKey: string | null;
  asset?: AssetSpec;
  attrs?: Record<string, unknown>;
  os?: string;
  osVersion?: string;
  firmware?: string;
  criticality: 'critical' | 'high' | 'medium' | 'low';
  environment?: string;
  ownerTeamKey: string;
  monitored?: boolean;
  siem?: boolean;
  tags?: string[];
  description?: string;
  serviceKeys?: string[];
  status?: string;
}

type Rel = [string, string, string, string?];

const BUSINESS_SERVICES: Record<string, [string, string][]> = {
  abc: [['SAP ERP (Production)', 'tier1'], ['Plant Floor Connectivity', 'tier1']],
  meridian: [['Core Banking (Finacle)', 'tier1'], ['Internet Banking Portal', 'tier1']],
  northwind: [['LIMS & Electronic Batch Records', 'tier1'], ['Email & Collaboration', 'tier2']],
  apex: [['Store POS', 'tier1'], ['E-commerce Platform', 'tier2']],
  helios: [['Energy Management Portal', 'tier2'], ['Corporate Email', 'tier2']],
  sterling: [['Hospital Information System', 'tier1'], ['PACS Imaging', 'tier1']],
  orbital: [['Warehouse Management System', 'tier1'], ['Track & Trace Portal', 'tier2']],
  quantum: [['Customer Delivery Platform', 'tier1'], ['DevOps Toolchain', 'tier2']],
  riverside: [['Learning Management System', 'tier2'], ['Campus Wi-Fi', 'tier1']],
  crestline: [['Opera PMS', 'tier1'], ['Guest Services Portal', 'tier2']],
};

const APP_STACK: Record<string, { app: string; vendor: string; db: string; engine: string; port: number; url: string }> = {
  abc: { app: 'SAP ERP ECC 6.0', vendor: 'SAP', db: 'SAP HANA (ERP)', engine: 'SAP HANA', port: 30015, url: 'https://sap.abc.local' },
  meridian: { app: 'Finacle Core Banking', vendor: 'Infosys', db: 'Finacle Oracle DB', engine: 'Oracle 19c', port: 1521, url: 'https://finacle.mrd.local' },
  northwind: { app: 'LabWare LIMS', vendor: 'LabWare', db: 'LIMS SQL Database', engine: 'Microsoft SQL Server 2019', port: 1433, url: 'https://lims.nwp.local' },
  apex: { app: 'POS Central Server', vendor: 'Oracle Retail', db: 'POS Transactions DB', engine: 'Microsoft SQL Server 2022', port: 1433, url: 'https://pos.apx.local' },
  helios: { app: 'Energy Management Portal', vendor: 'In-house (.NET)', db: 'EMS Database', engine: 'PostgreSQL 15', port: 5432, url: 'https://ems.hel.local' },
  sterling: { app: 'HIS (Hospital Information System)', vendor: 'Medeil', db: 'HIS Oracle DB', engine: 'Oracle 19c', port: 1521, url: 'https://his.stl.local' },
  orbital: { app: 'WMS Web Front-end', vendor: 'Infor', db: 'WMS Database', engine: 'PostgreSQL 14', port: 5432, url: 'https://wms.orb.local' },
  quantum: { app: 'Delivery Platform (Jira/Confluence)', vendor: 'Atlassian', db: 'Atlassian PostgreSQL', engine: 'PostgreSQL 15', port: 5432, url: 'https://jira.qit.local' },
  riverside: { app: 'Moodle LMS', vendor: 'Moodle', db: 'Moodle MariaDB', engine: 'MariaDB 10.11', port: 3306, url: 'https://lms.rvu.local' },
  crestline: { app: 'Opera PMS', vendor: 'Oracle Hospitality', db: 'Opera Oracle DB', engine: 'Oracle 19c', port: 1521, url: 'https://opera.crl.local' },
};

const SERVER_MODELS: [string, string, number][] = [['Dell', 'PowerEdge R750', 1250000], ['HPE', 'ProLiant DL380 Gen10 Plus', 1180000], ['Lenovo', 'ThinkSystem SR650 V2', 1095000]];
const CORE_SW: [string, string, number][] = [['Cisco', 'Catalyst 9300-48P', 820000], ['Aruba', 'CX 6300M 48G', 690000]];
const ACC_SW: [string, string, number][] = [['Cisco', 'Catalyst 9200L-48P-4G', 285000], ['Aruba', '2930F-48G-PoE+', 210000]];
const AP_MODELS: [string, string, number][] = [['Aruba', 'AP-515', 62000], ['Cisco', 'C9120AXI-D', 71000]];
const STORAGE: [string, string, number][] = [['NetApp', 'FAS2750', 3400000], ['Dell', 'PowerStore 500T', 4100000], ['Synology', 'RackStation RS3621xs+', 480000]];
const LAPTOPS: [string, string, number][] = [['Lenovo', 'ThinkPad T14 Gen 4', 98000], ['Dell', 'Latitude 5540', 92000], ['HP', 'EliteBook 840 G10', 105000]];
const PRINTERS: [string, string, number][] = [['HP', 'LaserJet Enterprise M507dn', 48000], ['Canon', 'imageRUNNER 2630i', 165000]];

function mac(seed: string) {
  const h = hashHex(seed, 12);
  return `00:1A:${h.slice(0, 2)}:${h.slice(2, 4)}:${h.slice(4, 6)}:${h.slice(6, 8)}`;
}

const serial = (prefix: string, seed: string) => `${prefix}${hashHex(seed, 9)}`;

function buildSite(cust: DemoCustomer, site: DemoSite, rng: Rng, specs: CiSpec[], rels: Rel[], tier: 'main' | 'large' | 'small') {
  const c = cust.short;
  const s = site.code.toLowerCase().replace(/^(st|br|wh)-/, '');
  const h = (role: string) => `${c}-${s}-${role}`;
  const ip = (last: number) => `10.${cust.index}.${site.subnet}.${last}`;
  const soc = cust.domains.soc;
  const env = site.typeKey === 'data_center' ? 'dr' : 'production';
  const pick = <T>(arr: readonly T[]) => rng.pick(arr);
  const large = tier !== 'small';
  const main = tier === 'main';
  const endpointCis = main && (cust.domains.soc || cust.domains.eus);

  const fwModel = large ? (rng.chance(0.7) ? 'FortiGate 200F' : 'FortiGate 100F') : 'FortiGate 60F';
  specs.push({ key: `${site.key}:fw`, typeKey: 'firewall', name: `${site.name} Firewall`, hostname: h('fw01'), ip: ip(1), siteKey: site.key, criticality: large ? 'critical' : 'high', environment: env, ownerTeamKey: 'network', monitored: true, siem: soc, os: 'FortiOS', osVersion: rng.pick(['7.4.3', '7.4.5', '7.2.8']), firmware: 'v7.4.3 build2573', asset: large || rng.chance(0.7) ? { categoryKey: 'firewall', manufacturer: 'Fortinet', model: fwModel, cost: large ? 640000 : 145000, rack: large ? 'R1/U40' : 'Cabinet 1' } : undefined, attrs: { haMode: large ? 'active_passive' : 'standalone', licenseExpiry: isoDate(addDays(new Date(), rng.int(-20, 400))) }, tags: ['perimeter', 'utm'], serviceKeys: ['network_management', ...(soc ? ['security_monitoring'] : [])] });
  const rtrModel = large ? 'ISR 4331' : 'ISR 1111-8P';
  if (large) specs.push({ key: `${site.key}:rtr`, typeKey: 'router', name: `${site.name} WAN Router`, hostname: h('rtr01'), ip: ip(254), siteKey: site.key, criticality: large ? 'high' : 'medium', environment: env, ownerTeamKey: 'network', monitored: true, os: 'IOS-XE', osVersion: '17.9.4a', asset: { categoryKey: 'router', manufacturer: 'Cisco', model: rtrModel, cost: large ? 310000 : 95000, rack: large ? 'R1/U42' : 'Cabinet 1' }, attrs: { wanProvider: rng.pick(['Airtel', 'Tata Communications', 'Jio Business', 'BT Business']), circuitId: `CKT-${hashHex(h('rtr01'), 6)}`, bandwidth: large ? '200 Mbps MPLS + 500 Mbps ILL' : '50 Mbps MPLS' }, tags: ['wan'], serviceKeys: ['network_management'] });
  if (large) rels.push([`${site.key}:fw`, `${site.key}:rtr`, 'connected_to', 'WAN uplink']);

  if (large) {
    const [cm, cmodel, ccost] = pick(CORE_SW);
    specs.push({ key: `${site.key}:core`, typeKey: 'network_switch', name: `${site.name} Core Switch`, hostname: h('core-sw01'), ip: ip(2), siteKey: site.key, criticality: 'critical', environment: env, ownerTeamKey: 'network', monitored: true, os: cm === 'Cisco' ? 'IOS-XE' : 'AOS-CX', osVersion: cm === 'Cisco' ? '17.9.4' : '10.13.1000', asset: { categoryKey: 'network_switch', manufacturer: cm, model: cmodel, cost: ccost, rack: 'R1/U38' }, attrs: { ports: 48, stackMember: '1 of 2', managementVlan: '10' }, tags: ['core', 'stack'], serviceKeys: ['network_management'] });
    rels.push([`${site.key}:core`, `${site.key}:fw`, 'connected_to', 'Core uplink to firewall (LACP)']);
    for (let i = 1; i <= (main ? 2 : 1); i++) {
      const [am, amodel, acost] = pick(ACC_SW);
      specs.push({ key: `${site.key}:acc${i}`, typeKey: 'network_switch', name: `${site.name} Access Switch ${i}`, hostname: h(`acc-sw0${i}`), ip: ip(2 + i), siteKey: site.key, criticality: 'medium', environment: env, ownerTeamKey: 'network', monitored: true, os: am === 'Cisco' ? 'IOS-XE' : 'ArubaOS-Switch', osVersion: am === 'Cisco' ? '17.6.5' : '16.11.0012', asset: { categoryKey: 'network_switch', manufacturer: am, model: amodel, cost: acost, rack: i === 1 ? 'R2/U30' : `Floor ${i} IDF` }, attrs: { ports: 48, managementVlan: '10' }, tags: ['access'], serviceKeys: ['network_management'] });
      rels.push([`${site.key}:acc${i}`, `${site.key}:core`, 'connected_to', '10G uplink']);
    }
    for (let i = 1; i <= 1; i++) {
      const [apm, apmodel, apcost] = pick(AP_MODELS);
      specs.push({ key: `${site.key}:ap${i}`, typeKey: 'access_point', name: `${site.name} AP ${i}`, hostname: h(`ap0${i}`), ip: ip(9 + i), siteKey: site.key, criticality: 'low', environment: env, ownerTeamKey: 'network', monitored: i === 1, firmware: apm === 'Aruba' ? '8.11.2.1' : '17.9.4.27', asset: { categoryKey: 'wireless', manufacturer: apm, model: apmodel, cost: apcost }, tags: ['wifi'], serviceKeys: ['network_management'] });
      rels.push([`${site.key}:ap${i}`, `${site.key}:acc1`, 'connected_to', 'PoE port']);
    }
    specs.push({ key: `${site.key}:ups`, typeKey: 'ups', name: `${site.name} UPS`, hostname: h('ups01'), ip: ip(40), siteKey: site.key, criticality: 'high', environment: env, ownerTeamKey: 'infra', monitored: true, firmware: 'UPS 06.4', asset: { categoryKey: 'ups', manufacturer: 'APC', model: 'Smart-UPS SRT 10kVA RM', cost: 520000, rack: 'R3/U1' }, attrs: { capacityKva: 10, batteryReplacedOn: isoDate(addDays(new Date(), -rng.int(200, 1100))) }, tags: ['power'], serviceKeys: ['noc_monitoring'] });
    rels.push([`${site.key}:core`, `${site.key}:ups`, 'depends_on', 'Powered via UPS feed A']);
    rels.push([`${site.key}:fw`, `${site.key}:ups`, 'depends_on']);

    const hostCount = main ? 2 : 1;
    for (let i = 1; i <= hostCount; i++) {
      const [sm, smodel, scost] = pick(SERVER_MODELS);
      specs.push({ key: `${site.key}:esx${i}`, typeKey: 'hypervisor', name: `${site.name} ESXi Host ${i}`, hostname: h(`esx0${i}`), ip: ip(19 + i), siteKey: site.key, criticality: 'critical', environment: env, ownerTeamKey: 'infra', monitored: true, siem: soc, os: 'VMware ESXi', osVersion: rng.pick(['8.0 U2', '8.0 U3', '7.0 U3']), asset: { categoryKey: 'server', manufacturer: sm, model: smodel, cost: scost, rack: `R1/U${10 + i * 2}` }, attrs: { platform: 'vmware', cluster: `${c.toUpperCase()}-${s.toUpperCase()}-CL01`, cpu: '2x Intel Xeon Gold 6338 (32c)', memoryGb: 512, rack: `R1/U${10 + i * 2}`, iloIp: ip(120 + i) }, tags: ['vmware', 'cluster'], serviceKeys: ['server_management', 'virtualization_management', ...(soc ? ['security_monitoring'] : [])] });
      rels.push([`${site.key}:esx${i}`, `${site.key}:core`, 'connected_to', '2x 10G LACP']);
      rels.push([`${site.key}:esx${i}`, `${site.key}:ups`, 'depends_on']);
      rels.push([`${site.key}:esx${i}`, `${site.key}:fw`, 'protected_by']);
    }
    const [stm, stmodel, stcost] = pick(STORAGE);
    specs.push({ key: `${site.key}:san`, typeKey: 'storage_array', name: `${site.name} Storage Array`, hostname: h('san01'), ip: ip(30), siteKey: site.key, criticality: 'critical', environment: env, ownerTeamKey: 'infra', monitored: true, os: stm === 'NetApp' ? 'ONTAP' : stm === 'Dell' ? 'PowerStoreOS' : 'DSM', osVersion: stm === 'NetApp' ? '9.13.1P4' : stm === 'Dell' ? '3.6.0' : '7.2.1', asset: { categoryKey: 'storage', manufacturer: stm, model: stmodel, cost: stcost, rack: 'R1/U4' }, attrs: { capacityTb: rng.pick([24, 48, 96]), protocol: stm === 'Synology' ? 'NFS/iSCSI' : 'FC/iSCSI' }, tags: ['storage'], serviceKeys: ['storage_management'] });
    for (let i = 1; i <= hostCount; i++) rels.push([`${site.key}:esx${i}`, `${site.key}:san`, 'depends_on', 'Datastores on SAN']);
    rels.push([`${site.key}:san`, `${site.key}:ups`, 'depends_on']);
    specs.push({ key: `${site.key}:bkp`, typeKey: 'backup_system', name: `${site.name} Backup Server`, hostname: h('bkp01'), ip: ip(31), siteKey: site.key, criticality: 'high', environment: env, ownerTeamKey: 'infra', monitored: true, os: 'Windows Server', osVersion: '2022 Standard', asset: { categoryKey: 'backup_appliance', manufacturer: 'Dell', model: 'PowerEdge R540', cost: 780000, rack: 'R1/U8' }, attrs: { software: 'Veeam Backup & Replication 12.1', retentionDays: 30 }, tags: ['veeam', 'backup'], serviceKeys: ['backup_management'] });
    rels.push([`${site.key}:bkp`, `${site.key}:san`, 'depends_on', 'Backup repository on SAN']);
    rels.push([`${site.key}:bkp`, `${site.key}:core`, 'connected_to']);

    const vms: [string, string, string, string, number, number][] = [
      ...(main ? [['ad01', 'Domain Controller', 'Windows Server', '2022 Standard', 4, 16] as [string, string, string, string, number, number]] : []),
      ['app01', 'Application Server', 'Red Hat Enterprise Linux', '8.9', 8, 64],
      ['db01', 'Database Server', rng.pick(['Red Hat Enterprise Linux', 'Windows Server']), '8.9', 16, 128],
    ];
    vms.forEach(([role, label, os, ver, vcpu, mem], i) => {
      specs.push({ key: `${site.key}:vm-${role}`, typeKey: 'virtual_machine', name: `${site.name} ${label}`, hostname: h(role), ip: ip(50 + i), siteKey: site.key, criticality: role === 'fs01' ? 'medium' : 'high', environment: env, ownerTeamKey: 'infra', monitored: true, siem: soc, os, osVersion: ver, attrs: { vcpu, memoryGb: mem, diskGb: role === 'db01' ? 2048 : role === 'fs01' ? 4096 : 200 }, tags: ['vm'], serviceKeys: ['server_management', ...(soc ? ['security_monitoring'] : [])] });
      rels.push([`${site.key}:vm-${role}`, `${site.key}:esx${(i % hostCount) + 1}`, 'runs_on']);
      rels.push([`${site.key}:vm-${role}`, `${site.key}:bkp`, 'backed_up_by', 'Daily incremental, weekly full']);
      rels.push([`${site.key}:vm-${role}`, `${site.key}:fw`, 'protected_by']);
    });
    const stack = APP_STACK[cust.key]!;
    specs.push({ key: `${site.key}:db`, typeKey: 'database', name: env === 'dr' ? `${stack.db} (DR replica)` : stack.db, hostname: h('db01'), siteKey: site.key, criticality: 'critical', environment: env, ownerTeamKey: 'infra', attrs: { engine: stack.engine, version: stack.engine.split(' ').pop(), port: stack.port }, tags: ['database'], serviceKeys: ['server_management'] });
    rels.push([`${site.key}:db`, `${site.key}:vm-db01`, 'runs_on']);
    specs.push({ key: `${site.key}:app`, typeKey: 'application', name: env === 'dr' ? `${stack.app} (DR)` : stack.app, hostname: h('app01'), siteKey: site.key, criticality: 'critical', environment: env, ownerTeamKey: 'infra', attrs: { vendor: stack.vendor, version: rng.pick(['2024.1', '12.4', '7.2']), url: stack.url }, tags: ['application'], serviceKeys: ['server_management'] });
    rels.push([`${site.key}:app`, `${site.key}:vm-app01`, 'runs_on']);
    rels.push([`${site.key}:app`, `${site.key}:db`, 'depends_on']);
    if (main) rels.push([`${site.key}:app`, `${site.key}:vm-ad01`, 'depends_on', 'Authentication via AD']);

    // Endpoints and a printer as CIs only where the SOC / service desk works them.
    for (let i = 1; i <= (endpointCis ? 1 : 0); i++) {
      const [lm, lmodel, lcost] = pick(LAPTOPS);
      specs.push({ key: `${site.key}:lt${i}`, typeKey: 'endpoint', name: `${site.name} Laptop ${String(i).padStart(2, '0')}`, hostname: h(`lt${String(i).padStart(2, '0')}`), ip: ip(100 + i), siteKey: site.key, criticality: 'low', environment: env, ownerTeamKey: 'service_desk', siem: soc, os: 'Windows 11', osVersion: '23H2', asset: { categoryKey: 'endpoint', manufacturer: lm, model: lmodel, cost: lcost }, tags: ['endpoint'] });
    }
    if (endpointCis) {
      const [pm, pmodel, pcost] = pick(PRINTERS);
      specs.push({ key: `${site.key}:prn`, typeKey: 'printer', name: `${site.name} Printer`, hostname: h('prn01'), ip: ip(90), siteKey: site.key, criticality: 'low', environment: env, ownerTeamKey: 'service_desk', asset: { categoryKey: 'printer', manufacturer: pm, model: pmodel, cost: pcost }, tags: ['printer'] });
      rels.push([`${site.key}:prn`, `${site.key}:acc1`, 'connected_to']);
    }
  } else {
    const [am, amodel, acost] = pick(ACC_SW);
    specs.push({ key: `${site.key}:sw`, typeKey: 'network_switch', name: `${site.name} Switch`, hostname: h('sw01'), ip: ip(2), siteKey: site.key, criticality: 'high', environment: env, ownerTeamKey: 'network', monitored: true, os: am === 'Cisco' ? 'IOS-XE' : 'ArubaOS-Switch', osVersion: am === 'Cisco' ? '17.6.5' : '16.11.0012', asset: rng.chance(0.6) ? { categoryKey: 'network_switch', manufacturer: am, model: amodel, cost: acost, rack: 'Cabinet 1' } : undefined, attrs: { ports: rng.pick([24, 48]), managementVlan: '10' }, tags: ['access'], serviceKeys: ['network_management'] });
    rels.push([`${site.key}:sw`, `${site.key}:fw`, 'connected_to']);
    if (rng.chance(0.6)) {
      const [apm, apmodel, apcost] = pick(AP_MODELS);
      specs.push({ key: `${site.key}:ap1`, typeKey: 'access_point', name: `${site.name} AP 1`, hostname: h('ap01'), ip: ip(10), siteKey: site.key, criticality: 'medium', environment: env, ownerTeamKey: 'network', monitored: true, firmware: apm === 'Aruba' ? '8.11.2.1' : '17.9.4.27', asset: rng.chance(0.5) ? { categoryKey: 'wireless', manufacturer: apm, model: apmodel, cost: apcost } : undefined, tags: ['wifi'], serviceKeys: ['network_management'] });
      rels.push([`${site.key}:ap1`, `${site.key}:sw`, 'connected_to']);
    }
    if (rng.chance(0.3)) {
      specs.push({ key: `${site.key}:ups`, typeKey: 'ups', name: `${site.name} UPS`, hostname: h('ups01'), ip: ip(40), siteKey: site.key, criticality: 'medium', environment: env, ownerTeamKey: 'infra', monitored: rng.chance(0.5), asset: { categoryKey: 'ups', manufacturer: 'APC', model: 'Smart-UPS 3000VA LCD RM', cost: 98000, rack: 'Cabinet 1' }, attrs: { capacityKva: 3, batteryReplacedOn: isoDate(addDays(new Date(), -rng.int(100, 1300))) }, tags: ['power'] });
      rels.push([`${site.key}:sw`, `${site.key}:ups`, 'depends_on']);
    }
  }
}

function buildCustomer(cust: DemoCustomer, rng: Rng): { specs: CiSpec[]; rels: Rel[] } {
  const specs: CiSpec[] = [];
  const rels: Rel[] = [];
  const main = cust.sites[0]!;
  cust.sites.forEach((site, i) => buildSite(cust, site, rng, specs, rels, i === 0 ? 'main' : site.size === 'large' ? 'large' : 'small'));
  // Branch firewalls terminate site-to-site tunnels on the main firewall.
  for (const site of cust.sites.slice(1)) rels.push([`${site.key}:fw`, `${main.key}:fw`, 'connected_to', 'IPsec site-to-site tunnel']);
  // Secondary large sites (DR / second plant) replicate from the primary storage.
  for (const site of cust.sites.slice(1).filter((s) => s.size === 'large')) rels.push([`${site.key}:san`, `${main.key}:san`, 'depends_on', 'SnapMirror replication from primary']);

  // Business services
  const [[bs1, tier1], [bs2, tier2]] = BUSINESS_SERVICES[cust.key]!;
  const owner = cust.contacts.find((c) => c.escalationLevel === 2)?.name ?? cust.contacts[0]!.name;
  specs.push({ key: 'bs1', typeKey: 'business_service', name: bs1, siteKey: null, criticality: 'critical', ownerTeamKey: 'service_desk', attrs: { owner, tier: tier1 }, tags: ['business-service'] });
  specs.push({ key: 'bs2', typeKey: 'business_service', name: bs2, siteKey: null, criticality: 'high', ownerTeamKey: 'service_desk', attrs: { owner: cust.contacts[0]!.name, tier: tier2 }, tags: ['business-service'] });
  rels.push(['bs1', `${main.key}:app`, 'depends_on']);
  rels.push([`${main.key}:app`, 'bs1', 'supports']);
  rels.push(['bs1', `${main.key}:db`, 'depends_on']);
  rels.push(['bs2', `${main.key}:vm-ad01`, 'depends_on']);
  rels.push(['bs2', `${main.key}:esx1`, 'depends_on']);
  rels.push(['bs2', `${main.key}:fw`, 'depends_on', 'Published via firewall VIP']);
  rels.push(['bs1', `${main.key}:core`, 'depends_on']);

  // Cloud estates
  if (cust.domains.cloud) {
    const aws = cust.key === 'orbital';
    const provider = aws ? 'aws' : 'azure';
    const region = aws ? 'ap-south-1' : 'centralindia';
    specs.push({ key: 'cloud', typeKey: 'cloud_account', name: aws ? 'AWS Production Account' : 'Azure Production Subscription', siteKey: null, criticality: 'critical', ownerTeamKey: 'cloud', monitored: true, attrs: { provider, accountId: aws ? `${hashHex(cust.key, 12).replace(/[A-F]/g, '4')}` : `sub-${hashHex(cust.key, 8).toLowerCase()}` }, tags: ['cloud', provider], serviceKeys: ['cloud_support'] });
    const resources: [string, string, string][] = aws
      ? [['wms-app-ec2-01', 'EC2 m6i.xlarge', 'Compute'], ['wms-app-ec2-02', 'EC2 m6i.xlarge', 'Compute'], ['wms-db-rds-01', 'RDS PostgreSQL db.r6g.large (Multi-AZ)', 'Database'], ['wms-artifacts-s3', 'S3 bucket', 'Storage'], ['vpc-prod-ap-south-1', 'VPC + Transit Gateway', 'Network'], ['wms-alb-prod', 'Application Load Balancer', 'Network']]
      : [['aks-prod-01', 'AKS cluster (3 nodes)', 'Compute'], ['sqlmi-prod-01', 'Azure SQL Managed Instance', 'Database'], ['vm-jump-01', 'Azure VM D4s_v5 (jump host)', 'Compute'], ['stg-prod-artifacts', 'Storage account (GRS)', 'Storage'], ['vnet-hub-centralindia', 'Hub VNet + Firewall', 'Network']];
    resources.forEach(([name, type, kind], i) => {
      specs.push({ key: `cloud-${i}`, typeKey: 'cloud_resource', name, hostname: name, ip: kind === 'Network' ? undefined : `10.${cust.index + 100}.${i}.${10 + i}`, siteKey: null, criticality: kind === 'Database' ? 'critical' : 'high', ownerTeamKey: 'cloud', monitored: true, attrs: { resourceType: type, region }, tags: ['cloud', kind.toLowerCase()], serviceKeys: ['cloud_support'] });
      rels.push([`cloud-${i}`, 'cloud', 'hosted_on']);
    });
    rels.push(['bs1', 'cloud-0', 'depends_on']);
    rels.push(['cloud-0', `cloud-${aws ? 2 : 1}`, 'depends_on']);
    rels.push([`${main.key}:fw`, 'cloud', 'connected_to', aws ? 'Site-to-site VPN to VPC' : 'ExpressRoute / VPN to hub VNet']);
  }
  return { specs, rels };
}

export async function seedInventory(state: DemoState, tx: Tx) {
  const { refs, rng, now } = state;
  const amcContractIdFor = (cust: DemoCustomer, siteKey: string | null) => {
    const amc = cust.contracts.find((c) => c.typeKey === 'amc' && ['active', 'expiring'].includes(c.status));
    if (!amc || !siteKey) return null;
    return amc.siteKeys.length === 0 || amc.siteKeys.includes(siteKey) ? amc : null;
  };
  let assetSeq = 0;
  let monitoringSeq = 2000;
  let siemSeq = 1000;
  const allRelRows: (typeof schema.ciRelationships.$inferInsert)[] = [];
  const allCiServiceRows: (typeof schema.ciServices.$inferInsert)[] = [];
  let staleBudget = 14;
  let warrantyPlan = 0;

  for (const cust of state.customers) {
    const { specs, rels } = buildCustomer(cust, rng);
    const siteId = (key: string | null) => (key ? cust.sites.find((s) => s.key === key)!.id : null);
    // Assets first (they are referenced by CIs).
    const assetRows: (typeof schema.assets.$inferInsert)[] = [];
    const assetSpecIndex: number[] = [];
    specs.forEach((spec, i) => {
      if (!spec.asset) return;
      assetSeq++;
      assetSpecIndex.push(i);
      const a = spec.asset;
      const purchased = addDays(now, -rng.int(120, 1700));
      // Deterministic rotation so some warranties expire soon, some are expired.
      warrantyPlan++;
      const mod = warrantyPlan % 12;
      const warrantyEnd = mod === 0 ? addDays(now, rng.int(3, 30)) : mod === 1 || mod === 2 ? addDays(now, rng.int(31, 90)) : mod <= 5 ? addDays(now, -rng.int(10, 400)) : addDays(purchased, 365 * 3);
      const amc = amcContractIdFor(cust, spec.siteKey);
      const lifecycle = a.lifecycle ?? 'deployed';
      assetRows.push({
        customerId: cust.id,
        siteId: siteId(spec.siteKey),
        tag: `AST-${String(assetSeq).padStart(6, '0')}`,
        name: spec.name,
        categoryId: refs.option('asset_category', a.categoryKey),
        statusId: refs.option('asset_status', a.statusKey ?? 'in_use'),
        lifecycleStage: lifecycle,
        manufacturer: a.manufacturer,
        model: a.model,
        serialNumber: serial(a.manufacturer.slice(0, 2).toUpperCase(), `${cust.key}:${spec.key}`),
        partNumber: a.partNumber ?? null,
        description: `${a.manufacturer} ${a.model} at ${cust.sites.find((s) => s.key === spec.siteKey)?.name ?? cust.name}`,
        location: spec.siteKey ? `${cust.sites.find((s) => s.key === spec.siteKey)!.name}${a.rack ? ` / ${a.rack}` : ''}` : null,
        rackPosition: a.rack ?? null,
        vendor: rng.pick(['Ingram Micro', 'Redington', 'Savex Technologies', 'Direct from OEM']),
        purchaseDate: isoDate(purchased),
        purchaseCost: String(a.cost),
        currency: cust.timezone === 'Europe/London' ? 'GBP' : 'INR',
        poNumber: `${cust.code}/PO/${purchased.getUTCFullYear()}/${hashHex(spec.key + cust.key, 4)}`,
        invoiceNumber: `INV-${hashHex(cust.key + spec.key + 'inv', 6)}`,
        warrantyStart: isoDate(purchased),
        warrantyEnd: isoDate(warrantyEnd),
        warrantyProvider: a.manufacturer,
        amcContractId: amc?.id ?? null,
        amcStart: amc?.startDate ?? null,
        amcEnd: amc?.endDate ?? null,
        eolDate: ['network_switch', 'firewall', 'router'].includes(a.categoryKey) ? isoDate(addDays(purchased, 365 * 6)) : null,
        eosDate: ['network_switch', 'firewall', 'router'].includes(a.categoryKey) ? isoDate(addDays(purchased, 365 * 8)) : null,
        ownerContactId: cust.contacts.find((c) => c.isPrimary)?.id ?? null,
        tags: [a.categoryKey, ...(amc ? ['amc'] : [])],
        customFields: { costCenter: `CC-${cust.code.slice(0, 3)}-${rng.int(100, 999)}` },
      });
    });
    const insertedAssets = assetRows.length ? await tx.insert(schema.assets).values(assetRows).returning({ id: schema.assets.id, tag: schema.assets.tag, name: schema.assets.name, siteId: schema.assets.siteId }) : [];
    const assetBySpec = new Map<number, (typeof insertedAssets)[number]>();
    assetSpecIndex.forEach((specIdx, i) => assetBySpec.set(specIdx, insertedAssets[i]!));

    // CIs
    const ciRows: (typeof schema.cis.$inferInsert)[] = specs.map((spec, i) => {
      const asset = assetBySpec.get(i);
      const site = spec.siteKey ? cust.sites.find((s) => s.key === spec.siteKey)! : null;
      const stale = staleBudget > 0 && rng.chance(0.06) && !['business_service', 'application', 'database'].includes(spec.typeKey);
      if (stale) staleBudget--;
      const lastSeen = stale ? addDays(now, -rng.int(31, 75)) : new Date(now.getTime() - rng.int(1, 240) * 60_000);
      const discovered = !!spec.ip && rng.chance(0.45);
      return {
        customerId: cust.id,
        siteId: site?.id ?? null,
        typeId: refs.ciType(spec.typeKey),
        name: spec.name,
        hostname: spec.hostname ?? null,
        fqdn: spec.hostname && !spec.typeKey.startsWith('cloud') ? `${spec.hostname}.${cust.short}.local` : null,
        ipAddress: spec.ip ?? null,
        macAddress: spec.ip && !spec.typeKey.startsWith('cloud') ? mac(`${cust.key}:${spec.key}`) : null,
        serialNumber: asset ? serial(spec.asset!.manufacturer.slice(0, 2).toUpperCase(), `${cust.key}:${spec.key}`) : null,
        manufacturer: spec.asset?.manufacturer ?? (spec.typeKey === 'virtual_machine' ? 'VMware' : null),
        model: spec.asset?.model ?? (spec.typeKey === 'virtual_machine' ? 'Virtual Machine' : null),
        osName: spec.os ?? null,
        osVersion: spec.osVersion ?? null,
        firmwareVersion: spec.firmware ?? null,
        environment: spec.environment ?? 'production',
        criticality: spec.criticality,
        status: spec.status ?? (stale ? 'inactive' : 'active'),
        description: spec.description ?? null,
        ownerTeamId: refs.team(spec.ownerTeamKey),
        assetId: asset?.id ?? null,
        attributes: spec.attrs ?? {},
        discoverySource: discovered ? 'network_scan' : null,
        discoveredAt: discovered ? addDays(now, -rng.int(5, 90)) : null,
        lastSeenAt: spec.typeKey === 'business_service' ? null : lastSeen,
        monitoringRef: spec.monitored ? String(++monitoringSeq) : null,
        siemRef: spec.siem && cust.domains.soc ? `FSM-${cust.code}-${++siemSeq}` : null,
        tags: [...(spec.tags ?? []), site ? site.code.toLowerCase() : 'global'],
      };
    });
    const insertedCis = await tx.insert(schema.cis).values(ciRows).returning({ id: schema.cis.id, name: schema.cis.name, hostname: schema.cis.hostname, ipAddress: schema.cis.ipAddress, monitoringRef: schema.cis.monitoringRef, assetId: schema.cis.assetId });
    const ciIdByKey = new Map<string, string>();
    specs.forEach((spec, i) => {
      const row = insertedCis[i]!;
      ciIdByKey.set(spec.key, row.id);
      cust.cis.push({ id: row.id, customerKey: cust.key, siteKey: spec.siteKey, typeKey: spec.typeKey, name: row.name, hostname: row.hostname, ipAddress: row.ipAddress, monitoringRef: row.monitoringRef, assetId: row.assetId, attributes: spec.attrs ?? {} });
      for (const sk of spec.serviceKeys ?? []) {
        const svc = state.services.get(sk);
        if (svc) allCiServiceRows.push({ ciId: row.id, serviceId: svc.id, customerId: cust.id });
      }
    });
    // Link assets back to CIs
    for (const [specIdx, asset] of assetBySpec) {
      const ciId = ciIdByKey.get(specs[specIdx]!.key)!;
      await tx.update(schema.assets).set({ ciId }).where(eq(schema.assets.id, asset.id));
      cust.assets.push({ id: asset.id, tag: asset.tag, name: asset.name, customerKey: cust.key, siteKey: specs[specIdx]!.siteKey, categoryKey: specs[specIdx]!.asset!.categoryKey, ciId });
    }
    for (const [src, dst, type, description] of rels) {
      const s = ciIdByKey.get(src);
      const d = ciIdByKey.get(dst);
      if (!s || !d || s === d) continue;
      allRelRows.push({ customerId: cust.id, sourceCiId: s, targetCiId: d, typeId: refs.relType(type), description: description ?? null, source: rng.chance(0.3) ? 'discovery' : 'manual' });
    }

    // Stand-alone assets without CIs: spares in stock, staff laptops, a licence and a retired device.
    const main = cust.sites[0]!;
    const extras: (typeof schema.assets.$inferInsert)[] = [];
    const extra = (name: string, categoryKey: string, manufacturer: string, model: string, cost: number, lifecycle: string, statusKey: string, opts: Partial<typeof schema.assets.$inferInsert> = {}) => {
      assetSeq++;
      extras.push({ customerId: cust.id, siteId: main.id, tag: `AST-${String(assetSeq).padStart(6, '0')}`, name, categoryId: refs.option('asset_category', categoryKey), statusId: refs.option('asset_status', statusKey), lifecycleStage: lifecycle, manufacturer, model, serialNumber: serial(manufacturer.slice(0, 2).toUpperCase(), `${cust.key}:extra:${name}`), purchaseDate: isoDate(addDays(now, -rng.int(60, 1500))), purchaseCost: String(cost), currency: 'INR', vendor: 'Ingram Micro', warrantyStart: isoDate(addDays(now, -rng.int(60, 1500))), warrantyEnd: isoDate(addDays(now, rng.int(-300, 600))), warrantyProvider: manufacturer, location: `${main.name} / Store room`, ownerContactId: cust.contacts.find((c) => c.isPrimary)?.id ?? null, tags: [categoryKey, 'no-ci'], ...opts });
    };
    const [lm, lmodel, lcost] = rng.pick(LAPTOPS);
    extra(`Staff laptop - ${cust.contacts[1]?.name ?? 'IT'}`, 'endpoint', lm, lmodel, lcost, 'deployed', 'in_use', { assignedContactId: cust.contacts[1]?.id ?? null, location: `${main.name}` });
    if (!(cust.domains.soc || cust.domains.eus)) {
      const [pm, pmodel, pcost] = rng.pick(PRINTERS);
      extra(`${main.name} Printer`, 'printer', pm, pmodel, pcost, 'deployed', 'in_use', { location: `${main.name} / Reception` });
    }
    if (cust.index % 2 === 1) extra(`Spare laptop (${cust.code})`, 'endpoint', lm, lmodel, lcost, 'in_stock', 'in_stock');
    if (cust.sites.length > 3) extra('Spare access switch (cold standby)', 'network_switch', 'Cisco', 'Catalyst 9200L-24P-4G', 190000, 'in_stock', 'in_stock');
    if (cust.index % 4 === 0) extra('Retired core switch (replaced)', 'network_switch', 'Cisco', 'Catalyst 3850-48P', 450000, 'retired', 'retired', { warrantyEnd: isoDate(addDays(now, -900)), eolDate: isoDate(addDays(now, -400)) });
    if (cust.index % 3 === 0) extra('Access point under RMA', 'wireless', 'Aruba', 'AP-515', 62000, 'in_repair', 'under_repair', { notes: 'RMA case open with Aruba TAC; replacement expected within 10 working days.' });
    if (cust.key === 'meridian' || cust.key === 'abc') extra('Microsoft 365 E3 licences (250)', 'software_license', 'Microsoft', 'Microsoft 365 E3 (annual)', 750000, 'deployed', 'in_use', { warrantyEnd: isoDate(addDays(now, rng.int(20, 200))), serialNumber: null, location: null, notes: 'Subscription renewal date tracked as warranty end.' });
    if (extras.length) {
      const rows = await tx.insert(schema.assets).values(extras).returning({ id: schema.assets.id, tag: schema.assets.tag, name: schema.assets.name });
      rows.forEach((r, i) => cust.assets.push({ id: r.id, tag: r.tag, name: r.name, customerKey: cust.key, siteKey: main.key, categoryKey: String(extras[i]!.tags?.[0] ?? 'other'), ciId: null }));
    }
  }
  if (allRelRows.length) await tx.insert(schema.ciRelationships).values(allRelRows).onConflictDoNothing();
  if (allCiServiceRows.length) await tx.insert(schema.ciServices).values(allCiServiceRows).onConflictDoNothing();
  // Interfaces on core switches / firewalls for a realistic CI detail page.
  const ifaceRows: (typeof schema.ciInterfaces.$inferInsert)[] = [];
  for (const cust of state.customers) {
    for (const ci of cust.cis.filter((c) => c.typeKey === 'network_switch' && c.name.includes('Core'))) {
      for (let i = 1; i <= 6; i++) ifaceRows.push({ ciId: ci.id, customerId: cust.id, name: `GigabitEthernet1/0/${i}`, ifIndex: i, description: i <= 2 ? `Uplink to ${cust.short}-fw01` : i <= 4 ? 'ESXi host' : 'Access switch uplink', macAddress: mac(`${ci.id}:${i}`), speedMbps: i <= 2 ? 10000 : 1000, adminStatus: 'up', operStatus: i === 6 && rng.chance(0.3) ? 'down' : 'up', vlan: i <= 2 ? 'trunk' : '10' });
    }
  }
  if (ifaceRows.length) await tx.insert(schema.ciInterfaces).values(ifaceRows);
  const [{ n: relCount }] = (await tx.execute(sql`select count(*)::int as n from ci_relationships`)).rows as { n: number }[];
  state.counts.assets = state.customers.reduce((s, c) => s + c.assets.length, 0);
  state.counts.cis = state.customers.reduce((s, c) => s + c.cis.length, 0);
  state.counts.ciRelationships = relCount;
}
