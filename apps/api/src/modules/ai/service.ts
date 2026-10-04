import { randomUUID } from 'node:crypto';
import { eq, and, desc, asc, sql } from 'drizzle-orm';
import { schema } from '@/db/client';
import { buildCtx, runAs, type Ctx, type CtxMeta } from '@/core/context';
import type { Principal } from '@/core/principal';
import { can } from '@/core/authz';
import { AppError, NotFoundError, ForbiddenError, ValidationError } from '@/core/errors';
import { aiProvider, aiEnabled, AiUpstreamError, type AiProvider, type ChatMessage, type ToolCall } from '@/lib/ai';
import { loadTicket } from '@/modules/tickets/common';
import { listTickets } from '@/modules/tickets/list';
import { CAB_READ, requireAny as requireAnyPermission } from '@/modules/changes/service';
import { matchRoute } from '@itsm/shared';
import { availableTools, availableToolsets, toolDefinitions, toolByName, toolAvailable, tierOf, previewDetail, isCustomerUser, listQuery, TOOLSET_KEYS, type AiTool, type Who, type ToolsetKey } from './tools';
import { buildSystemPrompt, describeScope, PROMPT_VERSION, skillsFor } from './prompt';
import { resolveToolsets, enableToolset, stickyOf, BASE_SETS, TOOLSETS, type ToolsetState } from './toolsets';
import { fenceToolResult, fenceAnswer, collectSeen, type TenantFence } from './fence';
import { factsOf, groundAnswer } from './ground';
import { compactForTrace, redactKeys, scrubResult, inputHash } from './redact';
import { wrapUntrusted, stripMarkers, sanitizeText } from './untrusted';
import { loadAiSettings, assertAssistantEnabled, assertDailyBudget, AiDisabledError, AI_FEATURES, featureEnabled, type AiSettings } from './guards';
import { logger } from '@/core/logger';
import { SKILLS, type ChatContext, type SkillKey } from './schemas';

export { AiDisabledError } from './guards';

/** Hard limits that keep a conversation turn bounded. */
export const MAX_TOOL_ITERATIONS = 8;
export const MAX_TOOL_RESULT_CHARS = 6000;
export const HISTORY_MESSAGES = 20;
const MAX_HISTORY_CHARS = 4000;
const CHAT_MAX_TOKENS = 4096;

// ---------------------------------------------------------------- provider (injectable for tests)

let override: AiProvider | null = null;
/** Test hook: inject a fake provider (pass null to restore the configured one). */
export const setProviderForTests = (p: AiProvider | null) => {
  override = p;
};
export const provider = (): AiProvider => override ?? aiProvider();
export const enabled = () => (override ? override.name !== 'none' : aiEnabled());

// ---------------------------------------------------------------- steps: short transactions around model calls

/** Who is asking, and the request this turn belongs to. */
export interface TurnMeta {
  requestId: string;
  ip?: string | null;
  userAgent?: string | null;
}

export const metaOf = (ctx: Ctx): TurnMeta => ({ requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent });

/**
 * One short tenant transaction with the assistant's identity: audit entries and
 * comments written inside carry source = 'ai', and `auditMetadata` (the action
 * id, the conversation id) is stamped on every audit row of its side effects.
 * Model calls never happen inside one of these.
 */
export const aiStep = <T>(p: Principal, meta: TurnMeta, fn: (ctx: Ctx) => Promise<T>, auditMetadata?: Record<string, unknown>): Promise<T> =>
  runAs(p, { requestId: meta.requestId, ip: meta.ip, userAgent: meta.userAgent, source: 'ai', auditMetadata } satisfies Partial<CtxMeta>, fn);

/**
 * How a feature runs its database work: `tx` opens a short transaction per
 * step. Built from a request (`stepsFor`) the steps are separate transactions
 * so the model call between them holds no connection; built from an existing
 * ctx (`stepsOf`) every step runs inside that ctx's transaction (tests, and
 * tools that already run inside their own step).
 */
export interface Steps {
  principal: Principal;
  tx<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T>;
}
export const stepsFor = (p: Principal, meta: TurnMeta): Steps => ({ principal: p, tx: (fn) => aiStep(p, meta, fn) });
export const stepsOf = (ctx: Ctx): Steps => ({ principal: ctx.user, tx: (fn) => fn(ctx) });
export const isSteps = (x: Ctx | Steps): x is Steps => typeof (x as Steps).tx === 'function';
export const asSteps = (x: Ctx | Steps): Steps => (isSteps(x) ? x : stepsOf(x));

/** Same principal and transaction, but audit entries and comments carry source = 'ai'. */
export const aiCtx = (ctx: Ctx): Ctx => (ctx.source === 'ai' ? ctx : buildCtx(ctx.user, ctx.tx, { requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent, source: 'ai' }));

/** Runs a service function with an AI-sourced ctx derived from the request ctx. */
export const withAiCtx = <T>(ctx: Ctx, fn: (ai: Ctx) => Promise<T>): Promise<T> => fn(aiCtx(ctx));

// ---------------------------------------------------------------- status

const CUSTOMER_PROMPTS = ['What tickets are currently open?', 'What is the status of my recent ticket?', 'Raise a ticket for a network problem at <site>', 'Show my SLA performance', 'When is the next maintenance visit?'];
const ENGINEER_PROMPTS = ['What tickets are assigned to me?', 'Summarize ticket <INC>', 'Show similar incidents to <INC>', 'What changed on <CI> recently?', 'Known solutions for backup job failures'];
const MANAGEMENT_PROMPTS = ['Which contracts expire in the next 90 days?', 'Which customers have the most SLA breaches this month?', 'Show out-of-scope work this month', 'Which services generate the most incidents?', 'How many AMC visits have been consumed for <customer>?'];

