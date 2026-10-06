import { randomInt, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, gte, isNull, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '@/db/client';
import { schema, withSystem } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ConflictError, TooManyRequestsError, ValidationError } from '@/core/errors';
import { invalidatePrincipal } from '@/core/principal';
import { writeAudit, type AuditActor } from '@/core/audit';
import { sha256 } from '@/lib/crypto';
import { normalizePhone } from '@/lib/channels';
import { queueNotification } from './dispatch';
import { loadWhatsAppSettings } from './channels';
import { getSetting } from '@/modules/config/service';
import { assertPerson, myPreferences, type PreferenceMatrix } from './preferences';

/**
 * Proof of ownership of a mobile number: a six-digit code exchanged over
 * WhatsApp sets users.whatsapp_verified_at. Verification never touches the
 * WhatsApp opt-in (consent to notifications stays with the profile toggle);
 * the WhatsApp assistant acts for a number only when it is verified. A number
 * verified on another account is refused; changing the number clears the
 * verification. The code is stored hashed and never reaches an audit row.
 */

export const CODE_LIFETIME_MS = 10 * 60_000;
export const CODES_PER_HOUR = 3;
export const MAX_ATTEMPTS = 5;

export const startBody = z.object({ method: z.enum(['sent', 'typed']).optional() });
export const confirmBody = z.object({ code: z.string().regex(/^\d{6}$/) });
export type VerificationMethod = 'sent' | 'typed';

/** `+919810011004` → `+91••••1004`: country code, four bullets, the last four digits. Used by every audit row, page, reply and fact. */
export const maskPhone = (e164: string): string => `${e164.slice(0, 3)}••••${e164.slice(-4)}`;

/** sha256(`${userId}:${phone}:${code}`): the hash binds the code to the person and the number it was issued for. */
export const hashVerificationCode = (userId: string, phone: string, code: string): string => sha256(`${userId}:${phone}:${code}`);

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** The audit actor of a ctx (what buildCtx hands ctx.audit). */
export const actorOf = (ctx: Ctx): AuditActor => ({ userId: ctx.user.apiKeyId ? null : ctx.user.id, userName: ctx.user.name, source: ctx.source, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });

const CONFLICT = 'That number is verified on another account';

/** At most one account per verified number (the partial unique index enforces it under concurrency). */
async function assertNumberFree(tx: Tx, userId: string, phone: string) {
  const [other] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.phone, phone), sql`${schema.users.whatsappVerifiedAt} is not null`, sql`${schema.users.id} <> ${userId}`))
    .limit(1);
  if (other) throw new ConflictError(CONFLICT);
}

const consumeOpenRows = (tx: Tx, userId: string) => tx.update(schema.phoneVerifications).set({ consumedAt: new Date() }).where(and(eq(schema.phoneVerifications.userId, userId), isNull(schema.phoneVerifications.consumedAt)));

/**
 * Serialises the verification writes of one person for the rest of the
 * transaction, so two concurrent starts cannot both pass the hourly counter.
 * Transaction-scoped: released at commit or rollback.
 */
