import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '@/config';
import { logger } from '@/core/logger';

let transporter: Transporter | null = null;

export function mailer() {
  if (transporter) return transporter;
  if (!config.SMTP_HOST) {
    transporter = nodemailer.createTransport({ jsonTransport: true });
    logger.warn('SMTP_HOST not configured; emails are logged instead of sent');
    return transporter;
  }
  transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10_000,
  });
  return transporter;
}

export async function sendMail(opts: { to: string; subject: string; html: string; text?: string; attachments?: { filename: string; content: Buffer | string; contentType?: string }[] }) {
  const info = await mailer().sendMail({ from: config.SMTP_FROM, ...opts });
  if (!config.SMTP_HOST) logger.info({ to: opts.to, subject: opts.subject }, 'email (not sent: SMTP not configured)');
  return info;
}
