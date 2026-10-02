import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Permission } from '@itsm/shared';
import { verifyAccessToken } from './tokens';
import { loadPrincipal, loadApiKeyPrincipal } from './principal';
import { sha256 } from '@/lib/crypto';
import { UnauthorizedError, ForbiddenError } from './errors';
import { can } from './authz';

/**
 * Resolves the principal from a Bearer access token, the access cookie, or an
 * integration API key. Routes opt in with `preHandler: app.auth()` or
 * `app.auth('tickets:read')`.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('principal', undefined);

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    let token: string | undefined;
    if (header?.startsWith('Bearer ')) token = header.slice(7);
    else if (req.cookies?.itsm_access) token = req.cookies.itsm_access;
    if (token) {
      const claims = await verifyAccessToken(token);
      if (claims) {
        const p = await loadPrincipal(claims.sub);
        if (p) req.principal = p;
      }
      return;
    }
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.length > 10) {
      const p = await loadApiKeyPrincipal(apiKey, sha256);
      if (p) req.principal = p;
    }
  });

  app.decorate('auth', (...perms: Permission[]) => {
    return async (req: FastifyRequest, _reply: FastifyReply) => {
      if (!req.principal) throw new UnauthorizedError();
      if (perms.length && !perms.some((perm) => can(req.principal!, perm))) {
        throw new ForbiddenError(`Missing permission: ${perms.join(' or ')}`);
      }
    };
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    auth: (...perms: Permission[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
