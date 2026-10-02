/**
 * Grounding: the figures in an answer come from the system, never from the model.
 *
 * Tools that compute something return `facts`: exact, server-rendered sentences
 * ("76 open tickets (new, in progress or pending) for Sample Customer"). The chat
 * loop collects them, and if the model's reply does not state at least one of the
 * figures those facts carry, the facts are put first so the user always reads the
 * system's number. Replies that already quote the figure are left untouched.
 */

const INTEGER_RE = /\d[\d,]*/g;

/** Facts carried by one tool result, if any. */
export function factsOf(content: string): string[] {
  try {
    const v = JSON.parse(content) as { facts?: unknown };
    return Array.isArray(v?.facts) ? v.facts.filter((f): f is string => typeof f === 'string' && f.trim().length > 0) : [];
  } catch {
    return [];
  }
}

const figures = (text: string) => new Set((text.match(INTEGER_RE) ?? []).map((n) => n.replace(/,/g, '')));

/** Bolds the leading figure of a fact so it reads as the headline. */
const headline = (fact: string) => fact.replace(/^(\d[\d,]*)/, '**$1**');

export function groundAnswer(text: string, facts: string[]): { text: string; prepended: boolean } {
  const unique = [...new Set(facts.map((f) => f.trim()))];
  if (!unique.length) return { text, prepended: false };
  const expected = new Set<string>();
  for (const f of unique) for (const n of figures(f)) expected.add(n);
  if (!expected.size) return { text, prepended: false };
  const stated = figures(text);
  for (const n of expected) if (stated.has(n)) return { text, prepended: false };
  const lead = unique.map(headline).join('  \n');
  return { text: text.trim() ? `${lead}\n\n${text.trim()}` : lead, prepended: true };
}
