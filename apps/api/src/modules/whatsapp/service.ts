import { and, desc, eq, sql } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { normalizePhone } from '@/lib/channels';
import { maskPhone } from '@/modules/notifications/phone';
import { isLocalUrl, loadWhatsAppSettings, resolveWebhookUrl, type Finding } from '@/modules/notifications/channels';
import { loadAiSettings, featureEnabled } from '@/modules/ai/guards';
import { enabled as aiEnabled } from '@/modules/ai/service';
import { loadAssistantSettings, type InboundQuery } from './schemas';

/**
 * Administrator reads: the readiness of the assistant on WhatsApp (every
 * switch that has to be on, as plain sentences with what to change) and the
 * inbound message log. Both routes require admin:system or admin:config.
 */

const n = (v: unknown) => Number(v ?? 0) || 0;

export async function assistantStatus(ctx: Ctx) {
  const [wa, ai, assistant] = await Promise.all([loadWhatsAppSettings(ctx.tx), loadAiSettings(ctx.tx), loadAssistantSettings(ctx.tx)]);
  const checks: Finding[] = [];
  const ok = (text: string) => checks.push({ level: 'ok', text });
  const warn = (text: string) => checks.push({ level: 'warn', text });
  const error = (text: string) => checks.push({ level: 'error', text });
  if (wa.enabled && wa.configured) ok('WhatsApp is enabled and the connection is configured');
  else error('Enable WhatsApp and enter the phone number id and access token above');
  if (wa.appSecret) ok('The app secret is set, so inbound messages are verified');
  else error('Inbound messages are ignored until the app secret is set');
  if (assistant.enabled) ok('The assistant answers messages on WhatsApp');
  else warn('Switch "Answer messages with Grady" on');
  if (!aiEnabled()) error('No AI provider is configured (AI_PROVIDER and credentials)');
  else if (!featureEnabled(ai, 'whatsapp_assistant')) error('Turn on the "Chat on WhatsApp" feature under Administration → AI assistant');
  else ok('The "Chat on WhatsApp" feature and the AI provider are on');
  if (wa.templates.default?.name) ok(`The default template "${wa.templates.default.name}" is mapped, so verification codes can be sent to phones`);
  else warn('Map a default template so verification codes can be sent to phones');
  if (assistant.displayNumber) ok(`People are told to message ${assistant.displayNumber}`);
  else warn('Set the display number: the profile card shows it and the "I\'ll send the code" link needs it');
  if (isLocalUrl(resolveWebhookUrl(wa.webhookUrl))) warn('The webhook URL is local; Meta cannot reach it, so no message will arrive. Use a tunnel URL on a laptop');
  else ok('The webhook URL is public');
  const [counts] = (await ctx.tx.execute(sql`
    SELECT count(*) FILTER (WHERE whatsapp_verified_at IS NOT NULL AND status = 'active')::int AS verified,
      count(*) FILTER (WHERE whatsapp_verified_at IS NOT NULL AND status = 'active' AND coalesce(preferences->'whatsapp'->'assistant' = 'true'::jsonb, false))::int AS linked
    FROM users`)).rows as { verified: number; linked: number }[];
  const linkedUsers = n(counts?.linked);
  const verifiedUsers = n(counts?.verified);
  if (linkedUsers) ok(`${linkedUsers} ${linkedUsers === 1 ? 'person has' : 'people have'} linked a number (${verifiedUsers} verified)`);
  else warn(`Nobody has switched the chat on yet (${verifiedUsers} verified)`);
  const [today] = (await ctx.tx.execute(sql`
    SELECT count(*)::int AS inbound,
      count(*) FILTER (WHERE outcome = 'replied')::int AS replied,
      count(*) FILTER (WHERE status = 'failed')::int AS failed
    FROM whatsapp_inbound WHERE received_at >= date_trunc('day', now())`)).rows as { inbound: number; replied: number; failed: number }[];
  return {
    enabled: assistant.enabled,
    ready: !checks.some((c) => c.level === 'error') && assistant.enabled,
    checks,
    linkedUsers,
    verifiedUsers,
    inboundToday: n(today?.inbound),
    repliedToday: n(today?.replied),
    failedToday: n(today?.failed),
    settings: { ...assistant, appSecretSet: !!wa.appSecret, webhookUrl: resolveWebhookUrl(wa.webhookUrl) },
  };
}

/** The inbound log, newest first, with the person the number resolved to and the state of the reply; numbers are masked like everywhere else (the phone filter still matches the full number). */
export async function listInbound(ctx: Ctx, q: InboundQuery) {
  const conds = [];
  if (q.phone?.trim()) {
    const normalised = normalizePhone(q.phone);
    conds.push(normalised ? eq(schema.whatsappInbound.phone, normalised) : sql`${schema.whatsappInbound.phone} like ${`%${q.phone.trim().replace(/[%_]/g, '')}%`}`);
  }
  if (q.outcome?.trim()) conds.push(eq(schema.whatsappInbound.outcome, q.outcome.trim()));
  const rows = await ctx.tx
    .select({
      id: schema.whatsappInbound.id,
      receivedAt: schema.whatsappInbound.receivedAt,
      handledAt: schema.whatsappInbound.handledAt,
      phone: schema.whatsappInbound.phone,
      displayName: schema.whatsappInbound.displayName,
      kind: schema.whatsappInbound.kind,
      text: schema.whatsappInbound.text,
      status: schema.whatsappInbound.status,
      outcome: schema.whatsappInbound.outcome,
      error: schema.whatsappInbound.error,
      conversationId: schema.whatsappInbound.conversationId,
      userId: schema.users.id,
      userName: schema.users.name,
      userType: schema.users.userType,
      replyStatus: schema.notificationOutbox.status,
      replyDelivery: schema.notificationOutbox.deliveryStatus,
      replyError: schema.notificationOutbox.lastError,
    })
    .from(schema.whatsappInbound)
    .leftJoin(schema.users, eq(schema.users.id, schema.whatsappInbound.userId))
    .leftJoin(schema.notificationOutbox, eq(schema.notificationOutbox.id, schema.whatsappInbound.replyOutboxId))
    .where(conds.length ? and(...conds) : undefined)
    // newest first; two messages in the same second (Meta's timestamps are whole seconds) keep their arrival order
    .orderBy(desc(schema.whatsappInbound.receivedAt), desc(schema.whatsappInbound.createdAt))
    .limit(q.limit);
  return {
    items: rows.map((r) => ({
      id: r.id,
      receivedAt: r.receivedAt,
      handledAt: r.handledAt,
      phone: maskPhone(r.phone),
      displayName: r.displayName,
      user: r.userId ? { id: r.userId, name: r.userName, userType: r.userType } : null,
      kind: r.kind,
      text: r.text ? (r.text.length > 160 ? `${r.text.slice(0, 160)}…` : r.text) : null,
      status: r.status,
      outcome: r.outcome,
      error: r.error,
      reply: r.replyStatus ? { status: r.replyStatus, deliveryStatus: r.replyDelivery, lastError: r.replyError } : null,
      conversationId: r.conversationId,
    })),
  };
}
