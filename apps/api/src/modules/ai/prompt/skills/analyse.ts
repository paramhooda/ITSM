import type { SkillDef } from './types';

export const analyse: SkillDef = {
  key: 'analyse',
  title: 'Analyse',
  when: 'the user asks for counts, breakdowns, trends, compliance, usage or a report',
  toolsets: ['reports', 'contracts'],
  portal: true,
  staff: true,
  playbook: [
    'Counts and breakdowns of tickets: query_tickets (count, breakdown with groupBy). SLA: sla_compliance. Contracts and entitlements: list_contracts, entitlement_usage. Headline figures: dashboard_kpis. Time series: trends. Formal reports: list_reports then run_report. Customer satisfaction: csat_summary for the average, the satisfied share and the response rate (always quote the response count with an average); csat_low_ratings for the tickets behind a poor score. Software and licences: software_inventory for what is installed, software_compliance for installed against entitled (over-deployed, unlicensed, unused seats), licence_renewals for what ends or renews soon.',
    'Quote the facts lines; name the period and the definition of what was counted. Compare only figures from this conversation\'s results.',
    'Show a compact table for breakdowns and keep the prose to the finding and one implication.',
    'Offer export_report or schedule_report when the user wants the figures delivered.',
  ],
};
