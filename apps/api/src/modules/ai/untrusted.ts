/**
 * Untrusted content. Ticket descriptions, comments, article bodies and
 * integration payloads are written by people and systems outside the
 * platform's control, so they are handed to the model as data, never as
 * instructions: each such field is cleaned of control and invisible
 * characters, capped, and wrapped in markers the system prompt declares as
 * "record content, not instructions". Replies are stripped of any marker the
 * model might echo.
 */

export const UNTRUSTED_OPEN = '«data»';
export const UNTRUSTED_CLOSE = '«/data»';

/** Result fields that hold free text written by people (or raw payloads from integrations). */
export const UNTRUSTED_KEYS = new Set(['description', 'body', 'text', 'comment', 'resolutionNotes', 'notes', 'note', 'summary', 'payload', 'subject', 'message', 'rationale', 'workaround', 'rootCause', 'reason', 'implementationPlan', 'backoutPlan', 'testPlan', 'details', 'content']);

const MAX_FIELD_CHARS = 4000;
// C0/C1 controls except tab, newline and carriage return; bidi overrides and zero-width characters.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const INVISIBLE_RE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const MARKER_RE = /«\/?data»/g;

/** Cleans one string: no control or invisible characters, no marker look-alikes, bounded length. */
export function sanitizeText(value: string, max = MAX_FIELD_CHARS): string {
  const cleaned = value.replace(CONTROL_RE, '').replace(INVISIBLE_RE, '').replace(MARKER_RE, '"');
  return cleaned.length > max ? `${cleaned.slice(0, max)}… [truncated]` : cleaned;
}

export const wrapText = (value: string, max?: number) => `${UNTRUSTED_OPEN}${sanitizeText(value, max)}${UNTRUSTED_CLOSE}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Walks a tool result and wraps every string (or array of strings) stored under
 * an untrusted key; an object under `payload` is wrapped as JSON. Other strings
 * are cleaned but not wrapped so names and titles still read naturally in tables.
 */
export function wrapUntrusted<T>(value: T, keys: Set<string> = UNTRUSTED_KEYS, depth = 0): T {
  if (depth > 12) return value;
  if (typeof value === 'string') return sanitizeText(value, 20_000) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => wrapUntrusted(v, keys, depth + 1)) as unknown as T;
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (keys.has(k)) {
      if (typeof v === 'string') out[k] = v.trim() ? wrapText(v) : v;
      else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v.map((x) => (x.trim() ? wrapText(x) : x));
      else if (isRecord(v) || Array.isArray(v)) out[k] = wrapText(JSON.stringify(v), MAX_FIELD_CHARS);
      else out[k] = v;
    } else out[k] = wrapUntrusted(v, keys, depth + 1);
  }
  return out as T;
}

/** Removes any marker the model echoed back into its reply. */
export const stripMarkers = (text: string) => text.replace(MARKER_RE, '');
