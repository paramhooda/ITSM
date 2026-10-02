import { eq, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import { consumeEntitlement } from '@/modules/contracts/entitlements';
import { addMonths } from '@/modules/contracts/common';
import { type DemoContract, type DemoCustomer, type DemoState } from './state';
import { addDays, addMinutes, atIst, isoDate, istWeekday, HOUR, MINUTE, type Rng } from './rng';

const PM_CHECKLIST = [
  { item: 'Visual inspection of racks, cabling and labelling', required: true },
  { item: 'Clean dust filters and verify airflow / inlet temperature', required: true },
  { item: 'UPS battery health and runtime test', required: true },
  { item: 'Review firmware versions against the agreed baseline', required: true },
  { item: 'Check RAID / disk health on servers and storage', required: true },
  { item: 'Verify backup job status and perform a test restore', required: false },
  { item: 'Review switch port utilisation and error counters', required: false },
  { item: 'Update asset register (serials, locations, photos)', required: true },
];

const FREQUENCY: Record<string, string> = { abc_amc: 'quarterly', nwp_amc: 'quarterly', hel_amc: 'half_yearly', stl_amc: 'monthly', orb_amc: 'quarterly' };
const MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, half_yearly: 6, annual: 12 };

type VisitInsert = typeof schema.fieldVisits.$inferInsert;

interface VisitSpec extends Omit<VisitInsert, 'number'> {
  parts?: { name: string; partNumber: string; serialNumber: string | null; quantity: number; unitCost: number; assetId: string | null; billable: boolean }[];
  notes?: { body: string; isInternal: boolean; authorKey: string; at: Date }[];
  consume?: { entitlementId: string; typeKey: string };
  engineerKey: string;
}

function businessDay(rng: Rng, from: Date, daysMin: number, daysMax: number, hour: number): Date {
  let d = atIst(addDays(from, rng.int(daysMin, daysMax)), hour, rng.pick([0, 30]));
  const wd = istWeekday(d);
  if (wd === 0) d = addDays(d, 1);
  if (wd === 6) d = addDays(d, 2);
  return d;
}

