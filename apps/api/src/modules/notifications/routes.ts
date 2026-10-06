import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import { paginationSchema } from '@/core/pagination';
import * as svc from './service';
import * as channels from './channels';
import { withSystem } from '@/db/client';

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/notifications/unread-count', { preHandler: app.auth(), schema: { tags: ['notifications'] } }, h((ctx) => svc.unreadCount(ctx)));
  r.get('/notifications', { preHandler: app.auth(), schema: { tags: ['notifications'], querystring: paginationSchema.extend({ unread: z.coerce.boolean().optional() }) } }, h((ctx, req) => {
    const q = req.query as { page: number; pageSize: number; unread?: boolean };
    return svc.list(ctx, q.page, q.pageSize, q.unread ?? false);
  }));
  r.post('/notifications/read', { preHandler: app.auth(), schema: { tags: ['notifications'], body: z.object({ ids: z.array(z.string().uuid()).optional(), all: z.boolean().optional() }) } }, h((ctx, req) => {
    const b = req.body as { ids?: string[]; all?: boolean };
    return svc.markRead(ctx, b.all ? 'all' : b.ids ?? []);
  }));
  r.get('/notifications/outbox', { preHandler: app.auth('admin:system', 'admin:config'), schema: { tags: ['notifications'], querystring: z.object({ channel: z.enum(['email', 'whatsapp']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }) } }, h((ctx, req) => {
    const q = req.query as { channel?: 'email' | 'whatsapp'; limit?: number };
    return svc.outboxStats(ctx, { channel: q.channel ?? null, limit: q.limit });
  }));

  // ------------------------------------------------------------ WhatsApp (admin)
  r.get('/notifications/whatsapp/status', { preHandler: app.auth('admin:system', 'admin:config'), schema: { tags: ['notifications'] } }, h((ctx) => channels.whatsappStatus(ctx)));
  r.get('/notifications/whatsapp/test/:id', { preHandler: app.auth('admin:system', 'admin:config'), schema: { tags: ['notifications'], params: z.object({ id: z.string().uuid() }) } }, h((ctx, req) => channels.whatsappMessageStatus(ctx, (req.params as { id: string }).id)));
  r.post('/notifications/whatsapp/enable-rules', { preHandler: app.auth('admin:config'), schema: { tags: ['notifications'] } }, h((ctx) => channels.enableWhatsAppOnRules(ctx)));
  r.post('/notifications/whatsapp/check', { preHandler: app.auth('admin:system'), config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['notifications'] } }, h((ctx) => channels.whatsappDiagnostics(ctx)));
  r.post('/notifications/whatsapp/test', { preHandler: app.auth('admin:system'), schema: { tags: ['notifications'], body: z.object({ to: z.string().min(6).max(30) }) } }, h((ctx, req) => channels.sendWhatsAppTest(ctx, (req.body as { to: string }).to)));

  // ------------------------------------------------------------ WhatsApp webhook (public; Meta calls it)
  await app.register(async (hook) => {
    // Keep the raw body so the signature Meta sends can be checked.
    hook.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as { rawBody?: string }).rawBody = body as string;
      try {
        done(null, body ? JSON.parse(body as string) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    });
    hook.get('/webhooks/whatsapp', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } }, schema: { tags: ['notifications'], hide: true } }, async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      const settings = await withSystem((tx) => channels.loadWhatsAppSettings(tx));
      if (q['hub.mode'] === 'subscribe' && settings.verifyToken && q['hub.verify_token'] === settings.verifyToken) return reply.type('text/plain').send(q['hub.challenge'] ?? '');
      return reply.code(403).send({ error: 'forbidden' });
    });
    hook.post('/webhooks/whatsapp', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } }, schema: { tags: ['notifications'], hide: true } }, async (req, reply) => {
      const settings = await withSystem((tx) => channels.loadWhatsAppSettings(tx));
      const raw = (req as { rawBody?: string }).rawBody ?? '';
      if (!channels.verifyWebhookSignature(raw, req.headers['x-hub-signature-256'] as string | undefined, settings.appSecret)) return reply.code(401).send({ error: 'bad signature' });
      const updated = await channels.applyWhatsAppStatuses(req.body);
      return reply.send({ ok: true, updated });
    });
  });
}
