/**
 * Notification preferences per person and category, the administrator's
 * defaults and locks, the dispatch veto and the number fill, scheduled report
 * recipients, verified mobile numbers and the assistant's two tools.
 * Run with the dev environment sourced: npx vitest run test/notification-prefs.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray, desc, like, isNull } from 'drizzle-orm';
import { NOTIFICATION_EVENTS, NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY_KEYS, ALWAYS_SENT_EVENTS, notificationCategoryOf } from '@itsm/shared';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, toPublicPrincipal, type Principal } from '../src/core/principal';
import { encryptSecret } from '../src/lib/crypto';
import { AppError } from '../src/core/errors';
import { queueNotification } from '../src/modules/notifications/dispatch';
import { resetWhatsAppSettingsCache } from '../src/modules/notifications/channels';
import { notificationPrefsOf, channelAllowed, loadCategoryPolicies, resetNotificationCategoryCache, myPreferences, updateMyPreferences, type CategoryPolicy } from '../src/modules/notifications/preferences';
import { startPhoneVerification, confirmPhoneVerification, maskPhone } from '../src/modules/notifications/phone';
import { updatePreferences } from '../src/modules/auth/service';
import { updateUser } from '../src/modules/iam/service';
import { updatePortalUser } from '../src/modules/portal/service';
import { createConfig, updateConfig, deleteConfig, listConfig } from '../src/modules/config/service';
import { scheduleRecipients } from '../src/jobs/processors/reports';
import type { ScheduleRow } from '../src/modules/reports/schedules';
import { toolByName } from '../src/modules/ai/tools';
import { buildApp } from '../src/core/app';
import { signAccessToken } from '../src/core/tokens';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-prefs-${S}`, ip: '127.0.0.1' };
const PHONES = { staff: '+919810099003', verified: '+919810099001', portal: '+919810099002', moved: '+919810099004', moved2: '+919810099005', moved3: '+919810099006' };
const ids = { customer: '', staff: '', staff2: '', staff3: '', nophone: '', portal: '', portalAdmin: '' };
let admin: Principal;
let staff: Principal;
let staff2: Principal;
let staff3: Principal;
let nophone: Principal;
let portal: Principal;
let portalAdmin: Principal;
const as = (p: Principal) => <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(p, meta, fn);
const emailOf = (who: string) => `np-${who}-${S}@example.test`;

async function roleId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  return row!.id;
}
async function reload(id: string) {
  invalidatePrincipal(id);
  return (await loadPrincipal(id))!;
}
async function setSettings(values: Record<string, unknown>) {
  await withSystem(async (tx) => {
    for (const [key, value] of Object.entries(values)) {
      await tx.insert(schema.systemSettings).values({ key, value: value as never }).onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: value as never, updatedAt: new Date() } });
    }
  });
  resetWhatsAppSettingsCache();
}
/** The same values whatsapp.test.ts writes, so the two files never race each other to different settings. */
const ensureWhatsApp = () => setSettings({ 'whatsapp.enabled': true, 'whatsapp.phone_number_id': '100200300', 'whatsapp.access_token.secret': encryptSecret('test-token'), 'whatsapp.templates': { default: { name: 'progression_update', language: 'en', params: ['subject', 'text', 'link'] } } });
const prefsOf = async (id: string) => (await withSystem((tx) => tx.select({ preferences: schema.users.preferences }).from(schema.users).where(eq(schema.users.id, id))))[0]!.preferences;
const userRow = async (id: string) => (await withSystem((tx) => tx.select().from(schema.users).where(eq(schema.users.id, id))))[0]!;
const outbox = (channel: 'email' | 'whatsapp', recipient: string, event: string) => withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.channel, channel), eq(schema.notificationOutbox.recipient, recipient), eq(schema.notificationOutbox.event, event))));
const inApp = (userId: string, event: string) => withSystem((tx) => tx.select().from(schema.notifications).where(and(eq(schema.notifications.userId, userId), eq(schema.notifications.event, event))));
const audits = (entityId: string, action: string) => withSystem((tx) => tx.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, entityId), eq(schema.auditLog.action, action))).orderBy(desc(schema.auditLog.occurredAt)));
const failure = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('expected a failure');
};

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [c] = await tx.insert(schema.customers).values({ code: `NP${S.toUpperCase()}`, name: `Prefs Customer ${S}` }).returning();
    ids.customer = c!.id;
    const engineer = await roleId(tx, 'engineer');
    const customerUser = await roleId(tx, 'customer_user');
    const mk = async (values: Partial<typeof schema.users.$inferInsert> & { email: string; name: string }, role: string, customerId: string | null) => {
      const [u] = await tx.insert(schema.users).values({ userType: 'msp', status: 'active', ...values }).returning();
      await tx.insert(schema.userRoles).values({ userId: u!.id, roleId: role, customerId });
      return u!.id;
    };
    ids.staff = await mk({ email: emailOf('staff'), name: 'Prefs Staff', phone: PHONES.staff, whatsappOptIn: true, whatsappOptedInAt: new Date(), preferences: { notifications: { contracts: { email: false }, tickets: { whatsapp: false } } } }, engineer, null);
    ids.staff2 = await mk({ email: emailOf('staff2'), name: 'Prefs Staff Two', phone: PHONES.verified, whatsappOptIn: true, whatsappOptedInAt: new Date(), whatsappVerifiedAt: new Date() }, engineer, null);
    ids.staff3 = await mk({ email: emailOf('staff3'), name: 'Prefs Staff Three', phone: PHONES.verified, whatsappOptIn: true, whatsappOptedInAt: new Date() }, engineer, null);
    ids.nophone = await mk({ email: emailOf('nophone'), name: 'Prefs No Phone' }, engineer, null);
    ids.portal = await mk({ email: emailOf('portal'), name: 'Prefs Portal', userType: 'customer', customerId: c!.id, phone: PHONES.portal, whatsappOptIn: false }, customerUser, c!.id);
    ids.portalAdmin = await mk({ email: emailOf('portaladmin'), name: 'Prefs Portal Admin', userType: 'customer', customerId: c!.id }, await roleId(tx, 'customer_admin'), c!.id);
    const [a] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    admin = (await reload(a!.id))!;
  });
  staff = await reload(ids.staff);
  staff2 = await reload(ids.staff2);
  staff3 = await reload(ids.staff3);
  nophone = await reload(ids.nophone);
  portal = await reload(ids.portal);
  portalAdmin = await reload(ids.portalAdmin);
  await ensureWhatsApp();
  resetNotificationCategoryCache();
});

