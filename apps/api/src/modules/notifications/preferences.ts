import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY_KEYS } from '@itsm/shared';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { ForbiddenError, ValidationError } from '@/core/errors';
import { invalidatePrincipal } from '@/core/principal';
import { isCustomerUser } from '@/modules/tickets/common';
import { loadWhatsAppSettings } from './channels';

/**
 * Per-person notification preferences. Three layers decide what a person
 * receives for an event: the notification rule names the channels an event may
 * use at all; the administrator's defaults and locks per category
 * (notification_categories) say what is on unless the person chooses otherwise
 * and what nobody may switch off; the person's own matrix
 * (users.preferences.notifications) removes channels. In-app is never vetoed
 * and the account messages (welcome, password reset, verification code) are
 * always sent. The daily briefing row reads and writes
 * preferences.briefing.channels, the array the briefing card owns.
 */

export const NOTIFICATION_PREF_CHANNELS = ['email', 'whatsapp'] as const;
export type PrefChannel = (typeof NOTIFICATION_PREF_CHANNELS)[number];
const cellSchema = z.object({ email: z.boolean().optional(), whatsapp: z.boolean().optional() }).strict();
/** Only the cells a person set explicitly are stored; absent keys mean "the administrator's default". The same shape is the body of a save. */
const notificationPrefsSchema = z.partialRecord(z.enum(NOTIFICATION_CATEGORY_KEYS), cellSchema);
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;
export const updatePreferencesBody = z.object({ rows: notificationPrefsSchema });
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesBody>;

const CATEGORY_KEYS = new Set<string>(NOTIFICATION_CATEGORY_KEYS);
const BRIEFING_CHANNELS = ['email', 'in_app'] as const;

/** Tolerant reader: unknown keys and the legacy `{ email, inApp }` booleans are dropped, never thrown; `{}` and null give `{}`. */
export function notificationPrefsOf(preferences: Record<string, unknown> | null | undefined): NotificationPrefs {
  const raw = preferences?.notifications;
  const out: NotificationPrefs = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, cell] of Object.entries(raw as Record<string, unknown>)) {
    if (!CATEGORY_KEYS.has(key) || !cell || typeof cell !== 'object' || Array.isArray(cell)) continue;
    const c = cell as Record<string, unknown>;
    const clean: { email?: boolean; whatsapp?: boolean } = {};
    if (typeof c.email === 'boolean') clean.email = c.email;
    if (typeof c.whatsapp === 'boolean') clean.whatsapp = c.whatsapp;
    if (Object.keys(clean).length) out[key] = clean;
  }
  return out;
}

/** The briefing's chosen channels as the card stores them (defaults to both when unset or malformed). */
export function briefingChannelsOf(preferences: Record<string, unknown> | null | undefined): string[] {
  const briefing = preferences?.briefing;
  const raw = briefing && typeof briefing === 'object' ? (briefing as Record<string, unknown>).channels : undefined;
  if (!Array.isArray(raw)) return [...BRIEFING_CHANNELS];
  return raw.filter((c): c is string => typeof c === 'string' && (BRIEFING_CHANNELS as readonly string[]).includes(c));
}

// ---------------------------------------------------------------- the administrator's policy

export interface CategoryPolicy {
  key: string;
  emailDefault: boolean;
  emailLocked: boolean;
  whatsappDefault: boolean;
  whatsappLocked: boolean;
}

let cache: { at: number; value: Map<string, CategoryPolicy> } | null = null;
const CACHE_MS = 30_000;

/** notification_categories as a map by key, cached 30 seconds per process (the worker applies an administrator's change within that). */
export async function loadCategoryPolicies(tx: Tx): Promise<Map<string, CategoryPolicy>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const rows = await tx
    .select({ key: schema.notificationCategories.key, emailDefault: schema.notificationCategories.emailDefault, emailLocked: schema.notificationCategories.emailLocked, whatsappDefault: schema.notificationCategories.whatsappDefault, whatsappLocked: schema.notificationCategories.whatsappLocked })
    .from(schema.notificationCategories);
  const value = new Map(rows.map((r) => [r.key, r]));
  cache = { at: Date.now(), value };
  return value;
}

