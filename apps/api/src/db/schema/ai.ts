import { pgTable, text, uuid, jsonb, index, integer, timestamp } from 'drizzle-orm/pg-core';
import { id, timestamps } from './_common';
import { users } from './iam';

export const aiConversations = pgTable('ai_conversations', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id'),
  title: text('title'),
  context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (t) => [index('ai_conversations_user_idx').on(t.userId, t.updatedAt), index('ai_conversations_updated_idx').on(t.updatedAt)]);

export const aiMessages = pgTable('ai_messages', {
  id: id(),
  conversationId: uuid('conversation_id').notNull().references(() => aiConversations.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id'),
  role: text('role').notNull(),
  content: text('content').notNull(),
  toolCalls: jsonb('tool_calls').$type<Record<string, unknown>[]>().notNull().default([]),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  /** Tokens served from the provider's prompt cache (a subset of the input). */
  cacheReadTokens: integer('cache_read_tokens'),
  durationMs: integer('duration_ms'),
  model: text('model'),
  promptVersion: text('prompt_version'),
  /** 'up' | 'down' from the person who read the reply. */
  feedback: text('feedback'),
  feedbackNote: text('feedback_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('ai_messages_conversation_idx').on(t.conversationId, t.createdAt), index('ai_messages_created_idx').on(t.createdAt)]);

/** AI recommendations are always explicit and reviewable; nothing is applied silently. */
export const aiSuggestions = pgTable('ai_suggestions', {
  id: id(),
  customerId: uuid('customer_id'),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  rationale: text('rationale'),
  confidence: integer('confidence'),
  status: text('status').notNull().default('proposed'),
  decidedBy: uuid('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('ai_suggestions_entity_idx').on(t.entityType, t.entityId, t.kind)]);
