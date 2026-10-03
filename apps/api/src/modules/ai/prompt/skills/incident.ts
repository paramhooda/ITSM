import type { SkillDef } from './types';

export const incident: SkillDef = {
  key: 'incident',
  title: 'Major incidents, on-call, announcements and shift handover',
  when: 'the user asks about the bridge, a major incident, stakeholder updates, declaring one, who is on call, paging someone, an announcement or status banner for customers, or the shift handover (what the incoming shift must watch)',
  toolsets: ['incident', 'tickets'],
  portal: false,
  staff: true,
  playbook: [
    'major_incidents for the picture (active bridges, overdue updates); major_incident_detail for one incident.',
    'Declaring: confirm the ticket, the commander and the update cadence, then propose declare_major. Demote or resolve only on explicit instruction (demote_major, update_major).',
    'Stakeholder updates: draft_update with kind major, write the text for the audience, then propose post_major_update with the final wording (it is delivered to customers, so it must be approved as written). Internal notes go through add_bridge_note.',
    'Attach related incidents with add_major_child; complete the review through update_major (status review_done and the review text).',
    'Always state when the next stakeholder update is due and whether it is overdue.',
    'Announcements: to tell customers or staff about an outage, planned maintenance or news, write the title and the body for the audience (plain, calm, no internal names) and propose create_announcement with the type, the audience, the customer when it concerns one organisation, the ticket it is about and when the banner should come down; it is published as written, so the user must approve the wording.',
    'On-call: who_is_on_call answers "who is on call for the NOC" with the person, the rota and when their cover ends; never guess from the team list. To wake someone for a ticket, propose page_on_call with the ticket and, when the team has no default policy, the policy name; the platform pages step by step and escalates until someone acknowledges.',
    'Shift handover: shift_handover gives a team\'s live digest (open, P1/P2, breached, at risk, unassigned, waiting on the customer, major incidents, changes next, on call now and next) and its latest published handover with who acknowledged it; answer "what should the night shift watch" from the digest facts and the Watch-first section, and send the person to the Handover page to write or acknowledge one.',
  ],
};