async function examplePrompts(ctx: Ctx): Promise<string[]> {
  const u = ctx.user;
  if (isCustomerUser(ctx)) {
    const [site] = u.customerId ? await ctx.tx.select({ name: schema.sites.name }).from(schema.sites).where(and(eq(schema.sites.customerId, u.customerId), eq(schema.sites.isActive, true))).orderBy(desc(schema.sites.isPrimary), asc(schema.sites.name)).limit(1) : [];
    return CUSTOMER_PROMPTS.map((s) => s.replace('<site>', site?.name ?? 'our main site'));
  }
  const management = ctx.can('dashboards:management') || ctx.can('admin:system') || ctx.can('contracts:manage');
  const engineer = ctx.can('tickets:assign') || ctx.can('tickets:resolve') || ctx.can('tickets:update');
  const out: string[] = [];
  if (engineer || !management) {
    let inc = 'INC-000001';
    let ci = 'a core switch';
    try {
      const mine = await listTickets(ctx, listQuery({ page: 1, pageSize: 1, sort: 'updatedAt', order: 'desc', open: true, mine: true }));
      const any = mine.items[0] ?? (await listTickets(ctx, listQuery({ page: 1, pageSize: 1, sort: 'updatedAt', order: 'desc', open: true, type: 'incident' }))).items[0];
      if (any) inc = any.number;
      if (ctx.can('cmdb:read')) {
        const [c] = await ctx.tx.select({ name: schema.cis.name }).from(schema.cis).where(eq(schema.cis.status, 'active')).orderBy(desc(schema.cis.updatedAt)).limit(1);
        if (c) ci = c.name;
      }
    } catch {
      /* examples are best-effort */
    }
    out.push(...ENGINEER_PROMPTS.map((s) => s.replace('<INC>', inc).replace('<CI>', ci)));
  }
  if (management) {
    let customer = 'a customer';
    try {
      const [c] = await ctx.tx.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.isActive, true)).orderBy(asc(schema.customers.name)).limit(1);
      if (c) customer = c.name;
    } catch {
      /* ignore */
    }
    const mgmt = MANAGEMENT_PROMPTS.map((s) => s.replace('<customer>', customer));
    return engineer ? [...mgmt.slice(0, 3), ...out.slice(0, 2)] : mgmt;
  }
  return out;
}

export async function status(ctx: Ctx) {
  const p = provider();
  const settings = await loadAiSettings(ctx.tx);
  const tools = availableTools(ctx);
  const offered = availableToolsets(ctx);
  const on = enabled() && settings.assistantEnabled && !settings.disabledFeatures.includes('assistant');
  return {
    enabled: on && ctx.can('ai:use'),
    promptVersion: PROMPT_VERSION,
    toolsets: offered.map((k) => ({ key: k, label: TOOLSETS[k].label, description: TOOLSETS[k].description })),
    skills: skillsFor({ customer: isCustomerUser(ctx), toolsets: offered }).map((sk) => ({ key: sk.key, title: sk.title, when: sk.when })),
    assistantEnabled: settings.assistantEnabled,
    provider: p.name,
    model: p.model || null,
    configured: { provider: p.name, model: p.model || null, baseUrl: p.baseUrl ?? null },
    features: AI_FEATURES.filter((f) => featureEnabled(settings, f)),
    autonomy: settings.autonomy,
    canAct: ctx.can('ai:act'),
    tools: tools.map((t) => ({ name: t.name, action: t.action, tier: tierOf(t), toolset: t.toolset })),
    suggestions: ctx.can('ai:use') ? await examplePrompts(ctx) : [],
  };
}

/**
 * Sends a one-line prompt through the configured provider so administrators can
 * verify credentials, model and endpoint from the product. Never throws for
 * upstream problems: the failure is returned so the screen can show it.
 */
export interface AiTestResult {
  ok: boolean;
  provider: string;
  model: string | null;
  baseUrl: string | null;
  latencyMs: number;
  reply?: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: { status: number; code: string; message: string };
}

/** Accepts a request ctx or a bare principal: the check needs no database access. */
export async function test(who: Ctx | Principal): Promise<AiTestResult> {
  const principal = 'user' in who ? who.user : who;
  if (!can(principal, 'admin:system') && !can(principal, 'admin:config')) throw new ForbiddenError();
  const p = provider();
  const base = { provider: p.name, model: p.model || null, baseUrl: p.baseUrl ?? null };
  if (!enabled()) return { ok: false, ...base, latencyMs: 0, error: { status: 503, code: 'ai_disabled', message: 'The AI assistant is not configured: set AI_PROVIDER and the provider credentials, then restart the app.' } };
  const started = Date.now();
  try {
    // Models that always think need room for it: a tiny max_tokens would return nothing.
    const res = await p.chat({ system: 'You are a connectivity check. Reply with the single word OK.', messages: [{ role: 'user', content: 'ping' }], maxTokens: 256, effort: 'low' });
    return { ok: true, ...base, latencyMs: Date.now() - started, reply: res.text.trim().slice(0, 200), usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens } };
  } catch (err) {
    const latencyMs = Date.now() - started;
    if (err instanceof AiUpstreamError) return { ok: false, ...base, latencyMs, error: { status: err.upstreamStatus ?? 502, code: err.code, message: err.upstreamMessage } };
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, ...base, latencyMs, error: { status: 500, code: 'error', message: message.slice(0, 500) } };
  }
}

// ---------------------------------------------------------------- conversations

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  summary: string;
  ok: boolean;
  action: boolean;
  error?: string;
  /** Records of another organisation removed from the result before the model saw it (customer users only; normally 0). */
  fenced?: number;
  /** The action was only proposed (preview shown); it runs when the user confirms. */
  proposed?: boolean;
  /** A low-risk write applied without confirmation (autonomy auto_low). */
  auto?: boolean;
  /** Web query caches to refresh after this action ran. */
  invalidates?: string[];
}

/**
 * Propose-then-commit. An action tool never runs on the turn the model calls it:
 * the call is stored on the conversation as a pending action with a resolved
 * preview, the model asks the user to confirm, and the next turn either commits
 * it (a confirmation bound to its id, or an explicit typed yes), drops it (a
 * no), or drops it and carries on (anything else). One pending action at a
 * time, executed at most once (the conversation row is locked while it runs),
 * and it expires.
 */
