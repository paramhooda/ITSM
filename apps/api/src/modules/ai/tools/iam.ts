import { z } from 'zod';
import { listUsers, listRoles, listApiKeys } from '@/modules/iam/service';
import { listAudit } from '@/modules/audit/service';
import { outboxStats } from '@/modules/notifications/service';
import { assistantStatus } from '@/modules/whatsapp/service';
import { sql } from 'drizzle-orm';
import { define } from './types';
import { iso, trunc, resolveCustomerId, resolveUser, resolveTeam } from '../helpers';

/** Identity, audit and delivery tools: read-only by design (people, roles and keys are changed on their admin pages). */

export const IAM: ReturnType<typeof define>[] = [
  define({
    name: 'list_users',
    toolset: 'iam',
    description: 'Users (staff or customer) with status, roles, teams and last login. Read-only.',
    inputSchema: z.object({ q: z.string().max(200).optional(), userType: z.enum(['msp', 'customer']).optional(), customer: z.string().max(200).optional(), status: z.enum(['active', 'disabled', 'invited', 'locked']).optional(), team: z.string().max(200).optional(), roleKey: z.string().max(60).optional(), limit: z.number().int().min(1).max(30).optional() }),
    requires: ['admin:users'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      const team = await resolveTeam(ctx, input.team);
      const res = await listUsers(ctx, { page: 1, pageSize: input.limit ?? 20, q: input.q, userType: input.userType, customerId, status: input.status, teamId: team?.id, roleKey: input.roleKey, sort: 'name', order: 'asc' });
      return { total: res.total, facts: [`${res.total} user(s)${input.userType ? ` of type ${input.userType}` : ''}${input.status ? ` with status ${input.status}` : ''}`], items: res.items.map((u) => ({ id: u.id, name: u.name, email: u.email, userType: u.userType, status: u.status, customer: u.customerName, title: u.title, roles: u.roles.map((r) => r.name), teams: u.teams.map((t) => t.name), lastLoginAt: iso(u.lastLoginAt), link: `/admin/users/${u.id}` })) };
    },
    summary: (_i, result) => `Listed ${(result as { items: unknown[] }).items.length} users`,
  }),

  define({
    name: 'list_roles',
    toolset: 'iam',
    description: 'Roles with their permissions and how many users hold each. Read-only.',
    inputSchema: z.object({ q: z.string().max(100).optional() }),
    requires: ['admin:users'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const roles = await listRoles(ctx);
      const r = input.q?.toLowerCase();
      const items = roles.filter((x) => !r || x.name.toLowerCase().includes(r) || x.key.toLowerCase().includes(r));
      return { items: items.slice(0, 40).map((x) => ({ key: x.key, name: x.name, userType: x.userType, description: x.description, users: x.userCount, permissions: x.permissions, isSystem: x.isSystem })), link: '/admin/roles' };
    },
    summary: (_i, result) => `Listed ${(result as { items: unknown[] }).items.length} roles`,
  }),

  define({
    name: 'list_integration_keys',
    toolset: 'iam',
    description: 'API keys: name, prefix, scope, expiry, last use and revocation. Never the key itself. Read-only.',
    inputSchema: z.object({}),
    requires: ['integrations:manage'],
    portal: null,
    action: false,
    run: async (ctx) => {
      const keys = await listApiKeys(ctx);
      return { items: keys.slice(0, 50).map((k) => ({ name: k.name, prefix: k.keyPrefix, customer: k.customerName, permissions: k.permissions.length, lastUsedAt: iso(k.lastUsedAt), expiresAt: iso(k.expiresAt), revoked: !!k.revokedAt, createdAt: iso(k.createdAt) })), link: '/admin/api-keys' };
    },
    summary: (_i, result) => `Listed ${(result as { items: unknown[] }).items.length} API keys`,
  }),

  define({
    name: 'audit_search',
    toolset: 'iam',
    description: 'Search the audit log: who did what, when, on which record (field changes are masked for secrets). Use for "who changed", "what happened to", "actions by".',
    inputSchema: z.object({ q: z.string().max(200).optional().describe('Record label, action or user name'), action: z.string().max(80).optional().describe('Exact action or a prefix with *, e.g. ticket.* or ai.*'), entityType: z.string().max(40).optional(), user: z.string().max(200).optional().describe('"me", a name or an email'), customer: z.string().max(200).optional(), source: z.enum(['web', 'api', 'ai', 'system', 'job', 'integration']).optional(), from: z.string().max(30).optional(), to: z.string().max(30).optional(), limit: z.number().int().min(1).max(30).optional() }),
    requires: ['admin:audit'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const [user, customerId] = await Promise.all([resolveUser(ctx, input.user), resolveCustomerId(ctx, input.customer)]);
      const res = await listAudit(ctx, { page: 1, pageSize: input.limit ?? 20, q: input.q, action: input.action, entityType: input.entityType, userId: user?.id, customerId, source: input.source, from: input.from, to: input.to });
      const items = res.items as unknown as Record<string, unknown>[];
      return { total: res.total, window: res.window, facts: [`${res.total} audit entr${res.total === 1 ? 'y' : 'ies'} match${input.action ? ` action ${input.action}` : ''}${user ? ` by ${user.name}` : ''}`], items: items.map((e) => ({ at: iso(e.occurredAt as Date), action: e.action, entityType: e.entityType, entity: e.entityLabel ?? e.entityId, by: e.userName ?? null, source: e.source ?? null, customer: e.customerName ?? null, changes: Object.fromEntries(Object.entries((e.changes ?? {}) as Record<string, { old: unknown; new: unknown }>).slice(0, 8).map(([k, v]) => [k, `${trunc(String(v.old ?? ''), 60)} → ${trunc(String(v.new ?? ''), 60)}`])) })), link: '/admin/audit' };
    },
    summary: (_i, result) => `Searched the audit log (${(result as { items: unknown[] }).items.length} of ${(result as { total: number }).total} entries)`,
  }),

  define({
    name: 'notifications_status',
    toolset: 'iam',
    description: 'Notification delivery health: outbox counts by status and channel and the latest deliveries with errors.',
    inputSchema: z.object({ channel: z.enum(['email', 'whatsapp', 'in_app']).optional(), limit: z.number().int().min(1).max(20).optional() }),
    requires: [],
    anyOf: ['admin:system', 'admin:config'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const s = await outboxStats(ctx, { channel: input.channel ?? null, limit: input.limit ?? 10 });
      const failed = s.byStatus.failed ?? 0;
      return { byStatus: s.byStatus, byChannel: s.byChannel, facts: [`Outbox: ${Object.entries(s.byStatus).map(([k, v]) => `${v} ${k}`).join(', ') || 'empty'}${failed ? ` (${failed} failed)` : ''}`], recent: s.recent.map((r) => ({ at: iso(r.createdAt), channel: r.channel, event: r.event, recipient: r.recipient, subject: trunc(r.subject, 80), status: r.status, delivery: r.deliveryStatus, attempts: r.attempts, error: trunc(r.lastError, 160) })), link: '/admin/outbox' };
    },
    summary: () => 'Read the notification outbox status',
  }),

  define({
    name: 'whatsapp_chat_status',
    toolset: 'iam',
    description: 'Whether Grady answers on WhatsApp and how it is doing: switch state, readiness checks (app secret, feature switch, provider, webhook), how many people linked a number, and inbound messages, replies and failures over the last hours. Answers: is WhatsApp chat working, who can use it, why did nobody get a reply.',
    inputSchema: z.object({ hours: z.number().int().min(1).max(168).optional() }),
    requires: [],
    anyOf: ['admin:system', 'admin:config'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const hours = input.hours ?? 24;
      const s = await assistantStatus(ctx);
      const since = new Date(Date.now() - hours * 3_600_000);
      const [w] = (await ctx.tx.execute(sql`
        SELECT count(*)::int AS inbound,
          count(*) FILTER (WHERE outcome = 'replied')::int AS replied,
          count(*) FILTER (WHERE status = 'failed')::int AS failed,
          count(*) FILTER (WHERE outcome = 'unverified')::int AS unverified
        FROM whatsapp_inbound WHERE received_at >= ${since}`)).rows as { inbound: number; replied: number; failed: number; unverified: number }[];
      const problems = s.checks.filter((c) => c.level !== 'ok').length;
      const inbound = Number(w?.inbound ?? 0);
      const replied = Number(w?.replied ?? 0);
      const failed = Number(w?.failed ?? 0);
      const unverified = Number(w?.unverified ?? 0);
      return {
        enabled: s.enabled,
        ready: s.ready,
        checks: s.checks,
        linkedUsers: s.linkedUsers,
        verifiedUsers: s.verifiedUsers,
        hours,
        inbound,
        replied,
        failed,
        unverified,
        audiences: s.settings.audiences,
        dailyMessageCap: s.settings.dailyMessageCap,
        facts: [`WhatsApp chat: ${s.enabled ? 'on' : 'off'}, ${s.ready ? 'ready' : `${problems} thing${problems === 1 ? '' : 's'} to fix`}, ${s.linkedUsers} linked people, ${inbound} messages in the last ${hours} h, ${replied} answered, ${failed} failed, ${unverified} from unlinked numbers`],
        link: '/admin/whatsapp',
      };
    },
    summary: () => 'Read the WhatsApp chat status',
  }),
];
