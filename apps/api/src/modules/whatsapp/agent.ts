import { and, desc, eq, gt, gte, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { schema, withSystem } from '@/db/client';
import { config } from '@/config';
import { logger } from '@/core/logger';
import { AppError, ForbiddenError, TooManyRequestsError } from '@/core/errors';
import { invalidatePrincipal, loadPrincipal, type Principal } from '@/core/principal';
import { can } from '@/core/authz';
import { enqueue } from '@/jobs/queues';
import { PermanentChannelError, sendWhatsAppText, markWhatsAppRead, type WhatsAppConfig } from '@/lib/channels';
import { systemCtx } from '@/modules/tickets/common';
import { loadWhatsAppSettings, whatsappClientConfig, type WhatsAppSettings } from '@/modules/notifications/channels';
import { actorOf, maskPhone } from '@/modules/notifications/phone';
import { loadAiSettings, featureEnabled, AiDisabledError, type AiSettings } from '@/modules/ai/guards';
import { chatTurn, aiStep, enabled as aiEnabled, type ChatResult, type TurnMeta } from '@/modules/ai/service';
import { CHAT_RATE_LIMIT_PER_MINUTE } from '@/modules/ai/admin';
import { audienceAllowed, loadAssistantSettings, type AssistantSettings } from './schemas';
import { assistantFlagOf, completeTypedLink, writeAssistantFlag } from './link';
import { renderWhatsAppReply, PART_MAX_CHARS, MAX_PARTS } from './render';
import { WHATSAPP_CHAT_JOB, whatsappJobId } from './inbound';

/**
 * The job behind one inbound WhatsApp message: claim the row, identify the
 * verified person, apply the gates, run the same assistant turn as the web
 * under that person's own principal (every tool, fence, confirmation and audit
 * entry included), render the reply as WhatsApp text, send it and record it.
 * Each database step is its own short transaction; the model and Meta are
 * called with none open. Nothing is sent before identity and the gates pass,
 * and every notice to a number is sent at most once an hour.
 */

export { PART_MAX_CHARS, MAX_PARTS };
export const CHAT_OFF_REPLY = 'Chat with Grady is switched off for this number. Turn it on under Profile & preferences → WhatsApp chat with Grady, or text START here.';
export const NOTICE_EVERY_MS = 3_600_000;
/** A sibling claimed longer ago than this no longer holds newer messages from the same phone back. */
export const CLAIM_STALE_MS = 90_000;
export const WINDOW_MS = 24 * 3_600_000;
export const MAX_REQUEUES = 20;
export const REQUEUE_DELAY_MS = 5_000;
export const REPLY_RETRY_MS = 2_000;
/** A claim older than the turn timeout plus this margin belongs to a worker that died mid-turn: the next run of the job takes the row over. */
export const RECLAIM_MARGIN_MS = 60_000;
/** The sweep: a message still waiting after this long gets its job again; a claim older than the abandon limit is recorded as failed. */
export const SWEEP_RECEIVED_AFTER_MS = 120_000;
export const SWEEP_ABANDON_AFTER_MS = 3_600_000;
/** Outcomes of a turn that ran the model (the reply may or may not have reached the phone); the cap and the burst limit count these. */
const TURN_OUTCOMES = ['replied', 'failed'];
const PLATFORM = 'Progression';
const STOP_RE = /^\s*stop\s*[.!]*\s*$/i;
const START_RE = /^\s*start\s*[.!]*\s*$/i;
const CODE_RE = /^\s*\d{6}\s*$/;
const GENERIC_FAILURE = 'Something went wrong; please try again in a minute.';

type InboundRow = typeof schema.whatsappInbound.$inferSelect;
type VerifiedUser = { id: string; email: string; name: string; userType: 'msp' | 'customer'; customerId: string | null; preferences: Record<string, unknown> };
export interface HandleResult {
  outcome: string;
  replied: boolean;
  parts: number;
}

/** `{{name}}` and `{{platform}}` in the administrator's texts; plain replacement, no HTML escaping (WhatsApp is plain text). */
export const fill = (template: string, data: Record<string, string>) => template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => data[k] ?? m);
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const greetingFor = (assistant: AssistantSettings, name: string) => fill(assistant.greeting, { name: firstName(name), platform: PLATFORM });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the row

