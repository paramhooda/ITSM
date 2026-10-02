import { get, post } from '@/api/client';

// ---------------------------------------------------------------- CMDB

export interface CiTypeCount { key: string; name: string; color: string | null; icon: string | null; parentKey?: string | null; count: number }
export interface CmdbOverview {
  totals: { total: number; active: number; retired: number; stale: number; discovered: number; withAsset: number; critical: number; unowned: number; noSite: number; withoutRelationships: number; openIncidents: number };
  byType: CiTypeCount[];
  byStatus: { status: string; count: number }[];
  byEnvironment: { environment: string; count: number }[];
  byCriticality: { criticality: string; count: number }[];
  health: { completenessPct: number | null; freshnessPct: number | null; relationshipCoveragePct: number | null };
  discovery: { sources: number; activeSources: number; pendingFindings: number; newFindings: number; lastRun: { id: string; sourceId: string; sourceName: string; status: string; startedAt: string | null; finishedAt: string | null } | null };
  recentChanges: { id: string; entityId: string | null; ciName: string | null; action: string; at: string; actorName: string | null }[];
  topImpacted: { id: string; name: string; typeName: string; openTickets: number }[];
}
export interface BusinessService { id: string; name: string; customerId: string; customerName: string | null; status: string; criticality: string; tier: string | null; owner: string | null; dependencies: number; openIncidents: number; health: 'good' | 'warning' | 'critical' }
export interface MapNode { id: string; name: string; typeKey: string; typeName: string; color: string | null; icon: string | null; status: string; criticality: string; layer: number; openTickets: number }
export interface MapEdge { id: string; source: string; target: string; typeKey: string; typeName: string }
export interface ServiceMapData { root: MapNode; nodes: MapNode[]; edges: MapEdge[]; truncated: boolean }
export interface CiTypeDef { id: string; key: string; name: string; description?: string | null; parentKey?: string | null; icon?: string | null; color?: string | null; attributeSchema?: { key: string; label: string; type: string; required?: boolean }[]; isSystem?: boolean; isActive?: boolean; sortOrder?: number }
export interface RelationshipTypeDef { id: string; key: string; name: string; inverseName: string; description?: string | null; impactDirection?: 'downstream' | 'upstream' | 'none'; isSystem?: boolean; isActive?: boolean }

export const cmdbKeys = {
  overview: (customerId?: string) => ['cmdb', 'overview', customerId ?? ''] as const,
  services: (customerId?: string) => ['cmdb', 'services', customerId ?? ''] as const,
  map: (id: string, depth: number) => ['cmdb', 'map', id, depth] as const,
  types: ['cmdb', 'types'] as const,
};

export const cmdbApi = {
  overview: (customerId?: string) => get<CmdbOverview>('/cmdb/overview', { customerId: customerId || undefined }),
  services: (customerId?: string) => get<{ items: BusinessService[] }>('/cmdb/services', { customerId: customerId || undefined }),
  map: (id: string, depth = 6) => get<ServiceMapData>(`/cmdb/services/${id}/map`, { depth }),
  types: () => get<{ types: CiTypeDef[]; relationshipTypes: RelationshipTypeDef[] }>('/cmdb/types'),
  bulk: (body: { ids: string[]; action: string; payload?: Record<string, unknown> }) => post<{ succeeded: number; failed: number; errors: { id: string; message: string }[] }>('/cmdb/cis/bulk', body),
};

// ---------------------------------------------------------------- Discovery

export interface SourceConfig { subnets: string[]; snmp: { version: '2c' | '3'; communities: string[]; v3?: { username?: string; authProtocol?: string; authKey?: string; privProtocol?: string; privKey?: string } }; ports: number[]; timeoutMs: number; concurrency: number; dnsResolve: boolean; maxHosts: number; snmpAlways: boolean }
export interface DiscoverySource { id: string; customerId: string; customerName?: string | null; siteId?: string | null; siteName?: string | null; name: string; sourceType: string; config: SourceConfig; scheduleCron?: string | null; autoApply: boolean; isActive: boolean; lastRunAt?: string | null; lastRunStatus?: string | null; lastRunId?: string | null; pendingFindings: number; createdAt?: string; updatedAt?: string }
export interface DiscoveryRun { id: string; sourceId: string; sourceName?: string | null; customerId?: string; customerName?: string | null; status: string; startedAt?: string | null; finishedAt?: string | null; durationSec?: number | null; stats: Record<string, number>; error?: string | null; triggeredBy?: string | null; triggeredByName?: string | null; createdAt: string; log?: string | null; findings?: { new: number; changed: number; unchanged: number } }
export interface Finding { id: string; runId: string; sourceId: string; customerId: string; ipAddress: string; hostname?: string | null; fqdn?: string | null; macAddress?: string | null; manufacturer?: string | null; model?: string | null; serialNumber?: string | null; sysDescr?: string | null; suggestedTypeKey?: string | null; openPorts: number[]; interfaces: Record<string, unknown>[]; neighbors: Record<string, unknown>[]; matchedCiId?: string | null; matchedCiName?: string | null; diffStatus: string; status: string; createdAt: string; appliedAt?: string | null; raw: Record<string, unknown> }
export interface FindingDetail extends Finding {
  source: { id: string; name: string } | null;
  run: { id: string; status: string; startedAt: string | null } | null;
  matchedCi: { id: string; name: string; typeKey: string; typeName: string; hostname: string | null; ipAddress: string | null; macAddress: string | null; serialNumber: string | null; manufacturer: string | null; model: string | null; osName: string | null; status: string; lastSeenAt: string | null } | null;
  changes: { field: string; current: unknown; discovered: unknown; changed: boolean }[];
  suggestedType: { key: string; name: string; color: string | null; icon: string | null } | null;
}
export interface DiscoveryOverview {
  sources: { total: number; active: number; scheduled: number };
  runs: { running: number; queued: number; completed7d: number; failed7d: number };
  findings: { pending: number; pendingNew: number; pendingChanged: number; pendingUnchanged: number; applied7d: number; ignored7d: number };
  lastRuns: DiscoveryRun[];
  byCustomer: { customerId: string; customerName: string; sources: number; pendingFindings: number; lastRunAt: string | null }[];
}
export interface FindingStats { byStatus: Record<string, number>; byDiff: Record<string, number>; bySuggestedType: { key: string; name: string; count: number }[]; total: number }