const lockPerson = (tx: Tx, userId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`phone_verification:${userId}`}))`);

async function loadUser(tx: Tx, userId: string) {
  const [user] = await tx.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, phone: schema.users.phone, customerId: schema.users.customerId, whatsappVerifiedAt: schema.users.whatsappVerifiedAt }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  return user ?? null;
}

export interface SentVerification {
  method: 'sent';
  sentTo: string;
  expiresAt: string;
}
/** The `typed` method: the code is shown once (stored hashed) and the person sends it to the business number from their own phone. */
export interface TypedVerification {
  method: 'typed';
  code: string;
  phone: string;
  expiresAt: string;
  businessNumber: string | null;
  waLink: string | null;
}

/**
 * Issues a code for the person's own number. `sent` (the default) delivers it
 * over WhatsApp; `typed` returns it once so the person sends it to the business
 * number (the WhatsApp assistant completes the link when the code arrives from
 * the same number). Refusals: no number on the profile (422), a number that
 * does not parse (422), a number another account verified (409), more than
 * three codes in the last hour across both methods (429,
 * `verification_rate_limited`), WhatsApp not set up or no template mapped
 * (422, `sent` only; nothing is stored because the transaction rolls back).
 */
export async function startPhoneVerification(ctx: Ctx, input: { method?: VerificationMethod } = {}): Promise<SentVerification | TypedVerification> {
  assertPerson(ctx);
  const method = input.method ?? 'sent';
  const user = await loadUser(ctx.tx, ctx.user.id);
  if (!user) throw new ValidationError('Save a mobile number in your profile first');
  if (!user.phone?.trim()) throw new ValidationError('Save a mobile number in your profile first');
  const settings = await loadWhatsAppSettings(ctx.tx);
  const phone = normalizePhone(user.phone, settings.defaultCountryCode);
  if (!phone) throw new ValidationError('Enter a valid mobile number with country code');
  await assertNumberFree(ctx.tx, user.id, phone);
  await lockPerson(ctx.tx, user.id);
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  const recent = await ctx.tx.select({ id: schema.phoneVerifications.id }).from(schema.phoneVerifications).where(and(eq(schema.phoneVerifications.userId, user.id), gte(schema.phoneVerifications.createdAt, hourAgo)));
  if (recent.length >= CODES_PER_HOUR) throw new TooManyRequestsError('Three codes an hour; try again later', 'verification_rate_limited');
  await consumeOpenRows(ctx.tx, user.id);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + CODE_LIFETIME_MS);
  await ctx.tx.insert(schema.phoneVerifications).values({ userId: user.id, phone, method, codeHash: hashVerificationCode(user.id, phone, code), expiresAt });
  if (method === 'typed') {
    // Nothing is sent: the person types the code into WhatsApp themselves. The business number is a plain setting
    // read here through the config service so the notifications module never imports the assistant's module.
    const businessNumber = String(await getSetting(ctx, 'whatsapp.display_number', '')).trim() || null;
    const digits = businessNumber ? businessNumber.replace(/\D/g, '') : '';
    await ctx.audit({ entityType: 'user', entityId: user.id, entityLabel: user.email, action: 'phone.verification_shown', customerId: user.customerId, metadata: { method, phone: maskPhone(phone) } });
    return { method: 'typed', code, phone, expiresAt: expiresAt.toISOString(), businessNumber, waLink: digits ? `https://wa.me/${digits}?text=${code}` : null };
  }
  const queued = await queueNotification(ctx.tx, {
    event: 'user.phone_verification',
    recipients: [{ userId: user.id, name: user.name, phone, whatsappOptIn: true }],
    data: { code, minutes: Math.round(CODE_LIFETIME_MS / 60_000), user: { name: user.name } },
    channels: ['whatsapp'],
    customerId: user.customerId,
    title: 'Your verification code',
    link: '/profile',
  });
  if (!queued) throw new ValidationError('WhatsApp is not set up on this platform, or no template is mapped');
  await ctx.audit({ entityType: 'user', entityId: user.id, entityLabel: user.email, action: 'phone.verification_sent', customerId: user.customerId, metadata: { method, phone: maskPhone(phone) } });
  return { method: 'sent', sentTo: maskPhone(phone), expiresAt: expiresAt.toISOString() };
}

/**
 * Checks the code against the latest open `sent` row. A wrong code counts an
 * attempt in its own transaction (the caller's rolls back with the 422) so the
 * counter survives; after five the code is void. The right code marks the
 * number verified and returns the matrix.
 */