/**
 * Takes the row for this run: a message still waiting, or one a run that died
 * mid-turn left in processing for longer than `reclaimAfterMs` (the turn
 * timeout plus a margin, so a live run is never taken over). Without
 * `reclaimAfterMs` only a waiting row is taken.
 */
async function claim(inboundId: string, reclaimAfterMs?: number): Promise<InboundRow | null> {
  if (!inboundId) return null;
  const now = new Date();
  const waiting = eq(schema.whatsappInbound.status, 'received');
  const abandoned = reclaimAfterMs === undefined ? undefined : and(eq(schema.whatsappInbound.status, 'processing'), lt(schema.whatsappInbound.claimedAt, new Date(now.getTime() - reclaimAfterMs)));
  const [row] = await withSystem((tx) =>
    tx
      .update(schema.whatsappInbound)
      .set({ status: 'processing', claimedAt: now })
      .where(and(eq(schema.whatsappInbound.id, inboundId), abandoned ? or(waiting, abandoned) : waiting))
      .returning(),
  );
  return row ?? null;
}

/** The claim failed because a run of this job still holds the row (a stalled re-run arriving before its claim is old enough): how long until it may be taken over, or null when the row is simply done. */
async function heldFor(inboundId: string, reclaimAfterMs: number): Promise<{ delay: number; providerMessageId: string } | null> {
  if (!inboundId) return null;
  const [row] = await withSystem((tx) =>
    tx.select({ status: schema.whatsappInbound.status, claimedAt: schema.whatsappInbound.claimedAt, providerMessageId: schema.whatsappInbound.providerMessageId }).from(schema.whatsappInbound).where(eq(schema.whatsappInbound.id, inboundId)).limit(1),
  );
  if (!row || row.status !== 'processing' || !row.claimedAt) return null;
  return { delay: Math.max(1000, row.claimedAt.getTime() + reclaimAfterMs - Date.now() + 1000), providerMessageId: row.providerMessageId };
}

/**
 * An older message from the same phone is being answered right now (claimed
 * less than CLAIM_STALE_MS ago). Only older siblings count, so of two messages
 * picked up together the oldest always proceeds and the newer one waits:
 * one turn per phone, in order, without the two holding each other back.
 */
async function siblingProcessing(row: InboundRow): Promise<boolean> {
  const since = new Date(Date.now() - CLAIM_STALE_MS);
  const rows = await withSystem((tx) =>
    tx
      .select({ id: schema.whatsappInbound.id })
      .from(schema.whatsappInbound)
      .where(
        and(
          eq(schema.whatsappInbound.phone, row.phone),
          eq(schema.whatsappInbound.status, 'processing'),
          sql`${schema.whatsappInbound.id} <> ${row.id}`,
          gt(schema.whatsappInbound.claimedAt, since),
          sql`(${schema.whatsappInbound.receivedAt}, ${schema.whatsappInbound.createdAt}, ${schema.whatsappInbound.id}) < (${row.receivedAt.toISOString()}::timestamptz, ${row.createdAt.toISOString()}::timestamptz, ${row.id}::uuid)`,
        ),
      )
      .limit(1),
  );
  return rows.length > 0;
}

/** Asks for the job again after `delay` (numbered, so the queue never sees the same id twice); false once the requeues are used up. */
async function later(row: { id: string; providerMessageId: string }, n: number, delay: number): Promise<boolean> {
  if (n >= MAX_REQUEUES) return false;
  const job = await enqueue('ai', WHATSAPP_CHAT_JOB, { inboundId: row.id, n: n + 1 }, { jobId: whatsappJobId(row.providerMessageId, n + 1), attempts: 1, delay, removeOnComplete: 500 });
  return !!job;
}