export interface PendingAction {
  id: string;
  tool: string;
  tier: string;
  /** Validated input with secret-looking keys redacted (action tools never carry secrets). */
  input: Record<string, unknown>;
  preview: string;
  /** The exact changes (bulk, multi-field) and the number of records touched (destructive). */
  lines?: string[];
  count?: number;
  createdAt: string;
  expiresAt: string;
}
export const PENDING_ACTION_TTL_MS = 30 * 60_000;
/** A whole message that only says yes. "Yes, proceed." / "ok" / "go ahead" / "confirm". */
export const CONFIRM_RE = /^\s*(?:yes|y|yep|yeah|yup|ok|okay|sure|go ahead|proceed|do it|confirm|confirmed|please do|please proceed|yes[,.!\s]+(?:please|proceed|go ahead|do it|confirm|do that)[\s\S]{0,24})\s*[.!]*\s*$/i;
/** A message that starts with a refusal. "No" / "No, do not do that." / "cancel". */
export const CANCEL_RE = /^\s*(?:no|nope|cancel|stop|abort|don'?t|do not|never ?mind|not now)\b/i;

export function readPending(context: Record<string, unknown> | null | undefined): PendingAction | null {
  const p = (context ?? {}).pendingAction as Partial<PendingAction> | undefined;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.tool !== 'string' || typeof p.preview !== 'string' || typeof p.createdAt !== 'string') return null;
  const expiresAt = typeof p.expiresAt === 'string' ? p.expiresAt : new Date(new Date(p.createdAt).getTime() + PENDING_ACTION_TTL_MS).toISOString();
  if (Date.now() > new Date(expiresAt).getTime()) return null;
  return { id: p.id, tool: p.tool, tier: typeof p.tier === 'string' ? p.tier : 'write', input: (p.input ?? {}) as Record<string, unknown>, preview: p.preview, ...(Array.isArray(p.lines) ? { lines: p.lines.map(String) } : {}), ...(typeof p.count === 'number' ? { count: p.count } : {}), createdAt: p.createdAt, expiresAt };
}
export type PublicPending = { id: string; tool: string; tier: string; preview: string; lines?: string[]; count?: number; expiresAt: string };
const publicPending = (p: PendingAction | null): PublicPending | null => (p ? { id: p.id, tool: p.tool, tier: p.tier, preview: p.preview, ...(p.lines ? { lines: p.lines } : {}), ...(p.count !== undefined ? { count: p.count } : {}), expiresAt: p.expiresAt } : null);
const withoutPending = (context: Record<string, unknown> | null | undefined) => {
  const { pendingAction: _p, ...rest } = context ?? {};
  return rest;
};

export class StaleActionError extends AppError {
  constructor(message = 'That proposal is no longer waiting: it was already decided or has expired. Ask again if you still want it.') {
    super(409, message, 'stale_action');
  }
}

/**
 * A conversation belongs to the user who started it. Customer users additionally
 * only ever see conversations held under their current organisation, so a user
 * moved between customers can never carry context across.
 */
const own = (ctx: Ctx, id: string) =>
  isCustomerUser(ctx)
    ? and(eq(schema.aiConversations.id, id), eq(schema.aiConversations.userId, ctx.user.id), eq(schema.aiConversations.customerId, ctx.user.customerId ?? '00000000-0000-0000-0000-000000000000'))
    : and(eq(schema.aiConversations.id, id), eq(schema.aiConversations.userId, ctx.user.id));

/** The organisation a customer (portal) user belongs to; null for MSP staff. Throws for a portal user without one. */
export async function organisationOf(ctx: Ctx): Promise<TenantFence | null> {
  if (!isCustomerUser(ctx)) return null;
  if (!ctx.user.customerId) throw new ForbiddenError('Your account is not linked to a customer');
  const [c] = await ctx.tx.select({ id: schema.customers.id, name: schema.customers.name, code: schema.customers.code }).from(schema.customers).where(eq(schema.customers.id, ctx.user.customerId)).limit(1);
  if (!c) throw new ForbiddenError('Your organisation is not available');
  return { customerId: c.id, customerName: c.name, customerCode: c.code };
}

export async function listConversations(ctx: Ctx, limit = 20) {
  const mine = isCustomerUser(ctx)
    ? and(eq(schema.aiConversations.userId, ctx.user.id), eq(schema.aiConversations.customerId, ctx.user.customerId ?? '00000000-0000-0000-0000-000000000000'))
    : eq(schema.aiConversations.userId, ctx.user.id);
  const rows = await ctx.tx
    .select({ id: schema.aiConversations.id, title: schema.aiConversations.title, context: schema.aiConversations.context, createdAt: schema.aiConversations.createdAt, updatedAt: schema.aiConversations.updatedAt, messageCount: sql<number>`(select count(*)::int from ai_messages m where m.conversation_id = ai_conversations.id)` })
    .from(schema.aiConversations)
    .where(mine)
    .orderBy(desc(schema.aiConversations.updatedAt))
    .limit(limit);
  return { items: rows.map((r) => ({ ...r, context: withoutPending(r.context) })) };
}

export async function getConversation(ctx: Ctx, id: string) {
  const [c] = await ctx.tx.select().from(schema.aiConversations).where(own(ctx, id)).limit(1);
  if (!c) throw new NotFoundError('Conversation');
  const messages = await ctx.tx.select().from(schema.aiMessages).where(eq(schema.aiMessages.conversationId, c.id)).orderBy(asc(schema.aiMessages.createdAt), desc(schema.aiMessages.role));
  return { id: c.id, title: c.title, context: withoutPending(c.context), createdAt: c.createdAt, updatedAt: c.updatedAt, messages: messages.map(publicMessage), pendingAction: publicPending(readPending(c.context)) };
}

export async function deleteConversation(ctx: Ctx, id: string) {
  const [c] = await ctx.tx.select({ id: schema.aiConversations.id }).from(schema.aiConversations).where(own(ctx, id)).limit(1);
  if (!c) throw new NotFoundError('Conversation');
  await ctx.tx.delete(schema.aiConversations).where(eq(schema.aiConversations.id, c.id));
  return { ok: true };
}

/** Thumbs up or down on one of the assistant's replies (the person's own conversation only). */
export async function feedback(ctx: Ctx, messageId: string, rating: 'up' | 'down' | null, note?: string | null) {
  const [m] = await ctx.tx
    .select({ id: schema.aiMessages.id, conversationId: schema.aiMessages.conversationId, role: schema.aiMessages.role })
    .from(schema.aiMessages)
    .innerJoin(schema.aiConversations, eq(schema.aiConversations.id, schema.aiMessages.conversationId))
    .where(and(eq(schema.aiMessages.id, messageId), eq(schema.aiConversations.userId, ctx.user.id)))
    .limit(1);
  if (!m || m.role !== 'assistant') throw new NotFoundError('Message');
  await ctx.tx.update(schema.aiMessages).set({ feedback: rating, feedbackNote: note ? sanitizeText(note, 1000) : null }).where(eq(schema.aiMessages.id, m.id));
  await ctx.audit({ entityType: 'ai_message', entityId: m.id, entityLabel: 'chat reply', action: 'ai.feedback', metadata: { conversationId: m.conversationId, rating, hasNote: !!note } });
  return { id: m.id, feedback: rating };
}

