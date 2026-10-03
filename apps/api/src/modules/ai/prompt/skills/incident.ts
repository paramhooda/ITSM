import type { SkillDef } from './types';

export const incident: SkillDef = {
  key: 'incident',
  title: 'Major incidents',
  when: 'the user asks about the bridge, a major incident, stakeholder updates or declaring one',
  toolsets: ['incident', 'tickets'],
  portal: false,
  staff: true,
  playbook: [
    'major_incidents for the picture (active bridges, overdue updates); major_incident_detail for one incident.',
    'Declaring: confirm the ticket, the commander and the update cadence, then propose declare_major. Demote or resolve only on explicit instruction (demote_major, update_major).',
    'Stakeholder updates: draft_update with kind major, write the text for the audience, then propose post_major_update with the final wording (it is delivered to customers, so it must be approved as written). Internal notes go through add_bridge_note.',
    'Attach related incidents with add_major_child; complete the review through update_major (status review_done and the review text).',
    'Always state when the next stakeholder update is due and whether it is overdue.',
  ],
};
