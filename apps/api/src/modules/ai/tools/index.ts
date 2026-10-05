import { z } from 'zod';
import type { ToolDefinition } from '@/lib/ai';
import { isCustomerUser } from '../helpers';
import { type AiTool, type Who, type ToolsetKey, TOOLSET_KEYS } from './types';
import { CORE } from './core';
import { UI } from './ui';
import { TICKETS } from './tickets';
import { TRIAGE } from './triage';
import { INCIDENT } from './incident';
import { APPROVALS } from './approvals';
import { CUSTOMERS } from './customers';
import { CONTRACTS } from './contracts';
import { CMDB } from './cmdb';
import { ASSETS } from './assets';
import { FIELD } from './field';
import { KNOWLEDGE } from './knowledge';
import { REPORTS } from './reports';
import { CONFIG } from './config';
import { ADMIN } from './admin';
import { IAM } from './iam';
import { CHANGES } from './changes';
import { KNOWN_ERRORS } from './known-errors';
import { SURVEYS } from './surveys';
import { BOARDS } from './boards';

/**
 * The tool registry. Each tool wraps a service function and runs with the
 * caller's `Ctx`, so authorization and tenant isolation apply exactly as they
 * do for the UI. Availability is filtered by the principal's permissions;
 * action tools additionally require `ai:act`. The order here is fixed so the
 * same set of tools always serialises to the same bytes (prompt caching).
 */
export * from './types';
export * from '../helpers';
export { compactForTrace as stripSecrets } from '../redact';

export const ALL_TOOLS: AiTool[] = [...CORE, ...UI, ...TICKETS, ...TRIAGE, ...INCIDENT, ...APPROVALS, ...CUSTOMERS, ...CONTRACTS, ...CMDB, ...ASSETS, ...FIELD, ...KNOWLEDGE, ...REPORTS, ...CONFIG, ...ADMIN, ...IAM, ...CHANGES, ...KNOWN_ERRORS, ...SURVEYS, ...BOARDS];
export const READ_TOOLS: AiTool[] = ALL_TOOLS.filter((t) => !t.action);
export const ACTION_TOOLS: AiTool[] = ALL_TOOLS.filter((t) => t.action);

{
  const seen = new Set<string>();
  for (const t of ALL_TOOLS) {
    if (seen.has(t.name)) throw new Error(`AI tool registered twice: ${t.name}`);
    if (!/^[a-z][a-z0-9_]{2,40}$/.test(t.name)) throw new Error(`AI tool name is not snake_case: ${t.name}`);
    if (!(TOOLSET_KEYS as readonly string[]).includes(t.toolset)) throw new Error(`AI tool ${t.name} has an unknown toolset ${t.toolset}`);
    seen.add(t.name);
  }
}

export const toolByName = (name: string) => ALL_TOOLS.find((t) => t.name === name) ?? null;

/** A tool is offered when the principal holds every required permission (portal variants for customer users) and `ai:act` for actions. */
export function toolAvailable(who: Who, tool: AiTool): boolean {
  if (!who.can('ai:use')) return false;
  if (tool.action && !who.can('ai:act')) return false;
  if (isCustomerUser(who)) {
    if (!tool.portal) return false;
    return tool.portal.every((p) => who.can(p));
  }
  if (tool.portalOnly) return false;
  if (!tool.requires.every((p) => who.can(p))) return false;
  if (tool.anyOf?.length && !tool.anyOf.some((p) => who.can(p))) return false;
  return true;
}

/** The tools offered to the model: available, not hidden, and (when toolsets are given) in one of the enabled sets. */
export const availableTools = (who: Who, toolsets?: Iterable<ToolsetKey> | null): AiTool[] => {
  const sets = toolsets ? new Set(toolsets) : null;
  return ALL_TOOLS.filter((t) => !t.hidden && (!sets || sets.has(t.toolset)) && toolAvailable(who, t));
};

/** Toolsets with at least one tool available to the principal (what `enable_toolset` may add). */
export const availableToolsets = (who: Who): ToolsetKey[] => TOOLSET_KEYS.filter((k) => ALL_TOOLS.some((t) => t.toolset === k && !t.hidden && toolAvailable(who, t)));

/** zod → JSON schema for the provider (draft 2020-12 with the `$schema` marker removed). */
export function toolJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  delete js.$schema;
  if (!js.type) js.type = 'object';
  if (!js.properties) js.properties = {};
  return js;
}

export const toolDefinitions = (tools: AiTool[]): ToolDefinition[] => tools.map((t) => ({ name: t.name, description: t.description, inputSchema: toolJsonSchema(t.inputSchema) }));