export async function confirmPhoneVerification(ctx: Ctx, code: string): Promise<PreferenceMatrix> {
  assertPerson(ctx);
  const [row] = await ctx.tx
    .select()
    .from(schema.phoneVerifications)
    .where(and(eq(schema.phoneVerifications.userId, ctx.user.id), eq(schema.phoneVerifications.method, 'sent'), isNull(schema.phoneVerifications.consumedAt), gt(schema.phoneVerifications.expiresAt, new Date())))
    .orderBy(desc(schema.phoneVerifications.createdAt))
    .limit(1);
  if (!row) throw new ValidationError('No code is waiting; request a new one');
  if (row.attempts >= MAX_ATTEMPTS) {
    await withSystem((tx) => tx.update(schema.phoneVerifications).set({ consumedAt: new Date() }).where(eq(schema.phoneVerifications.id, row.id)));
    throw new ValidationError('Too many attempts; request a new code');
  }
  const user = await loadUser(ctx.tx, ctx.user.id);
  if (!user) throw new ValidationError('No code is waiting; request a new one');
  const settings = await loadWhatsAppSettings(ctx.tx);
  if (normalizePhone(user.phone, settings.defaultCountryCode) !== row.phone) throw new ValidationError('Your number changed; request a new code');
  if (!sameHash(hashVerificationCode(user.id, row.phone, code), row.codeHash)) {
    // One atomic statement: concurrent wrong codes each count, and the fifth voids the code whoever sends it.
    const [counted] = await withSystem((tx) =>
      tx
        .update(schema.phoneVerifications)
        .set({
          attempts: sql`${schema.phoneVerifications.attempts} + 1`,
          consumedAt: sql`case when ${schema.phoneVerifications.attempts} + 1 >= ${MAX_ATTEMPTS} then now() else ${schema.phoneVerifications.consumedAt} end`,
        })
        .where(eq(schema.phoneVerifications.id, row.id))
        .returning({ attempts: schema.phoneVerifications.attempts }),
    );
    const attempts = counted?.attempts ?? row.attempts + 1;
    throw new ValidationError(attempts >= MAX_ATTEMPTS ? 'Too many attempts; request a new code' : `That code is not right, ${MAX_ATTEMPTS - attempts} attempts left`);
  }
  await markPhoneVerified(ctx.tx, user.id, row.phone, { method: 'sent', actor: actorOf(ctx) });
  return myPreferences(ctx);
}

/**
 * Marks `phone` (E.164) as verified for the person: the uniqueness rule is
 * checked again (409, also when two accounts race on the partial unique index),
 * the number is stored normalised, open codes are consumed and the principal
 * cache is dropped. Never touches whatsapp_opt_in or preferences.
 */
export async function markPhoneVerified(tx: Tx, userId: string, phone: string, opts: { method: VerificationMethod; actor: AuditActor }): Promise<void> {
  await assertNumberFree(tx, userId, phone);
  const user = await loadUser(tx, userId);
  if (!user) throw new ValidationError('No code is waiting; request a new one');
  try {
    await tx.update(schema.users).set({ whatsappVerifiedAt: new Date(), phone, updatedAt: new Date() }).where(eq(schema.users.id, userId));
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new ConflictError(CONFLICT);
    throw err;
  }
  await consumeOpenRows(tx, userId);
  invalidatePrincipal(userId);
  await writeAudit(tx, opts.actor, { entityType: 'user', entityId: userId, entityLabel: user.email, action: 'phone.verified', customerId: user.customerId, metadata: { method: opts.method, phone: maskPhone(phone) } });
}

/**
 * The number on a profile changed (normalised value differs): the verification
 * is cleared and open codes are consumed, with an audit row when there was a
 * verification to clear. preferences are left alone (the assistant's chat flag
 * is inert without a verified number). The codes are consumed with the system
 * context: phone_verifications is fenced to its owner by row-level security,
 * and the caller may be an administrator changing somebody else's number.
 */
export async function onPhoneChanged(tx: Tx, userId: string, before: string | null | undefined, after: string | null | undefined, actor: AuditActor): Promise<void> {
  const user = await loadUser(tx, userId);
  if (!user) return;
  await withSystem((stx) => consumeOpenRows(stx, userId));
  if (!user.whatsappVerifiedAt) return;
  await tx.update(schema.users).set({ whatsappVerifiedAt: null, updatedAt: new Date() }).where(eq(schema.users.id, userId));
  invalidatePrincipal(userId);
  const from = normalizePhone(before);
  const to = normalizePhone(after);
  await writeAudit(tx, actor, { entityType: 'user', entityId: userId, entityLabel: user.email, action: 'phone.verification_cleared', customerId: user.customerId, metadata: { reason: 'phone_changed', from: from ? maskPhone(from) : null, to: to ? maskPhone(to) : null } });
}
