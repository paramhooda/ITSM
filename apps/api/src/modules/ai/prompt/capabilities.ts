import { TOOLSETS } from '../toolsets';
import { tierOf, type AiTool, type ToolsetKey } from '../tools/types';

/** What the assistant can do this turn: the enabled toolsets, the tools by tier and the sets it could enable. */
export interface CapabilitiesInput {
  tools: AiTool[];
  active: ToolsetKey[];
  offered: ToolsetKey[];
  canAct: boolean;
}

const TIER_LABEL: Record<string, string> = {
  write_low: 'Low-risk actions (write_low)',
  write: 'Actions that wait for confirmation (write)',
  outbound: 'Outbound actions, always confirmed (outbound)',
  admin: 'Configuration changes, always confirmed (admin)',
  destructive: 'Destructive actions, always confirmed (destructive)',
};

export function capabilitiesSection(p: CapabilitiesInput): string {
  const lines: string[] = ['## Capabilities this turn'];
  lines.push(`Tool groups enabled: ${p.active.map((k) => `${k} (${TOOLSETS[k].description})`).join('; ')}.`);
  const reads = p.tools.filter((t) => !t.action).map((t) => t.name);
  lines.push(`Read tools: ${reads.join(', ') || 'none'}.`);
  if (p.canAct) {
    for (const tier of ['write_low', 'write', 'outbound', 'admin', 'destructive']) {
      const names = p.tools.filter((t) => t.action && tierOf(t) === tier).map((t) => t.name);
      if (names.length) lines.push(`${TIER_LABEL[tier]}: ${names.join(', ')}.`);
    }
    if (!p.tools.some((t) => t.action)) lines.push('No action tools are enabled in these groups; enable the group that has them when the user asks for a change.');
  }
  const more = p.offered.filter((k) => !p.active.includes(k));
  if (more.length) lines.push(`More groups you can enable with enable_toolset when the request needs them: ${more.map((k) => `${k} (${TOOLSETS[k].description})`).join('; ')}.`);
  return lines.join('\n');
}
