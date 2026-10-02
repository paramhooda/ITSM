export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type EventStatus = 'open' | 'resolved' | 'acknowledged' | 'info';
export type ProcessingStatus = 'received' | 'correlated' | 'ticket_created' | 'deduplicated' | 'ignored' | 'error';

export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
export const PROCESSING_STATUSES: ProcessingStatus[] = ['received', 'correlated', 'ticket_created', 'deduplicated', 'ignored', 'error'];

export interface SeverityMap {
  critical?: string;
  high?: string;
  medium?: string;
  low?: string;
  info?: string;
}

export interface CustomerMapping {
  match: { group?: string; probe?: string; hostPattern?: string; ipCidr?: string };
  customerId: string;
}

export interface Rules {
  ticketType: 'incident';
  domain: 'noc' | 'soc';
  defaultCategoryKey?: string | null;
  defaultSubcategoryKey?: string | null;
  severityToPriority: SeverityMap;
  severityToSecuritySeverity?: SeverityMap;
  minSeverityForTicket: Severity;
  dedupeWindowMinutes: number;
  autoResolve: boolean;
  reopenOnRecurrence: boolean;
  assignTeamKey?: string | null;
  customerMapping: CustomerMapping[];
  titleTemplate: string;
  ignorePatterns: string[];
}

export interface IntegrationType {
  type: string;
  label: string;
  description: string;
  docs: string;
  samplePayload: Record<string, unknown>;
  defaultRules: Rules;
  refField: 'monitoringRef' | 'siemRef' | null;
  webhookUrlPattern: string;
  acceptsFormEncoded: boolean;
}

export interface Integration {
  id: string;
  integrationType: string;
  typeLabel: string;
  name: string;
  description?: string | null;
  customerId: string | null;
  customerName?: string | null;
  apiKeyId: string | null;
  apiKeyPrefix?: string | null;
  apiKeyRevokedAt?: string | null;
  apiKeyLastUsedAt?: string | null;
  config: Record<string, unknown>;
  rules: Rules;
  autoCreateTickets: boolean;
  isActive: boolean;
  lastEventAt?: string | null;
  webhookUrl: string;
  counts?: { last24h: number; last7d: number; errors7d: number; unresolved7d: number };
  openTickets?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyReveal {
  id: string;
  key: string;
  keyPrefix: string;
}

export interface EventListItem {
  id: string;
  receivedAt: string;
  integrationId: string;
  integrationName?: string | null;
  integrationType: string;
  customerId: string | null;
  customerName?: string | null;
  externalId?: string | null;
  eventType?: string | null;
  severity?: Severity | null;
  status?: EventStatus | null;
  host?: string | null;
  ipAddress?: string | null;
  sensor?: string | null;
  message?: string | null;
  matchedCiId?: string | null;
  ciName?: string | null;
  ticketId?: string | null;
  ticketNumber?: string | null;
  processingStatus: ProcessingStatus;
  processingNote?: string | null;
  processedAt?: string | null;
}

export interface EventDetail extends EventListItem {
  payload: Record<string, unknown>;
  normalized?: { externalId: string; eventType: string; severity: Severity; status: EventStatus; host?: string; ipAddress?: string; sensor?: string; message: string; occurredAt?: string; monitoringRef?: string; siemRef?: string; tags?: string[]; group?: string; probe?: string } | null;
  ticket?: { id: string; number: string; title: string; statusLabel?: string | null; statusCategory?: string | null; statusColor?: string | null; resolvedAt?: string | null } | null;
  integrationCustomerId?: string | null;
}

export interface DryRunResult {
  parsedCount: number;
  autoCreateTickets: boolean;
  isActive: boolean;
  event: Record<string, unknown> & { raw?: Record<string, unknown> };
  outcome: string;
  note: string;
  customer: { id: string; name: string | null; source: string | null } | null;
  ci: { id: string; name: string; matchedBy: string; learnRef: string | null } | null;
  existingTicket: { id: string; number: string; statusCategory: string } | null;
  ticket: { title: string; priorityKey: string; categoryKey: string | null; categoryLabel: string | null; domain: string; teamKey: string | null; securitySeverityKey: string | null; sourceKey: string } | null;
  rules: { minSeverityForTicket: string; dedupeWindowMinutes: number; autoResolve: boolean; reopenOnRecurrence: boolean; domain: string };
}

export interface Stats {
  days: number;
  total: number;
  ticketsCreated: number;
  deduplicated: number;
  dedupRate: number;
  errors: number;
  unresolvedCustomer: number;
  pending: number;
  openTickets: number;
  activeIntegrations: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
  byStatus: Record<string, number>;
  byDay: { day: string; total: number; bySeverity: Record<string, number>; ticketsCreated: number }[];
}

export const TYPE_LABELS: Record<string, string> = { prtg: 'PRTG', fortisiem: 'FortiSIEM', generic: 'Webhook' };
export const typeLabel = (t: string) => TYPE_LABELS[t] ?? t;

export function errorMessage(err: unknown, fallback = 'Something went wrong') {
  const e = err as { message?: string; details?: unknown };
  const details = e?.details as { message?: string }[] | { error?: string } | undefined;
  if (Array.isArray(details) && details[0]?.message) return `${e.message}: ${details.map((d) => d.message).join('; ')}`;
  if (details && !Array.isArray(details) && details.error) return `${e.message}: ${details.error}`;
  return e?.message ?? fallback;
}
