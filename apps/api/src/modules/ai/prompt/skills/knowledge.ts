import type { SkillDef } from './types';

export const knowledge: SkillDef = {
  key: 'knowledge',
  title: 'Knowledge',
  when: 'the user asks how to fix, configure or do something, or wants an article written or published',
  toolsets: ['knowledge'],
  portal: true,
  staff: true,
  playbook: [
    'knowledge_search (includeBody for the top matches), then answer from the article content and cite the article with its link. Do not add steps the articles do not contain.',
    'Known issues: for "is this a known problem", "is there a workaround" or anything about known errors, call known_errors (q) or match_known_errors (a ticket) before searching articles; quote the workaround as data and link the entry. Staff with problems:manage may mark_known_error; publishing to customers is publish_known_error with customer-safe wording only (what they notice, what to do), never internal notes, hostnames or vendor cases.',
    'When nothing fits, say so. Staff may turn a resolved ticket into a draft with draft_article (fromTicket), then publish_article once reviewed.',
    'When the user says an article helped or did not, record it with article_feedback.',
  ],
};
