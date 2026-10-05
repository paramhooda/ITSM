import { z } from 'zod';
import { REPORT_CATEGORIES } from '../registry';
import { DATE_RANGE_PRESETS } from '../dates';
import { ENTITY_KEYS } from './catalog';

/** Query-string boolean: "true"/"false" strings become booleans (z.coerce.boolean would turn "false" into true). */
export const boolQuery = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

export const filterSchema = z.object({ field: z.string().max(60), op: z.string().max(20), value: z.unknown().optional() });
export const aggregateSchema = z.object({ fn: z.enum(['count', 'sum', 'avg', 'min', 'max']), field: z.string().max(60).optional(), label: z.string().trim().max(60).optional() });
export const sortSchema = z.object({ key: z.string().max(80), order: z.enum(['asc', 'desc']) });
export const chartSchema = z.object({ type: z.enum(['bar', 'line']), y: z.array(z.string().max(80)).min(1).max(4) });

/** The stored specification; every key is checked against the catalogue by validateSpec. */
export const specSchema = z.object({
  columns: z.array(z.string().max(60)).max(40).default([]),
  filters: z.array(filterSchema).max(30).default([]),
  match: z.enum(['all', 'any']).default('all'),
  groupBy: z.array(z.string().max(60)).max(2).default([]),
  aggregates: z.array(aggregateSchema).max(6).default([]),
  sort: sortSchema.nullable().default(null),
  dateField: z.string().max(60).nullable().default(null),
  rowLimit: z.number().int().min(1).max(50_000).nullable().default(null),
  chart: chartSchema.nullable().default(null),
});

export const definitionInput = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).nullable().optional(),
  category: z.enum(REPORT_CATEGORIES).default('custom'),
  entity: z.enum(ENTITY_KEYS),
  spec: specSchema,
  defaultDateRange: z.enum(DATE_RANGE_PRESETS).default('last_30_days'),
  scopeCustomerId: z.string().uuid().nullable().default(null),
  visibility: z.enum(['private', 'shared']).default('private'),
  sharedRoleKeys: z.array(z.string().max(60)).max(30).default([]),
  sharedTeamIds: z.array(z.string().uuid()).max(30).default([]),
  portalVisible: z.boolean().default(false),
  cover: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
export type DefinitionInput = z.infer<typeof definitionInput>;

/** Written out without defaults, like schedulePatch, so a partial update never resets untouched fields. */
export const definitionPatch = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  category: z.enum(REPORT_CATEGORIES).optional(),
  entity: z.enum(ENTITY_KEYS).optional(),
  spec: specSchema.optional(),
  defaultDateRange: z.enum(DATE_RANGE_PRESETS).optional(),
  scopeCustomerId: z.string().uuid().nullable().optional(),
  visibility: z.enum(['private', 'shared']).optional(),
  sharedRoleKeys: z.array(z.string().max(60)).max(30).optional(),
  sharedTeamIds: z.array(z.string().uuid()).max(30).optional(),
  portalVisible: z.boolean().optional(),
  cover: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export type DefinitionPatch = z.infer<typeof definitionPatch>;

export const previewBody = z.object({ entity: z.enum(ENTITY_KEYS), spec: specSchema, parameters: z.record(z.string(), z.unknown()).default({}), portal: z.boolean().default(false) });
export type PreviewBody = z.infer<typeof previewBody>;

export const listQuery = z.object({ entity: z.enum(ENTITY_KEYS).optional(), mine: boolQuery.optional(), includeInactive: boolQuery.optional(), q: z.string().max(100).optional() });
export type ListQuery = z.infer<typeof listQuery>;

export const suggestBody = z.object({ prompt: z.string().trim().min(3).max(600), entity: z.enum(ENTITY_KEYS).optional() });
export type SuggestBody = z.infer<typeof suggestBody>;