afterAll(async () => {
  await withSystem(async (tx) => {
    const users = Object.values(ids).filter((x) => x && x !== ids.customer);
    await tx.delete(schema.phoneVerifications).where(inArray(schema.phoneVerifications.userId, users));
    await tx.delete(schema.notificationOutbox).where(inArray(schema.notificationOutbox.recipient, [...Object.values(PHONES), emailOf('staff'), emailOf('staff2'), emailOf('contact')]));
    await tx.delete(schema.notificationOutbox).where(like(schema.notificationOutbox.recipient, `np-%-${S}@example.test`));
    await tx.delete(schema.users).where(inArray(schema.users.id, users));
    await tx.delete(schema.customers).where(eq(schema.customers.id, ids.customer));
  });
  resetNotificationCategoryCache();
  await closeDb();
});

describe('catalogue and seeds', () => {
  it('maps every event except the account messages to exactly one category and seeds the fifteen rows', async () => {
    const counts = new Map<string, number>();
    for (const c of NOTIFICATION_CATEGORIES) for (const e of c.events) counts.set(e, (counts.get(e) ?? 0) + 1);
    for (const e of NOTIFICATION_EVENTS) {
      if (ALWAYS_SENT_EVENTS.includes(e)) {
        expect(notificationCategoryOf(e), e).toBeNull();
        expect(counts.has(e), e).toBe(false);
      } else {
        expect(counts.get(e), e).toBe(1);
        expect(notificationCategoryOf(e), e).toBeTruthy();
      }
    }
    expect(ALWAYS_SENT_EVENTS).toEqual(['user.welcome', 'user.password_reset', 'user.phone_verification']);
    const rows = await withSystem((tx) => tx.select().from(schema.notificationCategories));
    expect(rows).toHaveLength(NOTIFICATION_CATEGORIES.length);
    expect(NOTIFICATION_CATEGORIES).toHaveLength(15);
    for (const r of rows) expect(NOTIFICATION_CATEGORY_KEYS).toContain(r.key);
    expect(rows.find((r) => r.key === 'paging')).toMatchObject({ emailDefault: true, emailLocked: true, whatsappDefault: true, whatsappLocked: true, isSystem: true });
    expect(rows.find((r) => r.key === 'sla')).toMatchObject({ emailLocked: true, whatsappLocked: false });
    expect(rows.find((r) => r.key === 'briefing')).toMatchObject({ emailDefault: true, whatsappDefault: false });
    const policies = await withSystem((tx) => loadCategoryPolicies(tx));
    expect(policies.get('approvals')?.emailLocked).toBe(true);
  });

  it('reads a person\'s stored choices tolerantly', () => {
    expect(notificationPrefsOf({})).toEqual({});
    expect(notificationPrefsOf(null)).toEqual({});
    expect(notificationPrefsOf({ notifications: { email: true, inApp: false } })).toEqual({});
    expect(notificationPrefsOf({ notifications: { garbage: { email: false }, tickets: 'no', sla: { email: 'yes', whatsapp: false }, contracts: { email: false } } })).toEqual({ sla: { whatsapp: false }, contracts: { email: false } });
    expect(notificationPrefsOf({ notifications: [1, 2] })).toEqual({});
  });

  it('decides a channel from the lock, then the explicit choice, then the default', () => {
    const locked: CategoryPolicy = { key: 'sla', emailDefault: true, emailLocked: true, whatsappDefault: true, whatsappLocked: false };
    const open: CategoryPolicy = { key: 'tickets', emailDefault: true, emailLocked: false, whatsappDefault: false, whatsappLocked: false };
    expect(channelAllowed(locked, { sla: { email: false } }, 'email')).toBe(true);
    expect(channelAllowed(locked, { sla: { whatsapp: false } }, 'whatsapp')).toBe(false);
    expect(channelAllowed(open, { tickets: { whatsapp: true } }, 'whatsapp')).toBe(true);
    expect(channelAllowed(open, {}, 'whatsapp')).toBe(false);
    expect(channelAllowed(open, {}, 'email')).toBe(true);
    expect(channelAllowed(undefined, { tickets: { email: false } }, 'email')).toBe(true);
  });
});

