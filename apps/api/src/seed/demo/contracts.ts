import { eq } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import { createContract } from '@/modules/contracts/service';
import type { ContractCreate, ScopeItemInput } from '@/modules/contracts/schemas';
import { adminCtx, customer, CAL_BUSINESS, CAL_EXTENDED, CAL_UK, POLICY_BUSINESS, POLICY_PREMIUM, POLICY_STANDARD, type DemoContract, type DemoState } from './state';
import { isoDate, addDays, shiftDate } from './rng';

interface EntSeed {
  typeKey: string;
  name: string;
  quantity: number;
  period: 'contract' | 'yearly' | 'half_yearly' | 'quarterly' | 'monthly';
  serviceKey?: string;
  warn?: number;
  overageAllowed?: boolean;
  overageRate?: number;
}

interface ScopeSeed {
  header: string;
  name: string;
  classification?: 'in_scope' | 'out_of_scope';
  serviceKey?: string;
  siteKey?: string;
  ciTypeKey?: string;
  ticketCategoryKey?: string;
  category?: string;
  description?: string;
}

interface ContractSeed {
  key: string;
  customerKey: string;
  name: string;
  typeKey: string;
  status: 'draft' | 'active' | 'expiring' | 'expired' | 'renewed' | 'terminated';
  startDate: string;
  endDate: string;
  noticePeriodDays?: number;
  autoRenew?: boolean;
  policy?: string;
  calendar?: string;
  services: { key: string; policy?: string; teamKey?: string; calendar?: string; notes?: string }[];
  siteKeys?: string[];
  entitlements: EntSeed[];
  scope: ScopeSeed[];
  value: number;
  currency?: string;
  billingCycle: string;
  poNumber: string;
  signedAt?: string;
  ownerKey: string;
  parentKey?: string;
  description: string;
  exclusions?: string;
  responseCommitment?: string;
  resolutionCommitment?: string;
}

const AMC_SCOPE = (siteKeys: string[]): ScopeSeed[] => [
  ...siteKeys.map((s) => ({ header: 'sites', name: `Covered site: ${s.toUpperCase()}`, siteKey: s, category: 'infrastructure' })),
  { header: 'device_types', name: 'Servers (physical)', ciTypeKey: 'server', category: 'infrastructure', description: 'Rack and tower servers listed in the asset register with a valid AMC date.' },
  { header: 'device_types', name: 'Network switches', ciTypeKey: 'network_switch', category: 'network' },
  { header: 'device_types', name: 'Firewalls', ciTypeKey: 'firewall', category: 'network' },
  { header: 'device_types', name: 'Storage arrays', ciTypeKey: 'storage_array', category: 'infrastructure' },
  { header: 'device_types', name: 'UPS systems (excluding batteries)', ciTypeKey: 'ups', category: 'infrastructure', description: 'Battery replacement is billable at list price.' },
  { header: 'device_types', name: 'End-user laptops and desktops', ciTypeKey: 'endpoint', classification: 'out_of_scope', category: 'end_user', description: 'Endpoints are covered under OEM warranty only.' },
  { header: 'device_types', name: 'Printers and MFDs', ciTypeKey: 'printer', classification: 'out_of_scope', category: 'end_user' },
  { header: 'activities', name: 'Breakdown support with on-site visit', serviceKey: 'amc_support', category: 'infrastructure' },
  { header: 'activities', name: 'Preventive maintenance visits per schedule', serviceKey: 'preventive_maintenance', category: 'infrastructure' },
  { header: 'activities', name: 'Part replacement (OEM or equivalent)', serviceKey: 'amc_support', category: 'infrastructure', description: 'Up to the hardware replacement entitlement; additional parts billable.' },
  { header: 'activities', name: 'Application development or customization', classification: 'out_of_scope', ticketCategoryKey: 'software', category: 'applications' },
];

const MANAGED_SCOPE: ScopeSeed[] = [
  { header: 'services', name: '24x7 monitoring and incident management', serviceKey: 'noc_monitoring', category: 'infrastructure' },
  { header: 'services', name: 'LAN/WAN and firewall administration', serviceKey: 'network_management', category: 'network' },
  { header: 'services', name: 'Server OS administration and patching', serviceKey: 'server_management', category: 'infrastructure' },
  { header: 'services', name: 'Backup job monitoring and restores', serviceKey: 'backup_management', category: 'backup' },
  { header: 'services', name: 'Storage capacity and health management', serviceKey: 'storage_management', category: 'infrastructure' },
  { header: 'services', name: 'Hypervisor cluster and VM administration', serviceKey: 'virtualization_management', category: 'infrastructure' },
  { header: 'device_types', name: 'Hypervisors and virtual machines', ciTypeKey: 'virtual_machine', category: 'infrastructure' },
  { header: 'activities', name: 'Third-party ISP escalation', classification: 'out_of_scope', ticketCategoryKey: 'connectivity', category: 'network', description: 'ISP circuits are managed by the customer; we assist with diagnostics only.' },
  { header: 'activities', name: 'Application development', classification: 'out_of_scope', ticketCategoryKey: 'software', category: 'applications' },
  { header: 'users', name: 'End-user laptops', classification: 'out_of_scope', ciTypeKey: 'endpoint', category: 'end_user' },
];

