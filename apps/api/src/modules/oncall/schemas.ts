import { z } from 'zod';

const uuid = z.string().uuid();
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const when = z.coerce.date();

export const rotaBodySchema = z.object({
  teamId: uuid,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  timezone: z.string().min(1).max(64).optional(),
  rotation: z.enum(['weekly', 'daily', 'custom']).optional(),
  rotationDays: z.number().int().min(1).max(365).optional(),
  handoffTime: hm.optional(),
  shiftStart: hm.nullable().optional(),
  shiftEnd: hm.nullable().optional(),
  startDate: isoDate,
  sortOrder: z.number().int().min(0).max(100).optional(),
  isActive: z.boolean().optional(),
  participants: z.array(uuid).max(50).optional(),
});
export type RotaBody = z.infer<typeof rotaBodySchema>;
export const rotaPatchSchema = rotaBodySchema.partial();
export type RotaPatch = z.infer<typeof rotaPatchSchema>;

export const overrideBodySchema = z.object({
  rotaId: uuid,
  userId: uuid,
  startsAt: when,
  endsAt: when,
  reason: z.string().trim().max(300).nullable().optional(),
});
export type OverrideBody = z.infer<typeof overrideBodySchema>;

export const stepSchema = z.object({
  target: z.enum(['oncall', 'user', 'team', 'manager']),
  userId: uuid.nullable().optional(),
  teamId: uuid.nullable().optional(),
  channels: z.array(z.enum(['email', 'in_app', 'whatsapp'])).min(1).max(3),
  timeoutMinutes: z.number().int().min(1).max(1440),
});

export const policyBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  steps: z.array(stepSchema).min(1).max(10),
  repeatCount: z.number().int().min(0).max(5).optional(),
  assignOnAck: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export type PolicyBody = z.infer<typeof policyBodySchema>;
export const policyPatchSchema = policyBodySchema.partial();
export type PolicyPatch = z.infer<typeof policyPatchSchema>;

export const teamPolicySchema = z.object({ policyId: uuid.nullable() });

export const nowQuerySchema = z.object({ teamId: uuid.optional(), at: when.optional() });
export const scheduleQuerySchema = z.object({ teamId: uuid, from: when, to: when });
export const overridesQuerySchema = z.object({ teamId: uuid.optional(), rotaId: uuid.optional(), from: when.optional(), to: when.optional() });
export const rotasQuerySchema = z.object({ teamId: uuid.optional() });

export const pageBodySchema = z.object({ ticketId: uuid, policyId: uuid.nullable().optional(), reason: z.string().trim().max(500).nullable().optional() });
export const pageAckSchema = z.object({ note: z.string().trim().max(500).nullable().optional() });
export const pageCancelSchema = z.object({ reason: z.string().trim().max(500).nullable().optional() });
export const pagesQuerySchema = z.object({ ticketId: uuid.optional(), status: z.enum(['open', 'pending', 'acked', 'escalated', 'expired', 'cancelled']).optional(), limit: z.coerce.number().int().min(1).max(200).optional() });