describe('the person\'s matrix', () => {
  it('gives staff their fourteen rows and a customer user the ten customer rows with customer wording', async () => {
    const mine = await as(staff)((ctx) => myPreferences(ctx));
    expect(mine.audience).toBe('staff');
    expect(mine.rows).toHaveLength(14);
    expect(mine.rows.map((r) => r.key)).not.toContain('knowledge');
    expect(mine.rows.find((r) => r.key === 'contracts')!.email).toMatchObject({ on: false, default: true, locked: false });
    expect(mine.rows.find((r) => r.key === 'tickets')!.whatsapp).toMatchObject({ on: false, default: true, locked: false, available: true });
    expect(mine.rows.find((r) => r.key === 'sla')!.email).toMatchObject({ on: true, locked: true });
    expect(mine.rows.find((r) => r.key === 'briefing')!.whatsapp.available).toBe(false);
    expect(mine.rows.find((r) => r.key === 'briefing')!.email.on).toBe(true);
    expect(mine.rows.every((r) => r.inApp === true)).toBe(true);
    expect(mine.whatsapp).toMatchObject({ channelEnabled: true, phone: PHONES.staff, optIn: true, verifiedAt: null });
    const two = await as(staff2)((ctx) => myPreferences(ctx));
    expect(two.whatsapp.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const theirs = await as(portal)((ctx) => myPreferences(ctx));
    expect(theirs.audience).toBe('customer');
    expect(theirs.rows.map((r) => r.key)).toEqual(['tickets', 'replies', 'closure', 'escalations', 'approvals', 'changes', 'field', 'feedback', 'knowledge', 'reports']);
    for (const key of ['sla', 'paging', 'handover', 'briefing', 'contracts']) expect(theirs.rows.map((r) => r.key)).not.toContain(key);
    expect(theirs.rows.find((r) => r.key === 'tickets')).toMatchObject({ label: 'Ticket updates', description: 'Your ticket is logged, assigned or changes status.' });
    expect(theirs.rows.find((r) => r.key === 'escalations')!.label).toBe('Major incident updates');
    const text = theirs.rows.map((r) => `${r.label} ${r.description}`).join(' ').toLowerCase();
    for (const word of ['escalat', 'sentiment', 'overdue', 'unhappy', 'you handled', 'missed']) expect(text, word).not.toContain(word);
    expect(theirs.whatsapp).toMatchObject({ phone: PHONES.portal, optIn: false, verifiedAt: null });
  });

  it('refuses API-key principals', async () => {
    const key = { ...staff, apiKeyId: 'k' } as Principal;
    const err = await failure(as(key)((ctx) => myPreferences(ctx)));
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe('Preferences belong to a person');
  });

  it('never lets the profile route overwrite the matrix with a stale copy of preferences', async () => {
    await updatePreferences(ids.staff2, { preferences: { notifications: { tickets: { email: false } }, whatsapp: { assistant: true }, briefing: { enabled: true, time: '07:30', role: 'auto', channels: ['email'] } } }, {});
    const stored = await prefsOf(ids.staff2);
    expect(stored.notifications).toBeUndefined();
    expect(stored.whatsapp).toBeUndefined();
    expect((stored.briefing as { time: string }).time).toBe('07:30');
    const mine = await as(staff2)((ctx) => myPreferences(ctx));
    expect(mine.rows.find((r) => r.key === 'tickets')!.email.on).toBe(true);
    expect(mine.rows.find((r) => r.key === 'briefing')!.email.on).toBe(true);
  });

  it('stores only the patched cells, refuses what the row does not allow, and routes the briefing cell to the briefing card', async () => {
    const after = await as(staff)((ctx) => updateMyPreferences(ctx, { rows: { feedback: { whatsapp: false } } }));
    expect(after.rows.find((r) => r.key === 'feedback')!.whatsapp.on).toBe(false);
    expect((await prefsOf(ids.staff)).notifications).toEqual({ contracts: { email: false }, tickets: { whatsapp: false }, feedback: { whatsapp: false } });

    expect((await failure(as(staff)((ctx) => updateMyPreferences(ctx, { rows: { sla: { email: false } } })))).message).toBe('SLA warnings and breaches cannot be switched off');
    expect((await failure(as(staff)((ctx) => updateMyPreferences(ctx, { rows: { knowledge: { email: false } } })))).message).toBe('Unknown notification category for your account');
    expect((await failure(as(portal)((ctx) => updateMyPreferences(ctx, { rows: { sla: { email: false } } })))).message).toBe('Unknown notification category for your account');
    expect((await failure(as(portal)((ctx) => updateMyPreferences(ctx, { rows: { tickets: { whatsapp: true } } })))).message).toBe('Turn on WhatsApp notifications on your profile first');
    expect((await failure(as(staff)((ctx) => updateMyPreferences(ctx, { rows: { briefing: { whatsapp: true } } })))).message).toBe('Daily briefing is not sent over WhatsApp');
    // a refused patch leaves the stored choices as they were
    expect((await prefsOf(ids.staff)).notifications).toEqual({ contracts: { email: false }, tickets: { whatsapp: false }, feedback: { whatsapp: false } });

    const briefing = await as(staff)((ctx) => updateMyPreferences(ctx, { rows: { briefing: { email: false } } }));
    expect(briefing.rows.find((r) => r.key === 'briefing')!.email.on).toBe(false);
    const stored = await prefsOf(ids.staff);
    expect((stored.briefing as { channels: string[] }).channels).toEqual(['in_app']);
    expect((stored.notifications as Record<string, unknown>).briefing).toBeUndefined();
    const back = await as(staff)((ctx) => updateMyPreferences(ctx, { rows: { briefing: { email: true } } }));
    expect(back.rows.find((r) => r.key === 'briefing')!.email.on).toBe(true);
    expect(((await prefsOf(ids.staff)).briefing as { channels: string[] }).channels).toEqual(['email', 'in_app']);

    const rows = await audits(ids.staff, 'notification_preferences.update');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect((rows[rows.length - 1]!.changes as { notifications: { old: unknown; new: unknown } }).notifications.new).toMatchObject({ feedback: { whatsapp: false } });
  });
});

describe('dispatch', () => {
  const data = { ticket: { number: `INC-${S}`, title: 'Prefs ticket', typeLabel: 'Incident', customerName: 'Prefs Customer', priority: 'P3', status: 'New', link: '/tickets/x' }, contract: { number: `CT-${S}`, name: 'Prefs contract', customerName: 'Prefs Customer', endDate: '2026-12-31', link: '/contracts/x' }, visit: { number: `FV-${S}`, title: 'Prefs visit', siteName: 'HQ', engineer: 'Someone', scheduledStart: new Date().toISOString() }, pm: { programName: 'Prefs PM', customerName: 'Prefs Customer', date: '2026-11-01' }, actor: 'Service Desk', reason: '', daysLeft: 10 };

  it('vetoes the channels a person switched off, keeps in-app, honours locks and leaves contacts alone', async () => {
    // contracts.email is off for the staff user: no email row, the in-app row still arrives
    const queuedContract = await withSystem((tx) => queueNotification(tx, { event: 'contract.expiring', recipients: [{ userId: ids.staff, email: emailOf('staff'), name: 'Prefs Staff' }], data, channels: ['email', 'in_app'], customerId: ids.customer }));
    expect(queuedContract).toBe(0);
    expect(await outbox('email', emailOf('staff'), 'contract.expiring')).toHaveLength(0);
    expect(await inApp(ids.staff, 'contract.expiring')).toHaveLength(1);
    // tickets.whatsapp is off: the email goes, the WhatsApp row does not, even though the resolver passed the opt-in
    const queuedTicket = await withSystem((tx) => queueNotification(tx, { event: 'ticket.created', recipients: [{ userId: ids.staff, email: emailOf('staff'), name: 'Prefs Staff', phone: PHONES.staff, whatsappOptIn: true }], data, channels: ['email', 'whatsapp'], customerId: ids.customer }));
    expect(queuedTicket).toBe(1);
    expect(await outbox('email', emailOf('staff'), 'ticket.created')).toHaveLength(1);
    expect(await outbox('whatsapp', PHONES.staff, 'ticket.created')).toHaveLength(0);
    // a locked category ignores a choice written straight to the row (the API refuses to store it)
    const before = await prefsOf(ids.staff);
    await withSystem((tx) => tx.update(schema.users).set({ preferences: { ...before, notifications: { ...(before.notifications as object), paging: { email: false } } } }).where(eq(schema.users.id, ids.staff)));
    try {
      const queuedPage = await withSystem((tx) => queueNotification(tx, { event: 'page.sent', recipients: [{ userId: ids.staff, email: emailOf('staff'), name: 'Prefs Staff' }], data, channels: ['email', 'in_app'], customerId: ids.customer }));
      expect(queuedPage).toBe(1);
      expect(await outbox('email', emailOf('staff'), 'page.sent')).toHaveLength(1);
    } finally {
      await withSystem((tx) => tx.update(schema.users).set({ preferences: before }).where(eq(schema.users.id, ids.staff)));
    }
    // a recipient without an account keeps the caller's channels, and a vetoed user sharing the address does not block it
    const contact = emailOf('contact');
    const queuedContact = await withSystem((tx) => queueNotification(tx, { event: 'contract.expiring', recipients: [{ userId: ids.staff, email: contact, name: 'Prefs Staff' }, { email: contact, name: 'Prefs Contact' }], data, channels: ['email'], customerId: ids.customer }));
    expect(queuedContact).toBe(1);
    expect(await outbox('email', contact, 'contract.expiring')).toHaveLength(1);
    // account messages never consult a preference
    expect(notificationCategoryOf('user.phone_verification')).toBeNull();
  });

  it('fills the number and the opt-in from the user row when the resolver did not say', async () => {
    await ensureWhatsApp();
    const queued = await withSystem((tx) => queueNotification(tx, { event: 'field_visit.scheduled', recipients: [{ userId: ids.staff, email: emailOf('staff'), name: 'Prefs Staff' }], data, channels: ['email', 'in_app', 'whatsapp'], customerId: ids.customer }));
    expect(queued).toBe(2);
    expect(await outbox('whatsapp', PHONES.staff, 'field_visit.scheduled')).toHaveLength(1);
    // the same for a person who did not opt in: nothing on WhatsApp
    await withSystem((tx) => queueNotification(tx, { event: 'pm.scheduled', recipients: [{ userId: ids.portal, email: emailOf('portal'), name: 'Prefs Portal' }], data, channels: ['email', 'whatsapp'], customerId: ids.customer }));
    expect(await outbox('whatsapp', PHONES.portal, 'pm.scheduled')).toHaveLength(0);
    // a resolver that passes the opt-in explicitly is never second-guessed
    await withSystem((tx) => queueNotification(tx, { event: 'field_visit.completed', recipients: [{ userId: ids.staff, email: emailOf('staff'), name: 'Prefs Staff', whatsappOptIn: false }], data, channels: ['email', 'whatsapp'], customerId: ids.customer }));
    expect(await outbox('whatsapp', PHONES.staff, 'field_visit.completed')).toHaveLength(0);
  });

  it('drops a scheduled report recipient who switched the reports category off and keeps explicit addresses', async () => {
    await as(staff)((ctx) => updateMyPreferences(ctx, { rows: { reports: { email: false } } }));
    try {
      const schedule = { recipients: ['Explicit@Example.test'], recipientUserIds: [ids.staff, ids.staff2], filters: {} } as unknown as ScheduleRow;
      const emails = await withSystem((tx) => scheduleRecipients(tx, schedule, null));
      expect(emails).toContain('explicit@example.test');
      expect(emails).toContain(emailOf('staff2'));
      expect(emails).not.toContain(emailOf('staff'));
    } finally {
      await as(staff)((ctx) => updateMyPreferences(ctx, { rows: { reports: { email: true } } }));
    }
  });
});

describe('verified mobile numbers', () => {
  const latestCode = async (phone: string) => {
    const [row] = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.channel, 'whatsapp'), eq(schema.notificationOutbox.recipient, phone), eq(schema.notificationOutbox.event, 'user.phone_verification'))).orderBy(desc(schema.notificationOutbox.createdAt)).limit(1));
    const params = (row!.payload as { template: { params: string[] } }).template.params;
    const code = /\b(\d{6})\b/.exec(params[1]!)?.[1];
    expect(code, 'the six-digit code is in the WhatsApp text').toBeTruthy();
    return { code: code!, row: row! };
  };

  it('sends a code over WhatsApp, counts attempts, verifies the number without touching the opt-in, and voids a code after five tries', async () => {
    await ensureWhatsApp();
    const started = await as(staff)((ctx) => startPhoneVerification(ctx, { method: 'sent' }));
    expect(started).toMatchObject({ method: 'sent', sentTo: '+91••••9003' });
    expect(maskPhone(PHONES.staff)).toBe('+91••••9003');
    const rows = await withSystem((tx) => tx.select().from(schema.phoneVerifications).where(eq(schema.phoneVerifications.userId, ids.staff)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: 'sent', phone: PHONES.staff, attempts: 0, consumedAt: null });
    expect(rows[0]!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    const { code, row } = await latestCode(PHONES.staff);
    expect(row.body).not.toContain(rows[0]!.codeHash);
    expect((await audits(ids.staff, 'phone.verification_sent'))[0]!.metadata).toMatchObject({ method: 'sent', phone: '+91••••9003' });
    // the code itself never reaches the audit log
    expect(JSON.stringify(await audits(ids.staff, 'phone.verification_sent'))).not.toContain(code);

    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    expect((await failure(as(staff)((ctx) => confirmPhoneVerification(ctx, wrong)))).message).toBe('That code is not right, 4 attempts left');
    const matrix = await as(staff)((ctx) => confirmPhoneVerification(ctx, code));
    expect(matrix.whatsapp.verifiedAt).toMatch(/^\d{4}-/);
    const user = await userRow(ids.staff);
    expect(user.whatsappVerifiedAt).toBeInstanceOf(Date);
    expect(user.phone).toBe(PHONES.staff);
    expect(user.whatsappOptIn).toBe(true);
    expect((await audits(ids.staff, 'phone.verified'))[0]!.metadata).toMatchObject({ method: 'sent', phone: '+91••••9003' });
    expect((await withSystem((tx) => tx.select().from(schema.phoneVerifications).where(and(eq(schema.phoneVerifications.userId, ids.staff), eq(schema.phoneVerifications.id, rows[0]!.id)))))[0]!.consumedAt).toBeInstanceOf(Date);
    expect((await reload(ids.staff)).whatsappVerifiedAt).toBeInstanceOf(Date);
    expect(typeof toPublicPrincipal(await reload(ids.staff)).whatsappVerifiedAt).toBe('string');

    // five wrong codes void the code
    await ensureWhatsApp();
    await as(staff)((ctx) => startPhoneVerification(ctx, {}));
    const second = await latestCode(PHONES.staff);
    const bad = String((Number(second.code) + 7) % 1_000_000).padStart(6, '0');
    for (const left of [4, 3, 2, 1]) expect((await failure(as(staff)((ctx) => confirmPhoneVerification(ctx, bad)))).message).toBe(`That code is not right, ${left} attempts left`);
    expect((await failure(as(staff)((ctx) => confirmPhoneVerification(ctx, bad)))).message).toBe('Too many attempts; request a new code');
    expect((await failure(as(staff)((ctx) => confirmPhoneVerification(ctx, second.code)))).message).toBe('No code is waiting; request a new one');

    // three codes an hour: the third goes, the fourth is refused
    await ensureWhatsApp();
    await as(staff)((ctx) => startPhoneVerification(ctx, {}));
    const limited = await failure(as(staff)((ctx) => startPhoneVerification(ctx, {})));
    expect(limited.statusCode).toBe(429);
    expect(limited.code).toBe('verification_rate_limited');
  });

  it('refuses a missing number, a platform without WhatsApp, and a number verified on another account', async () => {
    expect((await failure(as(nophone)((ctx) => startPhoneVerification(ctx, {})))).message).toBe('Save a mobile number in your profile first');
    await setSettings({ 'whatsapp.enabled': false });
    try {
      const off = await failure(as(staff2)((ctx) => startPhoneVerification(ctx, {})));
      expect(off.statusCode).toBe(422);
      expect(off.message).toBe('WhatsApp is not set up on this platform, or no template is mapped');
      expect(await withSystem((tx) => tx.select().from(schema.phoneVerifications).where(eq(schema.phoneVerifications.userId, ids.staff2)))).toHaveLength(0);
    } finally {
      await ensureWhatsApp();
    }
    const taken = await failure(as(staff3)((ctx) => startPhoneVerification(ctx, {})));
    expect(taken.statusCode).toBe(409);
    expect(taken.message).toBe('That number is verified on another account');
  });

  it('clears the verification when the number changes on the profile or through the users page, and keeps it when only the formatting changes', async () => {
    const moved = await updatePreferences(ids.staff, { phone: PHONES.moved }, { ip: '127.0.0.1', requestId: meta.requestId });
    expect(moved!.phone).toBe(PHONES.moved);
    expect(moved!.whatsappVerifiedAt).toBeNull();
    expect((await userRow(ids.staff)).whatsappVerifiedAt).toBeNull();
    expect((await audits(ids.staff, 'phone.verification_cleared'))[0]!.metadata).toMatchObject({ reason: 'phone_changed', from: '+91••••9003', to: '+91••••9004' });

    await as(admin)((ctx) => updateUser(ctx, ids.staff2, { phone: PHONES.moved2 }));
    expect((await userRow(ids.staff2)).whatsappVerifiedAt).toBeNull();
    expect((await audits(ids.staff2, 'phone.verification_cleared'))[0]!.metadata).toMatchObject({ reason: 'phone_changed' });
    await withSystem((tx) => tx.update(schema.users).set({ whatsappVerifiedAt: new Date() }).where(eq(schema.users.id, ids.staff2)));
    await as(admin)((ctx) => updateUser(ctx, ids.staff2, { phone: '+91 98100 99005' }));
    const kept = await userRow(ids.staff2);
    expect(kept.whatsappVerifiedAt).toBeInstanceOf(Date);
    expect(kept.phone).toBe(PHONES.moved2);
    const same = await updatePreferences(ids.staff2, { phone: '+91 98100 99005' }, {});
    expect(same!.whatsappVerifiedAt).toBeInstanceOf(Date);
  });

  it('consumes an open code when a customer administrator changes the number of one of their users', async () => {
    await ensureWhatsApp();
    await withSystem((tx) => tx.update(schema.users).set({ phone: PHONES.portal, whatsappVerifiedAt: new Date() }).where(eq(schema.users.id, ids.portal)));
    await withSystem((tx) => tx.delete(schema.phoneVerifications).where(eq(schema.phoneVerifications.userId, ids.portal)));
    await as(portal)((ctx) => startPhoneVerification(ctx, {}));
    const open = await withSystem((tx) => tx.select().from(schema.phoneVerifications).where(and(eq(schema.phoneVerifications.userId, ids.portal), isNull(schema.phoneVerifications.consumedAt))));
    expect(open).toHaveLength(1);
    // the customer administrator's row-level context cannot see the portal user's codes; the clear still reaches them
    await as(portalAdmin)((ctx) => updatePortalUser(ctx, ids.portal, { phone: PHONES.moved3 }));
    const after = await userRow(ids.portal);
    expect(after.phone).toBe(PHONES.moved3);
    expect(after.whatsappVerifiedAt).toBeNull();
    expect(await withSystem((tx) => tx.select().from(schema.phoneVerifications).where(and(eq(schema.phoneVerifications.userId, ids.portal), isNull(schema.phoneVerifications.consumedAt))))).toHaveLength(0);
    expect((await audits(ids.portal, 'phone.verification_cleared'))[0]!.metadata).toMatchObject({ reason: 'phone_changed', to: '+91••••9006' });
    expect((await failure(as(portal)((ctx) => confirmPhoneVerification(ctx, '000000')))).message).toBe('No code is waiting; request a new one');
    await withSystem((tx) => tx.update(schema.users).set({ phone: PHONES.portal }).where(eq(schema.users.id, ids.portal)));
  });
});

