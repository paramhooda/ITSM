import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import { UnauthorizedError } from '@/core/errors';
import { stepsFor } from '@/modules/ai/service';
import * as svc from './service';
import { BRIEFING_ROLES } from './definitions';

const tags = ['briefings'];
const generateBody = z.object({ role: z.enum(BRIEFING_ROLES as [string, ...string[]]).optional() }).default({});

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  /** Generation calls the model, so it runs as separate short transactions rather than inside h(). */
  const steps = (req: FastifyRequest) => {
    if (!req.principal) throw new UnauthorizedError();
    return stepsFor(req.principal, { requestId: req.id, ip: req.ip, userAgent: req.headers['user-agent'] as string | undefined });
  };

  r.get('/briefings/today', { preHandler: app.auth(), schema: { tags } }, h((ctx) => svc.today(ctx)));
  r.post('/briefings/generate', { preHandler: app.auth(), config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags, body: generateBody } }, async (req) => svc.generate(steps(req), { role: (req.body as z.infer<typeof generateBody>).role as svc.GenerateOptions['role'], deliver: false }));
}
