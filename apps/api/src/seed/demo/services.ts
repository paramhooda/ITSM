import type { Tx } from '@/db/client';
import { createService } from '@/modules/services/service';
import { adminCtx, POLICY_STANDARD, type DemoState } from './state';

interface ServiceSeed {
  key: string;
  name: string;
  description: string;
  /** service_category key. */
  categoryKey: string;
  /** service_subcategory key (child of categoryKey). */
  subcategoryKey: string;
  domain: 'general' | 'noc' | 'soc' | 'amc' | 'service_desk';
  teamKey: string;
  ticketCategoryKey: string | null;
  ciTypeKeys: string[];
  ownerKey: string;
}

export const SERVICE_SEEDS: ServiceSeed[] = [
  { key: 'network_management', name: 'Network Management', description: 'Monitoring, configuration and incident management for LAN/WAN switches, routers, firewalls and wireless.', categoryKey: 'managed_infrastructure', subcategoryKey: 'network_management', domain: 'noc', teamKey: 'noc', ticketCategoryKey: 'network', ciTypeKeys: ['network_switch', 'router', 'firewall', 'wireless_controller', 'access_point', 'load_balancer'], ownerKey: 'rajesh' },
  { key: 'server_management', name: 'Server Management', description: 'Operating system administration, patching, performance and availability management for physical and virtual servers.', categoryKey: 'managed_infrastructure', subcategoryKey: 'server_virtualization', domain: 'noc', teamKey: 'noc', ticketCategoryKey: 'server', ciTypeKeys: ['server', 'virtual_machine'], ownerKey: 'rajesh' },
  { key: 'storage_management', name: 'Storage Management', description: 'Capacity, performance and health management of SAN/NAS storage arrays and fabrics.', categoryKey: 'managed_infrastructure', subcategoryKey: 'storage_backup', domain: 'noc', teamKey: 'noc', ticketCategoryKey: 'storage', ciTypeKeys: ['storage_array', 'nas', 'san_switch'], ownerKey: 'rajesh' },
  { key: 'backup_management', name: 'Backup Management', description: 'Backup job monitoring, restore handling, retention policy and DR readiness checks.', categoryKey: 'managed_infrastructure', subcategoryKey: 'storage_backup', domain: 'noc', teamKey: 'noc', ticketCategoryKey: 'backup', ciTypeKeys: ['backup_system'], ownerKey: 'rajesh' },
  { key: 'virtualization_management', name: 'Virtualization Management', description: 'Hypervisor cluster administration, VM lifecycle, capacity and HA/DRS management.', categoryKey: 'managed_infrastructure', subcategoryKey: 'server_virtualization', domain: 'noc', teamKey: 'noc', ticketCategoryKey: 'virtualization', ciTypeKeys: ['hypervisor', 'virtual_machine'], ownerKey: 'rajesh' },
  { key: 'security_monitoring', name: 'Security Monitoring (SOC)', description: '24x7 SIEM monitoring, alert triage, incident response and threat advisories delivered by the SOC.', categoryKey: 'managed_security', subcategoryKey: 'security_monitoring', domain: 'soc', teamKey: 'soc', ticketCategoryKey: 'security_incident', ciTypeKeys: ['firewall', 'security_appliance', 'server', 'endpoint'], ownerKey: 'sneha' },
  { key: 'noc_monitoring', name: 'NOC Monitoring', description: '24x7 infrastructure monitoring (PRTG) with alert handling, first-level diagnosis and escalation.', categoryKey: 'managed_infrastructure', subcategoryKey: 'network_management', domain: 'noc', teamKey: 'noc', ticketCategoryKey: 'availability', ciTypeKeys: ['server', 'network_switch', 'router', 'firewall', 'storage_array', 'ups'], ownerKey: 'rajesh' },
  { key: 'cloud_support', name: 'Cloud Infrastructure Support', description: 'Operations support for AWS/Azure landing zones: compute, storage, networking, cost and backup.', categoryKey: 'managed_infrastructure', subcategoryKey: 'cloud_management', domain: 'noc', teamKey: 'cloud', ticketCategoryKey: 'cloud', ciTypeKeys: ['cloud_account', 'cloud_resource'], ownerKey: 'deepak' },
  { key: 'amc_support', name: 'AMC Support', description: 'Annual maintenance: breakdown support, on-site visits and part replacement for covered hardware.', categoryKey: 'amc_field', subcategoryKey: 'hardware_amc', domain: 'amc', teamKey: 'field', ticketCategoryKey: 'breakdown_support', ciTypeKeys: ['server', 'network_switch', 'firewall', 'storage_array', 'ups', 'access_point'], ownerKey: 'ananya' },
  { key: 'preventive_maintenance', name: 'Preventive Maintenance', description: 'Scheduled preventive maintenance visits with checklists, health reports and recommendations.', categoryKey: 'amc_field', subcategoryKey: 'preventive_maintenance', domain: 'amc', teamKey: 'field', ticketCategoryKey: 'preventive_maintenance', ciTypeKeys: ['server', 'network_switch', 'ups', 'storage_array'], ownerKey: 'ananya' },
  { key: 'end_user_support', name: 'End User Support', description: 'Service desk for end users: accounts, email, collaboration tools, laptops and standard software.', categoryKey: 'service_desk', subcategoryKey: 'service_desk_support', domain: 'service_desk', teamKey: 'service_desk', ticketCategoryKey: 'access', ciTypeKeys: ['endpoint', 'printer'], ownerKey: 'ananya' },
];

export async function seedServices(state: DemoState, tx: Tx) {
  const { refs } = state;
  const ctx = adminCtx(state, tx);
  for (const s of SERVICE_SEEDS) {
    const row = await createService(ctx, {
      key: s.key,
      name: s.name,
      description: s.description,
      categoryId: refs.option('service_category', s.categoryKey),
      subcategoryId: refs.option('service_subcategory', s.subcategoryKey),
      statusId: refs.option('service_status', 'active'),
      domain: s.domain,
      defaultTeamId: refs.team(s.teamKey),
      defaultSlaPolicyId: refs.policy(POLICY_STANDARD),
      defaultTicketCategoryId: s.ticketCategoryKey ? refs.option('ticket_category', s.ticketCategoryKey) : null,
      ciTypeKeys: s.ciTypeKeys,
      ownerUserId: state.users.get(s.ownerKey)!.id,
    });
    state.services.set(s.key, { key: s.key, id: row.id, name: s.name, domain: s.domain, teamKey: s.teamKey, categoryKey: s.ticketCategoryKey });
  }
  state.counts.services = state.services.size;
}
