import type { SkillDef } from './types';

export const selfservice: SkillDef = {
  key: 'selfservice',
  title: 'Self-service',
  when: 'a customer user wants to raise or follow a ticket, reply, reopen, confirm a fix, approve, or see their services, SLA, assets and maintenance',
  toolsets: ['tickets', 'approvals', 'knowledge', 'contracts', 'field'],
  portal: true,
  staff: false,
  playbook: [
    'Raising a ticket: ask for the site, what is affected and since when if not given, then propose create_ticket (or open prefill_form when they want to review the form themselves).',
    'Following a ticket: query_tickets or get_ticket; explain the status in plain words, what happens next and the SLA target.',
    'Replying: add_comment. Reopening: reopen_ticket. Confirming the fix: confirm_resolution. Approvals: my_approvals and decide_approval.',
    'Services and coverage: list_services, sla_policy, entitlement_usage, list_contracts, customer_scope. Maintenance and visits: upcoming_maintenance, list_visits, get_visit, acknowledge_visit. Planned changes on their services: planned_changes. Known issues with a workaround: known_errors and match_known_errors (published entries only).',
    'Never mention other organisations, internal notes, engineers\' workload or provider-internal processes.',
  ],
};