export const discoveryKeys = {
  all: ['discovery'] as const,
  overview: (customerId?: string) => ['discovery', 'overview', customerId ?? ''] as const,
  providers: ['discovery', 'providers'] as const,
  sources: (customerId?: string) => ['discovery', 'sources', customerId ?? ''] as const,
  source: (id: string) => ['discovery', 'source', id] as const,
  runs: (params: Record<string, unknown>) => ['discovery', 'runs', params] as const,
  run: (id: string) => ['discovery', 'run', id] as const,
  findings: (params: Record<string, unknown>) => ['discovery', 'findings', params] as const,
  finding: (id: string) => ['discovery', 'finding', id] as const,
  findingStats: (params: Record<string, unknown>) => ['discovery', 'findings', 'stats', params] as const,
};

export const discoveryApi = {
  overview: (customerId?: string) => get<DiscoveryOverview>('/discovery/overview', { customerId: customerId || undefined }),
  providers: () => get<{ items: { type: string; label: string }[] }>('/discovery/providers'),
  sources: (customerId?: string) => get<{ items: DiscoverySource[] }>('/discovery/sources', { customerId: customerId || undefined, includeInactive: true }),
  source: (id: string) => get<DiscoverySource>(`/discovery/sources/${id}`),
  runs: (params: Record<string, unknown>) => get<{ items: DiscoveryRun[]; total: number }>('/discovery/runs', params),
  sourceRuns: (sourceId: string, params: Record<string, unknown>) => get<{ items: DiscoveryRun[]; total: number }>(`/discovery/sources/${sourceId}/runs`, params),
  run: (id: string) => get<DiscoveryRun>(`/discovery/runs/${id}`),
  cancelRun: (id: string) => post<DiscoveryRun>(`/discovery/runs/${id}/cancel`),
  runNow: (sourceId: string) => post<DiscoveryRun>(`/discovery/sources/${sourceId}/run`),
  test: (sourceId: string) => post<{ ok: boolean; message: string; results: { host: string; reachable: boolean; openPorts: number[]; snmp: boolean; hostname?: string | null; sysDescr?: string | null; latencyMs: number }[] }>(`/discovery/sources/${sourceId}/test`),
  findings: (params: Record<string, unknown>) => get<{ items: Finding[]; total: number }>('/discovery/findings', params),
  finding: (id: string) => get<FindingDetail>(`/discovery/findings/${id}`),
  findingStats: (params: Record<string, unknown>) => get<FindingStats>('/discovery/findings/stats', params),
  act: (id: string, action: 'apply' | 'ignore') => post<{ ciName?: string; created?: boolean; ciId?: string }>(`/discovery/findings/${id}/${action}`),
  bulk: (ids: string[], action: 'apply' | 'ignore') => post<{ applied: number; failed: number; results: { message?: string }[] }>('/discovery/findings/bulk', { ids, action }),
};

export const RUN_COLORS: Record<string, string> = { queued: 'blue', running: 'amber', completed: 'green', failed: 'red', cancelled: 'slate' };
export const DIFF_COLORS: Record<string, string> = { new: 'green', changed: 'amber', unchanged: 'slate' };
export const FINDING_STATUS_COLORS: Record<string, string> = { pending: 'blue', applied: 'green', ignored: 'slate' };
export const runDuration = (r: { startedAt?: string | null; finishedAt?: string | null }) => (r.startedAt && r.finishedAt ? Math.max(0, Math.round((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 60000)) : null);