type MessageRow = typeof schema.aiMessages.$inferSelect;
const publicMessage = (m: MessageRow) => ({ id: m.id, role: m.role as 'user' | 'assistant', content: m.content, toolCalls: (m.toolCalls ?? []) as unknown as ToolCallRecord[], inputTokens: m.inputTokens, outputTokens: m.outputTokens, feedback: (m.feedback ?? null) as 'up' | 'down' | null, createdAt: m.createdAt });
export type PublicMessage = ReturnType<typeof publicMessage>;

// ---------------------------------------------------------------- context description

/** The page the user is on, from the application map: label, route and the allowlisted filters it carries. */
function describePage(page: ChatContext['page'] | null | undefined): string | null {
  if (!page?.pathname) return null;
  const hit = matchRoute(page.pathname.split('?')[0]!);
  if (!hit || hit.page.hidden) return null;
  const allowed = hit.page.filters ?? [];
  const filters = Object.entries(page.query ?? {}).filter(([k, v]) => allowed.includes(k) && v).map(([k, v]) => `${k}=${sanitizeText(String(v), 80)}`);
  return `Current page: ${hit.page.label} (${hit.page.route})${filters.length ? ` with filters ${filters.join(', ')}` : ''}. ${hit.page.purpose}`;
}

/** Resolves the UI context (page and record) into a few lines for the prompt, through the service layer (so nothing leaks). */
export async function describeContext(ctx: Ctx, c: ChatContext | null | undefined): Promise<string | null> {
  const lines = [describePage(c?.page), await describeEntity(ctx, c)].filter((x): x is string => !!x);
  return lines.length ? lines.join('\n') : null;
}

async function describeEntity(ctx: Ctx, c: ChatContext | null | undefined): Promise<string | null> {
  const label = c?.label ? sanitizeText(String(c.label), 200) : null;
  if (!c?.entityType || !c.entityId) return label ? `User is viewing: ${label}` : null;
  try {
    switch (c.entityType) {
      case 'ticket': {
        const t = await loadTicket(ctx, c.entityId);
        const [cust] = await ctx.tx.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, t.customerId)).limit(1);
        return `User is viewing ticket ${t.number} ("${sanitizeText(t.title, 120)}", ${t.type}) for customer ${cust?.name ?? 'unknown'}. Use get_ticket with "${t.number}" for details.`;
      }
      case 'customer': {
        ctx.requireCustomer(c.entityId);
        const [cust] = await ctx.tx.select({ name: schema.customers.name, code: schema.customers.code }).from(schema.customers).where(eq(schema.customers.id, c.entityId)).limit(1);
        return cust ? `User is viewing customer ${cust.name} (${cust.code}). Use get_customer with "${cust.code}".` : null;
      }
      case 'ci': {
        const [ci] = await ctx.tx.select({ name: schema.cis.name, hostname: schema.cis.hostname, customerId: schema.cis.customerId }).from(schema.cis).where(eq(schema.cis.id, c.entityId)).limit(1);
        if (!ci) return null;
        ctx.requireCustomer(ci.customerId);
        return `User is viewing configuration item "${ci.name}"${ci.hostname ? ` (${ci.hostname})` : ''}. Use get_ci with "${ci.name}".`;
      }
      case 'contract': {
        const [k] = await ctx.tx.select({ number: schema.contracts.number, name: schema.contracts.name, customerId: schema.contracts.customerId }).from(schema.contracts).where(eq(schema.contracts.id, c.entityId)).limit(1);
        if (!k) return null;
        ctx.requireCustomer(k.customerId);
        const [cust] = await ctx.tx.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, k.customerId)).limit(1);
        return `User is viewing contract ${k.number} (${k.name}) of customer ${cust?.name ?? ''}. Use list_contracts with customer "${cust?.name ?? ''}".`;
      }
      case 'kb_article':
        return `User is viewing knowledge article ${label ?? ''}${c.title ? ` "${sanitizeText(String(c.title), 120)}"` : ''}.`;
      case 'cab_meeting': {
        requireAnyPermission(ctx, CAB_READ);
        const [m] = await ctx.tx.select({ title: schema.cabMeetings.title, scheduledAt: schema.cabMeetings.scheduledAt, status: schema.cabMeetings.status }).from(schema.cabMeetings).where(eq(schema.cabMeetings.id, c.entityId)).limit(1);
        if (!m) return null;
        const title = sanitizeText(m.title, 120);
        return `User is viewing CAB meeting "${title}" scheduled ${m.scheduledAt.toISOString()} (${m.status}). Use cab_agenda with meeting "${title}".`;
      }
      default:
        return label ? `User is viewing ${sanitizeText(String(c.entityType), 40)} "${label}".` : null;
    }
  } catch {
    return label ? `User is viewing: ${label}` : null;
  }
}

// ---------------------------------------------------------------- tool execution

