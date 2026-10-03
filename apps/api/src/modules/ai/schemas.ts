import { z } from 'zod';

const uuid = z.string().uuid();

const shortString = (max: number) => z.string().max(max);

/** Where the user is: the route and its allowlisted filters (sent by the shells from the router). */
export const pageContextSchema = z.object({
  pathname: shortString(300),
  route: shortString(200).optional(),
  params: z.record(z.string().max(60), z.string().max(120)).optional(),
  query: z.record(z.string().max(60), z.string().max(200)).optional(),
});
export type PageContext = z.infer<typeof pageContextSchema>;

/** UI context sent by the panel: the record on screen (detail pages) and the page itself. */
export const chatContextSchema = z
  .object({
    label: shortString(200).optional(),
    entityType: shortString(40).optional(),
    entityId: shortString(80).optional(),
    title: shortString(300).optional(),
    page: pageContextSchema.optional(),
  })
  .passthrough();
export type ChatContext = z.infer<typeof chatContextSchema>;

export const SKILLS = ['lookup', 'triage', 'act', 'incident', 'approvals', 'knowledge', 'analyse', 'navigate', 'admin', 'selfservice'] as const;
export type SkillKey = (typeof SKILLS)[number];

/** A decision on the action the conversation is holding, bound to that action's id. */
export const confirmSchema = z.object({ actionId: uuid, decision: z.enum(['confirm', 'cancel']) });

export const chatBodySchema = z
  .object({
    conversationId: uuid.nullable().optional(),
    message: z.string().trim().max(8000).optional(),
    context: chatContextSchema.nullable().optional(),
    confirm: confirmSchema.nullable().optional(),
    skill: z.enum(SKILLS).optional(),
  })
  .refine((b) => (b.message && b.message.length > 0) || b.confirm, { message: 'A message or a confirmation is required', path: ['message'] });
export type ChatBody = z.infer<typeof chatBodySchema>;

export const feedbackBodySchema = z.object({ rating: z.enum(['up', 'down']).nullable(), note: z.string().max(1000).nullable().optional() });

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
