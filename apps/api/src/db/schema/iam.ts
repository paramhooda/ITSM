import { pgTable, text, boolean, timestamp, uuid, jsonb, index, uniqueIndex, primaryKey, integer, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id, timestamps, userTypeEnum, userStatusEnum } from './_common';
import { customers } from './customers';

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull(),
  passwordHash: text('password_hash'),
  name: text('name').notNull(),
  phone: text('phone'),
  /** The person asked for WhatsApp notifications on their phone number (Meta requires an opt-in). */
  whatsappOptIn: boolean('whatsapp_opt_in').notNull().default(false),
  whatsappOptedInAt: timestamp('whatsapp_opted_in_at', { withTimezone: true }),
  title: text('title'),
  userType: userTypeEnum('user_type').notNull().default('msp'),
  status: userStatusEnum('status').notNull().default('active'),
  customerId: uuid('customer_id').references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
  timezone: text('timezone').notNull().default('UTC'),
  locale: text('locale').notNull().default('en'),
  avatarUrl: text('avatar_url'),
  preferences: jsonb('preferences').$type<Record<string, unknown>>().notNull().default({}),
  authProvider: text('auth_provider').notNull().default('local'),
  externalId: text('external_id'),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [
  uniqueIndex('users_email_idx').on(t.email),
  index('users_customer_idx').on(t.customerId),
]);

export const roles = pgTable('roles', {
  id: id(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  userType: userTypeEnum('user_type').notNull().default('msp'),
  isSystem: boolean('is_system').notNull().default(false),
  /** Navigation areas shown to holders of this role; null = everything their permissions allow. */
  navAreas: text('nav_areas').array(),
  ...timestamps,
});

export const rolePermissions = pgTable('role_permissions', {
  roleId: uuid('role_id').notNull().references((): AnyPgColumn => roles.id, { onDelete: 'cascade' }),
  permission: text('permission').notNull(),
}, (t) => [primaryKey({ columns: [t.roleId, t.permission] })]);

export const teams = pgTable('teams', {
  id: id(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  teamType: text('team_type').notNull().default('general'),
  email: text('email'),
  managerUserId: uuid('manager_user_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
});

export const teamMembers = pgTable('team_members', {
  teamId: uuid('team_id').notNull().references((): AnyPgColumn => teams.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
  isLead: boolean('is_lead').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.teamId, t.userId] })]);

/** Role assignment, optionally scoped to a single customer. */
export const userRoles = pgTable('user_roles', {
  id: id(),
  userId: uuid('user_id').notNull().references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id').notNull().references((): AnyPgColumn => roles.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid('created_by'),
}, (t) => [
  uniqueIndex('user_roles_unique_idx').on(t.userId, t.roleId, t.customerId),
  index('user_roles_user_idx').on(t.userId),
]);

/** Explicit customer visibility grants for MSP users without tenant:all. */
export const userCustomerAccess = pgTable('user_customer_access', {
  userId: uuid('user_id').notNull().references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.customerId] })]);

export const sessions = pgTable('sessions', {
  id: id(),
  userId: uuid('user_id').notNull().references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
  refreshTokenHash: text('refresh_token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  ip: text('ip'),
  userAgent: text('user_agent'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('sessions_user_idx').on(t.userId), uniqueIndex('sessions_token_idx').on(t.refreshTokenHash)]);

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: id(),
  userId: uuid('user_id').notNull().references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** API keys for integrations (monitoring, SIEM, automation). */
export const apiKeys = pgTable('api_keys', {
  id: id(),
  name: text('name').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
  customerId: uuid('customer_id').references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
