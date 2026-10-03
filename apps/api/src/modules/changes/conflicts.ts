/**
 * Conflict detection for a change window, pure part: the service gathers the
 * candidate's CIs, the business services they roll up to, the other changes
 * in the same period and the blackout windows; this file decides what
 * overlaps what. A conflict is a warning on the ticket, never a block.
 */

export type ConflictKind = 'ci' | 'service' | 'blackout';

export interface Window {
  start: Date;
  end: Date;
}

export interface OtherChange {
  ticketId: string;
  number: string;
  title: string;
  customerId: string;
  customerName: string | null;
  changeType: string;
  status: string | null;
  start: Date;
  end: Date;
  /** Configuration items the change touches (primary and affected). */
  ciIds: string[];
  /** Business services those CIs roll up to. */
  serviceIds: string[];
}

export interface Blackout {
  id: string;
  name: string;
  reason: string | null;
  customerId: string | null;
  start: Date;
  end: Date;
  allowEmergency: boolean;
}

export interface Candidate extends Window {
  ticketId?: string | null;
  customerId: string;
  changeType: string;
  ciIds: string[];
  serviceIds: string[];
}

export interface Conflict {
  kind: ConflictKind;
  /** Short text for the activity and the banner. */
  text: string;
  /** The other change, when there is one. */
  ticket?: { id: string; number: string; title: string; customerName: string | null; start: Date; end: Date } | null;
  /** What is shared: CI ids or business service ids. */
  shared?: string[];
  blackout?: { id: string; name: string; reason: string | null; start: Date; end: Date } | null;
}

/** Half-open overlap: windows touching at an edge do not overlap. */
export const overlaps = (a: Window, b: Window) => a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();

/** A change without an end is assumed to take an hour. */
export const DEFAULT_WINDOW_MS = 60 * 60_000;
export const windowOf = (start: Date, end: Date | null | undefined): Window => ({ start, end: end && end.getTime() > start.getTime() ? end : new Date(start.getTime() + DEFAULT_WINDOW_MS) });

const intersect = (a: string[], b: string[]) => {
  const set = new Set(b);
  return a.filter((x) => set.has(x));
};

export function findConflicts(candidate: Candidate, others: OtherChange[], blackouts: Blackout[]): Conflict[] {
  const out: Conflict[] = [];
  for (const o of others) {
    if (candidate.ticketId && o.ticketId === candidate.ticketId) continue;
    if (!overlaps(candidate, o)) continue;
    const ref = { id: o.ticketId, number: o.number, title: o.title, customerName: o.customerName, start: o.start, end: o.end };
    const sharedCis = intersect(candidate.ciIds, o.ciIds);
    if (sharedCis.length) {
      out.push({ kind: 'ci', text: `Overlaps ${o.number} (${o.title}) on ${sharedCis.length} shared configuration item${sharedCis.length === 1 ? '' : 's'}`, ticket: ref, shared: sharedCis });
      continue;
    }
    const sharedServices = intersect(candidate.serviceIds, o.serviceIds);
    if (sharedServices.length) out.push({ kind: 'service', text: `Overlaps ${o.number} (${o.title}) on the same business service`, ticket: ref, shared: sharedServices });
  }
  for (const b of blackouts) {
    if (b.customerId && b.customerId !== candidate.customerId) continue;
    if (!overlaps(candidate, b)) continue;
    if (candidate.changeType === 'emergency' && b.allowEmergency) continue;
    out.push({ kind: 'blackout', text: `Falls inside the blackout window "${b.name}"${b.reason ? ` (${b.reason})` : ''}`, blackout: { id: b.id, name: b.name, reason: b.reason, start: b.start, end: b.end } });
  }
  return out;
}