describe('the administrator\'s defaults', () => {
  const kind = 'notification-categories';
  const rowOf = async (key: string) => ((await as(admin)((ctx) => listConfig(ctx, kind))) as unknown as { id: string; key: string }[]).find((r) => r.key === key)!;

  it('refuses locks without a default, platform fields, new rows, deletions and the briefing row; applies and audits a lock', async () => {
    const changes = await rowOf('changes');
    expect((await failure(as(admin)((ctx) => updateConfig(ctx, kind, changes.id, { emailLocked: true, emailDefault: false })))).message).toBe('A locked channel must be on by default');
    expect((await failure(as(admin)((ctx) => updateConfig(ctx, kind, changes.id, { key: 'x' })))).message).toBe('Categories are defined by the platform');
    expect((await failure(as(admin)((ctx) => updateConfig(ctx, kind, changes.id, { sortOrder: 5 })))).message).toBe('Categories are defined by the platform');
    expect((await failure(as(admin)((ctx) => updateConfig(ctx, kind, changes.id, { emailLocked: 'maybe' })))).message).toBe('emailLocked must be true or false');
    const reports = await rowOf('reports');
    expect((await failure(as(admin)((ctx) => updateConfig(ctx, kind, reports.id, { whatsappLocked: true })))).message).toBe('Scheduled reports is not sent over WhatsApp');
    const briefing = await rowOf('briefing');
    expect((await failure(as(admin)((ctx) => updateConfig(ctx, kind, briefing.id, { emailDefault: false })))).message).toBe('The daily briefing is chosen by each person on their profile');
    expect((await failure(as(admin)((ctx) => createConfig(ctx, kind, { key: 'extra' })))).message).toBe('Categories cannot be added');
    expect((await failure(as(admin)((ctx) => deleteConfig(ctx, kind, changes.id)))).statusCode).toBe(422);
    expect((await rowOf('changes')).id).toBe(changes.id);

    await as(admin)((ctx) => updateConfig(ctx, kind, changes.id, { emailLocked: true }));
    try {
      expect((await withSystem((tx) => loadCategoryPolicies(tx))).get('changes')?.emailLocked).toBe(true);
      const locked = await as(staff)((ctx) => myPreferences(ctx));
      expect(locked.rows.find((r) => r.key === 'changes')!.email).toMatchObject({ on: true, locked: true });
      expect((await failure(as(staff)((ctx) => updateMyPreferences(ctx, { rows: { changes: { email: false } } })))).message).toBe('Changes and CAB cannot be switched off');
      const [audit] = await withSystem((tx) => tx.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityType, 'notification_category'), eq(schema.auditLog.entityId, changes.id))).orderBy(desc(schema.auditLog.occurredAt)).limit(1));
      expect(audit).toMatchObject({ action: 'update', entityLabel: 'changes' });
      expect(audit!.changes).toMatchObject({ emailLocked: { old: false, new: true } });
    } finally {
      await as(admin)((ctx) => updateConfig(ctx, kind, changes.id, { emailLocked: false }));
    }
    expect((await withSystem((tx) => loadCategoryPolicies(tx))).get('changes')?.emailLocked).toBe(false);
    const [rule] = (await as(admin)((ctx) => listConfig(ctx, 'notification-rules'))) as { id: string }[];
    expect((await failure(as(admin)((ctx) => updateConfig(ctx, 'notification-rules', rule!.id, { channels: ['sms'] })))).message).toContain('"sms" is not a channel');
  });
});

