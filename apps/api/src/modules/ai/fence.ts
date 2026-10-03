/**
 * Tenant fence for customer (portal) users of the assistant.
 *
 * Row-level security and the service layer already limit what a tool can read.
 * This is the last line: every tool result handed to the model is walked, and any
 * record that names another organisation (a `customerId` that is not the user's,
 * or a `customer` / `customerName` that is neither their name nor their code) is
 * removed before the model sees it. Dropped records are counted so the caller can
 * log and audit the event: under normal operation the count is always zero.
 */

export interface TenantFence {
  customerId: string;
  customerName: string;
  customerCode: string;
}

export interface FenceOutcome {
  value: unknown;
  /** Records removed because they belonged to another organisation. */
  dropped: number;
}

const ID_KEYS = ['customerId', 'customer_id'] as const;
const NAME_KEYS = ['customer', 'customerName', 'customer_name'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FOREIGN = Symbol('foreign');
const norm = (s: string) => s.trim().toLowerCase();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Does this object carry an explicit reference to an organisation other than the fence's? */
export function belongsElsewhere(obj: Record<string, unknown>, fence: TenantFence): boolean {
  for (const k of ID_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && UUID_RE.test(v) && v.toLowerCase() !== fence.customerId.toLowerCase()) return true;
  }
  const own = new Set([norm(fence.customerName), norm(fence.customerCode)]);
  for (const k of NAME_KEYS) {
    const v = obj[k];
    if (typeof v === 'string') {
      if (v.trim() && !own.has(norm(v))) return true;
    } else if (isRecord(v)) {
      const id = v.id;
      const name = v.name;
      const code = v.code;
      if (typeof id === 'string' && UUID_RE.test(id) && id.toLowerCase() !== fence.customerId.toLowerCase()) return true;
      if (typeof name === 'string' && name.trim() && !own.has(norm(name)) && !(typeof code === 'string' && own.has(norm(code)))) return true;
    }
  }
  return false;
}

function walk(value: unknown, fence: TenantFence, stats: { dropped: number }): unknown {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const w = walk(item, fence, stats);
      if (w === FOREIGN) stats.dropped += 1;
      else out.push(w);
    }
    return out;
  }
  if (isRecord(value)) {
    if (belongsElsewhere(value, fence)) return FOREIGN;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const w = walk(v, fence, stats);
      if (w === FOREIGN) {
        stats.dropped += 1;
        out[k] = null;
      } else out[k] = w;
    }
    return out;
  }
  return value;
}

/** Removes every record of another organisation from a tool result. */
export function fenceToolResult(value: unknown, fence: TenantFence): FenceOutcome {
  const stats = { dropped: 0 };
  const w = walk(value, fence, stats);
  if (w === FOREIGN) return { value: { error: 'forbidden', message: 'That record belongs to another organisation and is not available.' }, dropped: stats.dropped + 1 };
  return { value: w, dropped: stats.dropped };
}

// ---------------------------------------------------------------- answer fence (customer users)

const TICKET_NUMBER_RE = /\b(?:INC|REQ|PRB|CHG)-\d{6}\b/g;
const RECORD_LINK_RE = /\(\/(?:portal\/)?(?:tickets|customers|contracts|assets|cmdb\/cis|cmdb|field|knowledge)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[^)]*\)/gi;

/** Ticket numbers and record ids that this conversation has legitimately shown the user. */
export interface SeenRecords {
  numbers: Set<string>;
  ids: Set<string>;
}

/** Collects the ticket numbers and record ids present in any text (tool results, earlier messages). */
export function collectSeen(texts: Iterable<string>, into: SeenRecords = { numbers: new Set(), ids: new Set() }): SeenRecords {
  for (const t of texts) {
    for (const m of t.matchAll(TICKET_NUMBER_RE)) into.numbers.add(m[0].toUpperCase());
    for (const m of t.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) into.ids.add(m[0].toLowerCase());
  }
  return into;
}

export const ANSWER_FENCE_NOTE = 'Some references were left out because they are not available to your organisation.';
export const LINK_FENCE_NOTE = 'A link was left out because it did not match any record shown in this conversation.';

/**
 * An answer may only link to records this conversation has actually shown (for
 * everyone), and a customer user's answer may only name tickets it has shown
 * (ticket-number mode). Anything else (an invented number, a link to a record
 * the tools never returned) is removed, and the reply says so once. Counts how
 * many references were removed so the caller can log it.
 */
export function fenceAnswer(text: string, seen: SeenRecords, opts: { numbers?: boolean; note?: string } = {}): { text: string; removed: number } {
  const numbers = opts.numbers ?? true;
  let removed = 0;
  let out = text.replace(RECORD_LINK_RE, (whole, id: string) => {
    if (seen.ids.has(id.toLowerCase())) return whole;
    removed += 1;
    return '';
  });
  if (numbers) {
    out = out.replace(TICKET_NUMBER_RE, (num) => {
      if (seen.numbers.has(num.toUpperCase())) return num;
      removed += 1;
      return 'a ticket';
    });
  }
  if (!removed) return { text, removed };
  // Empty link labels left behind ("[a ticket]") read as plain text.
  out = out.replace(/\[([^\]]*)\](?=\s|$|\|)/g, '$1');
  return { text: `${out.trimEnd()}\n\n${opts.note ?? (numbers ? ANSWER_FENCE_NOTE : LINK_FENCE_NOTE)}`, removed };
}
