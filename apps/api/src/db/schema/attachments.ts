import { pgTable, text, boolean, uuid, index, bigint, timestamp } from 'drizzle-orm/pg-core';
import { id } from './_common';
import { users } from './iam';

export const attachments = pgTable('attachments', {
  id: id(),
  customerId: uuid('customer_id'),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull().default('application/octet-stream'),
  size: bigint('size', { mode: 'number' }).notNull(),
  storageKey: text('storage_key').notNull(),
  sha256: text('sha256'),
  /** document type for contract/customer documents: agreement | po | sow | report | photo | signature | other */
  docType: text('doc_type').notNull().default('other'),
  title: text('title'),
  customerVisible: boolean('customer_visible').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('attachments_entity_idx').on(t.entityType, t.entityId), index('attachments_customer_idx').on(t.customerId)]);
