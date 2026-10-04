import type { SkillDef } from './types';

export const lookup: SkillDef = {
  key: 'lookup',
  title: 'Look up',
  when: 'the user asks what, where, who, when or how many about records',
  toolsets: ['tickets', 'customers', 'contracts'],
  portal: true,
  staff: true,
  playbook: [
    'Identify the kind of record and the reference (ticket number, customer name, CI name, visit number). When the kind is unclear, use search.',
    'Fetch with the narrowest tool: get_ticket for one ticket; query_tickets for lists, counts and breakdowns; get_customer, get_contract, get_ci, get_asset, get_visit or get_article for one record of that kind.',
    'Answer with the fields that were asked for and link the record. When the question is about progress or urgency, state each SLA clock (running, paused, met, breached) and the time left or over.',
    'Changes: change_calendar lists what is scheduled in a period with each change\'s window, risk and scheduling conflicts (shared systems, the same business service, blackout windows) and the change freezes in force; ticket_approvals shows where a change stands with the approvers and the CAB; standard_changes lists the pre-approved templates; cab_agenda shows the next CAB meetings, their agendas and decisions and the changes still waiting for the board; planned_changes answers what is scheduled on a customer\'s services.',
    'Offer one next step (open the record, triage it, draft an update) only when it follows naturally from the answer.',
  ],
};