/** Releases the claim and asks for the job again in a few seconds, so one phone's messages are answered in order. False when it is time to proceed anyway. */
async function requeue(row: InboundRow, n: number): Promise<boolean> {
  if (n >= MAX_REQUEUES) return false;
  await withSystem((tx) => tx.update(schema.whatsappInbound).set({ status: 'received', claimedAt: null }).where(eq(schema.whatsappInbound.id, row.id)));
  if (await later(row, n, REQUEUE_DELAY_MS)) return true;
  // The queue is not reachable: take the claim back and answer now rather than never.
  const again = await claim(row.id);
  return !again;
}

/**
 * Every ten minutes (maintenance queue): a message still waiting after two
 * minutes gets its job again (the queue refused it, or Redis lost it), and a
 * claim older than an hour belongs to a run that never came back, so the row
 * is recorded as failed instead of sitting in processing for ever.
 */
export async function sweepInbound(): Promise<{ requeued: number; abandoned: number }> {
  const now = Date.now();
  const waiting = await withSystem((tx) =>
    tx
      .select({ id: schema.whatsappInbound.id, providerMessageId: schema.whatsappInbound.providerMessageId })
      .from(schema.whatsappInbound)
      .where(and(eq(schema.whatsappInbound.status, 'received'), lt(schema.whatsappInbound.createdAt, new Date(now - SWEEP_RECEIVED_AFTER_MS))))
      .limit(200),
  );
  let requeued = 0;
  for (const w of waiting) {
    const job = await enqueue('ai', WHATSAPP_CHAT_JOB, { inboundId: w.id }, { jobId: `${whatsappJobId(w.providerMessageId)}-sweep-${Math.floor(now / 600_000)}`, attempts: 1, removeOnComplete: 500 });
    if (job) requeued++;
  }
  const abandoned = await withSystem(async (tx) => {
    const rows = await tx
      .update(schema.whatsappInbound)
      .set({ status: 'failed', outcome: 'failed', error: 'worker stopped mid-turn', handledAt: new Date() })
      .where(and(eq(schema.whatsappInbound.status, 'processing'), lt(schema.whatsappInbound.claimedAt, new Date(now - SWEEP_ABANDON_AFTER_MS))))
      .returning({ id: schema.whatsappInbound.id, phone: schema.whatsappInbound.phone, providerMessageId: schema.whatsappInbound.providerMessageId, userId: schema.whatsappInbound.userId });
    for (const r of rows) await systemCtx(tx, `whatsapp:${r.providerMessageId}`).audit({ entityType: 'whatsapp_inbound', entityId: r.id, entityLabel: maskPhone(r.phone), action: 'whatsapp.chat', metadata: { outcome: 'failed', userId: r.userId, replied: false, error: 'worker stopped mid-turn' } });
    return rows.length;
  });
  if (requeued || abandoned) logger.info({ requeued, abandoned }, 'whatsapp inbound swept');
  return { requeued, abandoned };
}

interface FinishOptions {
  userId?: string | null;
  conversationId?: string | null;
  error?: string | null;
  parts?: number;
  /** The reply path audits as the person; everything else is audited here with the system context. */
  audited?: boolean;
  metadata?: Record<string, unknown>;
}

async function finish(row: InboundRow, outcome: string, outboxId: string | null, opts: FinishOptions = {}): Promise<HandleResult> {
  const status = opts.error && outcome === 'failed' ? 'failed' : outcome === 'ignored' ? 'ignored' : 'handled';
  await withSystem(async (tx) => {
    await tx
      .update(schema.whatsappInbound)
      .set({ status, outcome, replyOutboxId: outboxId, userId: opts.userId ?? row.userId, conversationId: opts.conversationId ?? null, error: opts.error ?? null, handledAt: new Date() })
      .where(eq(schema.whatsappInbound.id, row.id));
    if (!opts.audited) {
      await systemCtx(tx, `whatsapp:${row.providerMessageId}`).audit({ entityType: 'whatsapp_inbound', entityId: row.id, entityLabel: maskPhone(row.phone), action: 'whatsapp.chat', metadata: { outcome, userId: opts.userId ?? row.userId ?? null, replied: !!outboxId, ...(opts.metadata ?? {}) } });
    }
  });
  logger.info({ inboundId: row.id, outcome, replied: !!outboxId, parts: opts.parts ?? (outboxId ? 1 : 0), error: opts.error ?? undefined }, 'whatsapp chat handled');
  return { outcome, replied: !!outboxId, parts: opts.parts ?? (outboxId ? 1 : 0) };
}