function truncateResult(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  } catch {
    text = String(value);
  }
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}… [truncated: ${text.length - MAX_TOOL_RESULT_CHARS} more characters; narrow the query]`;
}

export interface ExecuteOptions {
  /** Run the action (the user confirmed, or autonomy allows it) instead of proposing it. */
  confirmed?: boolean;
  /** The pending action being executed; stamped on the audit trail. */
  actionId?: string;
  conversationId?: string;
  /** The write ran without confirmation under autonomy auto_low. */
  auto?: boolean;
}

export interface ExecuteResult {
  record: ToolCallRecord;
  content: string;
  isError: boolean;
  proposal?: PendingAction;
}

/**
 * Validates and executes one tool call under a savepoint, so a failing tool
 * (permission denied, validation error, RLS violation) never aborts the
 * surrounding transaction. Every call is audited as `ai.tool` with its outcome
 * and an input fingerprint, never the input itself.
 */
export async function executeToolCall(ctx: Ctx, call: ToolCall, index: number, fence?: TenantFence | null, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
  const tool = toolByName(call.name);
  const base = { name: call.name, input: compactForTrace(call.input ?? {}), action: tool?.action ?? false };
  const audit = async (outcome: string, extra: Record<string, unknown> = {}) => {
    try {
      await aiCtx(ctx).audit({ entityType: 'ai_tool', entityId: opts.conversationId ?? null, entityLabel: call.name, action: 'ai.tool', metadata: { tool: call.name, tier: tool ? tierOf(tool) : null, outcome, inputHash: inputHash(call.input ?? {}), actionId: opts.actionId ?? null, conversationId: opts.conversationId ?? null, ...extra } });
    } catch (err) {
      logger.warn({ err, tool: call.name }, 'ai tool audit failed');
    }
  };
  if (!tool) {
    await audit('unknown_tool');
    return { record: { ...base, ok: false, summary: `Unknown tool ${call.name}`, error: 'unknown_tool' }, content: JSON.stringify({ error: `Unknown tool "${call.name}"` }), isError: true };
  }
  if (!toolAvailable(ctx, tool)) {
    await audit('forbidden');
    return { record: { ...base, ok: false, summary: `${tool.name} not permitted`, error: 'forbidden' }, content: JSON.stringify({ error: 'forbidden', message: tool.action && !ctx.can('ai:act') ? 'The user has not enabled AI actions (ai:act).' : 'The user does not have permission for this tool.' }), isError: true };
  }
  const parsed = tool.inputSchema.safeParse(call.input ?? {});
  if (!parsed.success) {
    await audit('invalid_input');
    return { record: { ...base, ok: false, summary: `${tool.name}: invalid input`, error: 'validation_error' }, content: JSON.stringify({ error: 'invalid_input', issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })) }), isError: true };
  }
  const data = parsed.data as Record<string, unknown>;
  const trace = compactForTrace(data);
  const sp = `ai_tool_${index}`;
  await ctx.tx.execute(sql.raw(`SAVEPOINT ${sp}`));
  try {
    if (tool.action && !opts.confirmed) {
      // Propose only: resolve the preview against real records, run nothing.
      const detail = previewDetail(tool.preview ? await tool.preview(aiCtx(ctx), data) : `Run ${tool.name} with ${JSON.stringify(trace)}`);
      const preview = detail.text;
      await ctx.tx.execute(sql.raw(`RELEASE SAVEPOINT ${sp}`));
      const createdAt = new Date();
      const proposal: PendingAction = { id: randomUUID(), tool: tool.name, tier: tierOf(tool), input: redactKeys(data), preview, ...(detail.lines?.length ? { lines: detail.lines.slice(0, 40) } : {}), ...(detail.count !== undefined ? { count: detail.count } : {}), createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + PENDING_ACTION_TTL_MS).toISOString() };
      await audit('proposed', { actionId: proposal.id });
      return {
        record: { ...base, input: trace, ok: true, summary: `Proposed: ${preview}`, proposed: true },
        content: JSON.stringify({ status: 'awaiting_confirmation', preview, ...(detail.lines?.length ? { changes: detail.lines.slice(0, 40) } : {}), ...(detail.count !== undefined ? { count: detail.count } : {}), instruction: 'Nothing has been done yet. Repeat this preview to the user in one sentence and end with "Shall I proceed?". The platform runs it only when they confirm; do not call this tool again for the same request.' }),
        isError: false,
        proposal,
      };
    }
    const raw = await tool.run(aiCtx(ctx), data);
    await ctx.tx.execute(sql.raw(`RELEASE SAVEPOINT ${sp}`));
    // Secrets never reach the model; customer users never see another organisation (the fence reads the structure, so it runs
    // before people-written text is marked as data).
    const scrubbed = scrubResult(raw);
    const guard = fence === undefined ? await organisationOf(ctx) : fence;
    const fenced = guard ? fenceToolResult(scrubbed, guard) : { value: scrubbed, dropped: 0 };
    const result = wrapUntrusted(fenced.value);
    if (fenced.dropped > 0) {
      logger.warn({ tool: tool.name, dropped: fenced.dropped, userId: ctx.user.id, customerId: guard?.customerId, requestId: ctx.requestId }, 'ai tenant fence removed records of another organisation');
      await ctx.audit({ entityType: 'ai_tool', entityId: ctx.user.id, entityLabel: tool.name, action: 'ai.tenant_fence', customerId: guard?.customerId ?? null, metadata: { tool: tool.name, dropped: fenced.dropped } });
    }
    let summary: string;
    try {
      summary = tool.summary(data, raw);
    } catch {
      summary = `Ran ${tool.name}`;
    }
    await audit('ok', { fenced: fenced.dropped, auto: !!opts.auto });
    return { record: { ...base, input: trace, ok: true, summary, ...(fenced.dropped ? { fenced: fenced.dropped } : {}), ...(opts.auto ? { auto: true } : {}), ...(tool.action && tool.invalidates?.length ? { invalidates: tool.invalidates } : {}) }, content: truncateResult(result), isError: false };
  } catch (err) {
    try {
      await ctx.tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${sp}`));
    } catch {
      /* the transaction is unusable; surface the original error */
      throw err;
    }
    const e = err as AppError;
    const code = e instanceof AppError ? e.code : 'error';
    const message = e instanceof AppError ? e.message : 'The tool failed unexpectedly';
    if (!(e instanceof AppError)) logger.error({ err, tool: tool.name, requestId: ctx.requestId }, 'ai tool failed unexpectedly');
    await audit('error', { error: code });
    return { record: { ...base, input: trace, ok: false, summary: `${tool.name} failed: ${message.slice(0, 160)}`, error: code }, content: JSON.stringify({ error: code, message }), isError: true };
  }
}

// ---------------------------------------------------------------- chat

export interface ChatInput {
  conversationId?: string | null;
  message?: string | null;
  context?: ChatContext | null;
  /** A decision on the held action, bound to its id (the panel's Confirm / Cancel buttons). */
  confirm?: { actionId: string; decision: 'confirm' | 'cancel' } | null;
  skill?: string | null;
}

/** Something the web should do after the reply (navigation, a prefilled form); produced by UI tools. */
export interface UiAction {
  type: 'navigate';
  to: string;
  label?: string;
}

export interface ChatResult {
  conversationId: string;
  message: PublicMessage;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  pendingAction: PublicPending | null;
  uiActions: UiAction[];
}

