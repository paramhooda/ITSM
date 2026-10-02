import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { config, isProd } from '@/config';
import * as svc from './service';
import { toPublicPrincipal } from '@/core/principal';
import { UnauthorizedError } from '@/core/errors';

const REFRESH_COOKIE = 'itsm_refresh';

function setRefreshCookie(reply: FastifyReply, token: string) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE || isProd && config.APP_URL.startsWith('https'),
    path: '/api/auth',
    maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400,
  });
}

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post('/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['auth'], body: z.object({ email: z.string().min(3), password: z.string().min(1) }) },
  }, async (req, reply) => {
    const result = await svc.login(req.body.email, req.body.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setRefreshCookie(reply, result.refreshToken);
    return { accessToken: result.accessToken, user: toPublicPrincipal(result.principal), mustChangePassword: result.mustChangePassword };
  });

  r.post('/auth/refresh', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } }, schema: { tags: ['auth'] } }, async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) throw new UnauthorizedError('No session');
    const result = await svc.refresh(token, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setRefreshCookie(reply, result.refreshToken);
    return { accessToken: result.accessToken, user: toPublicPrincipal(result.principal) };
  });

  r.post('/auth/logout', { schema: { tags: ['auth'] } }, async (req, reply) => {
    await svc.logout(req.cookies[REFRESH_COOKIE], req.principal?.id);
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return { ok: true };
  });

  r.get('/auth/me', { preHandler: app.auth(), schema: { tags: ['auth'] } }, async (req) => ({ user: toPublicPrincipal(req.principal!) }));

  r.patch('/auth/me', {
    preHandler: app.auth(),
    schema: { tags: ['auth'], body: z.object({ name: z.string().min(1).max(200).optional(), phone: z.string().max(50).optional(), timezone: z.string().max(64).optional(), preferences: z.record(z.string(), z.unknown()).optional() }) },
  }, async (req) => {
    const p = await svc.updatePreferences(req.principal!.id, req.body);
    return { user: toPublicPrincipal(p!) };
  });

  r.post('/auth/change-password', {
    preHandler: app.auth(),
    schema: { tags: ['auth'], body: z.object({ currentPassword: z.string(), newPassword: z.string() }) },
  }, async (req) => {
    await svc.changePassword(req.principal!.id, req.body.currentPassword, req.body.newPassword, { ip: req.ip, userAgent: req.headers['user-agent'] });
    return { ok: true };
  });

  r.post('/auth/forgot-password', {
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
    schema: { tags: ['auth'], body: z.object({ email: z.string().min(3) }) },
  }, async (req) => {
    await svc.requestPasswordReset(req.body.email);
    return { ok: true, message: 'If an account exists for this email, a reset link has been sent.' };
  });

  r.post('/auth/reset-password', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    schema: { tags: ['auth'], body: z.object({ token: z.string().min(10), password: z.string() }) },
  }, async (req) => {
    await svc.resetPassword(req.body.token, req.body.password);
    return { ok: true };
  });

  r.get('/auth/sessions', { preHandler: app.auth(), schema: { tags: ['auth'] } }, async (req) => ({ items: await svc.listSessions(req.principal!.id) }));

  r.delete('/auth/sessions/:id', { preHandler: app.auth(), schema: { tags: ['auth'], params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    await svc.revokeSession(req.principal!.id, req.params.id);
    return { ok: true };
  });

  r.post('/auth/sessions/revoke-all', { preHandler: app.auth(), schema: { tags: ['auth'] } }, async (req, reply) => {
    await svc.revokeAllSessions(req.principal!.id);
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return { ok: true };
  });
}
