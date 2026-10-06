import { eq, and, lte, lt, sql } from 'drizzle-orm';
import { registerProcessor, registerSchedule } from '../workers';
import { withSystem, schema } from '@/db/client';
import { sendMail } from '@/lib/email';
import { storage } from '@/lib/storage';
import { logger } from '@/core/logger';
import { PermanentChannelError, whatsappProvider, type TemplateRef } from '@/lib/channels';
import { loadWhatsAppSettings, whatsappClientConfig } from '@/modules/notifications/channels';

const MAX_ATTEMPTS = 5;

type OutboxRow = { id: string; channel: string; recipient: string; subject: string | null; body: string; body_text: string | null; attachments: { attachmentId?: string; filename: string; contentType?: string }[]; attempts: number; payload: { template?: TemplateRef; link?: string } | null };

async function deliverEmail(row: OutboxRow) {
  const attachments = [];
  for (const a of row.attachments ?? []) {
    if (!a.attachmentId) continue;
    const [att] = await withSystem((tx) => tx.select().from(schema.attachments).where(eq(schema.attachments.id, a.attachmentId!)).limit(1));
    if (att) attachments.push({ filename: a.filename || att.filename, content: await storage.get(att.storageKey), contentType: a.contentType ?? att.contentType });
  }
  await sendMail({ to: row.recipient, subject: row.subject ?? '(no subject)', html: row.body, text: row.body_text ?? undefined, attachments });
  return { providerMessageId: null as string | null };
}

async function deliverWhatsApp(row: OutboxRow) {
  const settings = await withSystem((tx) => loadWhatsAppSettings(tx));
  if (!settings.enabled) throw new PermanentChannelError('WhatsApp notifications are disabled');
  if (!settings.configured) throw new PermanentChannelError('WhatsApp is not configured');
  return whatsappProvider.send(whatsappClientConfig(settings), { to: row.recipient, subject: row.subject, text: row.body_text ?? row.body, template: row.payload?.template ?? null, link: row.payload?.link ?? null });
}

/** Delivers pending outbox rows. Idempotent: rows are claimed with SKIP LOCKED. */
export async function deliverOutbox(batch = 50) {
  let delivered = 0;
  let failed = 0;
  const rows = await withSystem(async (tx) => {
    const res = await tx.execute(sql`
      UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM notification_outbox
        WHERE status IN ('pending', 'retry') AND scheduled_at <= now() AND attempts < ${MAX_ATTEMPTS}
        ORDER BY scheduled_at LIMIT ${batch} FOR UPDATE SKIP LOCKED
      ) RETURNING id, channel, recipient, subject, body, body_text, attachments, attempts, payload`);
    return res.rows as OutboxRow[];
  });
  for (const row of rows) {
    try {
      let result: { providerMessageId?: string | null };
      if (row.channel === 'email') result = await deliverEmail(row);
      else if (row.channel === 'whatsapp') result = await deliverWhatsApp(row);
      else throw new PermanentChannelError(`Unsupported channel ${row.channel}`);
      await withSystem((tx) =>
        tx
          .update(schema.notificationOutbox)
          .set({ status: 'sent', sentAt: new Date(), lastError: null, providerMessageId: result.providerMessageId ?? null, deliveryStatus: row.channel === 'whatsapp' ? 'accepted' : null })
          .where(eq(schema.notificationOutbox.id, row.id)),
      );
      delivered++;
    } catch (err) {
      failed++;
      const message = (err as Error).message?.slice(0, 1000);
      const giveUp = row.attempts >= MAX_ATTEMPTS || err instanceof PermanentChannelError;
      await withSystem((tx) =>
        tx
          .update(schema.notificationOutbox)
          .set({ status: giveUp ? 'failed' : 'retry', lastError: message, scheduledAt: new Date(Date.now() + Math.min(60, 2 ** row.attempts) * 60_000) })
          .where(eq(schema.notificationOutbox.id, row.id)),
      );
      logger.warn({ id: row.id, channel: row.channel, err: message, giveUp }, 'outbox delivery failed');
    }
  }
  if (rows.length) logger.info({ delivered, failed }, 'outbox processed');
  return { delivered, failed };
}

registerProcessor({ queue: 'notifications', concurrency: 1, processor: async () => deliverOutbox() });

registerSchedule({ queue: 'notifications', jobName: 'deliver-outbox', pattern: '* * * * *' });

/** Sent and failed rows older than the retention setting are dropped once a day. */
registerSchedule({ queue: 'maintenance', jobName: 'outbox-purge', pattern: '15 3 * * *' });
registerProcessor({
  queue: 'maintenance',
  jobName: 'outbox-purge',
  processor: async () => {
    await withSystem(async (tx) => {
      const [row] = await tx.select({ value: schema.systemSettings.value }).from(schema.systemSettings).where(eq(schema.systemSettings.key, 'notifications.outbox_retention_days')).limit(1);
      const days = Math.max(7, Number(row?.value ?? 90) || 90);
      const res = await tx.execute(sql`DELETE FROM notification_outbox WHERE status IN ('sent', 'failed', 'cancelled') AND created_at < now() - (${days} || ' days')::interval`);
      // verification codes live ten minutes; the rows only serve the hourly counter
      await tx.execute(sql`DELETE FROM phone_verifications WHERE created_at < now() - interval '1 day'`);
      logger.info({ days, deleted: res.rowCount ?? 0 }, 'outbox purged');
    });
  },
});

/** Recover rows stuck in "sending" (worker crash mid-send). */
registerSchedule({ queue: 'maintenance', jobName: 'recover-outbox', pattern: '*/10 * * * *' });
registerProcessor({
  queue: 'maintenance',
  jobName: 'recover-outbox',
  processor: async () => {
    await withSystem((tx) =>
      tx
        .update(schema.notificationOutbox)
        .set({ status: 'retry' })
        .where(and(eq(schema.notificationOutbox.status, 'sending'), lt(schema.notificationOutbox.scheduledAt, new Date(Date.now() - 15 * 60_000)), lte(schema.notificationOutbox.attempts, MAX_ATTEMPTS))),
    );
  },
});