/** Progress events for a streamed turn (the panel shows them while the reply is being prepared). */
export type TurnEvent =
  | { type: 'turn'; conversationId: string }
  | { type: 'toolsets'; active: ToolsetKey[] }
  | { type: 'step'; status: 'start' | 'done' | 'error'; tool: string; summary: string; action: boolean };
export type Emit = (event: TurnEvent) => void;

/** Builds the provider history from stored messages (text only; tool traces are not replayed). */
function historyMessages(rows: MessageRow[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of rows) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const content = m.content.length > MAX_HISTORY_CHARS ? `${m.content.slice(0, MAX_HISTORY_CHARS)}…` : m.content;
    if (!content.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      // providers expect alternating roles; merge consecutive messages
      (last as { content: string }).content += `\n\n${content}`;
      continue;
    }
    out.push(m.role === 'user' ? { role: 'user', content } : { role: 'assistant', content });
  }
  if (out[0]?.role === 'assistant') out.shift();
  return out;
}

const parseLink = (content: string): string | undefined => {
  try {
    return (JSON.parse(content) as { link?: string }).link;
  } catch {
    return undefined;
  }
};
const parseFailure = (content: string): string => {
  try {
    return (JSON.parse(content) as { message?: string }).message ?? 'it failed';
  } catch {
    return 'it failed';
  }
};

/** Runs one turn for a request ctx (tests and callers that already hold a ctx). The turn opens its own short transactions. */
export const chat = (ctx: Ctx, input: ChatInput): Promise<ChatResult> => chatTurn(ctx.user, metaOf(ctx), input);

/**
 * One conversation turn. Model calls run outside any database transaction;
 * every persistence step and every tool call opens a short tenant transaction
 * of its own, so a slow model never pins a connection.
 */
