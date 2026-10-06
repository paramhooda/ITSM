import type { Who, AiTool, ToolsetKey } from '../tools/types';
import type { SkillKey } from '../schemas';
import { PROMPT_VERSION } from './version';
import { identitySection } from './identity';
import { rulesSection } from './rules';
import { STYLE } from './style';
import { skillsFor, skillByKey, playbooksSection } from './skills';
import { contextSection, describeScope } from './context';
import { capabilitiesSection } from './capabilities';

/**
 * The system prompt, assembled from fixed sections in a fixed order:
 * stable (identity, rules, style, the role's playbooks; cacheable across turns
 * and users with the same permission profile) and volatile (operating context,
 * this turn's capabilities).
 */
export { PROMPT_VERSION } from './version';
export { describeScope } from './context';
export * from './features';
export { SKILL_DEFS, skillByKey, skillsFor, type SkillDef } from './skills';

export interface PromptInput {
  /** The principal and its permission check (a request ctx works). */
  ctx: Who;
  tools: AiTool[];
  /** Enabled and enablable toolsets; derived from the tools when omitted. */
  toolsets?: { active: ToolsetKey[]; offered: ToolsetKey[] };
  /** confirm_all (default) or auto_low: low-risk internal writes run without confirmation. */
  autonomy?: 'confirm_all' | 'auto_low';
  /** The current screen ("User is viewing ticket INC-001234 …"), resolved through the service layer. */
  contextDescription?: string | null;
  skill?: SkillKey | null;
  customerScopeSummary: string;
  /** Customer (portal) users: the organisation they belong to. Required for them; ignored for MSP staff. */
  organisation?: { name: string; code: string } | null;
  today?: Date;
  /** Turn notes (a cancelled proposal, …). */
  notes?: string[];
  /** The web panel (default) or WhatsApp: the channel note tells the model how to write and that there is nothing to navigate. */
  channel?: 'web' | 'whatsapp';
}

export interface BuiltPrompt {
  stable: string;
  volatile: string;
  version: string;
  /** Section titles in order (for tests and the control page). */
  sections: string[];
}

export function buildSystemPrompt(p: PromptInput): BuiltPrompt {
  const customer = p.ctx.user.userType === 'customer';
  const canAct = p.ctx.can('ai:act');
  const active = p.toolsets?.active ?? [...new Set(p.tools.map((t) => t.toolset))];
  const offered = p.toolsets?.offered ?? active;
  const skills = skillsFor({ customer, toolsets: offered });
  const stable = [identitySection(customer), rulesSection({ customer }), STYLE, playbooksSection(skills)].join('\n\n');
  const volatile = [
    contextSection({ who: p.ctx, today: p.today, customerScopeSummary: p.customerScopeSummary, organisation: p.organisation, autonomy: p.autonomy, canAct, skill: p.skill ? skillByKey(p.skill) : null, contextDescription: p.contextDescription, notes: p.notes, channel: p.channel }),
    capabilitiesSection({ tools: p.tools, active, offered, canAct }),
  ].join('\n\n');
  return { stable, volatile, version: PROMPT_VERSION, sections: ['Identity', 'Applications', 'Rules', 'How you answer', 'Skills', 'Operating context', 'Current screen', 'Capabilities'] };
}