/** Forget the cached policies (after an administrator saves a default, and in tests). */
export function resetNotificationCategoryCache() {
  cache = null;
}

/** locked → true; else the person's explicit choice; else the administrator's default; no policy row → true. Pure. */
export function channelAllowed(policy: CategoryPolicy | undefined, prefs: NotificationPrefs, channel: PrefChannel): boolean {
  const def = policy ? (channel === 'email' ? policy.emailDefault : policy.whatsappDefault) : true;
  const locked = policy ? (channel === 'email' ? policy.emailLocked : policy.whatsappLocked) : false;
  if (locked) return true;
  const own = policy ? prefs[policy.key]?.[channel] : undefined;
  return own ?? def;
}

// ---------------------------------------------------------------- the person's matrix

export interface MatrixRow {
  key: string;
  label: string;
  description: string;
  email: { on: boolean; default: boolean; locked: boolean };
  whatsapp: { on: boolean; default: boolean; locked: boolean; available: boolean };
  inApp: true;
}

export interface PreferenceMatrix {
  audience: 'staff' | 'customer';
  rows: MatrixRow[];
  whatsapp: { channelEnabled: boolean; phone: string | null; optIn: boolean; verifiedAt: string | null };
}

export type Audience = PreferenceMatrix['audience'];

/** Rows for one audience: the shared definition, the table row (defaults, locks), the person's choice. */
export function buildRows(audience: Audience, policies: Map<string, CategoryPolicy>, prefs: NotificationPrefs, briefingChannels: string[]): MatrixRow[] {
  return NOTIFICATION_CATEGORIES.filter((c) => c.audience === 'both' || c.audience === audience).map((c) => {
    const p = policies.get(c.key);
    const isBriefing = c.key === 'briefing';
    return {
      key: c.key,
      label: audience === 'customer' ? (c.customerLabel ?? c.label) : c.label,
      description: audience === 'customer' ? (c.customerDescription ?? c.description) : c.description,
      email: isBriefing
        ? { on: briefingChannels.includes('email'), default: true, locked: false }
        : { on: channelAllowed(p, prefs, 'email'), default: p?.emailDefault ?? true, locked: p?.emailLocked ?? false },
      whatsapp: { on: c.whatsapp && channelAllowed(p, prefs, 'whatsapp'), default: c.whatsapp && (p?.whatsappDefault ?? false), locked: c.whatsapp && (p?.whatsappLocked ?? false), available: c.whatsapp },
      inApp: true,
    };
  });
}

/** Preferences belong to a signed-in person: API keys and the system principal have none. */
export function assertPerson(ctx: Ctx) {
  if (ctx.user.apiKeyId || ctx.user.isSystem) throw new ForbiddenError('Preferences belong to a person');
}

export const audienceOf = (ctx: Ctx): Audience => (isCustomerUser(ctx) ? 'customer' : 'staff');

async function loadPerson(ctx: Ctx) {
  const [user] = await ctx.tx
    .select({ id: schema.users.id, email: schema.users.email, customerId: schema.users.customerId, preferences: schema.users.preferences, phone: schema.users.phone, whatsappOptIn: schema.users.whatsappOptIn, whatsappVerifiedAt: schema.users.whatsappVerifiedAt })
    .from(schema.users)
    .where(eq(schema.users.id, ctx.user.id))
    .limit(1);
  if (!user) throw new ForbiddenError('Preferences belong to a person');
  return user;
}

