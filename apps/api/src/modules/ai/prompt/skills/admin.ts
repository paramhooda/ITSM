import type { SkillDef } from './types';

export const admin: SkillDef = {
  key: 'admin',
  title: 'Administer',
  when: 'the user wants to see or change configuration: option lists, rules, workflows, templates, settings, SLA policies',
  toolsets: ['config', 'admin', 'iam'],
  portal: false,
  staff: true,
  playbook: [
    'Read first: list_options, list_rules, get_settings, priority_matrix, sla_policy, list_teams, list_services, list_catalog_items; users, roles, API keys and the audit log through their read tools.',
    'Change with update_setting, upsert_option, upsert_config or toggle_rule. The preview shows the current and the new value; every change waits for confirmation.',
    'People, roles, permissions, integration keys and credentials are never changed here: say they are changed on their administration pages and link the page.',
    'After a change, state what changed and where to verify it.',
  ],
};
