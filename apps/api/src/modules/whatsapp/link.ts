import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import type { Tx } from '@/db/client';
import { schema, withSystem } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ConflictError, NotFoundError, ValidationError } from '@/core/errors';
import { invalidatePrincipal } from '@/core/principal';
import { writeAudit, type AuditActor } from '@/core/audit';
import { normalizePhone } from '@/lib/channels';
import { systemCtx } from '@/modules/tickets/common';
import { actorOf, hashVerificationCode, markPhoneVerified, maskPhone, MAX_ATTEMPTS } from '@/modules/notifications/phone';
import { assertPerson } from '@/modules/notifications/preferences';
import { loadWhatsAppSettings } from '@/modules/notifications/channels';
import { loadAiSettings, featureEnabled } from '@/modules/ai/guards';
import { enabled as aiEnabled } from '@/modules/ai/service';
import { audienceAllowed, loadAssistantSettings } from './schemas';

/**
 * "Linked for chat" means two things at once: the person proved they own the
 * number (users.whatsapp_verified_at, the notifications module's flow) and they
 * switched the chat on (users.preferences.whatsapp.assistant). This file owns
 * the flag and the `typed` completion of the verification; the number itself
 * is verified, cleared and masked by `notifications/phone.ts`.
 */

export type AssistantFlagBy = 'self' | 'typed_code' | 'phone' | 'admin' | 'portal_admin';

/** Tolerant read of the chat flag from a preferences object. */
export const assistantFlagOf = (preferences: Record<string, unknown> | null | undefined): boolean => {
  const w = preferences?.whatsapp;
  return !!w && typeof w === 'object' && !Array.isArray(w) && (w as Record<string, unknown>).assistant === true;
};

/** The merged preferences object with only the `whatsapp.assistant` key changed (every other key is somebody else's). */
const withFlag = (preferences: Record<string, unknown> | null | undefined, on: boolean): Record<string, unknown> => {
  const prev = preferences ?? {};
  const w = prev.whatsapp && typeof prev.whatsapp === 'object' && !Array.isArray(prev.whatsapp) ? (prev.whatsapp as Record<string, unknown>) : {};
  return { ...prev, whatsapp: { ...w, assistant: on } };
};

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

async function loadUser(tx: Tx, userId: string) {
  const [user] = await tx
    .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, phone: schema.users.phone, userType: schema.users.userType, customerId: schema.users.customerId, whatsappVerifiedAt: schema.users.whatsappVerifiedAt, whatsappOptIn: schema.users.whatsappOptIn, preferences: schema.users.preferences })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return user ?? null;
}

/** Writes the flag, audits it and drops the cached principal. */
export async function writeAssistantFlag(tx: Tx, user: { id: string; email: string; customerId: string | null; preferences: Record<string, unknown> }, on: boolean, actor: AuditActor, by: AssistantFlagBy): Promise<void> {
  await tx.update(schema.users).set({ preferences: withFlag(user.preferences, on), updatedAt: new Date() }).where(eq(schema.users.id, user.id));
  invalidatePrincipal(user.id);
  await writeAudit(tx, actor, { entityType: 'user', entityId: user.id, entityLabel: user.email, action: on ? 'whatsapp.assistant.on' : 'whatsapp.assistant.off', customerId: user.customerId, metadata: { by } });
}

/**
 * The agent's path for a `typed` code sent from a phone: the open typed rows
 * issued for exactly this number are checked; the first whose hash matches
 * marks the number verified (the notifications module's rule set: uniqueness,
 * normalised number, consumed rows, audit) and switches the chat on. A wrong
 * code counts an attempt on every candidate (atomically) and returns null;
 * candidates with five attempts are void. Never throws on a wrong code.
 */
export async function completeTypedLink(tx: Tx, phone: string, code: string, requestId: string): Promise<{ userId: string; name: string; customerId: string | null } | null> {
  // Every open typed row for this number is a candidate (each account keeps at most one open row), so other accounts asking for codes on the same number cannot push the owner's row out of reach.
  const candidates = await tx
    .select()
    .from(schema.phoneVerifications)
    .where(and(eq(schema.phoneVerifications.method, 'typed'), eq(schema.phoneVerifications.phone, phone), isNull(schema.phoneVerifications.consumedAt), gt(schema.phoneVerifications.expiresAt, new Date())))
    .orderBy(desc(schema.phoneVerifications.createdAt));
  const live = candidates.filter((c) => c.attempts < MAX_ATTEMPTS);
  const spent = candidates.filter((c) => c.attempts >= MAX_ATTEMPTS);
  if (spent.length) await tx.update(schema.phoneVerifications).set({ consumedAt: new Date() }).where(inArray(schema.phoneVerifications.id, spent.map((c) => c.id)));
  if (!live.length) return null;
  const actor = actorOf(systemCtx(tx, requestId));
  const hit = live.find((c) => sameHash(hashVerificationCode(c.userId, phone, code), c.codeHash));
  if (!hit) {
    // One statement per candidate: concurrent wrong codes each count, and the fifth voids the code whoever sends it.
    for (const c of live) {
      await tx
        .update(schema.phoneVerifications)
        .set({ attempts: sql`${schema.phoneVerifications.attempts} + 1`, consumedAt: sql`case when ${schema.phoneVerifications.attempts} + 1 >= ${MAX_ATTEMPTS} then now() else ${schema.phoneVerifications.consumedAt} end` })
        .where(eq(schema.phoneVerifications.id, c.id));
    }
    return null;
  }
  try {
    await markPhoneVerified(tx, hit.userId, phone, { method: 'typed', actor });
  } catch (err) {
    if (err instanceof ConflictError) return null;
    throw err;
  }
  const user = await loadUser(tx, hit.userId);
  if (!user) return null;
  await writeAssistantFlag(tx, user, true, actor, 'typed_code');
  return { userId: user.id, name: user.name, customerId: user.customerId };
}

