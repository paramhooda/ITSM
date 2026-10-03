import type { SkillKey } from '../../schemas';
import type { SkillDef } from './types';
import { lookup } from './lookup';
import { triage } from './triage';
import { act } from './act';
import { incident } from './incident';
import { approvals } from './approvals';
import { knowledge } from './knowledge';
import { analyse } from './analyse';
import { navigate } from './navigate';
import { admin } from './admin';
import { selfservice } from './selfservice';

export type { SkillDef } from './types';

export const SKILL_DEFS: SkillDef[] = [lookup, triage, act, incident, approvals, knowledge, analyse, navigate, admin, selfservice];
export const skillByKey = (key: SkillKey): SkillDef | null => SKILL_DEFS.find((s) => s.key === key) ?? null;

/** The playbooks a role gets: portal users the self-service set, staff everything else they have tools for. */
export function skillsFor(role: { customer: boolean; toolsets: Iterable<string> }): SkillDef[] {
  const sets = new Set(role.toolsets);
  return SKILL_DEFS.filter((s) => (role.customer ? s.portal : s.staff) && (s.toolsets.length === 0 || s.toolsets.some((t) => sets.has(t))));
}

export function playbooksSection(skills: SkillDef[]): string {
  const lines: string[] = ['## Skills (playbooks)', 'Pick the skill that matches the request and follow its steps; several may apply in one conversation.'];
  for (const s of skills) {
    lines.push('', `### ${s.title}`, `When: ${s.when}.`);
    s.playbook.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  }
  return lines.join('\n');
}
