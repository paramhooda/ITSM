import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import { eq, and } from 'drizzle-orm';
import { config } from '@/config';
import { render, emailLayout } from '@/lib/templates';
import { enqueue } from '@/jobs/queues';
import { logger } from '@/core/logger';

export interface Recipient {
  userId?: string | null;
  email?: string | null;
  name?: string | null;
}

export interface NotificationInput {
  event: string;
  recipients: Recipient[];
  data: Record<string, unknown>;
  customerId?: string | null;
  channels?: ('email' | 'in_app')[];
  entityType?: string;
  entityId?: string;
  link?: string;
  /** Override title/body for in-app notifications (defaults derived from the template subject). */
  title?: string;
  body?: string;
}

/**
 * Renders the event template and writes outbound messages to the outbox plus
 * in-app notifications. Runs inside the caller's transaction, so nothing is
 * sent unless the business operation commits. Delivery happens in the worker.
 */
export async function queueNotification(tx: Tx, input: NotificationInput) {
  const channels = input.channels ?? ['email', 'in_app'];
  const [template] = await tx
    .select()
    .from(schema.notificationTemplates)
    .where(and(eq(schema.notificationTemplates.event, input.event), eq(schema.notificationTemplates.channel, 'email'), eq(schema.notificationTemplates.isActive, true)))
    .limit(1);
  const data = { platformName: 'MSP Service Management', appUrl: config.APP_URL, ...input.data };
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
  const seenEmails = new Set<string>();
  const seenUsers = new Set<string>();
  let queued = 0;
  for (const rcpt of input.recipients) {
    if (channels.includes('email') && rcpt.email && !seenEmails.has(rcpt.email.toLowerCase())) {
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
  }
  if (queued) void enqueue('notifications', 'deliver', {}, { delay: 500, jobId: `deliver-${Date.now()}` });
  return queued;
}
