import { eq, inArray } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import { createApiKey } from '@/modules/iam/service';
import { encryptSecret } from '@/lib/crypto';
import { adminCtx, customer, type DemoState } from './state';
import { addDays, addMinutes, hashHex, MINUTE } from './rng';

/** Integration definitions and their API keys. Runs in the foundation phase so integration-created tickets carry a real key principal. */
export async function seedIntegrationRows(state: DemoState, tx: Tx) {
  const { refs } = state;
  const ctx = adminCtx(state, tx);
  const meridian = customer(state, 'meridian');
  const prtgKey = await createApiKey(ctx, { name: 'PRTG Monitoring (webhook)', permissions: ['tenant:all', 'tickets:create', 'tickets:read', 'tickets:update', 'cmdb:read', 'integrations:events'] });
  const siemKey = await createApiKey(ctx, { name: 'FortiSIEM - Meridian Bank', permissions: ['tickets:create', 'tickets:read', 'tickets:update', 'cmdb:read', 'integrations:events', 'soc:read'], customerId: meridian.id });
  // Raw keys are intentionally not logged or stored anywhere else; the demo only needs the rows.
  const [prtg] = await tx
    .insert(schema.integrations)
    .values({
      integrationType: 'prtg',
      name: 'PRTG Network Monitor',
      description: 'Central PRTG core server (prtg.msp.local). Devices are tagged with the customer code; alarms arrive via the HTTP notification template.',
      customerId: null,
      apiKeyId: prtgKey.id,
      config: { baseUrl: 'https://prtg.msp.local', customerMapping: { strategy: 'device_tag', tagPrefix: 'cust-', fallback: 'ignore' }, ciMatching: ['monitoringRef', 'hostname', 'ipAddress'], webhookPath: '/api/integrations/prtg/events', acknowledgeInPrtg: true },
      rules: {
        autoCreateTickets: true,
        ticketType: 'incident',
        defaultCategoryId: refs.option('ticket_category', 'availability'),
        defaultPriorityId: refs.option('ticket_priority', 'p3'),
        severityMap: { Down: 'p2', 'Down (Partial)': 'p3', Warning: 'p4', Unusual: 'p4', 'Down (Acknowledged)': 'p4' },
        categoryBySensor: { Ping: 'availability', SNMP: 'availability', 'SNMP Traffic': 'network', 'Disk Free': 'storage', 'CPU Load': 'performance', 'Veeam Backup Job': 'backup', 'UPS': 'hardware' },
        dedupeWindowMinutes: 30,
        autoResolveOnUp: true,
        assignTeamId: refs.team('noc'),
        domain: 'noc',
        sourceKey: 'monitoring',
      },
      autoCreateTickets: true,
      isActive: true,
      lastEventAt: addMinutes(state.now, -7),
    })
    .returning({ id: schema.integrations.id });
  const [siem] = await tx
    .insert(schema.integrations)
    .values({
      integrationType: 'fortisiem',
      name: 'FortiSIEM - Meridian Bank',
      description: 'Customer-dedicated FortiSIEM supervisor; incident notifications forwarded to the SOC queue.',
      customerId: meridian.id,
      apiKeyId: siemKey.id,
      config: { baseUrl: 'https://fsm.meridianbank.example', orgId: 'MERIDIAN', ciMatching: ['siemRef', 'hostname', 'ipAddress'], webhookPath: '/api/integrations/fortisiem/events' },
      rules: {
        autoCreateTickets: true,
        ticketType: 'incident',
        defaultCategoryId: refs.option('ticket_category', 'security_incident'),
        defaultPriorityId: refs.option('ticket_priority', 'p3'),
        severityMap: { critical: 'p1', high: 'p2', medium: 'p3', low: 'p4', info: 'p5' },
        securitySeverityMap: { critical: 'critical', high: 'high', medium: 'medium', low: 'low', info: 'informational' },
        categoryByRule: { 'Brute Force': 'authentication', Malware: 'malware', 'Policy Change': 'firewall', 'Data Exfiltration': 'suspicious_activity' },
        dedupeWindowMinutes: 60,
        minimumSeverity: 'medium',
        assignTeamId: refs.team('soc'),
        domain: 'soc',
        sourceKey: 'siem',
      },
      autoCreateTickets: true,
      isActive: true,
      lastEventAt: addMinutes(state.now, -22),
    })
    .returning({ id: schema.integrations.id });
  state.integrations.set('prtg', prtg!.id);
  state.integrations.set('prtg:apikey', prtgKey.id);
  state.integrations.set('fortisiem', siem!.id);
  state.integrations.set('fortisiem:apikey', siemKey.id);
  state.counts.integrations = 2;
}

