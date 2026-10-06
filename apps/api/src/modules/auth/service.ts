import { normalizePhone } from '@/lib/channels';
import { eq, and, isNull, gt, sql } from 'drizzle-orm';
import { db, schema, withSystem } from '@/db/client';
import { config } from '@/config';
import { hashPassword, verifyPassword, randomToken, sha256 } from '@/lib/crypto';
import { signAccessToken } from '@/core/tokens';
import { AppError, UnauthorizedError, ValidationError } from '@/core/errors';
import { invalidatePrincipal, loadPrincipal } from '@/core/principal';
import { writeAudit } from '@/core/audit';
import { queueNotification } from '@/modules/notifications/dispatch';
import { onPhoneChanged } from '@/modules/notifications/phone';

const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export interface LoginMeta {
  ip?: string;
  userAgent?: string;
}

export async function login(email: string, password: string, meta: LoginMeta) {
  const normalized = email.trim().toLowerCase();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, normalized)).limit(1);
  const failure = () => new UnauthorizedError('Invalid email or password');
  if (!user || !user.passwordHash) throw failure();
  if (user.status === 'disabled') throw new UnauthorizedError('This account is disabled');
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(423, `Account temporarily locked. Try again after ${user.lockedUntil.toISOString()}`, 'locked');
  }
  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    const count = user.failedLoginCount + 1;
    const lock = count >= LOCKOUT_ATTEMPTS;
    await db
      .update(schema.users)
      .set({ failedLoginCount: lock ? 0 : count, lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null })
      .where(eq(schema.users.id, user.id));
    await withSystem((tx) => writeAudit(tx, { userId: user.id, userName: user.name, source: 'ui', ip: meta.ip, userAgent: meta.userAgent }, { entityType: 'user', entityId: user.id, action: lock ? 'login.locked' : 'login.failed', customerId: user.customerId }));
    throw failure();
  }
  if (user.status !== 'active') throw new UnauthorizedError('This account is not active');

  const refreshToken = randomToken(48);
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  const [session] = await db
    .insert(schema.sessions)
    .values({ userId: user.id, refreshTokenHash: sha256(refreshToken), expiresAt, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 500) })
    .returning();
  await db.update(schema.users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
  await withSystem((tx) => writeAudit(tx, { userId: user.id, userName: user.name, source: 'ui', ip: meta.ip, userAgent: meta.userAgent }, { entityType: 'user', entityId: user.id, action: 'login', customerId: user.customerId }));
  const accessToken = await signAccessToken(user.id, session.id);
  const principal = await loadPrincipal(user.id);
  return { accessToken, refreshToken, principal: principal!, mustChangePassword: !user.passwordChangedAt };
}

export async function refresh(refreshToken: string, meta: LoginMeta) {
  const [session] = await db
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.refreshTokenHash, sha256(refreshToken)), isNull(schema.sessions.revokedAt), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  if (!session) throw new UnauthorizedError('Session expired');
  const principal = await loadPrincipal(session.userId);
  if (!principal) throw new UnauthorizedError('Account is not active');
  // Rotate the refresh token on every use.
  const next = randomToken(48);
  await db.update(schema.sessions).set({ refreshTokenHash: sha256(next), lastSeenAt: new Date(), ip: meta.ip ?? session.ip }).where(eq(schema.sessions.id, session.id));
  const accessToken = await signAccessToken(session.userId, session.id);
  return { accessToken, refreshToken: next, principal };
}

export async function logout(refreshToken: string | undefined, userId: string | undefined) {
  if (refreshToken) {
    await db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.refreshTokenHash, sha256(refreshToken)));
  }
  if (userId) invalidatePrincipal(userId);
}

export async function listSessions(userId: string) {
  return db
    .select({ id: schema.sessions.id, ip: schema.sessions.ip, userAgent: schema.sessions.userAgent, createdAt: schema.sessions.createdAt, lastSeenAt: schema.sessions.lastSeenAt, expiresAt: schema.sessions.expiresAt })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt), gt(schema.sessions.expiresAt, new Date())))
    .orderBy(sql`${schema.sessions.lastSeenAt} desc`);
}

export async function revokeSession(userId: string, sessionId: string) {
  await db.update(schema.sessions).set({ revokedAt: new Date() }).where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, userId)));
}

