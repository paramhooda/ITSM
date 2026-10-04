/**
 * Generated CAB minutes: when a meeting is closed without typed minutes the
 * service writes this record so every closed meeting states who was there,
 * what was decided and what was not reached. Pure text, no database.
 */

export interface MinutesMeeting {
  title: string;
  scheduledAt: Date;
  chairName: string | null;
}

export interface MinutesItem {
  number: string;
  title: string;
  /** pending | approved | rejected | deferred */
  decision: string;
  decidedByName: string | null;
  notes: string | null;
}

const stamp = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const line = (i: MinutesItem) => `- ${i.number} ${i.title}`;

export function renderMinutes(m: MinutesMeeting, items: MinutesItem[], attendees: string[]): string {
  const decided = items.filter((i) => i.decision === 'approved' || i.decision === 'rejected');
  const deferred = items.filter((i) => i.decision !== 'approved' && i.decision !== 'rejected');
  const out: string[] = [
    `Meeting: ${m.title} · ${stamp(m.scheduledAt)} · Chair: ${m.chairName ?? 'not recorded'}`,
    `Attendees: ${attendees.length ? attendees.join(', ') : 'not recorded'}`,
    '',
    'Decisions',
    ...(decided.length ? decided.map((i) => `${line(i)} — ${i.decision} by ${i.decidedByName ?? 'the board'}${i.notes ? ` (${i.notes})` : ''}`) : ['- none']),
    '',
    'Deferred (not reached)',
    ...(deferred.length ? deferred.map((i) => `${line(i)}${i.notes ? ` (${i.notes})` : ''}`) : ['- none']),
  ];
  return `${out.join('\n')}\n`;
}
