import { z } from 'zod';
import { AdapterParseError, EVENT_SEVERITIES, EVENT_STATUSES, clip, isRecord, toDate, type IntegrationAdapter, type NormalizedEvent } from './types';

/**
 * Generic webhook: the caller sends events that already use the normalized
 * field names. Only `externalId` is mandatory.
 */
const genericSchema = z.object({
  externalId: z.union([z.string().min(1).max(300), z.number()]).transform((v) => String(v)),
  eventType: z.string().max(100).optional(),
  severity: z.enum(EVENT_SEVERITIES).optional(),
  status: z.enum(EVENT_STATUSES).optional(),
  host: z.string().max(253).optional(),
  ipAddress: z.string().max(64).optional(),
  sensor: z.string().max(300).optional(),
  message: z.string().max(5000).optional(),
  occurredAt: z.union([z.string(), z.number()]).optional(),
  monitoringRef: z.union([z.string().max(200), z.number()]).transform((v) => (v === undefined ? undefined : String(v))).optional(),
  siemRef: z.union([z.string().max(200), z.number()]).transform((v) => (v === undefined ? undefined : String(v))).optional(),
  tags: z.array(z.string().max(50)).max(30).optional(),
  group: z.string().max(200).optional(),
  probe: z.string().max(200).optional(),
});

export function parseGenericEvent(payload: unknown): NormalizedEvent {
  if (!isRecord(payload)) throw new AdapterParseError('Event must be a JSON object');
  const parsed = genericSchema.safeParse(payload);
  if (!parsed.success) throw new AdapterParseError(parsed.error.issues.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`).join('; '));
  const e = parsed.data;
  const eventType = e.eventType ?? 'generic.event';
  return {
    externalId: e.externalId,
    eventType,
    severity: e.severity ?? 'medium',
    status: e.status ?? 'open',
    host: e.host,
    ipAddress: e.ipAddress,
    sensor: e.sensor,
    message: clip(e.message ?? e.sensor ?? eventType, 2000)!,
    occurredAt: toDate(e.occurredAt),
    monitoringRef: e.monitoringRef,
    siemRef: e.siemRef,
    tags: e.tags,
    group: e.group,
    probe: e.probe,
    raw: payload,
  };
}

export const genericAdapter: IntegrationAdapter = {
  type: 'generic',
  label: 'Generic webhook',
  description: 'Any system that can POST JSON. Send already-normalized events (externalId, severity, status, host, message...).',
  refField: null,
  parse: (payload) => parseGenericEvent(payload),
  samplePayload: {
    externalId: 'alert-123',
    eventType: 'disk.full',
    severity: 'high',
    status: 'open',
    host: 'srv-01',
    ipAddress: '10.0.0.5',
    sensor: 'Disk C:',
    message: 'Disk C: 97% used',
    occurredAt: '2026-10-02T14:03:12Z',
    tags: ['storage'],
  },
  defaultRules: { domain: 'noc', defaultCategoryKey: 'availability', titleTemplate: '{{host}}: {{message}}' },
  docs: `### Generic webhook

POST a JSON object (or an array of objects) to \`{{webhookUrl}}\` with the header \`X-API-Key: {{apiKey}}\` (or \`?key={{apiKey}}\`).

| Field | Required | Values |
| --- | --- | --- |
| \`externalId\` | yes | stable alarm id – repeated events with the same id are de-duplicated |
| \`status\` | no | \`open\` (default), \`resolved\`, \`acknowledged\`, \`info\` |
| \`severity\` | no | \`critical\`, \`high\`, \`medium\` (default), \`low\`, \`info\` |
| \`host\`, \`ipAddress\` | no | used to correlate the configuration item |
| \`monitoringRef\`, \`siemRef\` | no | exact CI references |
| \`sensor\`, \`message\`, \`eventType\`, \`occurredAt\`, \`tags\`, \`group\` | no | descriptive fields; \`group\` feeds customer mapping |

Send a second event with \`status: "resolved"\` and the same \`externalId\` to resolve the ticket automatically.`,
};