export async function chatTurn(p: Principal, meta: TurnMeta, input: ChatInput, emit?: Emit): Promise<ChatResult> {
  if (!can(p, 'ai:use')) throw new ForbiddenError('Missing permission: ai:use');
  if (!enabled()) throw new AiDisabledError();
  const started = Date.now();
  const typed = (input.message ?? '').trim();
  const text = typed || (input.confirm ? (input.confirm.decision === 'confirm' ? 'Yes, go ahead.' : 'No, cancel that.') : '');
  if (!text) throw new ValidationError('A message is required');

  // ---- step A: guards, the conversation, the user's message, the held action
  const a = await aiStep(p, meta, async (ctx) => {
    const settings = await loadAiSettings(ctx.tx);
    assertAssistantEnabled(settings, enabled());
    await assertDailyBudget(ctx, settings);
    // Customer users are bound to exactly one organisation for the whole turn: prompt, tools and stored conversation.
    const org = await organisationOf(ctx);
    let conv: typeof schema.aiConversations.$inferSelect | undefined;
    if (input.conversationId) {
      [conv] = await ctx.tx.select().from(schema.aiConversations).where(own(ctx, input.conversationId)).limit(1);
      if (!conv) throw new NotFoundError('Conversation');
    } else {
      if (input.confirm) throw new StaleActionError();
      [conv] = await ctx.tx.insert(schema.aiConversations).values({ userId: ctx.user.id, customerId: isCustomerUser(ctx) ? ctx.user.customerId : null, title: sanitizeText(text.replace(/\s+/g, ' '), 60), context: (input.context ?? {}) as Record<string, unknown> }).returning();
    }
    const pending = readPending(conv!.context);
    // A button decision must name the action the conversation is holding; anything else is stale.
    if (input.confirm && (!pending || pending.id !== input.confirm.actionId)) throw new StaleActionError();
    const [userMessage] = await ctx.tx.insert(schema.aiMessages).values({ conversationId: conv!.id, customerId: conv!.customerId, role: 'user', content: text, createdAt: new Date() }).returning({ id: schema.aiMessages.id });
    return { settings, org, conv: conv!, pending, userMessageId: userMessage!.id };
  });
  const { settings, org, conv } = a;
  emit?.({ type: 'turn', conversationId: conv.id });
  const organisation = org ? { name: org.customerName, code: org.customerCode } : null;

  // ---- step C: the held action is decided by this message before the model sees anything
  const decision: 'confirm' | 'cancel' | null = input.confirm ? input.confirm.decision : a.pending ? (CONFIRM_RE.test(text) ? 'confirm' : CANCEL_RE.test(text) ? 'cancel' : null) : null;
  if (a.pending && decision) {
    const actionId = a.pending.id;
    return aiStep(
      p,
      meta,
      async (ctx) => {
        // The row lock makes "exactly once" hold even for two simultaneous confirmations.
        const [locked] = await ctx.tx.select().from(schema.aiConversations).where(own(ctx, conv.id)).for('update');
        const pending = readPending(locked?.context);
        const finish = async (reply: string, records: ToolCallRecord[], outcome: string) => {
          const [assistant] = await ctx.tx
            .insert(schema.aiMessages)
            .values({ conversationId: conv.id, customerId: conv.customerId, role: 'assistant', content: reply, toolCalls: records as unknown as Record<string, unknown>[], inputTokens: 0, outputTokens: 0, durationMs: Date.now() - started, createdAt: new Date(Date.now() + 1) })
            .returning();
          const context = { ...withoutPending(locked?.context ?? conv.context), lastAction: { id: actionId, outcome, at: new Date().toISOString() } };
          await ctx.tx.update(schema.aiConversations).set({ updatedAt: new Date(), context }).where(eq(schema.aiConversations.id, conv.id));
          await ctx.audit({ entityType: 'ai_conversation', entityId: conv.id, entityLabel: 'chat', action: 'ai.chat', customerId: conv.customerId, metadata: { messageId: assistant!.id, outcome, actionId, tools: records.map((r) => r.name), durationMs: Date.now() - started, inputTokens: 0, outputTokens: 0 } });
          return { conversationId: conv.id, message: publicMessage(assistant!), usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, pendingAction: null, uiActions: [] } satisfies ChatResult;
        };
        if (!pending || pending.id !== actionId) {
          if (input.confirm) throw new StaleActionError();
          return finish('That proposal is no longer waiting: it was already decided or has expired. Ask again if you still want it.', [], 'stale');
        }
        if (decision === 'cancel') return finish('OK, I have not done that.', [], 'cancelled');
        emit?.({ type: 'step', status: 'start', tool: pending.tool, summary: pending.preview, action: true });
        const r = await executeToolCall(ctx, { id: pending.id, name: pending.tool, input: pending.input }, 0, org, { confirmed: true, actionId: pending.id, conversationId: conv.id });
        emit?.({ type: 'step', status: r.isError ? 'error' : 'done', tool: pending.tool, summary: r.record.summary, action: true });
        const link = r.isError ? undefined : parseLink(r.content);
        return finish(r.isError ? `I could not do that: ${parseFailure(r.content)}` : `Done: ${r.record.summary}${link ? ` ([open](${link}))` : ''}.`, [r.record], r.isError ? 'failed' : 'done');
      },
      { aiActionId: actionId, aiConversationId: conv.id },
    );
  }

  // ---- step B: history, screen, tools and the prompt
  const b = await aiStep(p, meta, async (ctx) => {
    let cancelledNote: string | null = null;
    if (a.pending) {
      // The user moved on: the proposal is dropped and the model is told, so it can re-propose with the new details.
      cancelledNote = `The earlier proposal "${a.pending.preview}" was not confirmed and is now cancelled. If the user is adjusting it, propose again with the new details.`;
      await ctx.tx.update(schema.aiConversations).set({ context: withoutPending(conv.context) }).where(eq(schema.aiConversations.id, conv.id));
    }
    // explicit timestamps + role tie-breaker: rows written in one transaction would otherwise share now()
    const rows = await ctx.tx.select().from(schema.aiMessages).where(eq(schema.aiMessages.conversationId, conv.id)).orderBy(desc(schema.aiMessages.createdAt), asc(schema.aiMessages.role)).limit(HISTORY_MESSAGES);
    const skill = (input.skill && (SKILLS as readonly string[]).includes(input.skill) ? input.skill : null) as SkillKey | null;
    const sets = resolveToolsets({ who: ctx, message: text, page: input.context?.page?.pathname ?? null, sticky: stickyOf(conv.context), skill });
    const screen = await describeContext(ctx, input.context);
    return { rows: rows.reverse(), sets, screen, cancelledNote, skill };
  });
  // The prompt and the tool list need only the principal, so they are rebuilt outside any transaction when a toolset is enabled.
  const who: Who = { user: p, can: (perm, customerId) => can(p, perm, customerId) };
  const scope = describeScope(who, organisation);
  const promptFor = (s: ToolsetState, t: AiTool[]) => buildSystemPrompt({ ctx: who, tools: t, toolsets: { active: s.active, offered: s.offered }, contextDescription: b.screen, notes: b.cancelledNote ? [b.cancelledNote] : [], customerScopeSummary: scope, organisation, autonomy: settings.autonomy, skill: b.skill });
  let sets = b.sets;
  let tools = availableTools(who, sets.active);
  let built = promptFor(sets, tools);
  let system = { stable: built.stable, volatile: built.volatile };
  let definitions = toolDefinitions(tools);
  let toolMap = new Map<string, AiTool>(tools.map((t) => [t.name, t]));
  emit?.({ type: 'toolsets', active: sets.active });
  const messages = historyMessages(b.rows);
  if (!messages.length || messages[messages.length - 1]!.role !== 'user') messages.push({ role: 'user', content: text });

  // ---- the loop: model calls with no transaction open; each tool call is its own step
  const prov = provider();
  const deadline = started + settings.turnTimeoutSeconds * 1000;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Math.max(1000, deadline - Date.now()));
  const records: ToolCallRecord[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const facts: string[] = [];
  const toolContents: string[] = [];
  const uiActions: UiAction[] = [];
  let proposal: PendingAction | null = null;
  let reply = '';
  let outcome = 'answered';
  let toolCallCount = 0;
  let model = prov.model;
  try {
    for (let i = 0; i <= MAX_TOOL_ITERATIONS; i++) {
      if (Date.now() > deadline) {
        reply = 'I ran out of time for this request. Please narrow it or ask again.';
        outcome = 'timeout';
        break;
      }
      let res;
      try {
        // Deterministic where the model allows it: the same question yields the same tool calls and wording.
        res = await prov.chat({ system, messages, tools: definitions, maxTokens: CHAT_MAX_TOKENS, temperature: 0, effort: settings.effort, signal: abort.signal });
      } catch (err) {
        if (abort.signal.aborted) {
          reply = 'I ran out of time for this request. Please narrow it or ask again.';
          outcome = 'timeout';
          break;
        }
        throw err;
      }
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      usage.cacheReadTokens += res.usage.cacheReadTokens ?? 0;
      if (res.stopReason === 'refusal') {
        reply = res.text.trim() || 'I cannot help with that request.';
        outcome = 'refused';
        break;
      }
      if (!res.toolCalls.length) {
        reply = res.text;
        break;
      }
      if (i === MAX_TOOL_ITERATIONS) {
        reply = res.text || 'I reached the limit of tool calls for one message. Please narrow the request or ask again.';
        outcome = 'tool_limit';
        break;
      }
      messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls, raw: res.raw });
      for (const call of res.toolCalls) {
        if (call.name === 'enable_toolset') {
          // The meta-tool changes the tools offered on the next iteration; it never touches data.
          const key = String((call.input as { toolset?: unknown } | undefined)?.toolset ?? '');
          const valid = (TOOLSET_KEYS as readonly string[]).includes(key) && sets.offered.includes(key as ToolsetKey);
          if (valid) {
            sets = enableToolset(sets, key as ToolsetKey);
            tools = availableTools(who, sets.active);
            built = promptFor(sets, tools);
            system = { stable: built.stable, volatile: built.volatile };
            definitions = toolDefinitions(tools);
            toolMap = new Map(tools.map((t) => [t.name, t]));
            emit?.({ type: 'toolsets', active: sets.active });
          }
          records.push({ name: 'enable_toolset', input: { toolset: key }, action: false, ok: valid, summary: valid ? `Enabled the ${TOOLSETS[key as ToolsetKey].label} tools` : `Unknown tool group "${key.slice(0, 40)}"`, ...(valid ? {} : { error: 'unknown_toolset' }) });
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(valid ? { enabled: key, tools: tools.filter((t) => t.toolset === key).map((t) => t.name) } : { error: 'unknown_toolset', message: `No tool group "${key.slice(0, 40)}" is available to this user`, available: sets.offered }), isError: !valid });
          continue;
        }
        const tool = toolMap.get(call.name) ?? toolByName(call.name);
        if (proposal && tool?.action) {
          // One side effect at a time: a second action in the same turn waits for the first to be confirmed.
          const content = JSON.stringify({ error: 'one_action_at_a_time', message: `"${proposal.preview}" is waiting for the user's confirmation; ask for that first.` });
          records.push({ name: call.name, input: compactForTrace(call.input ?? {}), action: true, ok: false, summary: `${call.name} deferred until the pending action is confirmed`, error: 'one_action_at_a_time' });
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content, isError: true });
          continue;
        }
        const auto = !!tool && tool.action && tierOf(tool) === 'write_low' && settings.autonomy === 'auto_low';
        emit?.({ type: 'step', status: 'start', tool: call.name, summary: tool ? tool.description.split('.')[0]!.slice(0, 80) : call.name, action: !!tool?.action });
        const index = toolCallCount++;
        const r = await aiStep(p, meta, (ctx) => executeToolCall(ctx, call, index, org, { confirmed: auto, auto, conversationId: conv.id }), { aiConversationId: conv.id });
        emit?.({ type: 'step', status: r.isError ? 'error' : 'done', tool: call.name, summary: r.record.summary, action: !!tool?.action });
        records.push(r.record);
        if (r.proposal) proposal = r.proposal;
        if (!r.isError) {
          facts.push(...factsOf(r.content));
          toolContents.push(r.content);
          const ui = uiActionOf(r.content);
          if (ui) uiActions.push(ui);
        }
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: r.content, isError: r.isError });
      }
    }
  } catch (err) {
    // The model failed: nothing to show, so the turn is undone (the question is not stored without an answer).
    await aiStep(p, meta, (ctx) => ctx.tx.delete(schema.aiMessages).where(eq(schema.aiMessages.id, a.userMessageId))).catch(() => undefined);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!reply.trim()) reply = records.length ? 'Done. ' + records.map((r) => r.summary).join('; ') : 'I could not produce an answer. Please rephrase the question.';
  reply = stripMarkers(reply);
  // The system's figures come first whenever the reply does not state them itself.
  const grounded = groundAnswer(reply, facts);
  if (grounded.prepended) logger.info({ userId: p.id, requestId: meta.requestId, facts: facts.length }, 'ai answer did not state the computed figure; facts prepended');
  reply = grounded.text;
  // An answer may only link to records this conversation has shown; customer users may only name tickets it has shown.
  const seen = collectSeen([...b.rows.map((m) => m.content), ...toolContents]);
  const fenced = fenceAnswer(reply, seen, { numbers: !!org });
  if (fenced.removed > 0) {
    logger.warn({ removed: fenced.removed, userId: p.id, customerId: org?.customerId ?? null, requestId: meta.requestId }, 'ai answer fence removed references the user was never shown');
    reply = fenced.text;
  }

  // ---- step D: the reply, the conversation state and the audit trail
  return aiStep(p, meta, async (ctx) => {
    if (fenced.removed > 0) await ctx.audit({ entityType: 'ai_answer', entityId: conv.id, entityLabel: 'chat', action: 'ai.answer_fence', customerId: org?.customerId ?? null, metadata: { removed: fenced.removed } });
    const durationMs = Date.now() - started;
    const [assistant] = await ctx.tx
      .insert(schema.aiMessages)
      .values({ conversationId: conv.id, customerId: conv.customerId, role: 'assistant', content: reply, toolCalls: records as unknown as Record<string, unknown>[], inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, durationMs, model, promptVersion: PROMPT_VERSION, createdAt: new Date(Math.max(Date.now(), started + 1)) })
      .returning();
    const nextContext: Record<string, unknown> = { ...(input.context ? (input.context as Record<string, unknown>) : withoutPending(conv.context)), toolsets: sets.active.filter((k) => !BASE_SETS.includes(k)), ...(proposal ? { pendingAction: proposal } : {}) };
    await ctx.tx.update(schema.aiConversations).set({ updatedAt: new Date(), context: nextContext }).where(eq(schema.aiConversations.id, conv.id));
    await ctx.audit({
      entityType: 'ai_conversation',
      entityId: conv.id,
      entityLabel: 'chat',
      action: 'ai.chat',
      customerId: conv.customerId,
      metadata: { messageId: assistant!.id, outcome, tools: records.map((r) => r.name), toolCalls: records.length, proposed: proposal?.id ?? null, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, durationMs, model, promptVersion: PROMPT_VERSION, fenced: fenced.removed, grounded: grounded.prepended, uiActions: uiActions.length, toolsets: sets.active, skill: b.skill },
    });
    return { conversationId: conv.id, message: publicMessage(assistant!), usage, pendingAction: publicPending(proposal), uiActions };
  });
}

