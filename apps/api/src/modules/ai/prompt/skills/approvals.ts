import type { SkillDef } from './types';

export const approvals: SkillDef = {
  key: 'approvals',
  title: 'Approvals',
  when: 'the user asks what waits for their approval, or wants to approve, reject, request or withdraw an approval on a ticket',
  toolsets: ['approvals'],
  portal: true,
  staff: true,
  playbook: [
    'my_approvals to list what is waiting: show the ticket, who requested it and what is requested; get_ticket for the detail when asked.',
    'To decide: confirm which ticket and which decision, then propose decide_approval with the comment. One decision per proposal; never decide without an explicit instruction.',
    'To ask for an approval on any open ticket (incident, request, problem or change): request_approval naming the approver (an administrator of the customer organisation, a staff user, a role, a team or a workflow), the purpose and the due date; the ticket waits in Awaiting Approval with its resolution clock paused while a customer decides and running for an internal approver. withdraw_approval ends a request the desk no longer needs; a decision or a withdrawal brings the ticket back to work.',
    'CAB: cab_agenda for the meetings and decisions; add_to_cab_agenda to table a change; the board\'s decision on a meeting page decides the pending CAB step.',
  ],
};
