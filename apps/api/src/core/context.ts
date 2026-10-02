import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import type { Permission } from '@itsm/shared';
import { withTenant, type Tx, type TenantContext } from '@/db/client';
import type { Principal } from './principal';
import { UnauthorizedError } from './errors';
import { writeAudit, type AuditEntry } from './audit';
import { can, requirePermission, requireCustomerAccess, canSeeCustomer } from './authz';

/**
 * Per-request context handed to service functions. It carries the principal,
 * a tenant-scoped transaction (RLS enforced) and an audit helper.
 */
export interface Ctx {
  user: Principal;
  tx: Tx;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  source: 'ui' | 'api' | 'ai' | 'integration' | 'system';
  can(perm: Permission, customerId?: string | null): boolean;
  require(perm: Permission, customerId?: string | null): void;
  requireCustomer(customerId: string | null | undefined): void;
  canSeeCustomer(customerId: string): boolean;
  audit(entry: AuditEntry): Promise<void>;
}

export function tenantContextOf(p: Principal): TenantContext {
  return {
    userId: p.apiKeyId ? null : p.id,
    allCustomers: p.customerScope === 'all',
    customerIds: p.customerScope === 'all' ? [] : p.customerScope,
  };
}

export function buildCtx(p: Principal, tx: Tx, meta: { requestId: string; ip?: string | null; userAgent?: string | null; source?: Ctx['source'] }): Ctx {
  const source = meta.source ?? (p.apiKeyId ? 'integration' : 'ui');
  const ctx: Ctx = {
    user: p,
    tx,
    requestId: meta.requestId,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
    source,
    can: (perm, customerId) => can(p, perm, customerId),
    require: (perm, customerId) => requirePermission(p, perm, customerId),
    requireCustomer: (customerId) => requireCustomerAccess(p, customerId),
    canSeeCustomer: (customerId) => canSeeCustomer(p, customerId),
    audit: (entry) =>
      writeAudit(tx, { userId: p.apiKeyId ? null : p.id, userName: p.name, source, ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId }, entry),
  };
  return ctx;
}

/** Runs a service function with a tenant-scoped transaction for an authenticated principal. */
export async function runAs<T>(p: Principal, meta: { requestId?: string; ip?: string | null; userAgent?: string | null; source?: Ctx['source'] }, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  return withTenant(tenantContextOf(p), (tx) => fn(buildCtx(p, tx, { requestId: meta.requestId ?? 'internal', ...meta })));
}

type Handler<R = unknown> = (ctx: Ctx, req: FastifyRequest, reply: FastifyReply) => Promise<R>;

/**
 * Route wrapper: opens the tenant transaction, builds the Ctx and runs the
 * handler. The transaction commits when the handler resolves and rolls back on
 * error, so every mutation (and its audit record) is atomic.
 */
export function h<R>(fn: Handler<R>): RouteHandlerMethod {
  return async function (this: unknown, req: FastifyRequest, reply: FastifyReply) {
    const p = req.principal;
    if (!p) throw new UnauthorizedError();
    return withTenant(tenantContextOf(p), (tx) =>
      fn(buildCtx(p, tx, { requestId: req.id, ip: req.ip, userAgent: req.headers['user-agent'] as string | undefined, source: p.apiKeyId ? 'integration' : 'ui' }), req, reply),
    );
  } as RouteHandlerMethod;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}
