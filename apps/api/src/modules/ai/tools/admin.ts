import { z } from 'zod';
import { getTableColumns } from 'drizzle-orm';
import { TICKET_TYPES } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { ValidationError, NotFoundError } from '@/core/errors';
import { listOptions, createOption, updateOption, listConfig, createConfig, updateConfig, updateSettings, getSetting, CONFIG_TABLES } from '@/modules/config/service';
import { listPolicies, updatePolicy } from '@/modules/sla/policies';
import { AI_FEATURES } from '../guards';
import { define, type PreviewDetail } from './types';
import { RULE_KINDS, SECRET_SETTING_KEY, settingVisible, type RuleKind } from './config';

/**
 * Administration tools (tier admin: always confirmed). Configuration only:
 * option lists, config tables (rules, workflows, templates, calendars, CI
 * types), SLA policy attributes and allowlisted settings. People, roles,
 * permissions, API keys and every secret stay out of reach by design.
 */

/** Settings the assistant may change, by prefix; anything else is read-only or hidden. */
export const WRITABLE_SETTING_PREFIXES = ['ai.', 'tickets.', 'contracts.', 'entitlements.', 'portal.', 'notifications.', 'platform.', 'changes.', 'known_errors.', 'surveys.', 'boards.', 'software.', 'reports.'];
const settingValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.null(), z.array(z.string().max(100)).max(50)]);