// ---------------------------------------------------------------- sending

interface SendOptions {
  kind: 'text' | 'notice';
  userId?: string | null;
  customerId?: string | null;
  conversationId?: string | null;
  subject?: string;
}

/** Sends the parts in order and records each as an outbox row (status sent or failed), so delivery states land on it like any notification. */
async function sendParts(cfg: WhatsAppConfig | null, row: InboundRow, parts: string[], opts: SendOptions): Promise<{ firstOutboxId: string | null; failed: number; sent: number }> {
  let firstOutboxId: string | null = null;
  let failed = 0;
  let sent = 0;
  if (!cfg || !parts.length) return { firstOutboxId, failed: parts.length, sent };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    let providerMessageId: string | null = null;
    let lastError: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        providerMessageId = (await sendWhatsAppText(cfg, row.phone, part)).providerMessageId ?? null;
        lastError = null;
        break;
      } catch (err) {
        lastError = (err as Error).message?.slice(0, 1000) ?? 'send failed';
        if (err instanceof PermanentChannelError || attempt === 1) break;
        await sleep(REPLY_RETRY_MS);
      }
    }
    const ok = !lastError;
    const [outbox] = await withSystem((tx) =>
      tx
        .insert(schema.notificationOutbox)
        .values({
          channel: 'whatsapp',
          event: 'assistant.reply',
          customerId: opts.customerId ?? null,
          recipient: row.phone,
          subject: opts.subject ?? 'Grady',
          body: part,
          bodyText: part,
          payload: { kind: opts.kind, inboundId: row.id, conversationId: opts.conversationId ?? null, part: i + 1, parts: parts.length },
          providerMessageId,
          deliveryStatus: ok ? 'accepted' : null,
          status: ok ? 'sent' : 'failed',
          attempts: 1,
          lastError,
          sentAt: ok ? new Date() : null,
          entityType: opts.conversationId ? 'ai_conversation' : 'whatsapp_inbound',
          entityId: opts.conversationId ?? row.id,
        })
        .returning({ id: schema.notificationOutbox.id }),
    );
    firstOutboxId ??= outbox?.id ?? null;
    if (ok) sent++;
    else {
      failed++;
      logger.warn({ inboundId: row.id, part: i + 1, err: lastError }, 'whatsapp reply failed');
    }
  }
  return { firstOutboxId, failed, sent };
}

/** One notice of this kind per phone and hour; null when the person was told recently. */
async function throttledReply(cfg: WhatsAppConfig | null, row: InboundRow, kind: string, text: string, opts: Omit<SendOptions, 'kind'> = {}): Promise<string | null> {
  const since = new Date(Date.now() - NOTICE_EVERY_MS);
  const recent = await withSystem((tx) =>
    tx
      .select({ id: schema.whatsappInbound.id })
      .from(schema.whatsappInbound)
      .where(and(eq(schema.whatsappInbound.phone, row.phone), eq(schema.whatsappInbound.outcome, kind), isNotNull(schema.whatsappInbound.replyOutboxId), gt(schema.whatsappInbound.handledAt, since)))
      .limit(1),
  );
  if (recent.length) return null;
  return (await sendParts(cfg, row, [text], { ...opts, kind: 'notice' })).firstOutboxId;
}

// ---------------------------------------------------------------- identity and gates

async function verifiedUserByPhone(phone: string): Promise<VerifiedUser | null> {
  const [user] = await withSystem((tx) =>
    tx
      .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, userType: schema.users.userType, customerId: schema.users.customerId, preferences: schema.users.preferences })
      .from(schema.users)
      .where(and(eq(schema.users.phone, phone), isNotNull(schema.users.whatsappVerifiedAt), eq(schema.users.status, 'active')))
      .limit(1),
  );
  return user ?? null;
}

