import { ValidationError } from '@/core/errors';

/** Attribute schema entry as stored on ci_types.attribute_schema. */
export interface AttributeDef {
  key: string;
  label?: string;
  type?: 'text' | 'textarea' | 'number' | 'date' | 'select' | 'boolean' | 'multiselect' | string;
  required?: boolean;
  options?: (string | { value: string; label?: string })[];
  helpText?: string;
}

/** Keys written by discovery / integrations that are preserved regardless of the type schema. */
export const RESERVED_ATTRIBUTE_KEYS = ['snmp', 'discovery', 'monitoring', 'cloud'];

const optionValues = (def: AttributeDef) => (def.options ?? []).map((o) => (typeof o === 'string' ? o : o.value));

/**
 * Validates and normalises CI attributes against the type's attribute schema:
 * required fields, select options, number/date/boolean coercion. Unknown keys
 * are stripped (except the reserved integration namespaces).
 */
export function validateAttributes(schemaDefs: unknown, input: Record<string, unknown> | undefined, opts: { partial?: boolean } = {}): Record<string, unknown> {
  const defs = (Array.isArray(schemaDefs) ? schemaDefs : []).filter((d): d is AttributeDef => !!d && typeof d === 'object' && typeof (d as AttributeDef).key === 'string');
  const src = input ?? {};
  const out: Record<string, unknown> = {};
  const errors: { key: string; message: string }[] = [];

  for (const def of defs) {
    const raw = src[def.key];
    const empty = raw === undefined || raw === null || raw === '';
    if (empty) {
      if (def.required && !opts.partial) errors.push({ key: def.key, message: `${def.label ?? def.key} is required` });
      if (raw === null) out[def.key] = null;
      continue;
    }
    switch (def.type) {
      case 'number': {
        const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
        if (!Number.isFinite(n)) errors.push({ key: def.key, message: `${def.label ?? def.key} must be a number` });
        else out[def.key] = n;
        break;
      }
      case 'date': {
        const s = String(raw).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(new Date(s + 'T00:00:00Z').getTime())) errors.push({ key: def.key, message: `${def.label ?? def.key} must be a date (YYYY-MM-DD)` });
        else out[def.key] = s;
        break;
      }
      case 'boolean': {
        if (typeof raw === 'boolean') out[def.key] = raw;
        else if (['true', 'false', '1', '0', 'yes', 'no'].includes(String(raw).toLowerCase())) out[def.key] = ['true', '1', 'yes'].includes(String(raw).toLowerCase());
        else errors.push({ key: def.key, message: `${def.label ?? def.key} must be true or false` });
        break;
      }
      case 'select': {
        const allowed = optionValues(def);
        const s = String(raw);
        if (allowed.length && !allowed.includes(s)) errors.push({ key: def.key, message: `${def.label ?? def.key} must be one of: ${allowed.join(', ')}` });
        else out[def.key] = s;
        break;
      }
      case 'multiselect': {
        const allowed = optionValues(def);
        const arr = Array.isArray(raw) ? raw.map(String) : String(raw).split(',').map((x) => x.trim()).filter(Boolean);
        const bad = arr.filter((x) => allowed.length && !allowed.includes(x));
        if (bad.length) errors.push({ key: def.key, message: `${def.label ?? def.key}: invalid value(s) ${bad.join(', ')}` });
        else out[def.key] = arr;
        break;
      }
      default: {
        const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
        if (s.length > 4000) errors.push({ key: def.key, message: `${def.label ?? def.key} is too long` });
        else out[def.key] = s;
      }
    }
  }
  for (const k of RESERVED_ATTRIBUTE_KEYS) if (src[k] !== undefined && typeof src[k] === 'object') out[k] = src[k];
  if (errors.length) throw new ValidationError('Invalid attributes: ' + errors.map((e) => e.message).join('; '), errors);
  return out;
}
