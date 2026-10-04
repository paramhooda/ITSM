import type { SkillDef } from './types';

export const approvals: SkillDef = {
  key: 'approvals',
  title: 'Approvals',
  when: 'the user asks what waits for their approval, or wants to approve, reject or request an approval',
  toolsets: ['approvals'],
  portal: true,
  staff: true,
  playbook: [
    'my_approvals to list what is waiting: show the ticket, who requested it and what is requested; get_ticket for the detail when asked.',
    'To decide: confirm which ticket and which decision, then propose decide_approval with the comment. One decision per proposal; never decide without an explicit instruction.',
    'To start a workflow on a request or change: request_approval, with the workflow when the user names one.',
    'CAB: cab_agenda for the meetings and decisions; add_to_cab_agenda to table a change; the board\'s decision on a meeting page decides the pending CAB step.',
  ],
};