const assistantLive = (wa: WhatsAppSettings, ai: AiSettings, assistant: AssistantSettings) => wa.enabled && wa.configured && !!wa.appSecret && assistant.enabled && featureEnabled(ai, 'whatsapp_assistant') && aiEnabled();

/** The gates after identity and the chat flag, in order; null when the turn may run. */
async function gateFor(args: { wa: WhatsAppSettings; ai: AiSettings; assistant: AssistantSettings; user: VerifiedUser; row: InboundRow }): Promise<{ outcome: string; text: string | null } | null> {
  const { wa, ai, assistant, user, row } = args;
  if (!wa.enabled || !wa.configured || !wa.appSecret) return { outcome: 'feature_off', text: null };
  if (!assistant.enabled || !featureEnabled(ai, 'whatsapp_assistant') || !aiEnabled()) return { outcome: 'feature_off', text: `The WhatsApp assistant is switched off. Use the web application: ${config.APP_URL}` };
  if (!audienceAllowed(assistant, user.userType)) return { outcome: 'audience', text: 'WhatsApp chat is not available for your account' };
  if (row.kind === 'unsupported' || !row.text?.trim()) return { outcome: 'unsupported', text: 'I can only read text messages here.' };
  // Turns that ran the model count, whether or not Meta accepted the reply, so a number whose replies keep failing cannot spend tokens past the limits.
  const counts = await withSystem(async (tx) => {
    const [burst] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.whatsappInbound)
      .where(and(eq(schema.whatsappInbound.userId, user.id), inArray(schema.whatsappInbound.outcome, TURN_OUTCOMES), gt(schema.whatsappInbound.receivedAt, new Date(Date.now() - 60_000))));
    const [today] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.whatsappInbound)
      .where(and(eq(schema.whatsappInbound.userId, user.id), inArray(schema.whatsappInbound.outcome, TURN_OUTCOMES), gte(schema.whatsappInbound.handledAt, sql`date_trunc('day', now())`)));
    return { burst: Number(burst?.n ?? 0), today: Number(today?.n ?? 0) };
  });
  if (counts.burst > CHAT_RATE_LIMIT_PER_MINUTE) return { outcome: 'throttled', text: null };
  if (counts.today >= assistant.dailyMessageCap) return { outcome: 'cap', text: `You have reached today's WhatsApp limit of ${assistant.dailyMessageCap} messages; it resets at midnight UTC.` };
  return null;
}

/** The person's WhatsApp thread: the latest conversation keyed by context.channel, reused while it is not idle; and whether this is their first contact. */
async function threadFor(p: Principal, idleHours: number): Promise<{ conversationId: string | null; firstContact: boolean }> {
  return withSystem(async (tx) => {
    const customer = p.userType === 'customer' ? p.customerId : null;
    const [conv] = await tx
      .select({ id: schema.aiConversations.id, updatedAt: schema.aiConversations.updatedAt })
      .from(schema.aiConversations)
      .where(and(eq(schema.aiConversations.userId, p.id), sql`${schema.aiConversations.context}->>'channel' = 'whatsapp'`, customer ? eq(schema.aiConversations.customerId, customer) : undefined))
      .orderBy(desc(schema.aiConversations.updatedAt))
      .limit(1);
    const fresh = conv && idleHours > 0 && conv.updatedAt.getTime() > Date.now() - idleHours * 3_600_000;
    const [earlier] = await tx
      .select({ id: schema.whatsappInbound.id })
      .from(schema.whatsappInbound)
      .where(and(eq(schema.whatsappInbound.userId, p.id), inArray(schema.whatsappInbound.outcome, ['replied', 'linked'])))
      .limit(1);
    return { conversationId: fresh ? conv.id : null, firstContact: !earlier };
  });
}

// ---------------------------------------------------------------- the pipeline

