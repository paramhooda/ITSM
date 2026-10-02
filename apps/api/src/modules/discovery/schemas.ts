import { z } from 'zod';
import { paginationSchema } from '@/core/pagination';
import { DEFAULT_PORTS } from './providers/network-scan';

export const v3Schema = z.object({
  username: z.string().max(64).optional(),
  authProtocol: z.enum(['none', 'md5', 'sha', 'sha224', 'sha256', 'sha384', 'sha512']).optional(),
  authKey: z.string().max(128).optional(),
  privProtocol: z.enum(['none', 'des', 'aes', 'aes128', 'aes256', 'aes256b', 'aes256r']).optional(),
  privKey: z.string().max(128).optional(),
});

export const snmpSchema = z.object({
  version: z.enum(['2c', '3']).default('2c'),
  communities: z.array(z.string().min(1).max(128)).max(10).default([]),
  v3: v3Schema.optional(),
});

export const sourceConfigSchema = z.object({
  subnets: z.array(z.string().min(1).max(64)).min(1).max(256),
  snmp: snmpSchema.default({ version: '2c', communities: [] }),
  ports: z.array(z.number().int().min(1).max(65535)).max(64).default([...DEFAULT_PORTS]),
  timeoutMs: z.number().int().min(200).max(10_000).default(1500),
  concurrency: z.number().int().min(1).max(256).default(64),
  dnsResolve: z.boolean().default(false),
  maxHosts: z.number().int().min(1).max(65_536).default(2048),
  snmpAlways: z.boolean().default(true),
});
export type SourceConfig = z.infer<typeof sourceConfigSchema>;

export const sourceCreateBody = z.object({
  customerId: z.string().uuid(),
  siteId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(120),
  sourceType: z.string().max(64).default('network_scan'),
  config: sourceConfigSchema,
  scheduleCron: z.string().max(64).nullable().optional(),
  autoApply: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export type SourceCreateInput = z.infer<typeof sourceCreateBody>;

/** `.partial()` keeps `.default()` values in zod v4, which would silently reset ports/timeouts on PATCH; strip them. */
const stripDefaults = (shape: z.ZodRawShape) => z.object(Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, (v instanceof z.ZodDefault ? v.removeDefault() : v).optional()])));
export const sourceConfigPatchSchema = stripDefaults(sourceConfigSchema.shape).extend({ snmp: stripDefaults(snmpSchema.shape).optional() });
export const sourcePatchBody = sourceCreateBody.omit({ customerId: true, config: true, sourceType: true }).partial().extend({ sourceType: z.string().max(64).optional(), config: sourceConfigPatchSchema.optional() });
export type SourcePatchInput = z.infer<typeof sourcePatchBody>;

export const sourceListQuery = z.object({ customerId: z.string().uuid().optional(), includeInactive: z.preprocess((v) => v === 'true' || v === true, z.boolean()).optional() });
export const runsQuery = paginationSchema;
export const findingsQuery = paginationSchema.extend({
  sourceId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  status: z.enum(['pending', 'applied', 'ignored']).optional(),
  diffStatus: z.enum(['new', 'changed', 'unchanged']).optional(),
  q: z.string().max(120).optional(),
  sort: z.enum(['ipAddress', 'hostname', 'createdAt', 'diffStatus']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});
export type FindingsQuery = z.infer<typeof findingsQuery>;
export const bulkBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(500), action: z.enum(['apply', 'ignore']) });
