import { sql } from 'drizzle-orm';
import { TICKET_PREFIX, type TicketType } from '@itsm/shared';
import type { Tx } from '@/db/client';

const SEQUENCES: Record<TicketType, string> = {
  incident: 'ticket_incident_seq',
  request: 'ticket_request_seq',
  problem: 'ticket_problem_seq',
  change: 'ticket_change_seq',
};

/** Allocates the next ticket number (`INC-001234`) from the per-type sequence. Never generated client-side. */
export async function nextTicketNumber(tx: Tx, type: TicketType): Promise<string> {
  const seq = SEQUENCES[type];
  if (!seq) throw new Error(`Unknown ticket type: ${type}`);
  const res = await tx.execute(sql.raw(`SELECT nextval('${seq}')::bigint AS n`));
  const n = Number((res.rows[0] as { n: number | string }).n);
  return `${TICKET_PREFIX[type]}-${String(n).padStart(6, '0')}`;
}

export const ticketPrefixOf = (type: TicketType) => TICKET_PREFIX[type];