/** UI tools return `{ uiAction: { type: 'navigate', to } }`; nothing else is executed by the web. */
function uiActionOf(content: string): UiAction | null {
  try {
    const v = JSON.parse(content) as { uiAction?: { type?: string; to?: string; label?: string } };
    const u = v?.uiAction;
    if (u && u.type === 'navigate' && typeof u.to === 'string' && u.to.startsWith('/')) return { type: 'navigate', to: u.to, ...(u.label ? { label: u.label } : {}) };
  } catch {
    /* not an object */
  }
  return null;
}

// ---------------------------------------------------------------- structured LLM helper (shared by suggestions)

/** Extracts the first JSON object from model text (tolerates fences and surrounding prose). */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * One-shot structured call: system prompt + user content → parsed JSON.
 * Returns null when the provider is disabled or the response is unusable, so
 * callers fall back to deterministic logic. Never holds a database connection:
 * callers gather before and store after.
 */
export async function llmJson<T>(system: string, user: string, validate: (v: unknown) => T, opts: { maxTokens?: number } = {}): Promise<{ data: T; usage: { inputTokens: number; outputTokens: number } } | null> {
  if (!enabled()) return null;
  try {
    const res = await provider().chat({ system, messages: [{ role: 'user', content: user.length > 24_000 ? `${user.slice(0, 24_000)}…` : user }], maxTokens: opts.maxTokens ?? 1200, temperature: 0.1, effort: 'low' });
    return { data: validate(extractJson(res.text)), usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens } };
  } catch {
    return null;
  }
}

export type { AiSettings };
