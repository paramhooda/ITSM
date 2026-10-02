/**
 * Adapter contract: every external system (PRTG, FortiSIEM, generic webhooks)
 * is translated into the same `NormalizedEvent` shape. The shared pipeline
 * (store → correlate → dedupe → ticket) never looks at raw payloads.
 */
export const EVENT_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type EventSeverity = (typeof EVENT_SEVERITIES)[number];
export const SEVERITY_RANK: Record<EventSeverity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

export const EVENT_STATUSES = ['open', 'resolved', 'acknowledged', 'info'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export interface NormalizedEvent {
  /** Stable identifier of the alarm in the source system (sensor id, incident id). Drives deduplication. */
  externalId: string;
  /** `prtg.down`, `fortisiem.security_authentication`, `disk.full`... */
  eventType: string;
  severity: EventSeverity;
  /** open = problem active, resolved = cleared/up, acknowledged = someone acknowledged it in the source, info = informational. */
  status: EventStatus;
  host?: string;
  ipAddress?: string;
  /** Sensor / rule / check name. */
  sensor?: string;
  message: string;
  occurredAt?: Date;
  /** Device reference in the monitoring system (PRTG device id) → `cis.monitoringRef`. */
  monitoringRef?: string;
  /** Device reference in the SIEM (FortiSIEM device/host name) → `cis.siemRef`. */
  siemRef?: string;
  tags?: string[];
  /** Grouping information from the source (PRTG group / FortiSIEM organization) used by customer mapping rules. */
  group?: string;
  /** PRTG probe name used by customer mapping rules. */
  probe?: string;
  raw: Record<string, unknown>;
}

/** The subset of an integration row adapters may consult (e.g. per-integration config). */
export interface IntegrationLike {
  id: string;
  integrationType: string;
  name: string;
  customerId: string | null;
  config: Record<string, unknown>;
  rules: Record<string, unknown>;
}

export interface IntegrationAdapter {
  type: string;
  label: string;
  description: string;
  /** Translates one inbound payload into one or more normalized events. Throws `AdapterParseError` on unusable input. */
  parse(payload: unknown, integration: IntegrationLike): NormalizedEvent | NormalizedEvent[];
  samplePayload: Record<string, unknown>;
  /** Markdown explaining how to configure the external system. `{{webhookUrl}}` and `{{apiKey}}` are substituted by the UI. */
  docs: string;
  /** Suggested rule defaults for a new integration of this type. */
  defaultRules: Record<string, unknown>;
  /** Which CI reference this source populates when a CI is matched by other means. */
  refField: 'monitoringRef' | 'siemRef' | null;
}

export class AdapterParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterParseError';
  }
}

// ---------------------------------------------------------------- shared helpers

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Lower-cases keys, strips PRTG `%` placeholders markers, underscores and dashes so `%sensorid`, `sensor_id` and `sensorId` all map to `sensorid`. */
export function normalizeKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = k.replace(/^%+/, '').replace(/[_\-\s]/g, '').toLowerCase();
    if (!(key in out)) out[key] = v;
  }
  return out;
}

export const str = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
};

export function firstStr(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = str(obj[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+:[0-9a-f:]*$/i;
export const isIp = (v?: string | null): v is string => !!v && (IPV4.test(v) || (v.includes(':') && IPV6.test(v)));

/** Accepts ISO strings, epoch seconds/milliseconds and the PRTG `dd.mm.yyyy hh:mm:ss` / `mm/dd/yyyy` formats. */
export function toDate(v: unknown): Date | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v;
  if (typeof v === 'number') {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (/^\d{9,13}$/.test(s)) return toDate(Number(s));
  const eu = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (eu) {
    const d = new Date(Date.UTC(Number(eu[3]), Number(eu[2]) - 1, Number(eu[1]), Number(eu[4] ?? 0), Number(eu[5] ?? 0), Number(eu[6] ?? 0)));
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'event';
