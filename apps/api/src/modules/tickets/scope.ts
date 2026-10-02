import { eq } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import type { Ctx } from '@/core/context';
import { evaluateScope, selectContractForTicket, type ScopeEvaluation } from '@/modules/contracts/scope';
import { logger } from '@/core/logger';

export type { ScopeEvaluation };

export interface ScopeInput {
  customerId: string;
  serviceId?: string | null;
  siteId?: string | null;
  ticketCategoryId?: string | null;
  primaryCiId?: string | null;
  at?: Date;
}

/** Resolves the CI type key of the primary CI so scope rules on device types can apply. */
async function ciTypeKeyOf(tx: Tx, ciId: string | null | undefined): Promise<string | null> {
  if (!ciId) return null;
  const [row] = await tx.select({ key: schema.ciTypes.key }).from(schema.cis).innerJoin(schema.ciTypes, eq(schema.ciTypes.id, schema.cis.typeId)).where(eq(schema.cis.id, ciId)).limit(1);
  return row?.key ?? null;
}

/**
 * Scope classification is informational: a failure here must never block a
 * ticket operation, so errors degrade to `unknown`.
 */
export async function classifyScope(tx: Tx, input: ScopeInput): Promise<ScopeEvaluation> {
  try {
    const ciTypeKey = await ciTypeKeyOf(tx, input.primaryCiId);
    return await evaluateScope(tx, { customerId: input.customerId, serviceId: input.serviceId ?? null, siteId: input.siteId ?? null, ticketCategoryId: input.ticketCategoryId ?? null, ciTypeKey, at: input.at });
  } catch (err) {
    logger.warn({ err, customerId: input.customerId }, 'scope evaluation failed; defaulting to unknown');
    return { status: 'unknown', contractId: null, scopeItemId: null, reason: 'Scope could not be evaluated' };
  }
}

export async function contractForTicket(tx: Tx, input: { customerId: string; serviceId?: string | null; siteId?: string | null; at?: Date }) {
  try {
    return await selectContractForTicket(tx, input);
  } catch (err) {
    logger.warn({ err, customerId: input.customerId }, 'contract selection failed');
    return null;
  }
}

/** `POST /tickets/scope-preview`: what the classification would be for a customer/service/site/category combination. */
export async function scopePreview(ctx: Ctx, input: ScopeInput) {
  ctx.requireCustomer(input.customerId);
  const [scope, contract] = await Promise.all([classifyScope(ctx.tx, input), contractForTicket(ctx.tx, input)]);
  let contractInfo: { id: string; number: string; name: string; slaPolicyName: string | null } | null = null;
  const contractId = scope.contractId ?? contract?.contractId ?? null;
  if (contractId) {
    const [c] = await ctx.tx.select({ id: schema.contracts.id, number: schema.contracts.number, name: schema.contracts.name, slaPolicyId: schema.contracts.slaPolicyId }).from(schema.contracts).where(eq(schema.contracts.id, contractId)).limit(1);
    if (c) {
      const policyId = contract?.slaPolicyId ?? c.slaPolicyId;
      const [p] = policyId ? await ctx.tx.select({ name: schema.slaPolicies.name }).from(schema.slaPolicies).where(eq(schema.slaPolicies.id, policyId)).limit(1) : [];
      contractInfo = { id: c.id, number: c.number, name: c.name, slaPolicyName: p?.name ?? null };
    }
  }
  return { ...scope, contract: contractInfo, teamId: contract?.teamId ?? null };
}
