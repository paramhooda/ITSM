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
    'Custom reports: when the user wants a table or breakdown the fixed reports do not offer, read report_catalog for the field keys, then propose build_report with the entity, columns or grouping, filters, the period field and sharing (private unless asked); after the user confirms, offer run_report on the saved report or a schedule. Saved custom reports run through run_report like any other report.',
    'Quote the facts lines; name the period and the definition of what was counted. Compare only figures from this conversation\'s results.',
    'Show a compact table for breakdowns and keep the prose to the finding and one implication.',
    'Offer export_report or schedule_report when the user wants the figures delivered.',
  ],
};