const SOC_SCOPE: ScopeSeed[] = [
  { header: 'services', name: '24x7 SIEM monitoring and triage', serviceKey: 'security_monitoring', category: 'security' },
  { header: 'device_types', name: 'Firewalls and security appliances (log sources)', ciTypeKey: 'firewall', category: 'security' },
  { header: 'device_types', name: 'Servers (EDR + log sources)', ciTypeKey: 'server', category: 'security' },
  { header: 'activities', name: 'Incident response: containment and remediation guidance', serviceKey: 'security_monitoring', category: 'security' },
  { header: 'activities', name: 'Monthly threat and compliance report', serviceKey: 'security_monitoring', category: 'security' },
  { header: 'activities', name: 'Forensic investigation beyond 8 hours', classification: 'out_of_scope', ticketCategoryKey: 'other', category: 'security', description: 'Billable at professional services rates.' },
  { header: 'activities', name: 'Penetration testing', classification: 'out_of_scope', ticketCategoryKey: 'other', category: 'security', description: 'Vulnerability advisories are in scope; active testing is a separate engagement.' },
];

const CLOUD_SCOPE: ScopeSeed[] = [
  { header: 'services', name: 'Cloud operations support', serviceKey: 'cloud_support', category: 'cloud' },
  { header: 'services', name: 'Cloud backup and monitoring', serviceKey: 'backup_management', category: 'backup' },
  { header: 'services', name: 'Cloud resource monitoring', serviceKey: 'noc_monitoring', category: 'cloud' },
  { header: 'device_types', name: 'Cloud accounts and subscriptions', ciTypeKey: 'cloud_account', category: 'cloud' },
  { header: 'device_types', name: 'Compute, storage and database resources', ciTypeKey: 'cloud_resource', category: 'cloud' },
  { header: 'activities', name: 'Cost optimisation review (quarterly)', serviceKey: 'cloud_support', category: 'cloud' },
  { header: 'activities', name: 'Application code deployment', classification: 'out_of_scope', ticketCategoryKey: 'software', category: 'applications' },
];

const NETWORK_SCOPE: ScopeSeed[] = [
  { header: 'services', name: 'Network device administration', serviceKey: 'network_management', category: 'network' },
  { header: 'services', name: 'Network monitoring and alert handling', serviceKey: 'noc_monitoring', category: 'network' },
  { header: 'device_types', name: 'Switches, routers and wireless', ciTypeKey: 'network_switch', category: 'network' },
  { header: 'device_types', name: 'Firewalls', ciTypeKey: 'firewall', category: 'network' },
  { header: 'activities', name: 'Third-party ISP escalation', classification: 'out_of_scope', ticketCategoryKey: 'connectivity', category: 'network' },
  { header: 'users', name: 'Student / guest devices', classification: 'out_of_scope', ciTypeKey: 'endpoint', category: 'end_user' },
];

const EUS_SCOPE: ScopeSeed[] = [
  { header: 'services', name: 'Service desk for end users (Mon-Sat 08:00-20:00)', serviceKey: 'end_user_support', category: 'end_user' },
  { header: 'users', name: 'Head office and store staff (up to 450 users)', category: 'end_user' },
  { header: 'device_types', name: 'Laptops, desktops and printers', ciTypeKey: 'endpoint', category: 'end_user' },
  { header: 'applications', name: 'Microsoft 365, POS client, ERP client', category: 'applications' },
  { header: 'activities', name: 'Hardware repair (sent to OEM)', classification: 'out_of_scope', ticketCategoryKey: 'hardware', category: 'end_user' },
];

const STD_ENTS = (hours = 200, eng = 100): EntSeed[] => [
  { typeKey: 'remote_support_hours', name: 'Remote support hours', quantity: hours, period: 'yearly', warn: 80 },
  { typeKey: 'engineering_hours', name: 'Engineering / project hours', quantity: eng, period: 'yearly', warn: 80, overageRate: 3500 },
];

