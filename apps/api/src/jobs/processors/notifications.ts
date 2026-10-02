import { eq, and, lte, lt, sql } from 'drizzle-orm';
import { registerProcessor, registerSchedule } from '../workers';
import { withSystem, schema } from '@/db/client';
import { sendMail } from '@/lib/email';
import { storage } from '@/lib/storage';
import { logger } from '@/core/logger';

const MAX_ATTEMPTS = 5;

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
      ) RETURNING id, channel, recipient, subject, body, body_text, attachments, attempts`);
    return res.rows as { id: string; channel: string; recipient: string; subject: string | null; body: string; body_text: string | null; attachments: { attachmentId?: string; filename: string; contentType?: string }[]; attempts: number }[];
  });
  for (const row of rows) {
    try {
      if (row.channel !== 'email') throw new Error(`Unsupported channel ${row.channel}`);
      const attachments = [];
      for (const a of row.attachments ?? []) {
        if (!a.attachmentId) continue;
        const [att] = await withSystem((tx) => tx.select().from(schema.attachments).where(eq(schema.attachments.id, a.attachmentId!)).limit(1));
        if (att) attachments.push({ filename: a.filename || att.filename, content: await storage.get(att.storageKey), contentType: a.contentType ?? att.contentType });
      }
      await sendMail({ to: row.recipient, subject: row.subject ?? '(no subject)', html: row.body, text: row.body_text ?? undefined, attachments });
      await withSystem((tx) => tx.update(schema.notificationOutbox).set({ status: 'sent', sentAt: new Date(), lastError: null }).where(eq(schema.notificationOutbox.id, row.id)));
      delivered++;
    } catch (err) {
      failed++;
      const message = (err as Error).message?.slice(0, 1000);
      const giveUp = row.attempts >= MAX_ATTEMPTS;
      await withSystem((tx) =>
        tx
          .update(schema.notificationOutbox)
          .set({ status: giveUp ? 'failed' : 'retry', lastError: message, scheduledAt: new Date(Date.now() + Math.min(60, 2 ** row.attempts) * 60_000) })
          .where(eq(schema.notificationOutbox.id, row.id)),
      );
      logger.warn({ id: row.id, err: message, giveUp }, 'email delivery failed');
    }
  }
  if (rows.length) logger.info({ delivered, failed }, 'outbox processed');
  return { delivered, failed };
}

registerProcessor({ queue: 'notifications', concurrency: 1, processor: async () => deliverOutbox() });

registerSchedule({ queue: 'notifications', jobName: 'deliver-outbox', pattern: '* * * * *' });

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
