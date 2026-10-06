import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import * as link from './link';
import * as svc from './service';
import { inboundQuery, type InboundQuery } from './schemas';

/**
 * The person's own chat flag (`/whatsapp/link`: any signed-in person, never an
 * API key) and the administrator's readiness and inbound log. The verification
 * of the number itself lives under `/notifications/phone/verify/*`; the
 * webhook under `/webhooks/whatsapp`; the two unlink routes next to the users
 * they act on (`/iam/users/:id/whatsapp/unlink`, `/portal/users/:id/whatsapp/unlink`).
 */
export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['whatsapp'];
  const flagLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };
  r.get('/whatsapp/link', { preHandler: app.auth(), schema: { tags } }, h((ctx) => link.linkStatus(ctx)));
  r.post('/whatsapp/link', { preHandler: app.auth(), config: flagLimit, schema: { tags } }, h((ctx) => link.setAssistantFlag(ctx, true)));
  r.delete('/whatsapp/link', { preHandler: app.auth(), config: flagLimit, schema: { tags } }, h((ctx) => link.setAssistantFlag(ctx, false)));
  r.get('/whatsapp/assistant/status', { preHandler: app.auth('admin:system', 'admin:config'), schema: { tags } }, h((ctx) => svc.assistantStatus(ctx)));
  r.get('/whatsapp/inbound', { preHandler: app.auth('admin:system', 'admin:config'), schema: { tags, querystring: inboundQuery } }, h((ctx, req) => svc.listInbound(ctx, req.query as InboundQuery)));
}
