import { randomUUID } from 'node:crypto';
import { eq, and, desc, asc, sql } from 'drizzle-orm';
import { schema } from '@/db/client';
import { buildCtx, type Ctx } from '@/core/context';
import { AppError, NotFoundError, ForbiddenError } from '@/core/errors';
import { aiProvider, aiEnabled, AiUpstreamError, type AiProvider, type ChatMessage, type ToolCall } from '@/lib/ai';
import { getSetting } from '@/modules/config/service';
import { loadTicket } from '@/modules/tickets/common';
import { listTickets } from '@/modules/tickets/list';
import { availableTools, toolDefinitions, toolByName, toolAvailable, stripSecrets, isCustomerUser, listQuery } from './tools';
import { buildSystemPrompt, describeScope } from './prompts';
import { fenceToolResult, fenceAnswer, collectSeen, type TenantFence } from './fence';
import { factsOf, groundAnswer } from './ground';
import { logger } from '@/core/logger';
import type { ChatContext } from './schemas';

/** Hard limits that keep a conversation turn bounded. */
export const MAX_TOOL_ITERATIONS = 8;
export const MAX_TOOL_RESULT_CHARS = 6000;
export const HISTORY_MESSAGES = 20;
const MAX_HISTORY_CHARS = 4000;

// ---------------------------------------------------------------- provider (injectable for tests)

let override: AiProvider | null = null;
/** Test hook: inject a fake provider (pass null to restore the configured one). */
export const setProviderForTests = (p: AiProvider | null) => {
  override = p;
};
export const provider = (): AiProvider => override ?? aiProvider();
export const enabled = () => (override ? override.name !== 'none' : aiEnabled());

