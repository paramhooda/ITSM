import { z } from 'zod';
import { paginationSchema } from '@/core/pagination';
import { EVENT_SEVERITIES, EVENT_STATUSES, INTEGRATION_TYPES, getAdapter } from './adapters';

const uuid = z.string().uuid();
const optionKey = z.string().trim().max(100).nullable().optional();

export const PROCESSING_STATUSES = ['received', 'correlated', 'ticket_created', 'deduplicated', 'ignored', 'error'] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

export const severityMapSchema = z.object({
  critical: z.string().max(50).optional(),
  high: z.string().max(50).optional(),
  medium: z.string().max(50).optional(),
  low: z.string().max(50).optional(),
  info: z.string().max(50).optional(),
});

export const customerMappingSchema = z.object({
  match: z.object({
    group: z.string().max(200).optional(),
    probe: z.string().max(200).optional(),
    hostPattern: z.string().max(300).optional(),
    ipCidr: z.string().max(60).optional(),
  }),
  customerId: uuid,
});
export type CustomerMapping = z.infer<typeof customerMappingSchema>;

/** Editable correlation / ticketing rules stored in `integrations.rules`. */
export const rulesSchema = z.object({
  ticketType: z.literal('incident').default('incident'),
  domain: z.enum(['noc', 'soc']).default('noc'),
  defaultCategoryKey: optionKey,
  defaultSubcategoryKey: optionKey,
  severityToPriority: severityMapSchema.default({}),
  severityToSecuritySeverity: severityMapSchema.optional(),
  minSeverityForTicket: z.enum(EVENT_SEVERITIES).default('medium'),
  dedupeWindowMinutes: z.number().int().min(0).max(43200).default(240),
  autoResolve: z.boolean().default(true),
  reopenOnRecurrence: z.boolean().default(false),
  assignTeamKey: z.string().trim().max(100).nullable().optional(),
  customerMapping: z.array(customerMappingSchema).max(500).default([]),
  titleTemplate: z.string().max(300).default('{{host}}: {{message}}'),
  ignorePatterns: z.array(z.string().max(500)).max(100).default([]),
});
export type Rules = z.infer<typeof rulesSchema>;

export const DEFAULT_SEVERITY_TO_PRIORITY = { critical: 'p1', high: 'p2', medium: 'p3', low: 'p4', info: 'p5' } as const;
export const DEFAULT_SEVERITY_TO_SECURITY = { critical: 'critical', high: 'high', medium: 'medium', low: 'low', info: 'informational' } as const;

/** Merges adapter defaults, platform defaults and the stored jsonb into a fully-typed rule set (never throws). */
export function normalizeRules(raw: unknown, integrationType: string): Rules {
  const adapter = getAdapter(integrationType);
  const stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const merged: Record<string, unknown> = { ...adapter.defaultRules, ...stored };
  // Validate field by field so one bad entry (e.g. a stale mapping) never discards the whole rule set.
  const clean: Record<string, unknown> = {};
  const shape = rulesSchema.shape as Record<string, z.ZodTypeAny>;
  for (const [key, value] of Object.entries(merged)) {
    const field = shape[key];
    if (!field) continue;
    if (key === 'customerMapping' && Array.isArray(value)) {
      clean[key] = value.filter((m) => customerMappingSchema.safeParse(m).success);
      continue;
    }
    if (key === 'ignorePatterns' && Array.isArray(value)) {
      clean[key] = value.filter((x) => typeof x === 'string' && x.length <= 500);
      continue;
    }
    const r = field.safeParse(value);
    if (r.success) clean[key] = r.data;
  }
  const parsed = rulesSchema.safeParse(clean);
  const rules = parsed.success ? parsed.data : rulesSchema.parse({});
  rules.severityToPriority = { ...DEFAULT_SEVERITY_TO_PRIORITY, ...rules.severityToPriority };
  if (rules.domain === 'soc') rules.severityToSecuritySeverity = { ...DEFAULT_SEVERITY_TO_SECURITY, ...(rules.severityToSecuritySeverity ?? {}) };
  return rules;
}

export const integrationTypeSchema = z.enum(INTEGRATION_TYPES);

export const integrationCreateBody = z.object({
  integrationType: integrationTypeSchema,
  name: z.string().trim().min(2).max(200),
  description: z.string().max(2000).nullable().optional(),
  customerId: uuid.nullable().optional(),
  autoCreateTickets: z.boolean().default(true),
  isActive: z.boolean().default(true),
  rules: rulesSchema.partial().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  createApiKey: z.boolean().default(true),
});
export type IntegrationCreateInput = z.infer<typeof integrationCreateBody>;

export const integrationPatchBody = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  customerId: uuid.nullable().optional(),
  autoCreateTickets: z.boolean().optional(),
  isActive: z.boolean().optional(),
  rules: rulesSchema.partial().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type IntegrationPatchInput = z.infer<typeof integrationPatchBody>;

export const testBody = z.object({ payload: z.unknown().optional() }).optional();

const csv = (allowed: readonly string[]) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((x) => x.trim()).filter((x) => allowed.includes(x)) : undefined));

export const eventsListQuery = paginationSchema.extend({
  integrationId: uuid.optional(),
  integrationType: z.string().max(50).optional(),
  customerId: uuid.optional(),
  severity: csv(EVENT_SEVERITIES),
  status: csv(EVENT_STATUSES),
  processingStatus: csv(PROCESSING_STATUSES),
  host: z.string().max(253).optional(),
  ticketId: uuid.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().max(200).optional(),
  unresolvedOnly: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});
export type EventsListQuery = z.infer<typeof eventsListQuery>;

export const statsQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(7), customerId: uuid.optional() });

export const assignCustomerBody = z.object({ customerId: uuid });
export const createTicketBody = z.object({ customerId: uuid.optional() }).optional();
export const ingestQuery = z.object({ key: z.string().max(200).optional() }).passthrough();
