import type { SkillKey } from '../../schemas';
import type { ToolsetKey } from '../../tools/types';

/** A skill is a playbook: when it applies, which toolsets it works with and the steps to follow. */
export interface SkillDef {
  key: SkillKey;
  title: string;
  /** When the user's request is about this. */
  when: string;
  toolsets: ToolsetKey[];
  /** Offered to customer (portal) users. */
  portal: boolean;
  /** Offered to MSP staff. */
  staff: boolean;
  playbook: string[];
}