export class AiDisabledError extends AppError {
  constructor() {
    super(503, 'The AI assistant is not configured (set AI_PROVIDER and credentials)', 'ai_disabled');
  }
}

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
  const features = await getSetting<string[]>(ctx, 'ai.enabled_features', ['assistant', 'summarize', 'classify', 'similar', 'suggest_kb']);
  const tools = availableTools(ctx);
  return {
    enabled: enabled() && ctx.can('ai:use'),
    provider: p.name,
    model: p.model || null,
    configured: { provider: p.name, model: p.model || null, baseUrl: p.baseUrl ?? null },
    features: Array.isArray(features) ? features : [],
    canAct: ctx.can('ai:act'),
    tools: tools.map((t) => ({ name: t.name, action: t.action })),
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

export async function test(ctx: Ctx): Promise<AiTestResult> {
  if (!ctx.can('admin:system') && !ctx.can('admin:config')) throw new ForbiddenError();
  const p = provider();
  const base = { provider: p.name, model: p.model || null, baseUrl: p.baseUrl ?? null };
  if (!enabled()) return { ok: false, ...base, latencyMs: 0, error: { status: 503, code: 'ai_disabled', message: 'The AI assistant is not configured: set AI_PROVIDER and the provider credentials, then restart the app.' } };
  const started = Date.now();
  try {
    const res = await p.chat({ system: 'You are a connectivity check. Reply with the single word OK.', messages: [{ role: 'user', content: 'ping' }], maxTokens: 16 });
    return { ok: true, ...base, latencyMs: Date.now() - started, reply: res.text.trim().slice(0, 200), usage: res.usage };
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
}

/**
 * Propose-then-commit. An action tool never runs on the turn the model calls it:
 * the call is stored on the conversation as a pending action with a resolved
 * preview, the model asks the user to confirm, and the next turn either commits
 * it (an explicit yes), drops it (a no), or drops it and carries on (anything
 * else). One pending action at a time, executed at most once, and it expires.
 */
export interface PendingAction {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  preview: string;
  createdAt: string;
}
export const PENDING_ACTION_TTL_MS = 30 * 60_000;
/** A whole message that only says yes. "Yes, proceed." / "ok" / "go ahead" / "confirm". */
export const CONFIRM_RE = /^\s*(?:yes|y|yep|yeah|yup|ok|okay|sure|go ahead|proceed|do it|confirm|confirmed|please do|please proceed|yes[,.!\s]+(?:please|proceed|go ahead|do it|confirm|do that)[\s\S]{0,24})\s*[.!]*\s*$/i;
/** A message that starts with a refusal. "No" / "No, do not do that." / "cancel". */
export const CANCEL_RE = /^\s*(?:no|nope|cancel|stop|abort|don'?t|do not|never ?mind|not now)\b/i;

export function readPending(context: Record<string, unknown> | null | undefined): PendingAction | null {
  const p = (context ?? {}).pendingAction as Partial<PendingAction> | undefined;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.tool !== 'string' || typeof p.preview !== 'string' || typeof p.createdAt !== 'string') return null;
  if (Date.now() - new Date(p.createdAt).getTime() > PENDING_ACTION_TTL_MS) return null;
  return { id: p.id, tool: p.tool, input: (p.input ?? {}) as Record<string, unknown>, preview: p.preview, createdAt: p.createdAt };
}
const publicPending = (p: PendingAction | null) => (p ? { id: p.id, tool: p.tool, preview: p.preview } : null);
const withoutPending = (context: Record<string, unknown> | null | undefined) => {
  const { pendingAction: _p, ...rest } = context ?? {};
  return rest;
};

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
  return { items: rows };
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

type MessageRow = typeof schema.aiMessages.$inferSelect;
const publicMessage = (m: MessageRow) => ({ id: m.id, role: m.role as 'user' | 'assistant', content: m.content, toolCalls: (m.toolCalls ?? []) as unknown as ToolCallRecord[], inputTokens: m.inputTokens, outputTokens: m.outputTokens, createdAt: m.createdAt });

// ---------------------------------------------------------------- context description

/** Resolves the UI context into one line for the prompt, through the service layer (so nothing leaks). */
export async function describeContext(ctx: Ctx, c: ChatContext | null | undefined): Promise<string | null> {
  if (!c?.entityType || !c.entityId) return c?.label ? `User is viewing: ${c.label}` : null;
  try {
    switch (c.entityType) {
      case 'ticket': {
        const t = await loadTicket(ctx, c.entityId);
        const [cust] = await ctx.tx.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, t.customerId)).limit(1);
        return `User is viewing ticket ${t.number} ("${t.title.slice(0, 120)}", ${t.type}) for customer ${cust?.name ?? 'unknown'}. Use get_ticket with "${t.number}" for details.`;
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
        return `User is viewing knowledge article ${c.label ?? ''}${c.title ? ` "${String(c.title).slice(0, 120)}"` : ''}.`;
      default:
        return c.label ? `User is viewing ${c.entityType} "${c.label}".` : null;
    }
  } catch {
    return c.label ? `User is viewing: ${c.label}` : null;
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

/**
 * Validates and executes one tool call under a savepoint, so a failing tool
 * (permission denied, validation error, RLS violation) never aborts the
 * surrounding request transaction.
 */
export async function executeToolCall(ctx: Ctx, call: ToolCall, index: number, fence?: TenantFence | null, opts: { confirmed?: boolean } = {}): Promise<{ record: ToolCallRecord; content: string; isError: boolean; proposal?: PendingAction }> {
  const tool = toolByName(call.name);
  const base = { name: call.name, input: stripSecrets(call.input ?? {}), action: tool?.action ?? false };
  if (!tool) return { record: { ...base, ok: false, summary: `Unknown tool ${call.name}`, error: 'unknown_tool' }, content: JSON.stringify({ error: `Unknown tool "${call.name}"` }), isError: true };
  if (!toolAvailable(ctx, tool)) return { record: { ...base, ok: false, summary: `${tool.name} not permitted`, error: 'forbidden' }, content: JSON.stringify({ error: 'forbidden', message: tool.action && !ctx.can('ai:act') ? 'The user has not enabled AI actions (ai:act).' : 'The user does not have permission for this tool.' }), isError: true };
  const parsed = tool.inputSchema.safeParse(call.input ?? {});
  if (!parsed.success) return { record: { ...base, ok: false, summary: `${tool.name}: invalid input`, error: 'validation_error' }, content: JSON.stringify({ error: 'invalid_input', issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })) }), isError: true };
  const sp = `ai_tool_${index}`;
  await ctx.tx.execute(sql.raw(`SAVEPOINT ${sp}`));
  try {
    if (tool.action && !opts.confirmed) {
      // Propose only: resolve the preview against real records, run nothing.
      const preview = tool.preview ? await tool.preview(aiCtx(ctx), parsed.data) : `Run ${tool.name} with ${JSON.stringify(stripSecrets(parsed.data as Record<string, unknown>))}`;
      await ctx.tx.execute(sql.raw(`RELEASE SAVEPOINT ${sp}`));
      const proposal: PendingAction = { id: randomUUID(), tool: tool.name, input: parsed.data as Record<string, unknown>, preview, createdAt: new Date().toISOString() };
      return {
        record: { ...base, input: stripSecrets(parsed.data as Record<string, unknown>), ok: true, summary: `Proposed: ${preview}`, proposed: true },
        content: JSON.stringify({ status: 'awaiting_confirmation', preview, instruction: 'Nothing has been done yet. Repeat this preview to the user in one sentence and end with "Shall I proceed?". The platform runs it only when they confirm; do not call this tool again for the same request.' }),
        isError: false,
        proposal,
      };
    }
    const raw = await tool.run(aiCtx(ctx), parsed.data);
    await ctx.tx.execute(sql.raw(`RELEASE SAVEPOINT ${sp}`));
    // Customer users: nothing that names another organisation reaches the model, whatever the tool returned.
    const guard = fence === undefined ? await organisationOf(ctx) : fence;
    const fenced = guard ? fenceToolResult(raw, guard) : { value: raw, dropped: 0 };
    const result = fenced.value;
    if (fenced.dropped > 0) {
      logger.warn({ tool: tool.name, dropped: fenced.dropped, userId: ctx.user.id, customerId: guard?.customerId, requestId: ctx.requestId }, 'ai tenant fence removed records of another organisation');
      await ctx.audit({ entityType: 'ai_tool', entityId: ctx.user.id, entityLabel: tool.name, action: 'ai.tenant_fence', customerId: guard?.customerId ?? null, metadata: { tool: tool.name, dropped: fenced.dropped } });
    }
    let summary: string;
    try {
      summary = tool.summary(parsed.data, result);
    } catch {
      summary = `Ran ${tool.name}`;
    }
    return { record: { ...base, input: stripSecrets(parsed.data as Record<string, unknown>), ok: true, summary, ...(fenced.dropped ? { fenced: fenced.dropped } : {}) }, content: truncateResult(result), isError: false };
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
    return { record: { ...base, ok: false, summary: `${tool.name} failed: ${message.slice(0, 160)}`, error: code }, content: JSON.stringify({ error: code, message }), isError: true };
  }
}