const AMC_ENTS = (visits = 12, pm = 4, hw = 5): EntSeed[] => [
  { typeKey: 'site_visits', name: 'Breakdown site visits', quantity: visits, period: 'yearly', serviceKey: 'amc_support', warn: 80, overageRate: 4500 },
  { typeKey: 'pm_visits', name: 'Preventive maintenance visits', quantity: pm, period: 'yearly', serviceKey: 'preventive_maintenance', warn: 75 },
  { typeKey: 'hardware_replacements', name: 'Hardware replacements', quantity: hw, period: 'contract', serviceKey: 'amc_support', warn: 80, overageAllowed: false },
];

export function contractSeeds(now: Date): ContractSeed[] {
  const today = isoDate(now);
  const expiring30 = isoDate(addDays(now, 30));
  const expiring42 = isoDate(addDays(now, 42));
  return [
    // ABC Manufacturing
    { key: 'abc_ms_2025', customerKey: 'abc', name: 'Managed Infrastructure Services 2025', typeKey: 'managed_services', status: 'renewed', startDate: '2025-01-01', endDate: '2025-12-31', noticePeriodDays: 60, services: [{ key: 'noc_monitoring' }, { key: 'network_management' }, { key: 'server_management' }, { key: 'storage_management' }, { key: 'backup_management' }, { key: 'virtualization_management' }], entitlements: STD_ENTS(), scope: MANAGED_SCOPE, value: 4200000, billingCycle: 'quarterly', poNumber: 'ABC/PO/2024/1187', signedAt: '2024-12-12', ownerKey: 'lakshmi', description: 'Initial managed services agreement covering both plants and corporate office. Renewed as CTR-2026 series.' },
    { key: 'abc_ms', customerKey: 'abc', name: 'Managed Infrastructure Services 2026', typeKey: 'managed_services', status: 'active', startDate: '2026-01-01', endDate: '2026-12-31', noticePeriodDays: 60, autoRenew: false, parentKey: 'abc_ms_2025', services: [{ key: 'noc_monitoring' }, { key: 'network_management' }, { key: 'server_management' }, { key: 'storage_management' }, { key: 'backup_management' }, { key: 'virtualization_management' }], entitlements: STD_ENTS(240, 120), scope: MANAGED_SCOPE, value: 4650000, billingCycle: 'quarterly', poNumber: 'ABC/PO/2025/2210', signedAt: '2025-12-18', ownerKey: 'lakshmi', description: '24x7 NOC monitoring and management of network, server, storage, backup and virtualization at Gurgaon, Pune, Chennai and Delhi.', exclusions: 'ISP circuits, OT/PLC network, end-user devices, application development.', responseCommitment: 'P1 within 30 minutes, P2 within 1 hour (24x7).', resolutionCommitment: 'P1 restore within 4 hours; resolution within 8 hours.' },
    { key: 'abc_amc', customerKey: 'abc', name: 'Hardware AMC - Plants', typeKey: 'amc', status: 'active', startDate: '2026-04-01', endDate: '2027-03-31', noticePeriodDays: 30, siteKeys: ['gur', 'pun'], services: [{ key: 'amc_support', teamKey: 'field' }, { key: 'preventive_maintenance', teamKey: 'field' }], entitlements: AMC_ENTS(12, 4, 5), scope: AMC_SCOPE(['gur', 'pun']), value: 1850000, billingCycle: 'annual', poNumber: 'ABC/PO/2026/0412', signedAt: '2026-03-20', ownerKey: 'lakshmi', description: 'Comprehensive AMC for servers, switches, firewalls, storage and UPS at Gurgaon and Pune plants with quarterly PM.', exclusions: 'Consumables, UPS batteries, physical damage, Chennai and Delhi offices.' },
    // Meridian Bank
    { key: 'mrd_ms', customerKey: 'meridian', name: 'Premium Managed Services (HO + DR + Branches)', typeKey: 'managed_services', status: 'active', startDate: '2026-01-01', endDate: '2027-12-31', noticePeriodDays: 90, policy: POLICY_PREMIUM, services: [{ key: 'noc_monitoring', policy: POLICY_PREMIUM }, { key: 'network_management', policy: POLICY_PREMIUM }, { key: 'server_management', policy: POLICY_PREMIUM }, { key: 'storage_management' }, { key: 'backup_management' }, { key: 'virtualization_management' }], entitlements: STD_ENTS(400, 200), scope: MANAGED_SCOPE, value: 9800000, billingCycle: 'quarterly', poNumber: 'MBL/PROC/2025/7781', signedAt: '2025-12-05', ownerKey: 'lakshmi', description: 'Two-year premium agreement with 24x7 clocks on all priorities for head office, DR site and branch connectivity.', exclusions: 'Core banking application support (vendor), ATM network.', responseCommitment: 'P1 within 15 minutes, P2 within 30 minutes (24x7).', resolutionCommitment: 'P1 resolution within 4 hours, P2 within 12 hours.' },
    { key: 'mrd_soc_old', customerKey: 'meridian', name: 'SOC Services 2024-25', typeKey: 'soc', status: 'expired', startDate: '2024-10-01', endDate: '2025-09-30', noticePeriodDays: 60, policy: POLICY_PREMIUM, services: [{ key: 'security_monitoring' }], entitlements: [{ typeKey: 'incidents', name: 'Security incident investigations', quantity: 60, period: 'yearly' }], scope: SOC_SCOPE, value: 3600000, billingCycle: 'quarterly', poNumber: 'MBL/PROC/2024/5120', signedAt: '2024-09-15', ownerKey: 'lakshmi', description: 'First-year SOC engagement (FortiSIEM onboarding of firewalls, AD and core switches). Superseded by the 2025-27 agreement.' },
    { key: 'mrd_soc', customerKey: 'meridian', name: 'SOC Services 2025-27', typeKey: 'soc', status: 'active', startDate: '2025-10-01', endDate: '2027-09-30', noticePeriodDays: 60, policy: POLICY_PREMIUM, parentKey: 'mrd_soc_old', services: [{ key: 'security_monitoring', policy: POLICY_PREMIUM, teamKey: 'soc' }], entitlements: [{ typeKey: 'incidents', name: 'Security incident investigations', quantity: 80, period: 'yearly', warn: 80 }, { typeKey: 'engineering_hours', name: 'Forensic / IR hours', quantity: 40, period: 'yearly', warn: 75, overageRate: 6000 }], scope: SOC_SCOPE, value: 7400000, billingCycle: 'quarterly', poNumber: 'MBL/PROC/2025/6633', signedAt: '2025-09-22', ownerKey: 'lakshmi', description: '24x7 SOC with FortiSIEM, monthly compliance reporting for RBI audits.', exclusions: 'Penetration testing, forensic investigations beyond 8 hours per incident.' },
    // Northwind Pharma
    { key: 'nwp_ms', customerKey: 'northwind', name: 'Managed Services - Plant & R&D', typeKey: 'managed_services', status: 'active', startDate: '2026-02-01', endDate: '2027-01-31', noticePeriodDays: 45, services: [{ key: 'noc_monitoring' }, { key: 'network_management' }, { key: 'server_management' }, { key: 'backup_management' }, { key: 'virtualization_management' }], entitlements: STD_ENTS(160, 80), scope: MANAGED_SCOPE, value: 2900000, billingCycle: 'half-yearly', poNumber: 'NWP/IT/PO/2026/031', signedAt: '2026-01-20', ownerKey: 'lakshmi', description: 'Managed services for the GxP manufacturing plant and R&D office.', exclusions: 'Validated lab instruments, LIMS application.' },
    { key: 'nwp_amc', customerKey: 'northwind', name: 'Hardware AMC - Hyderabad Plant', typeKey: 'amc', status: 'active', startDate: '2026-01-01', endDate: '2026-12-31', noticePeriodDays: 30, siteKeys: ['plant'], services: [{ key: 'amc_support', teamKey: 'field' }, { key: 'preventive_maintenance', teamKey: 'field' }], entitlements: AMC_ENTS(6, 4, 3), scope: AMC_SCOPE(['plant']), value: 760000, billingCycle: 'annual', poNumber: 'NWP/IT/PO/2025/118', signedAt: '2025-12-10', ownerKey: 'lakshmi', description: 'AMC for plant server room equipment with quarterly PM.', exclusions: 'R&D office equipment, consumables.' },
    // Apex Retail
    { key: 'apx_net', customerKey: 'apex', name: 'Store Network Support', typeKey: 'network_support', status: 'expiring', startDate: shiftDate(expiring30, -364), endDate: expiring30, noticePeriodDays: 30, calendar: CAL_EXTENDED, services: [{ key: 'network_management', calendar: CAL_EXTENDED }, { key: 'noc_monitoring', calendar: CAL_EXTENDED }], entitlements: [...STD_ENTS(120, 40), { typeKey: 'site_visits', name: 'Store visits', quantity: 10, period: 'yearly', warn: 80, overageRate: 3500 }], scope: NETWORK_SCOPE, value: 1450000, billingCycle: 'quarterly', poNumber: 'APX/PO/25-26/0887', signedAt: shiftDate(expiring30, -380), ownerKey: 'lakshmi', description: 'Network support for head office and 5 stores on extended hours (Mon-Sat 08:00-20:00). Renewal proposal sent.', exclusions: 'ISP links, POS application, CCTV.' },
    { key: 'apx_eus', customerKey: 'apex', name: 'End User Support Services', typeKey: 'managed_services', status: 'active', startDate: '2026-03-01', endDate: '2027-02-28', noticePeriodDays: 30, calendar: CAL_EXTENDED, services: [{ key: 'end_user_support', calendar: CAL_EXTENDED, teamKey: 'service_desk' }], entitlements: [{ typeKey: 'incidents', name: 'Service desk tickets', quantity: 600, period: 'quarterly', warn: 85 }, { typeKey: 'remote_support_hours', name: 'Remote support hours', quantity: 100, period: 'quarterly', warn: 80 }], scope: EUS_SCOPE, value: 2100000, billingCycle: 'monthly', poNumber: 'APX/PO/26-27/0112', signedAt: '2026-02-14', ownerKey: 'lakshmi', description: 'Service desk for ~450 head office and store users with Microsoft 365 and POS client support.', exclusions: 'Hardware repair, software licensing.' },
    // Helios Energy
    { key: 'hel_noc', customerKey: 'helios', name: 'NOC Services - Corporate IT', typeKey: 'noc', status: 'active', startDate: '2026-04-01', endDate: '2027-03-31', noticePeriodDays: 60, services: [{ key: 'noc_monitoring' }, { key: 'network_management' }, { key: 'server_management' }, { key: 'backup_management' }], entitlements: STD_ENTS(150, 60), scope: MANAGED_SCOPE, value: 2200000, billingCycle: 'quarterly', poNumber: 'HEC/IT/2026/014-A', signedAt: '2026-03-28', ownerKey: 'lakshmi', description: 'NOC monitoring for the corporate IT segment at Noida, Jaipur control center and the Jaisalmer site office.', exclusions: 'OT / SCADA network, inverters and plant instrumentation.' },
    { key: 'hel_amc', customerKey: 'helios', name: 'Hardware AMC - Noida & Jaipur', typeKey: 'amc', status: 'active', startDate: '2026-04-01', endDate: '2027-03-31', noticePeriodDays: 60, siteKeys: ['noida', 'cc'], services: [{ key: 'amc_support', teamKey: 'field' }, { key: 'preventive_maintenance', teamKey: 'field' }], entitlements: AMC_ENTS(8, 2, 4), scope: AMC_SCOPE(['noida', 'cc']), value: 980000, billingCycle: 'annual', poNumber: 'HEC/IT/2026/014-B', signedAt: '2026-03-28', ownerKey: 'lakshmi', description: 'AMC with half-yearly PM for corporate office and control center equipment.', exclusions: 'Jaisalmer solar park equipment.' },
    // Sterling Hospitals
    { key: 'stl_ms', customerKey: 'sterling', name: 'Hospital Infrastructure Managed Services', typeKey: 'managed_services', status: 'active', startDate: '2026-01-01', endDate: '2026-12-31', noticePeriodDays: 60, services: [{ key: 'noc_monitoring', policy: POLICY_PREMIUM }, { key: 'network_management' }, { key: 'server_management' }, { key: 'storage_management' }, { key: 'backup_management' }, { key: 'virtualization_management' }], entitlements: STD_ENTS(200, 80), scope: MANAGED_SCOPE, value: 3900000, billingCycle: 'quarterly', poNumber: 'SHPL/PUR/2025/0931', signedAt: '2025-12-02', ownerKey: 'lakshmi', description: 'Managed services for the main hospital and Adyar clinic; HIS/PACS infrastructure on premium monitoring.', exclusions: 'HIS/PACS application support (vendor), medical devices.' },
    { key: 'stl_soc', customerKey: 'sterling', name: 'SOC Services', typeKey: 'soc', status: 'active', startDate: '2026-01-01', endDate: '2026-12-31', noticePeriodDays: 60, services: [{ key: 'security_monitoring', policy: POLICY_PREMIUM, teamKey: 'soc' }], entitlements: [{ typeKey: 'incidents', name: 'Security incident investigations', quantity: 40, period: 'yearly', warn: 80 }], scope: SOC_SCOPE, value: 2400000, billingCycle: 'quarterly', poNumber: 'SHPL/PUR/2025/0932', signedAt: '2025-12-02', ownerKey: 'lakshmi', description: 'SOC monitoring focused on patient data protection (HIPAA-aligned controls).' },
    { key: 'stl_amc', customerKey: 'sterling', name: 'Hardware AMC - Main Hospital', typeKey: 'amc', status: 'active', startDate: '2026-01-01', endDate: '2026-12-31', noticePeriodDays: 30, siteKeys: ['main'], services: [{ key: 'amc_support', teamKey: 'field' }, { key: 'preventive_maintenance', teamKey: 'field' }], entitlements: AMC_ENTS(12, 12, 6), scope: AMC_SCOPE(['main']), value: 1250000, billingCycle: 'annual', poNumber: 'SHPL/PUR/2025/0933', signedAt: '2025-12-02', ownerKey: 'lakshmi', description: 'AMC with monthly PM for the hospital data center (24x7 breakdown support).', exclusions: 'Adyar clinic, biomedical equipment.' },
    // Orbital Logistics
    { key: 'orb_amc', customerKey: 'orbital', name: 'Hardware AMC - HQ & Warehouses', typeKey: 'amc', status: 'expiring', startDate: shiftDate(expiring42, -364), endDate: expiring42, noticePeriodDays: 30, services: [{ key: 'amc_support', teamKey: 'field' }, { key: 'preventive_maintenance', teamKey: 'field' }], entitlements: AMC_ENTS(10, 4, 4), scope: AMC_SCOPE(['hq', 'bhi', 'nag']), value: 890000, billingCycle: 'annual', poNumber: 'OLF/PO/2025/0450', signedAt: shiftDate(expiring42, -372), ownerKey: 'lakshmi', description: 'AMC for warehouse networking, wireless and HQ server room. Renewal under discussion with a proposed uplift of 6%.', exclusions: 'Handheld scanners, barcode printers.' },
    { key: 'orb_cloud', customerKey: 'orbital', name: 'AWS Cloud Operations Support', typeKey: 'cloud_support', status: 'active', startDate: '2026-05-01', endDate: '2027-04-30', noticePeriodDays: 30, services: [{ key: 'cloud_support', teamKey: 'cloud' }, { key: 'backup_management' }], entitlements: [{ typeKey: 'engineering_hours', name: 'Cloud engineering hours', quantity: 60, period: 'quarterly', warn: 80, overageRate: 4500 }], scope: CLOUD_SCOPE, value: 1680000, billingCycle: 'monthly', poNumber: 'OLF/PO/2026/0123', signedAt: '2026-04-22', ownerKey: 'lakshmi', description: 'Operations support for the WMS landing zone on AWS ap-south-1 (EC2, RDS, S3, VPC, backups).', exclusions: 'WMS application code, AWS consumption charges.' },
    // Quantum IT Services
    { key: 'qit_cloud', customerKey: 'quantum', name: 'Azure Landing Zone Support', typeKey: 'cloud_support', status: 'active', startDate: '2026-03-01', endDate: '2027-02-28', noticePeriodDays: 30, services: [{ key: 'cloud_support', teamKey: 'cloud' }, { key: 'noc_monitoring' }], entitlements: [{ typeKey: 'engineering_hours', name: 'Cloud engineering hours', quantity: 50, period: 'quarterly', warn: 80, overageRate: 4500 }, { typeKey: 'remote_support_hours', name: 'Remote support hours', quantity: 80, period: 'quarterly', warn: 80 }], scope: CLOUD_SCOPE, value: 1520000, billingCycle: 'monthly', poNumber: 'QIT/PO/2026/0077', signedAt: '2026-02-20', ownerKey: 'lakshmi', description: 'Support for the Azure landing zone (hub-spoke VNets, AKS, SQL MI, Entra ID).' },
    { key: 'qit_soc', customerKey: 'quantum', name: 'SOC Services', typeKey: 'soc', status: 'active', startDate: '2026-03-01', endDate: '2027-02-28', noticePeriodDays: 60, services: [{ key: 'security_monitoring', teamKey: 'soc' }], entitlements: [{ typeKey: 'incidents', name: 'Security incident investigations', quantity: 50, period: 'yearly', warn: 80 }], scope: SOC_SCOPE, value: 1980000, billingCycle: 'quarterly', poNumber: 'QIT/PO/2026/0078', signedAt: '2026-02-20', ownerKey: 'lakshmi', description: 'SOC monitoring with ISO 27001 evidence reporting.' },
    // Riverside University
    { key: 'rvu_net', customerKey: 'riverside', name: 'Campus Network Support', typeKey: 'network_support', status: 'active', startDate: '2026-07-01', endDate: '2027-06-30', noticePeriodDays: 60, policy: POLICY_BUSINESS, services: [{ key: 'network_management' }, { key: 'noc_monitoring' }], entitlements: [...STD_ENTS(100, 40), { typeKey: 'site_visits', name: 'Campus visits', quantity: 6, period: 'yearly', warn: 80 }], scope: NETWORK_SCOPE, value: 1100000, billingCycle: 'half-yearly', poNumber: 'RUT/PUR/2026/0199', signedAt: '2026-06-18', ownerKey: 'lakshmi', description: 'Support for the campus core/distribution network and 120 access points on business hours.', exclusions: 'Student devices, ISP links, ERP application.' },
    { key: 'rvu_ms_2027', customerKey: 'riverside', name: 'Managed Services 2027 (proposal)', typeKey: 'managed_services', status: 'draft', startDate: '2027-01-01', endDate: '2027-12-31', noticePeriodDays: 60, services: [{ key: 'noc_monitoring' }, { key: 'server_management' }, { key: 'backup_management' }, { key: 'end_user_support' }], entitlements: STD_ENTS(120, 60), scope: MANAGED_SCOPE, value: 2650000, billingCycle: 'quarterly', poNumber: 'TBD', ownerKey: 'vikram', description: 'Proposed expansion to full managed services including end user support for faculty. Awaiting university purchase committee.' },
    // Crestline Hotels
    { key: 'crl_ms', customerKey: 'crestline', name: 'Managed IT Services (UK)', typeKey: 'managed_services', status: 'active', startDate: '2026-01-01', endDate: '2026-12-31', noticePeriodDays: 90, policy: POLICY_BUSINESS, calendar: CAL_UK, services: [{ key: 'noc_monitoring', calendar: CAL_UK }, { key: 'network_management', calendar: CAL_UK }, { key: 'server_management', calendar: CAL_UK }, { key: 'backup_management', calendar: CAL_UK }], entitlements: STD_ENTS(120, 50), scope: MANAGED_SCOPE, value: 96000, currency: 'GBP', billingCycle: 'monthly', poNumber: 'CHG-PO-2025-0618', signedAt: '2025-12-01', ownerKey: 'lakshmi', description: 'Managed services for London head office and two hotels on UK business hours, delivered remotely.', exclusions: 'Property management system (Opera) vendor support, guest Wi-Fi provider.' },
  ];
}