export async function revokeAllSessions(userId: string) {
  await db.update(schema.sessions).set({ revokedAt: new Date() }).where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
  invalidatePrincipal(userId);
}

export function validatePasswordStrength(password: string) {
  if (password.length < 10) throw new ValidationError('Password must be at least 10 characters');
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) throw new ValidationError('Password must contain upper and lower case letters and a number');
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string, meta: LoginMeta) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user?.passwordHash) throw new UnauthorizedError();
  if (!(await verifyPassword(user.passwordHash, currentPassword))) throw new ValidationError('Current password is incorrect');
  validatePasswordStrength(newPassword);
  await db.update(schema.users).set({ passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date() }).where(eq(schema.users.id, userId));
  await withSystem((tx) => writeAudit(tx, { userId, userName: user.name, source: 'ui', ip: meta.ip, userAgent: meta.userAgent }, { entityType: 'user', entityId: userId, action: 'password.changed', customerId: user.customerId }));
}

export async function requestPasswordReset(email: string) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email.trim().toLowerCase())).limit(1);
  if (!user || user.status === 'disabled') return; // never reveal whether the account exists
  const token = randomToken(32);
  await db.insert(schema.passwordResetTokens).values({ userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60 * 60_000) });
  await withSystem((tx) =>
    queueNotification(tx, {
      event: 'user.password_reset',
      recipients: [{ email: user.email, userId: user.id, name: user.name }],
      data: { user: { name: user.name, email: user.email }, resetLink: `${config.APP_URL}/reset-password?token=${token}` },
      customerId: user.customerId,
      channels: ['email'],
    }),
  );
}

export async function resetPassword(token: string, newPassword: string) {
  const [row] = await db.select().from(schema.passwordResetTokens).where(and(eq(schema.passwordResetTokens.tokenHash, sha256(token)), isNull(schema.passwordResetTokens.usedAt), gt(schema.passwordResetTokens.expiresAt, new Date()))).limit(1);
  if (!row) throw new ValidationError('This reset link is invalid or has expired');
  validatePasswordStrength(newPassword);
  await db.update(schema.users).set({ passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null }).where(eq(schema.users.id, row.userId));
  await db.update(schema.passwordResetTokens).set({ usedAt: new Date() }).where(eq(schema.passwordResetTokens.id, row.id));
  await revokeAllSessions(row.userId);
}

/** Keys of users.preferences with a server-side writer of their own: the profile route never overwrites them with a stale copy. */
const PREFERENCE_KEYS_OWNED_ELSEWHERE = new Set(['notifications', 'whatsapp']);

export async function updatePreferences(userId: string, patch: { preferences?: Record<string, unknown>; timezone?: string; name?: string; phone?: string; whatsappOptIn?: boolean }, meta: LoginMeta & { requestId?: string } = {}) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user) throw new UnauthorizedError();
  const incoming = patch.preferences ? Object.fromEntries(Object.entries(patch.preferences).filter(([k]) => !PREFERENCE_KEYS_OWNED_ELSEWHERE.has(k))) : null;
  // Phone numbers are kept in E.164 when they parse, so WhatsApp can use them as entered.
  const phone = patch.phone === undefined ? user.phone : patch.phone.trim() ? (normalizePhone(patch.phone) ?? patch.phone.trim()) : null;
  const optIn = patch.whatsappOptIn === undefined ? user.whatsappOptIn : patch.whatsappOptIn;
  if (optIn && !phone) throw new ValidationError('Add a mobile number before turning on WhatsApp notifications');
  await db
    .update(schema.users)
    .set({
      preferences: incoming ? { ...user.preferences, ...incoming } : user.preferences,
      timezone: patch.timezone ?? user.timezone,
      name: patch.name ?? user.name,
      phone,
      whatsappOptIn: optIn,
      whatsappOptedInAt: optIn && !user.whatsappOptIn ? new Date() : optIn ? user.whatsappOptedInAt : null,
      updatedAt: new Date(),
    })
    .where(eq(schema.users.id, userId));
  // A changed number is no longer the verified one. phone_verifications is under forced row-level security, so the clear runs with the system context (as the password audit above does).
  if (normalizePhone(user.phone) !== normalizePhone(phone)) await withSystem((tx) => onPhoneChanged(tx, userId, user.phone, phone, { userId, userName: user.name, source: 'ui', ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId }));
  invalidatePrincipal(userId);
  return loadPrincipal(userId);
}
