import { z } from 'zod';

const uuid = z.string().uuid();

/** UI context sent by detail pages (`useUiStore().assistantContext`). */
export const chatContextSchema = z
  .object({
    label: z.string().max(200).optional(),
    entityType: z.string().max(40).optional(),
    entityId: z.string().max(80).optional(),
    customerId: z.string().max(80).optional(),
    title: z.string().max(300).optional(),
  })
  .passthrough();
export type ChatContext = z.infer<typeof chatContextSchema>;

export const chatBodySchema = z.object({
  conversationId: uuid.optional(),
  message: z.string().trim().min(1).max(8000),
  context: chatContextSchema.nullable().optional(),
});
export type ChatBody = z.infer<typeof chatBodySchema>;

export const idParam = z.object({ id: uuid });

export const decideBodySchema = z.object({ status: z.enum(['accepted', 'rejected']), note: z.string().max(2000).nullable().optional() });

export const draftUpdateBodySchema = z.object({ tone: z.enum(['neutral', 'formal', 'friendly', 'apologetic']).optional() }).default({});

export const classifyDraftBodySchema = z.object({
  title: z.string().trim().min(3).max(300),
  description: z.string().max(20000).nullable().optional(),
  customerId: uuid.optional(),
  type: z.enum(['incident', 'request', 'problem', 'change']).optional(),
});
export type ClassifyDraftBody = z.infer<typeof classifyDraftBodySchema>;

export const problemClustersQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  customerId: uuid.optional(),
  minCount: z.coerce.number().int().min(2).max(50).default(3),
});

export const suggestionsQuerySchema = z.object({ kind: z.string().max(40).optional() });