const PRTG_SENSORS: [string, string, string][] = [
  ['Ping', 'Down', 'Ping sensor timed out (100% packet loss)'],
  ['SNMP Uptime', 'Down', 'SNMP request timed out (no response)'],
  ['CPU Load', 'Warning', 'CPU load 93% is above the warning limit of 85%'],
  ['Disk Free C:', 'Warning', 'Free disk space 8% is below the warning limit of 10%'],
  ['SNMP Traffic Gi1/0/48', 'Unusual', 'Traffic 940 Mbit/s is unusually high for this time of day'],
  ['Veeam Backup Job', 'Down', 'Last job result: Failed (VSS snapshot timeout)'],
  ['UPS Input Voltage', 'Down', 'Input voltage 0 V - running on battery'],
  ['HTTP', 'Down', 'HTTP 503 Service Unavailable'],
  ['Memory', 'Warning', 'Available memory 6% is below the warning limit of 10%'],
  ['Ping', 'Up', 'OK (24 ms)'],
];

const SIEM_RULES: [string, string, string][] = [
  ['Brute Force', 'high', 'Excessive failed SSL-VPN logons from multiple sources'],
  ['Malware', 'critical', 'EDR quarantined malware with execution attempt'],
  ['Policy Change', 'high', 'Firewall policy modified outside change window'],
  ['Data Exfiltration', 'medium', 'Unusual outbound data volume to low-reputation IP'],
  ['Account Anomaly', 'medium', 'Login from a new country for privileged account'],
  ['Scanner Activity', 'low', 'Port scan detected from internal host'],
];

