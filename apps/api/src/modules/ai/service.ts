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
}

const own = (ctx: Ctx, id: string) => and(eq(schema.aiConversations.id, id), eq(schema.aiConversations.userId, ctx.user.id));

export async function listConversations(ctx: Ctx, limit = 20) {
  const rows = await ctx.tx
    .select({ id: schema.aiConversations.id, title: schema.aiConversations.title, context: schema.aiConversations.context, createdAt: schema.aiConversations.createdAt, updatedAt: schema.aiConversations.updatedAt, messageCount: sql<number>`(select count(*)::int from ai_messages m where m.conversation_id = ai_conversations.id)` })
    .from(schema.aiConversations)
    .where(eq(schema.aiConversations.userId, ctx.user.id))
    .orderBy(desc(schema.aiConversations.updatedAt))
    .limit(limit);
  return { items: rows };
}

export async function getConversation(ctx: Ctx, id: string) {
  const [c] = await ctx.tx.select().from(schema.aiConversations).where(own(ctx, id)).limit(1);
  if (!c) throw new NotFoundError('Conversation');
  const messages = await ctx.tx.select().from(schema.aiMessages).where(eq(schema.aiMessages.conversationId, c.id)).orderBy(asc(schema.aiMessages.createdAt), desc(schema.aiMessages.role));
  return { id: c.id, title: c.title, context: c.context, createdAt: c.createdAt, updatedAt: c.updatedAt, messages: messages.map(publicMessage) };
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
export async function executeToolCall(ctx: Ctx, call: ToolCall, index: number): Promise<{ record: ToolCallRecord; content: string; isError: boolean }> {
  const tool = toolByName(call.name);
  const base = { name: call.name, input: stripSecrets(call.input ?? {}), action: tool?.action ?? false };
  if (!tool) return { record: { ...base, ok: false, summary: `Unknown tool ${call.name}`, error: 'unknown_tool' }, content: JSON.stringify({ error: `Unknown tool "${call.name}"` }), isError: true };
  if (!toolAvailable(ctx, tool)) return { record: { ...base, ok: false, summary: `${tool.name} not permitted`, error: 'forbidden' }, content: JSON.stringify({ error: 'forbidden', message: tool.action && !ctx.can('ai:act') ? 'The user has not enabled AI actions (ai:act).' : 'The user does not have permission for this tool.' }), isError: true };
  const parsed = tool.inputSchema.safeParse(call.input ?? {});
  if (!parsed.success) return { record: { ...base, ok: false, summary: `${tool.name}: invalid input`, error: 'validation_error' }, content: JSON.stringify({ error: 'invalid_input', issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })) }), isError: true };
  const sp = `ai_tool_${index}`;
  await ctx.tx.execute(sql.raw(`SAVEPOINT ${sp}`));
  try {
    const result = await tool.run(aiCtx(ctx), parsed.data);
    await ctx.tx.execute(sql.raw(`RELEASE SAVEPOINT ${sp}`));
    let summary: string;
    try {
      summary = tool.summary(parsed.data, result);
    } catch {
      summary = `Ran ${tool.name}`;
    }
    return { record: { ...base, input: stripSecrets(parsed.data as Record<string, unknown>), ok: true, summary }, content: truncateResult(result), isError: false };
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

  // conversation
  let conv: typeof schema.aiConversations.$inferSelect | undefined;
  if (input.conversationId) {
    [conv] = await ctx.tx.select().from(schema.aiConversations).where(own(ctx, input.conversationId)).limit(1);
    if (!conv) throw new NotFoundError('Conversation');
  } else {
    [conv] = await ctx.tx.insert(schema.aiConversations).values({ userId: ctx.user.id, customerId: isCustomerUser(ctx) ? ctx.user.customerId : null, title: input.message.replace(/\s+/g, ' ').trim().slice(0, 60), context: (input.context ?? {}) as Record<string, unknown> }).returning();
  }
  await ctx.tx.insert(schema.aiMessages).values({ conversationId: conv!.id, customerId: conv!.customerId, role: 'user', content: input.message, createdAt: new Date() });

  // history (last N messages including the one just stored)
  // explicit timestamps + role tie-breaker: rows written in one transaction would otherwise share now()
  const rows = await ctx.tx.select().from(schema.aiMessages).where(eq(schema.aiMessages.conversationId, conv!.id)).orderBy(desc(schema.aiMessages.createdAt), asc(schema.aiMessages.role)).limit(HISTORY_MESSAGES);
  const messages = historyMessages(rows.reverse());
  if (!messages.length || messages[messages.length - 1]!.role !== 'user') messages.push({ role: 'user', content: input.message });

  const tools = availableTools(ctx);
  const system = buildSystemPrompt({ ctx, tools, contextDescription: await describeContext(ctx, input.context), customerScopeSummary: describeScope(ctx) });
  const definitions = toolDefinitions(tools);

  const started = Date.now();
  const records: ToolCallRecord[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let text = '';
  let toolCallCount = 0;
  for (let i = 0; i <= MAX_TOOL_ITERATIONS; i++) {
    const res = await p.chat({ system, messages, tools: definitions, maxTokens: 1500 });
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
      const r = await executeToolCall(ctx, call, toolCallCount++);
      records.push(r.record);
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: r.content, isError: r.isError });
    }
  }
  if (!text.trim()) text = records.length ? 'Done. ' + records.map((r) => r.summary).join('; ') : 'I could not produce an answer. Please rephrase the question.';

  const [assistant] = await ctx.tx
    .insert(schema.aiMessages)
    .values({ conversationId: conv!.id, customerId: conv!.customerId, role: 'assistant', content: text, toolCalls: records as unknown as Record<string, unknown>[], inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, createdAt: new Date(Math.max(Date.now(), started + 1)) })
    .returning();
  await ctx.tx.update(schema.aiConversations).set({ updatedAt: new Date(), ...(input.context ? { context: input.context as Record<string, unknown> } : {}) }).where(eq(schema.aiConversations.id, conv!.id));
  return { conversationId: conv!.id, message: publicMessage(assistant!), usage };
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