describe('the assistant', () => {
  it('lists the person\'s own preferences with a masked number and previews one cell change with the row\'s rules', async () => {
    const mine = (await as(portal)((ctx) => toolByName('my_notification_preferences')!.run(ctx, {}))) as { rows: { key: string }[]; facts: string[]; whatsapp: { phoneMasked: string | null }; link: string };
    expect(mine.rows.map((r) => r.key)).not.toContain('sla');
    expect(mine.rows).toHaveLength(10);
    expect(mine.whatsapp.phoneMasked).toBe('+91••••9002');
    expect(mine.facts.some((f) => f.includes('+91••••9002') && f.includes('not verified'))).toBe(true);
    expect(mine.link).toBe('/profile');

    const set = toolByName('set_notification_preference')!;
    const preview = (await as(staff)((ctx) => set.preview!(ctx, { category: 'sla', channel: 'whatsapp', enabled: false }))) as { text: string; lines: string[] };
    expect(preview.text).toBe('Turn WhatsApp off for "SLA warnings and breaches"');
    expect(preview.lines).toContain('Email stays on');
    await expect(as(staff)((ctx) => set.preview!(ctx, { category: 'sla', channel: 'email', enabled: false }))).rejects.toThrow(/cannot be switched off/);
    await expect(as(portal)((ctx) => set.preview!(ctx, { category: 'sla', channel: 'whatsapp', enabled: false }))).rejects.toThrow(/Unknown notification category/);
    await expect(as(portal)((ctx) => set.preview!(ctx, { category: 'tickets', channel: 'whatsapp', enabled: true }))).rejects.toThrow(/Turn on WhatsApp/);
    const done = (await as(staff)((ctx) => set.run(ctx, { category: 'closure', channel: 'whatsapp', enabled: false }))) as { label: string; facts: string[] };
    expect(done.label).toBe('Resolution and closure');
    expect(done.facts[0]).toBe('Resolution and closure: WhatsApp off');
    expect((await prefsOf(ids.staff)).notifications).toMatchObject({ closure: { whatsapp: false } });

    const upsert = toolByName('upsert_config')!;
    const byKey = (await as(admin)((ctx) => upsert.preview!(ctx, { kind: 'notification-categories', record: 'approvals', fields: { emailLocked: false } }))) as { text: string };
    expect(byKey.text).toContain('"approvals"');
    expect(byKey.text).toContain('emailLocked → false (was true)');
  });
});