export interface LinkStatus {
  phone: string | null;
  verifiedAt: Date | null;
  assistant: { on: boolean; enabled: boolean; allowed: boolean; reason: string | null };
  pending: { method: 'sent' | 'typed'; expiresAt: Date } | null;
  businessNumber: string | null;
  waLink: string | null;
}

/** The profile card's state: masked number, verification, the chat flag, whether the platform offers the chat to this person, a pending code and the business number. */
export async function linkStatus(ctx: Ctx): Promise<LinkStatus> {
  assertPerson(ctx);
  const user = await loadUser(ctx.tx, ctx.user.id);
  if (!user) throw new NotFoundError('User');
  const [wa, ai, assistant] = await Promise.all([loadWhatsAppSettings(ctx.tx), loadAiSettings(ctx.tx), loadAssistantSettings(ctx.tx)]);
  const enabled = wa.enabled && wa.configured && !!wa.appSecret && assistant.enabled && featureEnabled(ai, 'whatsapp_assistant') && aiEnabled();
  const allowed = audienceAllowed(assistant, user.userType);
  const [pending] = await ctx.tx
    .select({ method: schema.phoneVerifications.method, expiresAt: schema.phoneVerifications.expiresAt })
    .from(schema.phoneVerifications)
    .where(and(eq(schema.phoneVerifications.userId, user.id), isNull(schema.phoneVerifications.consumedAt), gt(schema.phoneVerifications.expiresAt, new Date())))
    .orderBy(desc(schema.phoneVerifications.createdAt))
    .limit(1);
  const normalised = normalizePhone(user.phone, wa.defaultCountryCode);
  const businessNumber = assistant.displayNumber || null;
  const digits = businessNumber ? businessNumber.replace(/\D/g, '') : '';
  return {
    phone: normalised ? maskPhone(normalised) : user.phone?.trim() ? maskPhone(user.phone.trim()) : null,
    verifiedAt: user.whatsappVerifiedAt,
    assistant: {
      on: assistantFlagOf(user.preferences),
      enabled,
      allowed,
      reason: !enabled ? 'The administrator has not enabled WhatsApp chat yet' : !allowed ? 'WhatsApp chat is not available for your account' : null,
    },
    pending: pending ? { method: pending.method === 'typed' ? 'typed' : 'sent', expiresAt: pending.expiresAt } : null,
    businessNumber,
    waLink: digits ? `https://wa.me/${digits}` : null,
  };
}

/** The person switches the chat on (a verified number is required) or off; the number stays verified either way. */
export async function setAssistantFlag(ctx: Ctx, on: boolean): Promise<{ on: boolean }> {
  assertPerson(ctx);
  const user = await loadUser(ctx.tx, ctx.user.id);
  if (!user) throw new NotFoundError('User');
  if (on && !user.whatsappVerifiedAt) throw new ValidationError('Verify your mobile number first');
  await writeAssistantFlag(ctx.tx, user, on, actorOf(ctx), 'self');
  return { on };
}

/**
 * An administrator (or a customer administrator for their own organisation)
 * revokes a person's number: the chat goes off, the verification is cleared
 * and open codes are consumed, so the number has to be proved again.
 */
export async function revokeNumber(ctx: Ctx, userId: string, opts: { by: 'admin' | 'portal_admin' }): Promise<{ ok: true }> {
  const user = await loadUser(ctx.tx, userId);
  if (!user) throw new NotFoundError('User');
  if (user.customerId) ctx.requireCustomer(user.customerId);
  const actor = actorOf(ctx);
  const wasOn = assistantFlagOf(user.preferences);
  await ctx.tx.update(schema.users).set({ preferences: withFlag(user.preferences, false), whatsappVerifiedAt: null, updatedAt: new Date() }).where(eq(schema.users.id, userId));
  // Codes are fenced to their owner by row-level security; the caller is an administrator, so the system context consumes them.
  await withSystem((tx) => tx.update(schema.phoneVerifications).set({ consumedAt: new Date() }).where(and(eq(schema.phoneVerifications.userId, userId), isNull(schema.phoneVerifications.consumedAt))));
  invalidatePrincipal(userId);
  if (wasOn) await writeAudit(ctx.tx, actor, { entityType: 'user', entityId: userId, entityLabel: user.email, action: 'whatsapp.assistant.off', customerId: user.customerId, metadata: { by: opts.by } });
  if (user.whatsappVerifiedAt) {
    const normalised = normalizePhone(user.phone);
    await writeAudit(ctx.tx, actor, { entityType: 'user', entityId: userId, entityLabel: user.email, action: 'phone.verification_cleared', customerId: user.customerId, metadata: { reason: opts.by, phone: normalised ? maskPhone(normalised) : null } });
  }
  return { ok: true };
}
