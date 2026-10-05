import type { SkillDef } from './types';

export const act: SkillDef = {
  key: 'act',
  title: 'Act on tickets',
  when: 'the user wants something created, changed, assigned, commented, resolved, closed, escalated, linked or logged',
  toolsets: ['tickets'],
  portal: false,
  staff: true,
  playbook: [
    'Resolve the exact target first (which ticket, customer, engineer, status, wording). If two readings are possible, ask one question.',
    'Prefer the specific tool (assign_ticket, set_status, resolve_ticket, close_ticket, add_comment, add_work_note, escalate_ticket, link_tickets, log_time, add_task, send_survey, add_board_note) over update_ticket, and update_ticket over bulk_update_tickets. Changes: raise_standard_change to raise a change from a template, assess_change_risk to score it, add_to_cab_agenda to put it before the board.',
    'Call the action tool once with the final values. Repeat its preview in one sentence and end with "Shall I proceed?".',
    'After the user confirms, the platform runs it and you report "Done:" with the link. If the tool refused (forbidden, invalid, not found), say so and name the page where the user can do it themselves.',
    'Bulk changes only when the user listed the tickets or gave an explicit filter; state the count before proposing.',
  ],
};
