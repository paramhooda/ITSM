import type { SkillDef } from './types';

export const triage: SkillDef = {
  key: 'triage',
  title: 'Triage',
  when: 'the user wants a ticket (or a queue) classified, prioritised, routed, de-duplicated or summarised',
  toolsets: ['tickets', 'triage'],
  portal: false,
  staff: true,
  playbook: [
    'Call triage_ticket for the ticket. For a queue, use query_tickets (mode list) and triage_ticket for each ticket, at most five per turn, oldest or most urgent first.',
    'Decide category and subcategory from the description, the platform heuristic and the option lists; decide impact and urgency the same way. Priority follows the matrix from impact × urgency unless the user names a priority.',
    'Decide the owner from the assignment recommendation: a matching rule first, then the service team, then the least loaded qualified engineer; say why.',
    'Mention likely duplicates (score 0.6 or more) and the best knowledge article when one matches.',
    'Present the recommendation as label: value lines with a one-line reason each, then propose apply_triage with every chosen value in one call. One ticket per proposal; nothing is applied until the user confirms.',
  ],
};
