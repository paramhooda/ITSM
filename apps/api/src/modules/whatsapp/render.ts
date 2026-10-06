import type { ChatResult } from '@/modules/ai/service';

/**
 * Pure rendering of an assistant reply as WhatsApp text: Markdown becomes
 * WhatsApp's own formatting (bold with single asterisks, italics with
 * underscores, strikethrough with single tildes, bullets, no tables),
 * app-relative links become absolute web links, a held action gets the YES/NO
 * footer and navigation the model still requested becomes a plain link. Long
 * replies are split into numbered parts under WhatsApp's 4096-character limit.
 */

/** WhatsApp allows 4096 characters per text message; this leaves room for the part prefix. */
export const PART_MAX_CHARS = 3500;
export const MAX_PARTS = 4;
const CUT_NOTE = '… (ask for less at a time)';

const absolute = (target: string, appUrl: string) => (target.startsWith('/') ? `${appUrl.replace(/\/$/, '')}${target}` : target);

/** `[label](target)` → `label (URL)`; a label that already is the URL stays a bare URL. */
function convertLinks(text: string, appUrl: string): string {
  return text.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, label: string, target: string) => {
    const url = absolute(target, appUrl);
    const clean = label.trim();
    return clean && clean !== url && clean !== target ? `${clean} (${url})` : url;
  });
}

/** Stands in for a bold span while the italics rule runs, so `**x**` never reads as `*x*` italics. */
const BOLD = '\uE000';
const inline = (text: string, appUrl: string) =>
  convertLinks(text, appUrl)
    .replace(/\*\*([^*\n]+)\*\*/g, `${BOLD}$1${BOLD}`)
    .replace(/__([^_\n]+)__/g, `${BOLD}$1${BOLD}`)
    .replace(/~~([^~\n]+)~~/g, '~$1~')
    // Markdown italics (*x*) would read as WhatsApp bold; WhatsApp's italics are _x_
    .replace(/(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, '_$1_')
    .replace(/\uE000/g, '*');

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isSeparatorRow = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function markdownToWhatsApp(md: string, appUrl: string): string {
  const src = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < src.length; i++) {
    const line = src[i]!;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push('```');
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (isTableRow(line)) {
      // A GFM table: the header and the separator are dropped, every row becomes one bullet line.
      const block: string[] = [];
      while (i < src.length && isTableRow(src[i]!)) block.push(src[i++]!);
      i--;
      const rows = block.filter((l) => !isSeparatorRow(l));
      const body = block.some(isSeparatorRow) ? rows.slice(1) : rows;
      for (const r of body) {
        const parts = cells(r).map((c) => inline(c, appUrl)).filter((c) => c.length);
        if (parts.length) out.push(`• ${parts.join(' · ')}`);
      }
      continue;
    }
    let l = line;
    const heading = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(l);
    if (heading) {
      out.push(`*${inline(heading[1]!, appUrl).replace(/^\*|\*$/g, '')}*`);
      continue;
    }
    l = l.replace(/^(\s*)[-*+]\s+/, '$1• ');
    l = l.replace(/^\s*>\s?/, '');
    out.push(inline(l, appUrl));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const minutesLeft = (expiresAt: string) => Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000));

export interface RenderOptions {
  appUrl: string;
  /** Sent before the first reply to a person (null afterwards). */
  greeting?: string | null;
}

/** The parts to send, in order: greeting, the reply, the YES/NO footer for a held action, the links for navigation the web would have done. */
export function renderWhatsAppReply(result: Pick<ChatResult, 'message' | 'pendingAction' | 'uiActions'>, opts: RenderOptions): string[] {
  const blocks: string[] = [];
  if (opts.greeting?.trim()) blocks.push(opts.greeting.trim());
  blocks.push(markdownToWhatsApp(result.message.content, opts.appUrl));
  const pending = result.pendingAction;
  if (pending) {
    const lines: string[] = [];
    for (const l of (pending.lines ?? []).slice(0, 8)) lines.push(`• ${inline(l, opts.appUrl)}`);
    if (typeof pending.count === 'number') lines.push(`(${pending.count} record${pending.count === 1 ? '' : 's'})`);
    lines.push(`Reply *YES* to go ahead or *NO* to drop it (within ${minutesLeft(pending.expiresAt)} min).`);
    blocks.push(lines.join('\n'));
  }
  const links = (result.uiActions ?? []).filter((a) => a.type === 'navigate' && a.to.startsWith('/')).map((a) => `Open ${a.label ?? 'page'}: ${absolute(a.to, opts.appUrl)}`);
  if (links.length) blocks.push(links.join('\n'));
  return splitWhatsAppText(blocks.filter((b) => b.trim()).join('\n\n'), PART_MAX_CHARS);
}

/** Splits at paragraph, then line, then word boundaries; more than one part gets a `(i/n) ` prefix; beyond MAX_PARTS the text is cut. */
export function splitWhatsAppText(text: string, max = PART_MAX_CHARS): string[] {
  const body = text.trim();
  if (!body) return [];
  if (body.length <= max) return [body];
  const chunks: string[] = [];
  let rest = body;
  while (rest.length) {
    if (rest.length <= max) {
      chunks.push(rest);
      break;
    }
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max / 3) cut = window.lastIndexOf('\n');
    if (cut < max / 3) cut = window.lastIndexOf(' ');
    if (cut < max / 3) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  let parts = chunks.filter((c) => c.length);
  if (parts.length > MAX_PARTS) {
    parts = parts.slice(0, MAX_PARTS);
    const last = parts[MAX_PARTS - 1]!;
    parts[MAX_PARTS - 1] = `${last.slice(0, Math.max(0, max - CUT_NOTE.length - 12)).trimEnd()}${CUT_NOTE}`;
  }
  return parts.length > 1 ? parts.map((p, i) => `(${i + 1}/${parts.length}) ${p}`) : parts;
}
