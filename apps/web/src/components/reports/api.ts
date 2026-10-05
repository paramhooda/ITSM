import { get, post, patch, del } from '@/api/client';
import type { BuilderCatalog, CustomReport, DefinitionInput, PreviewResult, ReportSpec, SuggestResult } from './types';

export interface PreviewBody { entity: string; spec: ReportSpec; parameters?: Record<string, unknown>; portal?: boolean }
export interface CustomListQuery { entity?: string; mine?: boolean; includeInactive?: boolean; q?: string }

/** Query keys of the reports application; every family starts with 'reports' so one invalidation refreshes them all. */
export const reportKeys = {
  definitions: ['reports', 'definitions'] as const,
  runs: ['reports', 'runs'] as const,
  schedules: ['reports', 'schedules'] as const,
  catalog: ['reports', 'catalog'] as const,
  custom: (q?: CustomListQuery) => ['reports', 'custom', q ?? {}] as const,
  customOne: (id: string) => ['reports', 'custom', 'one', id] as const,
};

export const reportsApi = {
  catalog: () => get<BuilderCatalog>('/reports/builder/catalog'),
  preview: (b: PreviewBody) => post<PreviewResult>('/reports/builder/preview', b),
  suggest: (b: { prompt: string; entity?: string }) => post<SuggestResult>('/reports/builder/suggest', b),
  custom: (q?: CustomListQuery) => get<{ items: CustomReport[]; total: number }>('/reports/custom', q as Record<string, unknown> | undefined),
  customOne: (id: string) => get<CustomReport>(`/reports/custom/${id}`),
  create: (b: DefinitionInput) => post<CustomReport>('/reports/custom', b),
  update: (id: string, b: Partial<DefinitionInput> & { isActive?: boolean }) => patch<CustomReport>(`/reports/custom/${id}`, b),
  remove: (id: string) => del<{ ok: true }>(`/reports/custom/${id}`),
  duplicate: (id: string) => post<CustomReport>(`/reports/custom/${id}/duplicate`),
};