async function ensureUkCalendar(state: DemoState, tx: Tx) {
  const [existing] = await tx.select({ id: schema.businessCalendars.id }).from(schema.businessCalendars).where(eq(schema.businessCalendars.name, CAL_UK)).limit(1);
  if (existing) return;
  const hours: Record<string, [string, string][]> = { mon: [['09:00', '17:30']], tue: [['09:00', '17:30']], wed: [['09:00', '17:30']], thu: [['09:00', '17:30']], fri: [['09:00', '17:30']] };
  await tx.insert(schema.businessCalendars).values({ name: CAL_UK, description: 'UK customers supported remotely during London business hours', timezone: 'Europe/London', is24x7: false, hours, holidayCalendarId: null });
  void state;
}

export async function seedContracts(state: DemoState, tx: Tx) {
  const { refs } = state;
  await ensureUkCalendar(state, tx);
  // Refresh calendar lookups now that the UK calendar exists.
  const calendars = new Map((await tx.select().from(schema.businessCalendars)).map((c) => [c.name, c.id]));
  const calendarId = (name?: string) => (name ? calendars.get(name) ?? null : null);
  const ctx = adminCtx(state, tx);
  const byKey = new Map<string, DemoContract>();
  const seeds = contractSeeds(state.now);
  for (const s of seeds) {
    const cust = customer(state, s.customerKey);
    const primary = cust.contacts.find((c) => c.isPrimary)!;
    const esc2 = cust.contacts.find((c) => c.escalationLevel === 2);
    const siteId = (key: string) => cust.sites.find((x) => x.key === key)!.id;
    const year = Number(s.startDate.slice(0, 4));
    const number = `CTR-${year}-${String(seeds.filter((x) => Number(x.startDate.slice(0, 4)) === year).indexOf(s) + 1).padStart(4, '0')}`;
    const input: ContractCreate = {
      customerId: cust.id,
      number,
      name: s.name,
      typeId: refs.option('contract_type', s.typeKey),
      status: s.status,
      startDate: s.startDate,
      endDate: s.endDate,
      renewalDate: s.status === 'draft' ? null : shiftDate(s.endDate, -(s.noticePeriodDays ?? 30)),
      noticePeriodDays: s.noticePeriodDays ?? 30,
      autoRenew: s.autoRenew ?? false,
      supportHoursCalendarId: calendarId(s.calendar ?? (s.policy === POLICY_PREMIUM ? undefined : CAL_BUSINESS)),
      holidayCalendarId: s.calendar === CAL_UK ? null : refs.holidayCalendarId,
      slaPolicyId: refs.policy(s.policy ?? POLICY_STANDARD),
      escalationMatrix: [
        { level: 1, name: 'Service Desk / NOC shift lead', userId: state.users.get('rajesh')!.id, afterMinutes: 60, notes: 'Any P1/P2 not acknowledged within SLA' },
        { level: 2, name: 'Service Delivery Manager', userId: state.users.get('ananya')!.id, afterMinutes: 240 },
        { level: 3, name: 'Head of Managed Services', userId: state.users.get('sarah')!.id, afterMinutes: 480 },
        { level: 1, name: `Customer: ${primary.title}`, contactId: primary.id, afterMinutes: 60 },
        ...(esc2 ? [{ level: 2, name: `Customer: ${esc2.title}`, contactId: esc2.id, afterMinutes: 240 }] : []),
      ],
      responseCommitment: s.responseCommitment ?? 'As per the SLA policy attached to this contract.',
      resolutionCommitment: s.resolutionCommitment ?? 'As per the SLA policy attached to this contract.',
      exclusions: s.exclusions ?? null,
      description: s.description,
      value: s.value,
      currency: s.currency ?? 'INR',
      billingCycle: s.billingCycle,
      commercial: { discountPct: s.typeKey === 'amc' ? 5 : 0, uplift: s.status === 'expiring' ? 'proposed 6% on renewal' : undefined, paymentTerms: 'Net 30' },
      poNumber: s.poNumber,
      signedAt: s.signedAt ?? null,
      ownerUserId: state.users.get(s.ownerKey)!.id,
      customFields: { reviewCadence: 'quarterly' },
      services: s.services.map((svc) => ({ serviceId: state.services.get(svc.key)!.id, slaPolicyId: svc.policy ? refs.policy(svc.policy) : null, teamId: svc.teamKey ? refs.team(svc.teamKey) : null, supportHoursCalendarId: calendarId(svc.calendar), notes: svc.notes ?? null })),
      siteIds: (s.siteKeys ?? []).map(siteId),
      entitlements: s.entitlements.map((e) => ({ typeId: refs.option('entitlement_type', e.typeKey), name: e.name, serviceId: e.serviceKey ? state.services.get(e.serviceKey)!.id : null, quantity: e.quantity, unit: (refs.optionRow('entitlement_type', e.typeKey).metadata.unit as string) ?? 'count', period: e.period, warnThresholdPct: e.warn ?? 80, overageAllowed: e.overageAllowed ?? true, overageRate: e.overageRate ?? null })),
      scopeItems: s.scope.map((sc, i): ScopeItemInput => ({
        name: sc.name,
        description: sc.description ?? null,
        classification: sc.classification ?? 'in_scope',
        headerId: refs.option('scope_header', sc.header),
        categoryId: sc.category ? refs.option('scope_category', sc.category) : null,
        typeId: refs.option('scope_type', sc.classification === 'out_of_scope' ? 'excluded' : 'included'),
        statusId: refs.option('scope_status', 'active'),
        serviceId: sc.serviceKey ? state.services.get(sc.serviceKey)!.id : null,
        siteId: sc.siteKey ? siteId(sc.siteKey) : null,
        ticketCategoryId: sc.ticketCategoryKey ? refs.option('ticket_category', sc.ticketCategoryKey) : null,
        ciTypeKey: sc.ciTypeKey ?? null,
        sortOrder: (i + 1) * 10,
      })),
    };
    const created = await createContract(ctx, input);
    if (s.parentKey) {
      const parent = byKey.get(s.parentKey);
      if (parent) await tx.update(schema.contracts).set({ parentContractId: parent.id, customFields: { reviewCadence: 'quarterly', renewedFrom: parent.number } }).where(eq(schema.contracts.id, created.id));
    }
    const ents = await tx.select().from(schema.contractEntitlements).where(eq(schema.contractEntitlements.contractId, created.id));
    const typeKeyOf = new Map(refs.optionsOf('entitlement_type').map((o) => [o.id, o.key]));
    const dc: DemoContract = {
      key: s.key,
      id: created.id,
      number: created.number,
      name: s.name,
      typeKey: s.typeKey,
      status: s.status,
      startDate: s.startDate,
      endDate: s.endDate,
      serviceKeys: s.services.map((x) => x.key),
      siteKeys: s.siteKeys ?? [],
      entitlements: ents.map((e) => ({ id: e.id, typeKey: typeKeyOf.get(e.typeId ?? '') ?? 'other', contractId: created.id, quantity: Number(e.quantity), unit: e.unit })),
    };
    byKey.set(s.key, dc);
    cust.contracts.push(dc);
  }
  state.counts.contracts = seeds.length;
  state.counts.entitlements = [...byKey.values()].reduce((n, c) => n + c.entitlements.length, 0);
}

/** Entitlement of a type on the customer's covering contracts (active / expiring and in term). */
export function findEntitlement(state: DemoState, customerKey: string, typeKey: string, at: Date): { entitlementId: string; contractId: string } | null {
  const cust = customer(state, customerKey);
  const day = isoDate(at);
  for (const c of cust.contracts) {
    if (!['active', 'expiring'].includes(c.status) || c.startDate > day || c.endDate < day) continue;
    const e = c.entitlements.find((x) => x.typeKey === typeKey);
    if (e) return { entitlementId: e.id, contractId: c.id };
  }
  return null;
}