/** Validation for the settings whose shape the platform depends on. */
function validateSetting(key: string, value: unknown) {
  const expect = (ok: boolean, msg: string) => {
    if (!ok) throw new ValidationError(`${key}: ${msg}`);
  };
  switch (key) {
    case 'ai.autonomy': return expect(value === 'confirm_all' || value === 'auto_low', 'must be confirm_all or auto_low');
    case 'ai.effort': return expect(value === 'low' || value === 'medium' || value === 'high', 'must be low, medium or high');
    case 'ai.assistant.enabled': return expect(typeof value === 'boolean', 'must be true or false');
    case 'ai.daily_token_budget': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100_000_000, 'must be a whole number of tokens (0 = unlimited)');
    case 'ai.turn_timeout_seconds': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 10 && value <= 600, 'must be between 10 and 600 seconds');
    case 'ai.conversation_retention_days': return expect(typeof value === 'number' && Number.isInteger(value) && (value === 0 || (value >= 7 && value <= 3650)), 'must be 0 (keep forever) or 7 to 3650 days');
    case 'ai.disabled_features': return expect(Array.isArray(value) && value.every((v) => (AI_FEATURES as readonly string[]).includes(String(v))), `must be a list of: ${AI_FEATURES.join(', ')}`);
    case 'changes.reminder_hours': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 168, 'must be between 1 and 168 hours');
    case 'changes.conflict_warnings': return expect(typeof value === 'boolean', 'must be true or false');
    case 'changes.block_blackout_scheduling': return expect(typeof value === 'boolean', 'must be true or false');
    case 'changes.require_assessment_for_approval': return expect(typeof value === 'boolean', 'must be true or false');
    case 'changes.portal_horizon_days': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 7 && value <= 365, 'must be between 7 and 365 days');
    case 'known_errors.notify_customers': return expect(typeof value === 'boolean', 'must be true or false');
    case 'known_errors.resolve_on_fix': return expect(typeof value === 'boolean', 'must be true or false');
    case 'known_errors.suggest_limit': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10, 'must be between 1 and 10');
    case 'surveys.enabled': return expect(typeof value === 'boolean', 'must be true or false');
    case 'surveys.resend_on_close': return expect(typeof value === 'boolean', 'must be true or false');
    case 'surveys.send_on': return expect(value === 'resolved' || value === 'closed', 'must be resolved or closed');
    case 'surveys.sampling_pct': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100, 'must be between 0 and 100');
    case 'surveys.question': return expect(typeof value === 'string' && value.trim().length >= 5 && value.length <= 300, 'must be 5 to 300 characters');
    case 'surveys.comment_prompt': return expect(typeof value === 'string' && value.length <= 300, 'must be at most 300 characters');
    case 'surveys.reminder_days': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 60, 'must be between 0 and 60 days');
    case 'surveys.expiry_days': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 90, 'must be between 1 and 90 days');
    case 'surveys.fatigue_days': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 365, 'must be between 0 and 365 days');
    case 'surveys.low_rating_threshold': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 4, 'must be between 1 and 4');
    case 'surveys.satisfied_threshold': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= 5, 'must be between 2 and 5');
    case 'surveys.ticket_types': return expect(Array.isArray(value) && value.length > 0 && value.every((v) => (TICKET_TYPES as readonly string[]).includes(String(v))), `must be a list of: ${TICKET_TYPES.join(', ')}`);
    case 'boards.wip_default_limit': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100, 'must be between 0 and 100 (0 = no indicator)');
    case 'boards.card_limit': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 50 && value <= 500, 'must be between 50 and 500');
    case 'boards.note_retention_days': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 365, 'must be between 1 and 365 days');
    // settingValue only accepts arrays of strings, so the notice days arrive as numeric strings; the loader coerces them.
    case 'software.licence_notice_days': return expect(Array.isArray(value) && value.length >= 1 && value.length <= 10 && value.every((v) => /^\d+$/.test(String(v)) && Number(v) >= 1 && Number(v) <= 3650), 'must be a list of 1 to 10 whole numbers of days between 1 and 3650');
    case 'software.stale_install_days': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 365, 'must be between 1 and 365 days');
    case 'software.unused_seat_pct': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100, 'must be between 0 and 100');
    case 'software.import_creates_products': return expect(typeof value === 'boolean', 'must be true or false');
    case 'reports.builder.max_rows': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 50_000, 'must be between 1 and 50000 rows');
    case 'reports.builder.preview_rows': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 50 && value <= 5000, 'must be between 50 and 5000 rows');
    case 'reports.builder.statement_timeout_ms': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 1000 && value <= 120_000, 'must be between 1000 and 120000 milliseconds');
    case 'reports.confidentiality_line': return expect(typeof value === 'string' && value.length <= 300, 'must be text of at most 300 characters');
    case 'reports.narrative': return expect(typeof value === 'boolean', 'must be true or false');
    case 'reports.print_rows': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 10 && value <= 500, 'must be between 10 and 500 rows');
    case 'platform.brand_color':
    case 'platform.brand_accent': return expect(typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim()), 'must be a six-digit hex colour such as #292345');
    case 'ai.triage.auto_apply_confidence': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 50 && value <= 100, 'must be between 50 and 100');
    case 'ai.triage.storm_window_minutes': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 5 && value <= 1440, 'must be between 5 and 1440 minutes');
    case 'ai.triage.storm_threshold': return expect(typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= 50, 'must be between 2 and 50');
    case 'ai.triage.storm_auto_link': return expect(typeof value === 'boolean', 'must be true or false');
    default: return undefined;
  }
}

function assertWritableSetting(key: string) {
  if (!WRITABLE_SETTING_PREFIXES.some((p) => key.startsWith(p))) throw new ValidationError(`${key} cannot be changed through the assistant (allowed prefixes: ${WRITABLE_SETTING_PREFIXES.join(' ')}); use the Settings page`);
  if (!settingVisible(key) || SECRET_SETTING_KEY.test(key)) throw new ValidationError(`${key} is a protected setting and is never read or changed through the assistant`);
}

const fmt = (v: unknown) => (v === undefined ? 'unset' : typeof v === 'string' ? `"${v.slice(0, 80)}"` : JSON.stringify(v).slice(0, 120));

async function optionTarget(ctx: Ctx, input: { type: string; key?: string; id?: string }) {
  const all = await listOptions(ctx, input.type, true);
  const existing = input.id ? all.find((o) => o.id === input.id) : input.key ? all.find((o) => o.key === input.key) : undefined;
  if (input.id && !existing) throw new NotFoundError('Option');
  return { all, existing };
}