export async function seedFieldService(state: DemoState, tx: Tx) {
  const { rng, now, refs } = state;
  const specs: VisitSpec[] = [];
  const pmOccurrencesToLink: { occurrenceIndex: number; visitIndex: number }[] = [];
  const serviceId = (key: string) => state.services.get(key)!.id;
  const entitlementOf = (c: DemoContract, typeKey: string) => c.entitlements.find((e) => e.typeKey === typeKey) ?? null;
  const contactUser = (cust: DemoCustomer) => cust.contacts.find((c) => c.isPrimary)?.userId ?? state.users.get('ananya')!.id;
  const amcOf = (cust: DemoCustomer) => cust.contracts.find((c) => c.typeKey === 'amc' && ['active', 'expiring'].includes(c.status)) ?? null;
  const engineerFor = (cust: DemoCustomer) => (cust.fieldEngineerKeys.length ? rng.pick(cust.fieldEngineerKeys) : 'suresh');

  // ---------------------------------------------------------------- ticket-driven visits
  const fieldCategories = new Set(['breakdown_support', 'hardware_support', 'preventive_maintenance', 'inspection', 'health_check', 'network_support']);
  const hardwareCategories = new Set(['hardware', 'storage']);
  const candidates = [...state.tickets.values()].filter((t) => t.type === 'incident' && (fieldCategories.has(t.categoryKey) || (hardwareCategories.has(t.categoryKey) && rng.chance(0.5))));
  const ticketVisits = rng.sample(candidates, Math.min(24, candidates.length));
  for (const t of ticketVisits) {
    const cust = state.customers.find((c) => c.key === t.customerKey)!;
    const site = cust.sites.find((s) => s.key === t.siteKey) ?? cust.sites[0]!;
    const amc = amcOf(cust);
    const covered = !!amc && (amc.siteKeys.length === 0 || amc.siteKeys.includes(site.key));
    const engineerKey = engineerFor(cust);
    const engineer = state.users.get(engineerKey)!;
    const isPm = t.categoryKey === 'preventive_maintenance' || t.categoryKey === 'health_check';
    const typeKey = t.categoryKey === 'preventive_maintenance' ? 'preventive_maintenance' : t.categoryKey === 'inspection' ? 'inspection' : t.categoryKey === 'health_check' ? 'health_check' : 'breakdown';
    const ent = amc ? entitlementOf(amc, isPm ? 'pm_visits' : 'site_visits') : null;
    const asset = t.ciId ? cust.assets.find((a) => a.ciId === t.ciId) ?? null : null;
    const hardware = ['breakdown_support', 'hardware_support', 'network_support', 'hardware', 'storage'].includes(t.categoryKey);
    if (t.resolvedAt) {
      const start = businessDay(rng, t.createdAt, 0, 2, rng.int(9, 14));
      const actualStart = start.getTime() < t.resolvedAt.getTime() ? start : addMinutes(t.resolvedAt, -rng.int(120, 300));
      const workMinutes = rng.int(90, 300);
      const actualEnd = addMinutes(actualStart, workMinutes);
      specs.push({
        customerId: cust.id, siteId: site.id, ticketId: t.id, contractId: covered ? amc!.id : null, serviceId: serviceId(isPm ? 'preventive_maintenance' : 'amc_support'), typeId: refs.option('field_visit_type', typeKey),
        title: `${typeKey === 'breakdown' ? 'Breakdown visit' : typeKey === 'inspection' ? 'Inspection' : typeKey === 'health_check' ? 'Health check' : 'PM visit'}: ${t.title.slice(0, 90)}`,
        purpose: `On-site work for ${t.number}: ${t.title}`,
        status: 'completed', engineerId: engineer.id, teamId: refs.team('field'), requestedBy: contactUser(cust),
        scheduledStart: actualStart, scheduledEnd: addMinutes(actualStart, 240), actualStart, actualEnd, travelMinutes: rng.int(30, 120), workMinutes,
        workSummary: hardware ? `Diagnosed the fault on site, replaced the failed component from the engineer kit / spares and verified the device returned to service. Monitoring confirmed healthy status before leaving the site. Ticket ${t.number} updated.` : `Completed the scheduled activity per checklist; findings recorded on the ticket ${t.number} and the customer walked through the results.`,
        findings: hardware ? 'Failed component confirmed by diagnostics; no collateral damage. Rack airflow slightly obstructed by cable bundles - re-dressed.' : 'Equipment within normal parameters. Minor housekeeping issues addressed on site.',
        recommendations: hardware ? 'Keep one spare of this component on site; review UPS runtime for the rack.' : 'Schedule battery replacement within six months; label remaining unlabelled patch cords.',
        checklist: [{ item: 'Safety briefing and site access', done: true, result: 'ok' }, { item: 'Fault diagnosis / activity executed', done: true, result: hardware ? 'issue' : 'ok', notes: hardware ? 'Component replaced' : null }, { item: 'Customer walkthrough and sign-off', done: true, result: 'ok' }],
        customerAckName: cust.contacts.find((c) => c.isPrimary)!.name, customerAckTitle: cust.contacts.find((c) => c.isPrimary)!.title, customerAckAt: addMinutes(actualEnd, 10), customerAckNotes: rng.pick(['Work completed to our satisfaction.', 'Thanks for the quick turnaround.', 'Please share the report by email as well.', null]), customerRating: rng.weighted([[5, 0.5], [4, 0.35], [3, 0.15]]),
        entitlementId: ent?.id ?? null, billable: !covered, reportGeneratedAt: addMinutes(actualEnd, 60), createdAt: t.createdAt, updatedAt: actualEnd,
        parts: hardware && rng.chance(0.6) ? [rng.pick([{ name: 'Power supply unit 750W', partNumber: 'PWR-C1-715WAC-P', unitCost: 42000 }, { name: 'SAS HDD 1.2TB 10K', partNumber: '400-AJPD', unitCost: 28500 }, { name: '10G SFP+ SR transceiver', partNumber: 'SFP-10G-SR', unitCost: 18000 }, { name: 'System board (R750)', partNumber: '0YW3J2', unitCost: 185000 }, { name: 'Fan module', partNumber: 'FAN-T1', unitCost: 9500 }])].map((p) => ({ ...p, serialNumber: `SN${rng.int(100000, 999999)}`, quantity: 1, assetId: asset?.id ?? null, billable: !covered })) : [],
        notes: [{ body: 'Arrived on site; badge issued by security. Starting diagnostics.', isInternal: false, authorKey: engineerKey, at: actualStart }, { body: 'Spare used from the engineer kit; raise replenishment request.', isInternal: true, authorKey: engineerKey, at: actualEnd }],
        consume: ent ? { entitlementId: ent.id, typeKey: ent.typeKey } : undefined,
        engineerKey,
      });
    } else {
      // Open ticket: visit scheduled in the next two weeks, or in progress today.
      const scheduledStart = businessDay(rng, now, 1, 12, rng.int(9, 14));
      specs.push({
        customerId: cust.id, siteId: site.id, ticketId: t.id, contractId: covered ? amc!.id : null, serviceId: serviceId('amc_support'), typeId: refs.option('field_visit_type', typeKey),
        title: `Breakdown visit: ${t.title.slice(0, 90)}`, purpose: `On-site work for ${t.number}: ${t.title}`, status: 'scheduled', engineerId: engineer.id, teamId: refs.team('field'), requestedBy: contactUser(cust),
        scheduledStart, scheduledEnd: addMinutes(scheduledStart, 240), checklist: [{ item: 'Safety briefing and site access', done: false }, { item: 'Fault diagnosis', done: false }, { item: 'Customer sign-off', done: false }],
        entitlementId: ent?.id ?? null, billable: !covered, createdAt: t.createdAt, updatedAt: t.createdAt,
        notes: [{ body: `Visit confirmed with ${cust.contacts.find((c) => c.isPrimary)!.name}; parts to be carried: see ticket.`, isInternal: false, authorKey: engineerKey, at: addMinutes(t.createdAt, 60) }],
        engineerKey,
      });
    }
  }

  // ---------------------------------------------------------------- PM programs and occurrences
  const programs: { id: string; cust: DemoCustomer; contract: DemoContract; frequency: string; occurrences: { plannedDate: string; status: string; visitIndex?: number }[] }[] = [];
  let missedBudget = 2;
  for (const cust of state.customers) {
    const amc = amcOf(cust);
    if (!amc) continue;
    const frequency = FREQUENCY[amc.key] ?? 'quarterly';
    const siteKey = amc.siteKeys[0] ?? cust.sites[0]!.key;
    const site = cust.sites.find((s) => s.key === siteKey)!;
    const pmEnt = entitlementOf(amc, 'pm_visits');
    const engineerKey = engineerFor(cust);
    const cis = cust.cis.filter((c) => c.siteKey === siteKey && ['ups', 'storage_array', 'hypervisor', 'network_switch', 'backup_system'].includes(c.typeKey));
    const [program] = await tx
      .insert(schema.pmPrograms)
      .values({
        customerId: cust.id, siteId: site.id, contractId: amc.id, serviceId: serviceId('preventive_maintenance'), entitlementId: pmEnt?.id ?? null,
        name: `${frequency === 'monthly' ? 'Monthly' : frequency === 'quarterly' ? 'Quarterly' : 'Half-yearly'} PM - ${site.name}`,
        description: `Preventive maintenance of the ${site.name} server room equipment under ${amc.number} (${amc.name}). Visits are scheduled with the site contact at least 14 days in advance.`,
        frequency, startDate: amc.startDate, endDate: amc.endDate, leadDays: 14, graceDays: 7, checklist: PM_CHECKLIST,
        assignedTeamId: refs.team('field'), assignedEngineerId: state.users.get(engineerKey)!.id, ciIds: cis.map((c) => c.id), assetIds: cis.map((c) => c.assetId).filter((x): x is string => !!x), requiresSiteVisit: true, isActive: true,
        createdAt: new Date(`${amc.startDate}T04:30:00Z`), updatedAt: new Date(`${amc.startDate}T04:30:00Z`),
      })
      .returning({ id: schema.pmPrograms.id });
    const occ: (typeof programs)[number]['occurrences'] = [];
    const step = MONTHS[frequency] ?? 3;
    const horizon = isoDate(addDays(now, 190));
    for (let k = 0; ; k++) {
      const planned = addMonths(amc.startDate, k * step);
      if (planned > horizon || planned > amc.endDate) break;
      const plannedDate = new Date(`${planned}T00:00:00Z`);
      const daysAway = Math.round((plannedDate.getTime() - now.getTime()) / 86_400_000);
      if (daysAway < -7) {
        const missed = missedBudget > 0 && (amc.key === 'orb_amc' || amc.key === 'hel_amc') && k === 1;
        if (missed) {
          missedBudget--;
          occ.push({ plannedDate: planned, status: 'missed' });
          continue;
        }
        const actualStart = businessDay(rng, plannedDate, -3, 4, 10);
        const workMinutes = rng.int(180, 300);
        const actualEnd = addMinutes(actualStart, workMinutes);
        const results = PM_CHECKLIST.map((c, i) => {
          const done = !(i === 5 && rng.chance(0.3));
          const notes = i === 2 ? `Runtime ${rng.int(12, 26)} min at ${rng.int(35, 60)}% load` : i === 3 ? (rng.chance(0.3) ? 'Switch firmware behind baseline - change raised' : 'All on baseline') : null;
          return { item: c.item, required: c.required, done, result: !done ? 'na' : notes?.includes('behind') ? 'issue' : 'ok', notes };
        });
        specs.push({
          customerId: cust.id, siteId: site.id, ticketId: null, contractId: amc.id, serviceId: serviceId('preventive_maintenance'), typeId: refs.option('field_visit_type', 'preventive_maintenance'),
          title: `${frequency === 'monthly' ? 'Monthly' : frequency === 'quarterly' ? 'Quarterly' : 'Half-yearly'} PM visit - ${site.name} (${planned.slice(0, 7)})`, purpose: 'Scheduled preventive maintenance per the AMC checklist.',
          status: 'completed', engineerId: state.users.get(engineerKey)!.id, teamId: refs.team('field'), requestedBy: state.users.get('ananya')!.id,
          scheduledStart: actualStart, scheduledEnd: addMinutes(actualStart, 300), actualStart, actualEnd, travelMinutes: rng.int(40, 120), workMinutes,
          workSummary: 'Preventive maintenance completed per checklist: filters cleaned, UPS runtime test performed, firmware baseline reviewed, RAID and backup status verified, asset register updated with photos.',
          findings: results[5]!.done ? 'All checks passed. Two patch cords re-labelled.' : 'All checks passed except the test restore (deferred to the NOC - repository locked by a running job).',
          recommendations: rng.pick(['Replace UPS batteries within 6 months (runtime trending down).', 'Upgrade access switch firmware to the baseline in the next window.', 'Add blanking panels to rack 2 to improve airflow.', 'No actions required.']),
          checklist: results, customerAckName: cust.contacts.find((c) => c.isPrimary)!.name, customerAckTitle: cust.contacts.find((c) => c.isPrimary)!.title, customerAckAt: addMinutes(actualEnd, 15), customerAckNotes: 'PM report received.', customerRating: rng.weighted([[5, 0.6], [4, 0.4]]),
          entitlementId: pmEnt?.id ?? null, billable: false, reportGeneratedAt: addMinutes(actualEnd, 30), createdAt: addDays(actualStart, -14), updatedAt: actualEnd,
          notes: [{ body: 'PM report uploaded; recommendations shared with the site contact.', isInternal: false, authorKey: engineerKey, at: actualEnd }],
          consume: pmEnt ? { entitlementId: pmEnt.id, typeKey: 'pm_visits' } : undefined,
          engineerKey,
        });
        occ.push({ plannedDate: planned, status: 'completed', visitIndex: specs.length - 1 });
      } else if (daysAway <= 14) {
        const scheduledStart = businessDay(rng, plannedDate, 0, 3, 10);
        specs.push({
          customerId: cust.id, siteId: site.id, ticketId: null, contractId: amc.id, serviceId: serviceId('preventive_maintenance'), typeId: refs.option('field_visit_type', 'preventive_maintenance'),
          title: `${frequency === 'monthly' ? 'Monthly' : frequency === 'quarterly' ? 'Quarterly' : 'Half-yearly'} PM visit - ${site.name} (${planned.slice(0, 7)})`, purpose: 'Scheduled preventive maintenance per the AMC checklist.',
          status: 'scheduled', engineerId: state.users.get(engineerKey)!.id, teamId: refs.team('field'), requestedBy: state.users.get('ananya')!.id,
          scheduledStart, scheduledEnd: addMinutes(scheduledStart, 300), checklist: PM_CHECKLIST.map((c) => ({ item: c.item, done: false })),
          entitlementId: pmEnt?.id ?? null, billable: false, createdAt: addDays(scheduledStart, -14), updatedAt: addDays(scheduledStart, -14),
          notes: [{ body: `Visit confirmed with ${cust.contacts.find((c) => c.isPrimary)!.name}.`, isInternal: false, authorKey: engineerKey, at: addDays(scheduledStart, -10) }],
          engineerKey,
        });
        occ.push({ plannedDate: planned, status: 'scheduled', visitIndex: specs.length - 1 });
      } else occ.push({ plannedDate: planned, status: 'planned' });
    }
    programs.push({ id: program!.id, cust, contract: amc, frequency, occurrences: occ });
  }

  // ---------------------------------------------------------------- installation / project / other visits
  const projectSpecs: [string, string, string, string][] = [
    ['apex', 'ind', 'Store refresh: install new switch and access points', 'installation'],
    ['riverside', 'hostel', 'Campus Wi-Fi expansion - hostel block AP installation', 'installation'],
    ['meridian', 'tha', 'Branch firewall replacement (FortiGate 60F)', 'installation'],
    ['quantum', 'pune', 'Office move: network cabinet relocation and re-cabling', 'project'],
    ['abc', 'che', 'Chennai office network audit (out of AMC scope - billable)', 'inspection'],
    ['sterling', 'adyar', 'Clinic UPS installation and commissioning', 'installation'],
  ];
  for (const [custKey, siteKey, title, typeKey] of projectSpecs) {
    const cust = state.customers.find((c) => c.key === custKey)!;
    const site = cust.sites.find((s) => s.key === siteKey) ?? cust.sites[0]!;
    const engineerKey = engineerFor(cust);
    const actualStart = businessDay(rng, now, -100, -5, 10);
    const workMinutes = rng.int(240, 480);
    const amc = amcOf(cust);
    const covered = !!amc && (amc.siteKeys.length === 0 || amc.siteKeys.includes(site.key));
    specs.push({
      customerId: cust.id, siteId: site.id, ticketId: null, contractId: covered ? amc!.id : null, serviceId: serviceId(typeKey === 'inspection' ? 'amc_support' : 'network_management'), typeId: refs.option('field_visit_type', typeKey),
      title, purpose: `${title} as agreed with ${cust.contacts.find((c) => c.isPrimary)!.name}.`, status: 'completed', engineerId: state.users.get(engineerKey)!.id, teamId: refs.team('field'), requestedBy: contactUser(cust),
      scheduledStart: actualStart, scheduledEnd: addMinutes(actualStart, workMinutes + 60), actualStart, actualEnd: addMinutes(actualStart, workMinutes), travelMinutes: rng.int(45, 150), workMinutes,
      workSummary: 'Installation completed per the design document; devices configured from templates, labelled and added to monitoring. Handover walkthrough done with the site contact.',
      findings: 'Existing cabling reused where certified; two runs replaced.', recommendations: 'Add the new devices to the AMC at renewal.',
      checklist: [{ item: 'Pre-installation site check', done: true }, { item: 'Installation and configuration', done: true }, { item: 'Monitoring onboarding', done: true }, { item: 'Handover and sign-off', done: true }],
      customerAckName: cust.contacts.find((c) => c.isPrimary)!.name, customerAckTitle: cust.contacts.find((c) => c.isPrimary)!.title, customerAckAt: addMinutes(actualStart, workMinutes + 15), customerRating: 5,
      entitlementId: null, billable: !covered, reportGeneratedAt: addMinutes(actualStart, workMinutes + 45), createdAt: addDays(actualStart, -10), updatedAt: addMinutes(actualStart, workMinutes),
      notes: [{ body: 'Installation photos and configuration backups attached to the project folder.', isInternal: true, authorKey: engineerKey, at: addMinutes(actualStart, workMinutes) }],
      engineerKey,
    });
  }
  // Earlier breakdown visits for ABC in the current AMC period (before the 120-day history window) so the entitlement nears its threshold.
  {
    const cust = state.customers.find((c) => c.key === 'abc')!;
    const amc = amcOf(cust)!;
    const ent = entitlementOf(amc, 'site_visits');
    const titles = ['Replace failed PSU on gur-acc-sw02', 'Pune plant: UPS bypass switch fault', 'Gurgaon: ESXi host memory DIMM replacement', 'Pune: storage array controller battery replacement', 'Gurgaon: access switch stack cable replacement'];
    titles.forEach((title, i) => {
      const site = cust.sites[i % 2]!;
      const actualStart = businessDay(rng, new Date(`${amc.startDate}T05:00:00Z`), 10 + i * 24, 20 + i * 24, 10);
      if (actualStart.getTime() > now.getTime() - 125 * 86_400_000) return;
      const workMinutes = rng.int(120, 300);
      const actualEnd = addMinutes(actualStart, workMinutes);
      specs.push({ customerId: cust.id, siteId: site.id, ticketId: null, contractId: amc.id, serviceId: serviceId('amc_support'), typeId: refs.option('field_visit_type', 'breakdown'), title, purpose: 'Breakdown support visit under AMC (history migrated from the previous tool).', status: 'completed', engineerId: state.users.get(i % 2 ? 'neha' : 'suresh')!.id, teamId: refs.team('field'), requestedBy: contactUser(cust), scheduledStart: actualStart, scheduledEnd: addMinutes(actualStart, 240), actualStart, actualEnd, travelMinutes: rng.int(45, 120), workMinutes, workSummary: 'Fault diagnosed and part replaced from spares; device returned to service and verified with the NOC.', findings: 'Component failure confirmed; no further issues found.', recommendations: 'None.', checklist: [{ item: 'Fault diagnosis', done: true }, { item: 'Part replacement', done: true }, { item: 'Customer sign-off', done: true }], customerAckName: cust.contacts.find((c) => c.isPrimary)!.name, customerAckTitle: cust.contacts.find((c) => c.isPrimary)!.title, customerAckAt: addMinutes(actualEnd, 10), customerRating: 5, entitlementId: ent?.id ?? null, billable: false, reportGeneratedAt: addMinutes(actualEnd, 30), createdAt: addDays(actualStart, -1), updatedAt: actualEnd, consume: ent ? { entitlementId: ent.id, typeKey: 'site_visits' } : undefined, engineerKey: i % 2 ? 'neha' : 'suresh' });
    });
  }
  // In progress right now, one requested, two cancelled.
  {
    const cust = state.customers.find((c) => c.key === 'abc')!;
    const site = cust.sites[0]!;
    const start = addMinutes(now, -95);
    specs.push({ customerId: cust.id, siteId: site.id, ticketId: null, contractId: amcOf(cust)!.id, serviceId: serviceId('amc_support'), typeId: refs.option('field_visit_type', 'breakdown'), title: 'Replace degraded RAID disk on gur-esx02 (OEM part received)', purpose: 'Install the replacement disk delivered by the OEM and verify the rebuild.', status: 'in_progress', engineerId: state.users.get('suresh')!.id, teamId: refs.team('field'), requestedBy: contactUser(cust), scheduledStart: atIst(now, 10, 0), scheduledEnd: atIst(now, 13, 0), actualStart: start, checklist: [{ item: 'Safety briefing and site access', done: true }, { item: 'Disk replacement', done: false }, { item: 'Rebuild verification', done: false }], entitlementId: entitlementOf(amcOf(cust)!, 'site_visits')?.id ?? null, billable: false, createdAt: addDays(now, -2), updatedAt: start, notes: [{ body: 'On site; disk swap in progress, rebuild expected to take ~2 hours.', isInternal: false, authorKey: 'suresh', at: addMinutes(start, 30) }], engineerKey: 'suresh' });
    const nwp = state.customers.find((c) => c.key === 'northwind')!;
    specs.push({ customerId: nwp.id, siteId: nwp.sites[1]!.id, ticketId: null, contractId: null, serviceId: serviceId('network_management'), typeId: refs.option('field_visit_type', 'installation'), title: 'R&D office: install access point in the new lab area', purpose: 'Requested by Srinivas Kolli through the portal; needs scoping (R&D office is outside the AMC).', status: 'requested', engineerId: null, teamId: refs.team('field'), requestedBy: nwp.contacts[2]?.userId ?? contactUser(nwp), checklist: [], entitlementId: null, billable: true, createdAt: addMinutes(now, -300), updatedAt: addMinutes(now, -300), engineerKey: 'suresh' });
    const hel = state.customers.find((c) => c.key === 'helios')!;
    specs.push({ customerId: hel.id, siteId: hel.sites[0]!.id, ticketId: null, contractId: amcOf(hel)!.id, serviceId: serviceId('amc_support'), typeId: refs.option('field_visit_type', 'inspection'), title: 'Server room inspection after AC failure', purpose: 'Check equipment after the air-conditioning failure reported by facilities.', status: 'cancelled', engineerId: state.users.get('suresh')!.id, teamId: refs.team('field'), requestedBy: contactUser(hel), scheduledStart: businessDay(rng, now, -20, -15, 11), checklist: [], entitlementId: null, billable: false, cancelReason: 'Customer confirmed temperatures stayed within limits; visit not required.', createdAt: addDays(now, -22), updatedAt: addDays(now, -19), engineerKey: 'suresh' });
    const orb = state.customers.find((c) => c.key === 'orbital')!;
    specs.push({ customerId: orb.id, siteId: orb.sites[2]!.id, ticketId: null, contractId: amcOf(orb)!.id, serviceId: serviceId('amc_support'), typeId: refs.option('field_visit_type', 'breakdown'), title: 'Nagpur warehouse: replace faulty access point', purpose: 'AP ap01 reported dead by the warehouse supervisor.', status: 'cancelled', engineerId: state.users.get('amit')!.id, teamId: refs.team('field'), requestedBy: contactUser(orb), scheduledStart: businessDay(rng, now, -9, -6, 10), checklist: [], entitlementId: null, billable: false, cancelReason: 'AP recovered after a PoE port bounce by the NOC; visit cancelled.', createdAt: addDays(now, -10), updatedAt: addDays(now, -9), engineerKey: 'amit' });
  }

  // ---------------------------------------------------------------- insert visits, parts, notes, consumption, time
  const res = await tx.execute(sql`SELECT nextval('field_visit_seq')::int AS n FROM generate_series(1, ${specs.length})`);
  const numbers = (res.rows as { n: number }[]).map((r) => `FV-${String(r.n).padStart(6, '0')}`);
  const ordered = specs.map((s, i) => ({ s, i })).sort((a, b) => (a.s.createdAt as Date).getTime() - (b.s.createdAt as Date).getTime());
  const visitIds: string[] = new Array(specs.length);
  for (const [k, { s, i }] of ordered.entries()) {
    const { parts, notes, consume, engineerKey, ...row } = s;
    const [visit] = await tx.insert(schema.fieldVisits).values({ ...row, number: numbers[k]! }).returning({ id: schema.fieldVisits.id });
    visitIds[i] = visit!.id;
    const engineer = state.users.get(engineerKey)!;
    if (parts?.length) await tx.insert(schema.fieldVisitParts).values(parts.map((p) => ({ visitId: visit!.id, customerId: s.customerId, name: p.name, partNumber: p.partNumber, serialNumber: p.serialNumber, quantity: String(p.quantity), unitCost: String(p.unitCost), assetId: p.assetId, billable: p.billable, notes: p.billable ? 'Billable: site not covered by AMC' : 'Covered under AMC hardware replacement entitlement', createdAt: s.actualEnd ?? s.createdAt ?? now })));
    if (notes?.length) await tx.insert(schema.fieldVisitNotes).values(notes.map((n) => ({ visitId: visit!.id, customerId: s.customerId, authorId: state.users.get(n.authorKey)!.id, authorName: state.users.get(n.authorKey)!.name, body: n.body, isInternal: n.isInternal, createdAt: n.at })));
    if (s.status === 'completed' && s.workMinutes) {
      await tx.insert(schema.timeEntries).values({ ticketId: s.ticketId ?? null, fieldVisitId: visit!.id, customerId: s.customerId, userId: engineer.id, minutes: s.workMinutes, startedAt: s.actualStart ?? null, description: `On-site work: ${s.title}`, workType: 'onsite', billable: !!s.billable, createdAt: s.actualEnd ?? now, updatedAt: s.actualEnd ?? now });
      if (s.travelMinutes) await tx.insert(schema.timeEntries).values({ ticketId: s.ticketId ?? null, fieldVisitId: visit!.id, customerId: s.customerId, userId: engineer.id, minutes: s.travelMinutes, startedAt: addMinutes(s.actualStart as Date, -s.travelMinutes), description: `Travel to ${s.title}`, workType: 'travel', billable: false, createdAt: s.actualEnd ?? now, updatedAt: s.actualEnd ?? now });
    }
    if (consume && s.status === 'completed') {
      const out = await consumeEntitlement(tx, { entitlementId: consume.entitlementId, quantity: 1, consumedAt: s.actualEnd as Date, sourceType: 'field_visit', sourceId: visit!.id, ticketId: s.ticketId ?? null, notes: `${numbers[k]} ${s.title}`, createdBy: engineer.id });
      await tx.update(schema.fieldVisits).set({ consumptionId: out.consumption.id }).where(eq(schema.fieldVisits.id, visit!.id));
    }
    state.visits.push({ id: visit!.id, number: numbers[k]!, customerKey: state.customers.find((c) => c.id === s.customerId)!.key, ticketId: s.ticketId ?? null });
  }
  // Occurrences (linked to visits where they exist).
  let occurrences = 0;
  for (const p of programs) {
    for (const o of p.occurrences) {
      const visitId = o.visitIndex !== undefined ? visitIds[o.visitIndex]! : null;
      const visit = o.visitIndex !== undefined ? specs[o.visitIndex]! : null;
      const [row] = await tx
        .insert(schema.pmOccurrences)
        .values({
          programId: p.id, customerId: p.cust.id, plannedDate: o.plannedDate, scheduledDate: visit?.scheduledStart ? isoDate(visit.scheduledStart as Date) : null, status: o.status, fieldVisitId: visitId, engineerId: visit?.engineerId ?? null,
          completedAt: o.status === 'completed' ? (visit?.actualEnd as Date) : null, checklistResults: o.status === 'completed' ? (visit?.checklist as Record<string, unknown>[]) : [],
          notes: o.status === 'missed' ? 'Site access not granted during the inventory audit week; to be rescheduled with the next cycle.' : o.status === 'completed' ? 'Completed; report attached to the field visit.' : null,
          rescheduleReason: null,
          createdAt: new Date(`${o.plannedDate}T04:30:00Z`), updatedAt: o.status === 'completed' ? (visit?.actualEnd as Date) : o.status === 'missed' ? addDays(new Date(`${o.plannedDate}T04:30:00Z`), 8) : new Date(`${o.plannedDate}T04:30:00Z`),
        })
        .returning({ id: schema.pmOccurrences.id });
      if (visitId) await tx.update(schema.fieldVisits).set({ pmOccurrenceId: row!.id }).where(eq(schema.fieldVisits.id, visitId));
      occurrences++;
    }
  }
  pmOccurrencesToLink.length = 0;
  state.counts.fieldVisits = specs.length;
  state.counts.pmPrograms = programs.length;
  state.counts.pmOccurrences = occurrences;
  void HOUR;
}