describe('over HTTP', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const headers = async (p: Principal) => ({ authorization: `Bearer ${await signAccessToken(p.id, `test-${S}`)}` });
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('serves the matrix, validates the bodies, maps the service errors and keeps the defaults readable but not writable for a customer user', async () => {
    const mine = await app.inject({ method: 'GET', url: '/api/notifications/preferences', headers: await headers(staff) });
    expect(mine.statusCode).toBe(200);
    expect((mine.json() as { rows: unknown[]; audience: string }).rows).toHaveLength(14);
    const locked = await app.inject({ method: 'PUT', url: '/api/notifications/preferences', headers: await headers(staff), payload: { rows: { sla: { email: false } } } });
    expect(locked.statusCode).toBe(422);
    expect((locked.json() as { message: string }).message).toBe('SLA warnings and breaches cannot be switched off');
    const bogus = await app.inject({ method: 'PUT', url: '/api/notifications/preferences', headers: await headers(staff), payload: { rows: { nonsense: { email: false } } } });
    expect(bogus.statusCode).toBe(400);
    const ok = await app.inject({ method: 'PUT', url: '/api/notifications/preferences', headers: await headers(staff), payload: { rows: { handover: { email: false } } } });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { rows: { key: string; email: { on: boolean } }[] }).rows.find((r) => r.key === 'handover')!.email.on).toBe(false);
    const short = await app.inject({ method: 'POST', url: '/api/notifications/phone/verify/confirm', headers: await headers(staff), payload: { code: '12' } });
    expect(short.statusCode).toBe(400);
    const waiting = await app.inject({ method: 'POST', url: '/api/notifications/phone/verify/confirm', headers: await headers(staff), payload: { code: '000000' } });
    expect(waiting.statusCode).toBe(422);
    const limited = await app.inject({ method: 'POST', url: '/api/notifications/phone/verify/start', headers: await headers(staff), payload: { method: 'sent' } });
    expect(limited.statusCode).toBe(429);
    expect((limited.json() as { error: string }).error).toBe('verification_rate_limited');
    const anonymous = await app.inject({ method: 'GET', url: '/api/notifications/preferences' });
    expect(anonymous.statusCode).toBe(401);
    const defaults = await app.inject({ method: 'GET', url: '/api/config/notification-categories', headers: await headers(portal) });
    expect(defaults.statusCode).toBe(200);
    const rows = defaults.json() as { id: string; key: string }[];
    expect(rows).toHaveLength(15);
    const forbidden = await app.inject({ method: 'PATCH', url: `/api/config/notification-categories/${rows[0]!.id}`, headers: await headers(portal), payload: { emailDefault: false } });
    expect(forbidden.statusCode).toBe(403);
  });
});
