import { pgTable, text, boolean, uuid, jsonb, index, uniqueIndex, integer, timestamp } from 'drizzle-orm/pg-core';
import { id, timestamps, tsvector, searchExpr, domainEnum } from './_common';
import { customers } from './customers';
import { services } from './services';
import { users } from './iam';

export const kbCategories = pgTable('kb_categories', {
  id: id(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  parentId: uuid('parent_id'),
  domain: domainEnum('domain').notNull().default('general'),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps,
});

export const kbArticles = pgTable('kb_articles', {
  id: id(),
  number: text('number').notNull().unique(),
  title: text('title').notNull(),
  summary: text('summary'),
  body: text('body').notNull().default(''),
  categoryId: uuid('category_id').references(() => kbCategories.id, { onDelete: 'set null' }),
  /** sop | runbook | troubleshooting | faq | known_error | resolution | procedure */
  articleType: text('article_type').notNull().default('procedure'),
  domain: domainEnum('domain').notNull().default('general'),
  /** internal (MSP only) | customer (specific customer portal) | public (all customer portals) */
  visibility: text('visibility').notNull().default('internal'),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
  ciTypeKey: text('ci_type_key'),
  status: text('status').notNull().default('draft'),
  version: integer('version').notNull().default(1),
  authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
  reviewerId: uuid('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  tags: text('tags').array().notNull().default([]),
  relatedTicketIds: uuid('related_ticket_ids').array().notNull().default([]),
  viewCount: integer('view_count').notNull().default(0),
  helpfulCount: integer('helpful_count').notNull().default(0),
  notHelpfulCount: integer('not_helpful_count').notNull().default(0),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  searchVector: tsvector('search_vector').generatedAlwaysAs(searchExpr('number', 'title', 'summary', 'body')),
  ...timestamps,
}, (t) => [
  index('kb_articles_customer_idx').on(t.customerId),
  index('kb_articles_status_idx').on(t.status),
  index('kb_articles_category_idx').on(t.categoryId),
  index('kb_articles_search_idx').using('gin', t.searchVector),
]);

export const kbArticleVersions = pgTable('kb_article_versions', {
  id: id(),
  articleId: uuid('article_id').notNull().references(() => kbArticles.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id'),
  version: integer('version').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  summary: text('summary'),
  changedBy: uuid('changed_by'),
  changeNote: text('change_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('kb_article_versions_idx').on(t.articleId, t.version)]);
