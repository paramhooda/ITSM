import type { Who } from '../tools/types';
import type { SkillDef } from './skills';

/**
 * The operating context: who is asking, when, from where, with what autonomy
 * and which skill. Everything here is data the user may already see (their
 * own identity, roles and scope); never credentials or other customers' data.
 * It changes every turn, so it lives in the volatile block.
 */
export interface ContextInput {
  who: Who;
  today?: Date;
  customerScopeSummary: string;
  organisation?: { name: string; code: string } | null;
  autonomy?: 'confirm_all' | 'auto_low';
  canAct: boolean;
  skill?: SkillDef | null;
  /** Current screen (page and record), already resolved through the service layer. */
  contextDescription?: string | null;
  /** Turn notes such as a cancelled proposal. */
  notes?: string[];
  /** The web panel (default) or WhatsApp. */
  channel?: 'web' | 'whatsapp';
}

/** Appended to the operating context for a WhatsApp turn: plain text, short, links as given, no navigation, YES/NO instead of the Confirm card. Volatile, so the stable block is unchanged. */
export const WHATSAPP_CHANNEL_NOTE = [
  '## Channel',
  'The user is chatting from WhatsApp on a phone, not the web application. Plain text only: no Markdown tables (one record per line as "label: value"), no headings, no nested lists; bold only for the headline figure.',
  'Keep replies under about 80 words and show at most 5 records, then offer more.',
  'Links: still use the link field from tool results exactly as given; the platform turns them into full web links.',
  'You cannot open pages or forms here: never call navigate, open_record or prefill_form; give the link instead.',
  'Proposing an action: one sentence saying exactly what will happen, then end with "Reply YES to go ahead or NO to drop it." There is no Confirm card. After acting: one line starting with "Done:" and the link.',
].join('\n');

export const describeScope = (who: Who, organisation?: { name: string; code: string } | null): string => {
  const u = who.user;
  if (u.userType === 'customer') return organisation ? `only ${organisation.name}'s own tickets, contracts, services and knowledge` : 'only their own organisation';
  if (u.customerScope === 'all') return 'all customers (MSP-wide)';
  return `${u.customerScope.length} explicitly assigned customer(s)`;
};

export function contextSection(p: ContextInput): string {
  const u = p.who.user;
  const customer = u.userType === 'customer';
  const today = (p.today ?? new Date()).toISOString().slice(0, 10);
  const roles = u.roles.map((r) => r.name).filter((v, i, a) => a.indexOf(v) === i).join(', ') || (customer ? 'Customer user' : 'User');
  const org = customer ? p.organisation ?? null : null;
  const orgName = org ? `${org.name} (${org.code})` : 'their own organisation';
  const lines: string[] = ['## Operating context', `Today is ${today} (UTC). The user's timezone is ${u.timezone}.`];
  if (customer) {
    lines.push(`User: ${u.name}, a customer (portal) user at ${orgName} with the role${roles.includes(',') ? 's' : ''} ${roles}. They can see ${p.customerScopeSummary}.`);
    lines.push(`The user belongs to ${orgName}. Every answer is about ${org?.name ?? 'their organisation'} only: never mention, list, compare with or speculate about any other organisation. If a tool returns nothing, say nothing was found for ${org?.name ?? 'their organisation'}.`);
  } else {
    lines.push(`User: ${u.name}, MSP staff with the role${roles.includes(',') ? 's' : ''} ${roles}. They can see ${p.customerScopeSummary}.${u.teams.length ? ` Teams: ${u.teams.map((t) => t.name).join(', ')}.` : ''}`);
  }
  if (!p.canAct) lines.push('Actions: NOT enabled for this user. You can only look things up and navigate; if asked to change something, say you cannot and name where in the product they can do it.');
  else if (p.autonomy === 'auto_low') lines.push('Autonomy: low-risk internal writes (work notes, watching, tasks, links, time) apply at once and the tool result says so; every other change waits for the user to confirm the preview.');
  else lines.push('Autonomy: every change waits for the user to confirm the preview.');
  if (p.skill) lines.push(`Active skill: ${p.skill.title}. Follow its playbook for this request.`);
  if (p.contextDescription) lines.push('', '## Current screen', p.contextDescription, 'When the user says "this ticket", "this customer", "this page", "here" or similar, they mean what is on the current screen.');
  if (p.notes?.length) lines.push('', ...p.notes);
  if (p.channel === 'whatsapp') lines.push('', WHATSAPP_CHANNEL_NOTE);
  return lines.join('\n');
}