export async function handleInbound(inboundId: string, n = 0): Promise<HandleResult> {
  const { wa, ai, assistant } = await withSystem(async (tx) => ({ wa: await loadWhatsAppSettings(tx), ai: await loadAiSettings(tx), assistant: await loadAssistantSettings(tx) }));
  const reclaimAfterMs = ai.turnTimeoutSeconds * 1000 + RECLAIM_MARGIN_MS;
  const row = await claim(inboundId, reclaimAfterMs);
  if (!row) {
    // A run of this job died mid-turn and its re-run came before the claim is old enough: come back when it is.
    const held = await heldFor(inboundId, reclaimAfterMs);
    if (held && (await later({ id: inboundId, providerMessageId: held.providerMessageId }, n, held.delay))) return { outcome: 'requeued', replied: false, parts: 0 };
    return { outcome: 'duplicate', replied: false, parts: 0 };
  }
  if ((await siblingProcessing(row)) && (await requeue(row, n))) return { outcome: 'requeued', replied: false, parts: 0 };
  if (row.receivedAt.getTime() < Date.now() - WINDOW_MS) return finish(row, 'ignored', null, { error: 'stale: outside the 24-hour window' });
  const meta: TurnMeta = { requestId: `whatsapp:${row.providerMessageId}`, ip: null, userAgent: 'whatsapp' };
  // Nothing is sent while the channel is off, exactly as notifications are refused then; without the app secret no row would have been taken in.
  const cfg = wa.enabled && wa.configured && wa.appSecret ? whatsappClientConfig(wa) : null;
  const text = row.text?.trim() ?? '';

  // A six-digit code with an open typed row for this number completes the link (works for an already verified number too).
  if (CODE_RE.test(text)) {
    const linked = await withSystem((tx) => completeTypedLink(tx, row.phone, text, meta.requestId));
    if (linked) {
      const sent = await sendParts(cfg, row, [['Linked. You can now chat with Grady here.', greetingFor(assistant, linked.name)].join('\n\n')], { kind: 'notice', userId: linked.userId, customerId: linked.customerId, subject: 'Grady: linked' });
      return finish(row, 'linked', sent.firstOutboxId, { userId: linked.userId, parts: sent.sent });
    }
  }

  const user = await verifiedUserByPhone(row.phone);
  if (!user) return finish(row, 'unverified', await throttledReply(cfg, row, 'unverified', fill(assistant.unlinkedReply, { platform: PLATFORM })));
  if (cfg) void markWhatsAppRead(cfg, row.providerMessageId).catch(() => undefined);

  // STOP and START from the phone switch the chat flag, with a confirming reply (never throttled).
  const flagOn = assistantFlagOf(user.preferences);
  const live = assistantLive(wa, ai, assistant);
  if (STOP_RE.test(text)) {
    if (flagOn) await withSystem((tx) => writeAssistantFlag(tx, user, false, actorOf(systemCtx(tx, meta.requestId)), 'phone'));
    const reply = flagOn ? 'Chat with Grady is now off for this number. Text START to turn it back on, or use Profile & preferences in the web application.' : 'Chat with Grady is already off for this number. Text START to turn it on.';
    const sent = await sendParts(cfg, row, [reply], { kind: 'notice', userId: user.id, customerId: user.customerId, subject: 'Grady: chat off' });
    return finish(row, 'stopped', sent.firstOutboxId, { userId: user.id, parts: sent.sent, metadata: { changed: flagOn } });
  }
  if (START_RE.test(text)) {
    if (!flagOn) await withSystem((tx) => writeAssistantFlag(tx, user, true, actorOf(systemCtx(tx, meta.requestId)), 'phone'));
    const note = live ? 'Ask me about tickets, services, visits and approvals.' : 'The administrator has not enabled WhatsApp chat yet, so replies will start once it is on.';
    const reply = `${flagOn ? 'Chat with Grady is already on for this number.' : 'Chat with Grady is on for this number.'} ${note}`;
    const sent = await sendParts(cfg, row, [reply], { kind: 'notice', userId: user.id, customerId: user.customerId, subject: 'Grady: chat on' });
    return finish(row, 'started', sent.firstOutboxId, { userId: user.id, parts: sent.sent, metadata: { changed: !flagOn } });
  }
  if (!flagOn) return finish(row, 'chat_off', await throttledReply(cfg, row, 'chat_off', CHAT_OFF_REPLY, { userId: user.id, customerId: user.customerId }), { userId: user.id });

  const gate = await gateFor({ wa, ai, assistant, user, row });
  if (gate) return finish(row, gate.outcome, gate.text ? await throttledReply(cfg, row, gate.outcome, gate.text, { userId: user.id, customerId: user.customerId }) : null, { userId: user.id });

  invalidatePrincipal(user.id);
  const p = await loadPrincipal(user.id);
  if (!p) return finish(row, 'inactive', null, { userId: user.id });
  if (!can(p, 'ai:use')) return finish(row, 'audience', await throttledReply(cfg, row, 'audience', 'Your account cannot use the assistant.', { userId: user.id, customerId: user.customerId }), { userId: user.id });

  const customerId = p.userType === 'customer' ? p.customerId : null;
  const { conversationId, firstContact } = await threadFor(p, assistant.threadIdleHours);
  let result: ChatResult;
  try {
    result = await chatTurn(p, meta, { conversationId, message: text, context: { channel: 'whatsapp' }, channel: 'whatsapp' });
  } catch (err) {
    return failedTurn(row, err, { cfg, user, customerId });
  }
  const parts = renderWhatsAppReply(result, { appUrl: config.APP_URL, greeting: firstContact ? greetingFor(assistant, p.name) : null });
  const title = await withSystem(async (tx) => (await tx.select({ title: schema.aiConversations.title }).from(schema.aiConversations).where(eq(schema.aiConversations.id, result.conversationId)).limit(1))[0]?.title ?? null);
  const sent = await sendParts(cfg, row, parts, { kind: 'text', userId: p.id, customerId, conversationId: result.conversationId, subject: `Grady: ${title ?? 'chat'}` });
  await aiStep(p, meta, (ctx) =>
    ctx.audit({
      entityType: 'whatsapp_inbound',
      entityId: row.id,
      entityLabel: maskPhone(row.phone),
      action: 'whatsapp.chat',
      customerId: ctx.user.userType === 'customer' ? ctx.user.customerId : null,
      metadata: { outcome: 'replied', parts: parts.length, failedParts: sent.failed, conversationId: result.conversationId, pendingAction: !!result.pendingAction, uiActions: result.uiActions.length },
    }),
  );
  // The turn happened (the conversation holds the answer); when Meta refused every part the person got nothing, so the row says failed.
  const delivered = sent.sent > 0 || !parts.length;
  return finish(row, delivered ? 'replied' : 'failed', sent.firstOutboxId, { userId: p.id, conversationId: result.conversationId, parts: sent.sent, audited: true, error: delivered ? null : 'the reply could not be sent' });
}