const CONFIG_KIND_KEYS = [...Object.keys(CONFIG_TABLES), 'sla-policies'] as unknown as [string, ...string[]];
const PROTECTED_COLUMNS = new Set(['id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'isSystem']);

async function configTarget(ctx: Ctx, kind: string, ref?: string) {
  if (kind === 'sla-policies') {
    const items = (await listPolicies(ctx)).items;
    if (!ref) return { existing: undefined, label: 'SLA policy' };
    const hit = items.find((p) => p.id === ref) ?? items.find((p) => p.name.toLowerCase() === ref.toLowerCase());
    if (!hit) throw new NotFoundError('SLA policy', `No SLA policy matching "${ref}"`);
    return { existing: hit as unknown as Record<string, unknown>, label: 'SLA policy' };
  }
  const def = CONFIG_TABLES[kind];
  if (!def) throw new ValidationError(`Unknown configuration area "${kind}"`);
  const rows = (await listConfig(ctx, kind)) as unknown as Record<string, unknown>[];
  if (!ref) return { existing: undefined, label: def.label.replace(/_/g, ' ') };
  const r = ref.toLowerCase();
  const hit = rows.find((x) => x.id === ref) ?? rows.find((x) => String(x.name ?? '').toLowerCase() === r) ?? rows.find((x) => String(x.event ?? '').toLowerCase() === r);
  if (!hit) throw new NotFoundError(def.label.replace(/_/g, ' '), `No ${def.label.replace(/_/g, ' ')} matching "${ref}"`);
  return { existing: hit, label: def.label.replace(/_/g, ' ') };
}

/** Only real, non-protected columns of the table reach the database. */
function allowedFields(kind: string, fields: Record<string, unknown>) {
  const columns = kind === 'sla-policies' ? ['name', 'description', 'calendarId', 'holidayCalendarId', 'isDefault', 'isActive'] : Object.keys(getTableColumns(CONFIG_TABLES[kind]!.table as never));
  const out: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (PROTECTED_COLUMNS.has(k) || !columns.includes(k)) rejected.push(k);
    else out[k] = v;
  }
  if (rejected.length) throw new ValidationError(`Unknown or protected field(s) for ${kind}: ${rejected.join(', ')}. Known fields: ${columns.filter((c) => !PROTECTED_COLUMNS.has(c)).join(', ')}`);
  return out;
}

export const ADMIN: ReturnType<typeof define>[] = [
  define({
    name: 'update_setting',
    toolset: 'admin',
    description: 'Change one platform setting (prefixes ai., tickets., contracts., entitlements., portal., notifications., platform.). Secrets, security and mail-server settings cannot be changed here.',
    inputSchema: z.object({ key: z.string().min(3).max(120), value: settingValue }),
    requires: ['admin:system'],
    portal: null,
    action: true,
    tier: 'admin',
    invalidates: ['config'],
    run: async (ctx, input) => {
      assertWritableSetting(input.key);
      validateSetting(input.key, input.value);
      await updateSettings(ctx, { [input.key]: input.value });
      return { key: input.key, value: input.value, link: '/admin/settings' };
    },
    summary: (input) => `Set ${input.key} to ${fmt(input.value)}`,
    preview: async (ctx, input) => {
      assertWritableSetting(input.key);
      validateSetting(input.key, input.value);
      const current = await getSetting<unknown>(ctx, input.key, undefined);
      return `Change setting ${input.key} from ${fmt(current)} to ${fmt(input.value)}`;
    },
  }),

  define({
    name: 'upsert_option',
    toolset: 'admin',
    description: 'Add an option to a list (e.g. a new ticket category, asset status or visit type) or change an existing one (label, description, colour, order, active state).',
    inputSchema: z.object({ type: z.string().min(2).max(60), key: z.string().min(1).max(60).optional().describe('Option key (new or existing)'), id: z.string().uuid().optional(), label: z.string().max(120).optional(), description: z.string().max(500).optional(), color: z.string().max(20).optional(), sortOrder: z.number().int().min(0).max(10000).optional(), isActive: z.boolean().optional(), parent: z.string().max(60).optional().describe('Parent option key (subcategories)'), statusCategory: z.enum(['new', 'open', 'pending', 'resolved', 'closed', 'cancelled']).optional() }),
    requires: ['admin:config'],
    portal: null,
    action: true,
    tier: 'admin',
    invalidates: ['config'],
    run: async (ctx, input) => {
      const { all, existing } = await optionTarget(ctx, input);
      const parent = input.parent ? all.find((o) => o.key === input.parent) : undefined;
      if (input.parent && !parent) throw new ValidationError(`No option "${input.parent}" in ${input.type} to use as parent`);
      const patch = { ...(input.label !== undefined ? { label: input.label } : {}), ...(input.description !== undefined ? { description: input.description } : {}), ...(input.color !== undefined ? { color: input.color } : {}), ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}), ...(input.isActive !== undefined ? { isActive: input.isActive } : {}), ...(parent ? { parentId: parent.id } : {}), ...(input.statusCategory ? { statusCategory: input.statusCategory } : {}) };
      if (existing) {
        const row = await updateOption(ctx, existing.id, patch);
        return { action: 'updated', type: input.type, key: existing.key, option: row, link: '/admin/options' };
      }
      if (!input.key || !input.label) throw new ValidationError('A new option needs a key and a label');
      const row = await createOption(ctx, { type: input.type, key: input.key, label: input.label, ...patch });
      return { action: 'created', type: input.type, key: input.key, option: row, link: '/admin/options' };
    },
    summary: (input, result) => `${(result as { action: string }).action === 'created' ? 'Added' : 'Updated'} ${input.type.replace(/_/g, ' ')} option ${(result as { key: string }).key}`,
    preview: async (ctx, input): Promise<PreviewDetail> => {
      const { existing } = await optionTarget(ctx, input);
      const lines = [input.label !== undefined ? `label → ${input.label}` : null, input.description !== undefined ? 'description updated' : null, input.color !== undefined ? `colour → ${input.color}` : null, input.sortOrder !== undefined ? `order → ${input.sortOrder}` : null, input.isActive !== undefined ? (input.isActive ? 'active' : 'inactive') : null, input.parent ? `parent → ${input.parent}` : null, input.statusCategory ? `status category → ${input.statusCategory}` : null].filter((x): x is string => !!x);
      if (existing) return { text: `Update ${input.type.replace(/_/g, ' ')} option "${existing.label}" (${existing.key}): ${lines.join('; ') || 'no change'}`, lines };
      if (!input.key || !input.label) throw new ValidationError('A new option needs a key and a label');
      return { text: `Add ${input.type.replace(/_/g, ' ')} option "${input.label}" (${input.key})${lines.length > 1 ? `: ${lines.filter((l) => !l.startsWith('label')).join('; ')}` : ''}`, lines };
    },
  }),

  define({
    name: 'upsert_config',
    toolset: 'admin',
    description: 'Create or change a configuration record: assignment-rules, escalation-rules, notification-rules, notification-templates, approval-workflows, calendars, holiday-calendars, custom-fields, ci-types, relationship-types, or the attributes of sla-policies (name, description, calendars, default, active). Fields are the record\'s columns; read list_rules first to copy the shape.',
    inputSchema: z.object({ kind: z.enum(CONFIG_KIND_KEYS), record: z.string().max(200).optional().describe('Existing record name or id (omit to create)'), fields: z.record(z.string().max(60), z.unknown()).refine((f) => Object.keys(f).length > 0, 'At least one field') }),
    requires: ['admin:config'],
    portal: null,
    action: true,
    tier: 'admin',
    invalidates: ['config'],
    run: async (ctx, input) => {
      const { existing, label } = await configTarget(ctx, input.kind, input.record);
      const fields = allowedFields(input.kind, input.fields);
      if (input.kind === 'sla-policies') {
        if (!existing) throw new ValidationError('SLA policies with their targets are created on the SLA policies page; the assistant can only change an existing policy\'s attributes');
        const p = await updatePolicy(ctx, String(existing.id), fields as never);
        return { action: 'updated', kind: input.kind, name: p.name, fields: Object.keys(fields), link: `/admin/sla/${p.id}` };
      }
      const row = (existing ? await updateConfig(ctx, input.kind, String(existing.id), fields) : await createConfig(ctx, input.kind, fields)) as unknown as Record<string, unknown>;
      return { action: existing ? 'updated' : 'created', kind: input.kind, name: row.name ?? row.event ?? null, id: row.id, fields: Object.keys(fields), label, link: `/admin/${input.kind === 'notification-rules' ? 'notifications/rules' : input.kind === 'notification-templates' ? 'notifications/templates' : input.kind === 'approval-workflows' ? 'approvals' : input.kind === 'holiday-calendars' ? 'holidays' : input.kind}` };
    },
    summary: (input, result) => `${(result as { action: string }).action === 'created' ? 'Created' : 'Updated'} ${input.kind.replace(/-/g, ' ').replace(/s$/, '')} ${(result as { name?: string }).name ?? ''}`.trim(),
    preview: async (ctx, input): Promise<PreviewDetail> => {
      const { existing, label } = await configTarget(ctx, input.kind, input.record);
      const fields = allowedFields(input.kind, input.fields);
      const lines = Object.entries(fields).map(([k, v]) => `${k} → ${fmt(v)}${existing && existing[k] !== undefined ? ` (was ${fmt(existing[k])})` : ''}`);
      return { text: existing ? `Update ${label} "${existing.name ?? existing.event ?? existing.id}": ${lines.join('; ')}` : `Create a ${label} with ${lines.join('; ')}`, lines };
    },
  }),

  define({
    name: 'toggle_rule',
    toolset: 'admin',
    description: 'Enable or disable an assignment rule, escalation rule, notification rule or approval workflow by name.',
    inputSchema: z.object({ kind: z.enum(['assignment', 'escalation', 'notification', 'approval']), rule: z.string().max(200).describe('Rule name or id'), enabled: z.boolean() }),
    requires: ['admin:config'],
    portal: null,
    action: true,
    tier: 'admin',
    invalidates: ['config'],
    run: async (ctx, input) => {
      const kind = RULE_KINDS[input.kind as RuleKind];
      const { existing } = await configTarget(ctx, kind, input.rule);
      const row = (await updateConfig(ctx, kind, String(existing!.id), { isActive: input.enabled })) as unknown as Record<string, unknown>;
      return { kind: input.kind, name: row.name ?? null, isActive: row.isActive, link: `/admin/${input.kind === 'notification' ? 'notifications/rules' : input.kind === 'approval' ? 'approvals' : `${input.kind}-rules`}` };
    },
    summary: (input, result) => `${input.enabled ? 'Enabled' : 'Disabled'} ${input.kind} ${input.kind === 'approval' ? 'workflow' : 'rule'} "${(result as { name?: string }).name ?? input.rule}"`,
    preview: async (ctx, input) => {
      const { existing } = await configTarget(ctx, RULE_KINDS[input.kind as RuleKind], input.rule);
      const name = String(existing!.name ?? existing!.id);
      if (!!existing!.isActive === input.enabled) return `${input.kind} ${input.kind === 'approval' ? 'workflow' : 'rule'} "${name}" is already ${input.enabled ? 'enabled' : 'disabled'}`;
      return `${input.enabled ? 'Enable' : 'Disable'} the ${input.kind} ${input.kind === 'approval' ? 'workflow' : 'rule'} "${name}"`;
    },
  }),
];
