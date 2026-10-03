import { createHash } from 'node:crypto';

/**
 * Secrets never reach the model, the conversation store or the audit trail.
 * Three strengths: `redactKeys` (values under secret-looking keys), `scrubResult`
 * (the same, deep, over any tool result) and `compactForTrace` (redacted and
 * shortened, for the tool-call trace shown in the conversation).
 */

export const SECRET_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|client[_-]?secret)/i;
const MAX_TRACE_STRING = 2000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Values under secret-looking keys become "[redacted]"; everything else is kept as is (one level, for inputs). */
export function redactKeys(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) out[k] = SECRET_KEY.test(k) ? '[redacted]' : v;
  return out;
}

/** Redacted and shortened: what the conversation keeps as the record of a tool call. */
export function compactForTrace(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) out[k] = SECRET_KEY.test(k) ? '[redacted]' : typeof v === 'string' && v.length > MAX_TRACE_STRING ? `${v.slice(0, MAX_TRACE_STRING)}…` : v;
  return out;
}

/** Walks a tool result and redacts every value stored under a secret-looking key, however deep. */
export function scrubResult<T>(value: T, depth = 0): T {
  if (depth > 12) return value;
  if (Array.isArray(value)) return value.map((v) => scrubResult(v, depth + 1)) as unknown as T;
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) && v !== null && v !== undefined && v !== '' ? '[redacted]' : scrubResult(v, depth + 1);
    return out as T;
  }
  return value;
}

/** Stable fingerprint of a tool input for the audit trail (never the input itself). */
export function inputHash(input: Record<string, unknown>): string {
  const canonical = JSON.stringify(input ?? {}, Object.keys(input ?? {}).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