/** Integration events (7 days), one discovery source per two customers and a completed discovery run with findings. Runs after tickets. */
export async function seedIntegrationEvents(state: DemoState, tx: Tx) {
  const { rng, now } = state;
  const prtgId = state.integrations.get('prtg')!;
  const siemId = state.integrations.get('fortisiem')!;
  const monitored = state.customers.flatMap((c) => c.cis.filter((ci) => ci.monitoringRef).map((ci) => ({ ci, cust: c })));
  const monitoringTickets = [...state.tickets.values()].filter((t) => t.type === 'incident' && t.createdAt.getTime() > now.getTime() - 7 * 86_400_000);
  const rows: (typeof schema.integrationEvents.$inferInsert)[] = [];
  let seq = 0;
  // PRTG: ~48 events over 7 days
  for (let i = 0; i < 48; i++) {
    const { ci, cust } = rng.pick(monitored);
    const [sensor, status, message] = rng.pick(PRTG_SENSORS);
    const receivedAt = addMinutes(now, -rng.int(5, 7 * 24 * 60));
    const externalId = `${ci.monitoringRef}-${hashHex(`${ci.id}:${sensor}:${i}`, 4)}`;
    const linked = status !== 'Up' && rng.chance(0.35) ? monitoringTickets.find((t) => t.ciId === ci.id) ?? null : null;
    let processingStatus: string;
    let note: string | null = null;
    if (status === 'Up') {
      processingStatus = 'correlated';
      note = 'Clear event; matching open ticket auto-resolved or no ticket open';
    } else if (linked) processingStatus = 'ticket_created';
    else if (rng.chance(0.3)) {
      processingStatus = 'deduplicated';
      note = 'Duplicate of an event within the 30-minute dedupe window';
    } else if (rng.chance(0.2)) {
      processingStatus = 'ignored';
      note = 'Severity below the auto-create threshold (Warning)';
    } else processingStatus = 'correlated';
    rows.push({
      receivedAt,
      integrationId: prtgId,
      integrationType: 'prtg',
      customerId: cust.id,
      externalId,
      eventType: `sensor.${status.toLowerCase().replace(/[^a-z]+/g, '_')}`,
      severity: status === 'Down' ? 'error' : status === 'Warning' || status === 'Unusual' ? 'warning' : 'ok',
      status,
      host: ci.hostname ?? ci.name,
      ipAddress: ci.ipAddress,
      sensor,
      message: `${sensor} on ${ci.hostname ?? ci.name}: ${message}`,
      payload: { device: ci.hostname ?? ci.name, deviceid: Number(ci.monitoringRef), sensorid: Number(ci.monitoringRef) * 10 + (i % 7), name: sensor, status, message, group: `cust-${cust.code.toLowerCase()}`, tags: [`cust-${cust.code.toLowerCase()}`, ci.typeKey], datetime: receivedAt.toISOString(), priority: 3, laststatus: status === 'Up' ? 'Down' : 'Up' },
      matchedCiId: ci.id,
      ticketId: linked?.id ?? null,
      processingStatus,
      processingNote: note,
      processedAt: addMinutes(receivedAt, rng.int(0, 3)),
    });
    seq++;
  }
  // FortiSIEM: ~14 events for Meridian Bank
  const meridian = customer(state, 'meridian');
  const siemCis = meridian.cis.filter((c) => c.typeKey === 'firewall' || c.typeKey === 'virtual_machine' || c.typeKey === 'hypervisor');
  const socTickets = [...state.tickets.values()].filter((t) => t.customerKey === 'meridian' && t.type === 'incident' && t.createdAt.getTime() > now.getTime() - 7 * 86_400_000);
  for (let i = 0; i < 14; i++) {
    const ci = rng.pick(siemCis);
    const [rule, severity, message] = rng.pick(SIEM_RULES);
    const receivedAt = addMinutes(now, -rng.int(10, 7 * 24 * 60));
    const linked = rng.chance(0.4) ? socTickets[i % Math.max(1, socTickets.length)] ?? null : null;
    const processingStatus = severity === 'low' ? 'ignored' : linked ? 'ticket_created' : rng.chance(0.4) ? 'deduplicated' : 'correlated';
    rows.push({
      receivedAt,
      integrationId: siemId,
      integrationType: 'fortisiem',
      customerId: meridian.id,
      externalId: `INC-${100200 + seq++}`,
      eventType: `rule.${rule.toLowerCase().replace(/\s+/g, '_')}`,
      severity,
      status: linked ? 'Active' : 'Cleared',
      host: ci.hostname ?? ci.name,
      ipAddress: ci.ipAddress,
      sensor: rule,
      message: `${rule}: ${message} (${ci.hostname ?? ci.name})`,
      payload: { incidentId: 100200 + seq, ruleName: rule, severity, eventSeverity: severity === 'critical' ? 10 : severity === 'high' ? 8 : severity === 'medium' ? 5 : 2, incidentSrc: `185.220.${rng.int(1, 254)}.${rng.int(1, 254)}`, incidentTarget: ci.ipAddress, reportingDevice: ci.hostname ?? ci.name, siemRef: ci.name, status: linked ? 'Active' : 'Cleared', firstSeen: receivedAt.toISOString() },
      matchedCiId: ci.id,
      ticketId: linked?.id ?? null,
      processingStatus,
      processingNote: processingStatus === 'ignored' ? 'Below minimum severity (medium)' : processingStatus === 'deduplicated' ? 'Same FortiSIEM incident id already processed' : null,
      processedAt: addMinutes(receivedAt, 1),
    });
  }
  await tx.insert(schema.integrationEvents).values(rows);
  state.counts.integrationEvents = rows.length;

  // ---- Discovery: one source per two customers; one completed run with findings for ABC Gurgaon.
  const sourceCustomers = state.customers.filter((_, i) => i % 2 === 0);
  const daniel = state.users.get('daniel')!;
  let findings = 0;
  for (const [i, cust] of sourceCustomers.entries()) {
    const site = cust.sites[0]!;
    const subnet = `10.${cust.index}.${site.subnet}.0/24`;
    const [source] = await tx
      .insert(schema.discoverySources)
      .values({
        customerId: cust.id,
        siteId: site.id,
        name: `${cust.name} - ${site.name} LAN scan`,
        sourceType: 'network_scan',
        config: { subnets: [subnet, `10.${cust.index}.${site.subnet + 10}.0/24`], snmp: { version: '2c', communities: [encryptSecret('public')] }, ports: [22, 80, 161, 443, 3389, 8443], timeoutMs: 1500, concurrency: 64, dnsResolve: true, maxHosts: 2048, snmpAlways: true },
        scheduleCron: '0 2 * * 0',
        autoApply: false,
        isActive: true,
        lastRunAt: i === 0 ? addDays(now, -2) : addDays(now, -rng.int(5, 20)),
        createdBy: daniel.id,
      })
      .returning({ id: schema.discoverySources.id });
    if (i !== 0) continue;
    const startedAt = addDays(now, -2);
    const siteCis = cust.cis.filter((c) => c.siteKey === site.key && c.ipAddress && !c.typeKey.startsWith('cloud'));
    const [run] = await tx
      .insert(schema.discoveryRuns)
      .values({
        sourceId: source!.id,
        customerId: cust.id,
        status: 'completed',
        startedAt,
        finishedAt: addMinutes(startedAt, 14),
        stats: { hostsScanned: 508, responsive: siteCis.length + 4, snmp: siteCis.length - 2, findings: siteCis.length + 3, newCis: 3, changed: 2, unchanged: siteCis.length - 2, applied: 1, errors: 0 },
        log: [`Scan started for ${subnet} (and 1 more subnet)`, 'Probing 508 hosts with ICMP + TCP (ports 22,80,161,443,3389,8443)', `${siteCis.length + 4} hosts responsive, ${siteCis.length - 2} answered SNMP v2c`, `Reconciled ${siteCis.length + 3} findings: 3 new, 2 changed, ${siteCis.length - 2} unchanged`, 'Completed in 13m 48s'].join('\n'),
        triggeredBy: daniel.id,
        createdAt: startedAt,
      })
      .returning({ id: schema.discoveryRuns.id });
    const findingRows: (typeof schema.discoveryFindings.$inferInsert)[] = [];
    siteCis.forEach((ci, idx) => {
      const changed = idx === 1 || idx === 3;
      findingRows.push({
        runId: run!.id,
        sourceId: source!.id,
        customerId: cust.id,
        siteId: site.id,
        ipAddress: changed && idx === 3 ? ci.ipAddress!.replace(/\.\d+$/, `.${rng.int(150, 199)}`) : ci.ipAddress!,
        hostname: ci.hostname,
        fqdn: ci.hostname ? `${ci.hostname}.${cust.short}.local` : null,
        macAddress: null,
        manufacturer: changed && idx === 1 ? 'Cisco Systems' : null,
        model: null,
        serialNumber: null,
        sysDescr: ci.typeKey === 'network_switch' ? 'Cisco IOS Software [Cupertino], Catalyst L3 Switch Software (CAT9K_IOSXE), Version 17.9.4' : ci.typeKey === 'firewall' ? 'FortiGate-200F v7.4.3,build2573' : ci.typeKey === 'hypervisor' ? 'VMware ESXi 8.0.2 build-22380479' : null,
        sysObjectId: ci.typeKey === 'network_switch' ? '1.3.6.1.4.1.9.1.2494' : ci.typeKey === 'firewall' ? '1.3.6.1.4.1.12356.101.1.2000' : null,
        suggestedTypeKey: ci.typeKey,
        openPorts: ci.typeKey === 'network_switch' || ci.typeKey === 'firewall' ? [22, 161, 443] : [22, 443],
        interfaces: ci.typeKey === 'network_switch' ? [{ name: 'GigabitEthernet1/0/1', ifIndex: 1, operStatus: 'up', speedMbps: 10000 }, { name: 'GigabitEthernet1/0/2', ifIndex: 2, operStatus: 'up', speedMbps: 10000 }] : [],
        neighbors: ci.typeKey === 'network_switch' ? [{ protocol: 'cdp', localPort: 'Gi1/0/1', remoteSysName: `${cust.short}-${site.code.toLowerCase()}-fw01`, remotePort: 'port1' }] : [],
        raw: { snmp: true, latencyMs: rng.int(1, 12) },
        matchedCiId: ci.id,
        diffStatus: changed ? 'changed' : 'unchanged',
        status: idx === 1 ? 'applied' : 'pending',
        appliedAt: idx === 1 ? addMinutes(startedAt, 60) : null,
        appliedBy: idx === 1 ? daniel.id : null,
        createdAt: addMinutes(startedAt, 10),
      });
    });
    const newDevices: [string, string, string, number[]][] = [
      [`10.${cust.index}.${site.subnet}.201`, 'axis-cam-dock-01', 'iot_device', [80, 443]],
      [`10.${cust.index}.${site.subnet}.202`, `${cust.short}-${site.code.toLowerCase()}-nas02`, 'nas', [22, 443, 5000]],
      [`10.${cust.index}.${site.subnet}.91`, `${cust.short}-${site.code.toLowerCase()}-mfp02`, 'printer', [80, 443, 9100]],
    ];
    for (const [ip, host, type, ports] of newDevices) {
      findingRows.push({ runId: run!.id, sourceId: source!.id, customerId: cust.id, siteId: site.id, ipAddress: ip, hostname: host, fqdn: `${host}.${cust.short}.local`, macAddress: `00:40:8C:${hashHex(host, 6).replace(/(..)(..)(..)/, '$1:$2:$3')}`, manufacturer: type === 'iot_device' ? 'Axis Communications' : type === 'nas' ? 'Synology' : 'HP', model: type === 'iot_device' ? 'P3245-LVE' : type === 'nas' ? 'DS923+' : 'LaserJet M479fdw', sysDescr: type === 'nas' ? 'Linux DS923+ 4.4.302+ #69057 SMP' : null, suggestedTypeKey: type, openPorts: ports, interfaces: [], neighbors: [], raw: { snmp: type === 'nas' }, matchedCiId: null, diffStatus: 'new', status: 'pending', createdAt: addMinutes(startedAt, 11) });
    }
    await tx.insert(schema.discoveryFindings).values(findingRows);
    findings += findingRows.length;
    // The applied finding refreshed the CI it matched.
    const applied = findingRows.find((f) => f.status === 'applied');
    if (applied?.matchedCiId) await tx.update(schema.cis).set({ discoverySource: 'network_scan', discoveredAt: startedAt, lastSeenAt: addMinutes(startedAt, 10), manufacturer: 'Cisco Systems' }).where(eq(schema.cis.id, applied.matchedCiId));
    const matched = findingRows.map((f) => f.matchedCiId).filter((x): x is string => !!x);
    if (matched.length) await tx.update(schema.cis).set({ lastSeenAt: addMinutes(startedAt, 10) }).where(inArray(schema.cis.id, matched));
  }
  state.counts.discoverySources = sourceCustomers.length;
  state.counts.discoveryFindings = findings;
  void MINUTE;
}