// ---------------------------------------------------------------- chat

export interface ChatInput {
  conversationId?: string | null;
  message: string;
  context?: ChatContext | null;
}

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

export async function chat(ctx: Ctx, input: ChatInput) {
  ctx.require('ai:use');
  if (!enabled()) throw new AiDisabledError();
  const p = provider();
  // Customer users are bound to exactly one organisation for the whole turn: prompt, tools and stored conversation.
  const org = await organisationOf(ctx);

  // conversation
  let conv: typeof schema.aiConversations.$inferSelect | undefined;
  if (input.conversationId) {
    [conv] = await ctx.tx.select().from(schema.aiConversations).where(own(ctx, input.conversationId)).limit(1);
    if (!conv) throw new NotFoundError('Conversation');
  } else {
    [conv] = await ctx.tx.insert(schema.aiConversations).values({ userId: ctx.user.id, customerId: isCustomerUser(ctx) ? ctx.user.customerId : null, title: input.message.replace(/\s+/g, ' ').trim().slice(0, 60), context: (input.context ?? {}) as Record<string, unknown> }).returning();
  }
  await ctx.tx.insert(schema.aiMessages).values({ conversationId: conv!.id, customerId: conv!.customerId, role: 'user', content: input.message, createdAt: new Date() });

  // A pending action is decided by this message before the model sees anything: commit, cancel, or drop and carry on.
  const pending = readPending(conv!.context);
  let cancelledNote: string | null = null;
  if (pending) {
    const finish = async (text: string, records: ToolCallRecord[]) => {
      const [assistant] = await ctx.tx
        .insert(schema.aiMessages)
        .values({ conversationId: conv!.id, customerId: conv!.customerId, role: 'assistant', content: text, toolCalls: records as unknown as Record<string, unknown>[], inputTokens: 0, outputTokens: 0, createdAt: new Date(Date.now() + 1) })
        .returning();
      await ctx.tx.update(schema.aiConversations).set({ updatedAt: new Date(), context: withoutPending(conv!.context) }).where(eq(schema.aiConversations.id, conv!.id));
      return { conversationId: conv!.id, message: publicMessage(assistant!), usage: { inputTokens: 0, outputTokens: 0 }, pendingAction: null };
    };
    if (CONFIRM_RE.test(input.message)) {
      const r = await executeToolCall(ctx, { id: pending.id, name: pending.tool, input: pending.input }, 0, org, { confirmed: true });
      let link: string | undefined;
      try {
        link = (JSON.parse(r.content) as { link?: string }).link;
      } catch {
        /* no link */
      }
      const failure = r.isError ? ((): string => { try { return (JSON.parse(r.content) as { message?: string }).message ?? 'it failed'; } catch { return 'it failed'; } })() : null;
      return finish(r.isError ? `I could not do that: ${failure}` : `Done: ${r.record.summary}${link ? ` ([open](${link}))` : ''}.`, [r.record]);
    }
    if (CANCEL_RE.test(input.message)) return finish('OK, I have not done that.', []);
    cancelledNote = `The earlier proposal "${pending.preview}" was not confirmed and is now cancelled. If the user is adjusting it, propose again with the new details.`;
    await ctx.tx.update(schema.aiConversations).set({ context: withoutPending(conv!.context) }).where(eq(schema.aiConversations.id, conv!.id));
  }

  // history (last N messages including the one just stored)
  // explicit timestamps + role tie-breaker: rows written in one transaction would otherwise share now()
  const rows = await ctx.tx.select().from(schema.aiMessages).where(eq(schema.aiMessages.conversationId, conv!.id)).orderBy(desc(schema.aiMessages.createdAt), asc(schema.aiMessages.role)).limit(HISTORY_MESSAGES);
  const messages = historyMessages(rows.reverse());
  if (!messages.length || messages[messages.length - 1]!.role !== 'user') messages.push({ role: 'user', content: input.message });

  const tools = availableTools(ctx);
  const organisation = org ? { name: org.customerName, code: org.customerCode } : null;
  const screen = await describeContext(ctx, input.context);
  const system = buildSystemPrompt({ ctx, tools, contextDescription: [screen, cancelledNote].filter(Boolean).join('\n') || null, customerScopeSummary: describeScope(ctx, organisation), organisation });
  const definitions = toolDefinitions(tools);

  const started = Date.now();
  const records: ToolCallRecord[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const facts: string[] = [];
  let proposal: PendingAction | null = null;
  let text = '';
  let toolCallCount = 0;
  for (let i = 0; i <= MAX_TOOL_ITERATIONS; i++) {
    // Temperature 0: the same question yields the same tool calls and the same wording.
    const res = await p.chat({ system, messages, tools: definitions, maxTokens: 1500, temperature: 0 });
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    if (!res.toolCalls.length) {
      text = res.text;
      break;
    }
    if (i === MAX_TOOL_ITERATIONS) {
      text = res.text || 'I reached the limit of tool calls for one message. Please narrow the request or ask again.';
      break;
    }
    messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
    for (const call of res.toolCalls) {
      if (proposal && toolByName(call.name)?.action) {
        // One side effect at a time: a second action in the same turn waits for the first to be confirmed.
        const content = JSON.stringify({ error: 'one_action_at_a_time', message: `"${proposal.preview}" is waiting for the user's confirmation; ask for that first.` });
        records.push({ name: call.name, input: stripSecrets(call.input ?? {}), action: true, ok: false, summary: `${call.name} deferred until the pending action is confirmed`, error: 'one_action_at_a_time' });
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content, isError: true });
        continue;
      }
      const r = await executeToolCall(ctx, call, toolCallCount++, org);
      records.push(r.record);
      if (r.proposal) proposal = r.proposal;
      if (!r.isError) facts.push(...factsOf(r.content));
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: r.content, isError: r.isError });
    }
  }
  if (!text.trim()) text = records.length ? 'Done. ' + records.map((r) => r.summary).join('; ') : 'I could not produce an answer. Please rephrase the question.';
  // The system's figures come first whenever the reply does not state them itself.
  const grounded = groundAnswer(text, facts);
  if (grounded.prepended) logger.info({ userId: ctx.user.id, requestId: ctx.requestId, facts: facts.length }, 'ai answer did not state the computed figure; facts prepended');
  text = grounded.text;
  if (org) {
    // Customer users: the answer may only cite what this conversation has shown them (earlier messages, this turn's tool results).
    const seen = collectSeen([...rows.map((m) => m.content), ...messages.filter((m) => m.role === 'tool').map((m) => (m as { content: string }).content)]);
    const fenced = fenceAnswer(text, seen);
    if (fenced.removed > 0) {
      logger.warn({ removed: fenced.removed, userId: ctx.user.id, customerId: org.customerId, requestId: ctx.requestId }, 'ai answer fence removed references the user was never shown');
      await ctx.audit({ entityType: 'ai_answer', entityId: conv!.id, entityLabel: 'chat', action: 'ai.answer_fence', customerId: org.customerId, metadata: { removed: fenced.removed } });
      text = fenced.text;
    }
  }

  const [assistant] = await ctx.tx
    .insert(schema.aiMessages)
    .values({ conversationId: conv!.id, customerId: conv!.customerId, role: 'assistant', content: text, toolCalls: records as unknown as Record<string, unknown>[], inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, createdAt: new Date(Math.max(Date.now(), started + 1)) })
    .returning();
  const nextContext: Record<string, unknown> = { ...(input.context ? (input.context as Record<string, unknown>) : withoutPending(conv!.context)), ...(proposal ? { pendingAction: proposal } : {}) };
  await ctx.tx.update(schema.aiConversations).set({ updatedAt: new Date(), context: nextContext }).where(eq(schema.aiConversations.id, conv!.id));
  return { conversationId: conv!.id, message: publicMessage(assistant!), usage, pendingAction: publicPending(proposal) };
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
 * callers fall back to deterministic logic.
 */
export async function llmJson<T>(system: string, user: string, validate: (v: unknown) => T, opts: { maxTokens?: number } = {}): Promise<{ data: T; usage: { inputTokens: number; outputTokens: number } } | null> {
  if (!enabled()) return null;
  try {
    const res = await provider().chat({ system, messages: [{ role: 'user', content: user.length > 24_000 ? `${user.slice(0, 24_000)}…` : user }], maxTokens: opts.maxTokens ?? 1200, temperature: 0.1 });
    return { data: validate(extractJson(res.text)), usage: res.usage };
  } catch {
    return null;
  }
}