/** The caller's effective matrix: rows of their audience, defaults and locks from the table, their own choices, the briefing row from preferences.briefing.channels. */
export async function myPreferences(ctx: Ctx): Promise<PreferenceMatrix> {
  assertPerson(ctx);
  const user = await loadPerson(ctx);
  const [policies, settings] = await Promise.all([loadCategoryPolicies(ctx.tx), loadWhatsAppSettings(ctx.tx)]);
  return {
    audience: audienceOf(ctx),
    rows: buildRows(audienceOf(ctx), policies, notificationPrefsOf(user.preferences), briefingChannelsOf(user.preferences)),
    whatsapp: { channelEnabled: settings.enabled && settings.configured, phone: user.phone, optIn: user.whatsappOptIn, verifiedAt: user.whatsappVerifiedAt ? user.whatsappVerifiedAt.toISOString() : null },
  };
}

/** One cell change, checked against the row the person is offered: locked rows, email-only rows and WhatsApp without the opt-in are refused. */
export function checkCell(rows: MatrixRow[], key: string, channel: PrefChannel, value: boolean, optIn: boolean): MatrixRow {
  const row = rows.find((r) => r.key === key);
  if (!row) throw new ValidationError('Unknown notification category for your account');
  if (channel === 'whatsapp' && !row.whatsapp.available) throw new ValidationError(`${row.label} is not sent over WhatsApp`);
  if (row[channel].locked && value === false) throw new ValidationError(`${row.label} cannot be switched off`);
  if (channel === 'whatsapp' && value && !optIn) throw new ValidationError('Turn on WhatsApp notifications on your profile first');
  return row;
}

/**
 * Merges explicit choices into users.preferences.notifications (the briefing
 * row's email cell goes to preferences.briefing.channels instead), audits the
 * change and returns the fresh matrix. Only the keys this function owns are
 * written; every other key of users.preferences is left as it is.
 */
export async function updateMyPreferences(ctx: Ctx, input: UpdatePreferencesInput): Promise<PreferenceMatrix> {
  assertPerson(ctx);
  const user = await loadPerson(ctx);
  const policies = await loadCategoryPolicies(ctx.tx);
  const audience = audienceOf(ctx);
  const existing = notificationPrefsOf(user.preferences);
  const oldBriefingChannels = briefingChannelsOf(user.preferences);
  const rows = buildRows(audience, policies, existing, oldBriefingChannels);
  const merged: NotificationPrefs = JSON.parse(JSON.stringify(existing)) as NotificationPrefs;
  let briefingEmail: boolean | null = null;
  let touched = false;
  for (const [key, cell] of Object.entries(input.rows)) {
    if (!cell) continue;
    for (const channel of NOTIFICATION_PREF_CHANNELS) {
      const value = cell[channel];
      if (value === undefined) continue;
      checkCell(rows, key, channel, value, user.whatsappOptIn);
      touched = true;
      if (key === 'briefing') {
        briefingEmail = value;
        continue;
      }
      merged[key] = { ...(merged[key] ?? {}), [channel]: value };
    }
  }
  if (!touched) return myPreferences(ctx);
  const chosen = new Set(oldBriefingChannels);
  if (briefingEmail === true) chosen.add('email');
  if (briefingEmail === false) chosen.delete('email');
  const newBriefingChannels = BRIEFING_CHANNELS.filter((c) => chosen.has(c));
  const briefingBefore = user.preferences.briefing && typeof user.preferences.briefing === 'object' ? (user.preferences.briefing as Record<string, unknown>) : {};
  const preferences: Record<string, unknown> = {
    ...user.preferences,
    notifications: merged,
    ...(briefingEmail === null ? {} : { briefing: { ...briefingBefore, channels: newBriefingChannels } }),
  };
  await ctx.tx.update(schema.users).set({ preferences, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
  const changes: Record<string, { old: unknown; new: unknown }> = { notifications: { old: existing, new: merged } };
  if (briefingEmail !== null) changes.briefingChannels = { old: oldBriefingChannels, new: newBriefingChannels };
  await ctx.audit({ entityType: 'user', entityId: user.id, entityLabel: user.email, action: 'notification_preferences.update', customerId: user.customerId, changes });
  invalidatePrincipal(user.id);
  return myPreferences(ctx);
}
