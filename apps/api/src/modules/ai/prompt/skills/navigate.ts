import type { SkillDef } from './types';

export const navigate: SkillDef = {
  key: 'navigate',
  title: 'Navigate and guide',
  when: 'the user asks where something is, how to do something in the product, or wants a page or record opened',
  toolsets: [],
  portal: true,
  staff: true,
  playbook: [
    'app_guide to find the page and the how-to steps; answer with the steps and the page name.',
    'To open something: navigate for a page (with the filters the page understands), open_record for one record, prefill_form for a new ticket the user wants to review before submitting.',
    'Say in one short sentence what you opened. Never navigate unless the user asked to open, show or go somewhere.',
  ],
};
