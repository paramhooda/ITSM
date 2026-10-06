import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import { eq, and, inArray } from 'drizzle-orm';
import { notificationCategoryOf } from '@itsm/shared';
import { config } from '@/config';
import { render, emailLayout } from '@/lib/templates';
import { enqueue } from '@/jobs/queues';
import { logger } from '@/core/logger';
import { normalizePhone } from '@/lib/channels';
import { loadWhatsAppSettings, templateForEvent } from './channels';
import { loadCategoryPolicies, notificationPrefsOf, channelAllowed } from './preferences';

export type NotificationChannel = 'email' | 'in_app' | 'whatsapp';
export const NOTIFICATION_CHANNELS: NotificationChannel[] = ['email', 'in_app', 'whatsapp'];

export interface Recipient {
  userId?: string | null;
  email?: string | null;
  name?: string | null;
  /** Mobile number; WhatsApp rows are written only when `whatsappOptIn` is set. */
  phone?: string | null;
  whatsappOptIn?: boolean | null;
}

export interface NotificationInput {
  event: string;
  recipients: Recipient[];
  data: Record<string, unknown>;
  customerId?: string | null;
  channels?: NotificationChannel[];
  entityType?: string;
  entityId?: string;
  link?: string;
  /** The link the WhatsApp message carries when it should differ from `link` (for example a one-tap acknowledgement URL). */
  whatsappLink?: string;
  /** Override title/body for in-app notifications (defaults derived from the template subject). */
  title?: string;
  body?: string;
}

/**
 * Renders the event template and writes outbound messages to the outbox plus
 * in-app notifications. Runs inside the caller's transaction, so nothing is
 * sent unless the business operation commits. Delivery happens in the worker.
 *
 * For recipients with an account, the person's notification preferences and the
 * administrator's defaults and locks for the event's category decide whether an
 * email or WhatsApp row is written (in-app never consults them); recipients
 * without a user id (contacts, rule addresses) and events outside every category
 * (account messages) keep the caller's channels. A recipient whose resolver did
 * not say gets the number and the WhatsApp opt-in from the user row.
 */
export async function queueNotification(tx: Tx, input: NotificationInput) {
  const channels = input.channels ?? ['email', 'in_app'];
  const [template] = await tx
    .select()
    .from(schema.notificationTemplates)
    .where(and(eq(schema.notificationTemplates.event, input.event), eq(schema.notificationTemplates.channel, 'email'), eq(schema.notificationTemplates.isActive, true)))
    .limit(1);
  const data = { platformName: 'Progression', appUrl: config.APP_URL, ...input.data };
  let subject = input.title ?? input.event;
  let html = '';
  if (template) {
    try {
      subject = render(template.subject ?? input.event, data);
      html = emailLayout(subject, render(template.body, data));
    } catch (err) {
      logger.warn({ err, event: input.event }, 'template render failed');
      html = emailLayout(subject, `<p>${subject}</p>`);
    }
  } else {
    html = emailLayout(subject, `<p>${input.body ?? subject}</p>`);
  }
  // WhatsApp: a short text template per event becomes the parameters of the approved Meta template.
  let whatsapp: { settings: Awaited<ReturnType<typeof loadWhatsAppSettings>>; subject: string; text: string; link: string } | null = null;
  if (channels.includes('whatsapp')) {
    const settings = await loadWhatsAppSettings(tx);
    if (settings.enabled && settings.configured) {
      const [waTemplate] = await tx
        .select()
        .from(schema.notificationTemplates)
        .where(and(eq(schema.notificationTemplates.event, input.event), eq(schema.notificationTemplates.channel, 'whatsapp'), eq(schema.notificationTemplates.isActive, true)))
        .limit(1);
      let text = input.body ?? subject;
      let waSubject = subject;
      if (waTemplate) {
        try {
          text = render(waTemplate.body, data);
          if (waTemplate.subject) waSubject = render(waTemplate.subject, data);
        } catch (err) {
          logger.warn({ err, event: input.event }, 'whatsapp template render failed');
        }
      }
      const raw = input.whatsappLink ?? input.link;
      const link = raw ? (raw.startsWith('http') ? raw : `${config.APP_URL.replace(/\/$/, '')}${raw}`) : config.APP_URL;
      whatsapp = { settings, subject: waSubject, text, link };
    }
  }
  const category = notificationCategoryOf(input.event);
  const userIds = [...new Set(input.recipients.map((r) => r.userId).filter((x): x is string => !!x))];
  const people = userIds.length
    ? await tx.select({ id: schema.users.id, preferences: schema.users.preferences, phone: schema.users.phone, whatsappOptIn: schema.users.whatsappOptIn }).from(schema.users).where(inArray(schema.users.id, userIds))
    : [];
  const personOf = new Map(people.map((p) => [p.id, p]));
  const policy = category ? (await loadCategoryPolicies(tx)).get(category) : undefined;
  const allows = (rcpt: Recipient, channel: 'email' | 'whatsapp') => {
    if (!category || !rcpt.userId) return true; // contacts, schedule addresses and account events keep today's behaviour
    const person = personOf.get(rcpt.userId);
    return person ? channelAllowed(policy, notificationPrefsOf(person.preferences), channel) : true;
  };
  const seenEmails = new Set<string>();
  const seenUsers = new Set<string>();
  const seenPhones = new Set<string>();
  let queued = 0;
  for (let rcpt of input.recipients) {
    const person = rcpt.userId ? personOf.get(rcpt.userId) : undefined;
    if (person && rcpt.phone === undefined && rcpt.whatsappOptIn === undefined) rcpt = { ...rcpt, phone: person.phone, whatsappOptIn: person.whatsappOptIn };
    if (channels.includes('email') && rcpt.email && allows(rcpt, 'email') && !seenEmails.has(rcpt.email.toLowerCase())) {
      seenEmails.add(rcpt.email.toLowerCase());
      await tx.insert(schema.notificationOutbox).values({
        channel: 'email',
        event: input.event,
        customerId: input.customerId ?? null,
        recipient: rcpt.email,
        subject,
        body: html,
        bodyText: input.body ?? subject,
        entityType: input.entityType,
        entityId: input.entityId,
      });
      queued++;
    }
    if (channels.includes('in_app') && rcpt.userId && !seenUsers.has(rcpt.userId)) {
      seenUsers.add(rcpt.userId);
      await tx.insert(schema.notifications).values({
        userId: rcpt.userId,
        customerId: input.customerId ?? null,
        event: input.event,
        title: subject,
        body: input.body ?? null,
        link: input.link ?? null,
        entityType: input.entityType,
        entityId: input.entityId,
      });
    }
    if (whatsapp && rcpt.whatsappOptIn && allows(rcpt, 'whatsapp')) {
      const phone = normalizePhone(rcpt.phone, whatsapp.settings.defaultCountryCode);
      if (phone && !seenPhones.has(phone)) {
        seenPhones.add(phone);
        const template = templateForEvent(whatsapp.settings, input.event, { subject: whatsapp.subject, text: whatsapp.text, link: whatsapp.link });
        if (template) {
          await tx.insert(schema.notificationOutbox).values({
            channel: 'whatsapp',
            event: input.event,
            customerId: input.customerId ?? null,
            recipient: phone,
            subject: whatsapp.subject,
            body: whatsapp.text,
            bodyText: whatsapp.text,
            payload: { template, link: whatsapp.link },
            entityType: input.entityType,
            entityId: input.entityId,
          });
          queued++;
        }
      }
    }
  }
  if (queued) void enqueue('notifications', 'deliver', {}, { delay: 500, jobId: `deliver-${Date.now()}` });
  return queued;
}