/** The turn threw: the switches and budgets get their own notice; anything else is recorded as failed with a generic reply. */
async function failedTurn(row: InboundRow, err: unknown, args: { cfg: WhatsAppConfig | null; user: VerifiedUser; customerId: string | null }): Promise<HandleResult> {
  const { cfg, user, customerId } = args;
  const who = { userId: user.id, customerId };
  if (err instanceof AiDisabledError) return finish(row, 'feature_off', await throttledReply(cfg, row, 'feature_off', `The WhatsApp assistant is switched off. Use the web application: ${config.APP_URL}`, who), { userId: user.id });
  if (err instanceof TooManyRequestsError && err.code === 'ai_budget_exceeded') return finish(row, 'cap', await throttledReply(cfg, row, 'cap', err.message, who), { userId: user.id });
  if (err instanceof ForbiddenError) return finish(row, 'audience', await throttledReply(cfg, row, 'audience', 'Your account cannot use the assistant.', who), { userId: user.id });
  const message = err instanceof AppError ? err.message : (err as Error)?.message ?? String(err);
  logger.error({ inboundId: row.id, userId: user.id, err: message }, 'whatsapp chat turn failed');
  const sent = await sendParts(cfg, row, [GENERIC_FAILURE], { kind: 'notice', ...who, subject: 'Grady: error' });
  return finish(row, 'failed', sent.firstOutboxId, { userId: user.id, parts: sent.sent, error: message.slice(0, 1000) });
}

