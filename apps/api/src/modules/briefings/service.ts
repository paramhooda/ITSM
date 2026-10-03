import { and, eq, sql, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DateTime } from 'luxon';
import type { Ctx } from '@/core/context';
import { schema, withSystem, type Tx } from '@/db/client';
import { ForbiddenError, ValidationError } from '@/core/errors';
import { config } from '@/config';
import { logger } from '@/core/logger';
import { escapeHtml } from '@/lib/templates';
import { enqueue } from '@/jobs/queues';
import { loadPrincipal, invalidatePrincipal, type Principal } from '@/core/principal';
import { queueNotification } from '@/modules/notifications/dispatch';
import { llmJson, enabled as aiEnabled, asSteps, stepsFor, type Steps } from '@/modules/ai/service';
import { loadAiSettings, featureEnabled } from '@/modules/ai/guards';
import { BRIEFING_SYSTEM } from '@/modules/ai/prompt';
import type { BriefingFacts, BriefingRole } from '@/db/schema/briefings';
import { BRIEFING_DEFINITIONS, BRIEFING_ROLES, briefingDefinition, detectRole } from './definitions';

/**
 * Daily briefings. A person opts in on their profile (time of day in their
 * timezone, the role whose briefing they want, the channels); every fifteen
 * minutes the scheduler finds the people whose time has come and have no
 * briefing for their local day yet, and generates one for each under their
 * own identity, so the figures are exactly what they could see themselves.
 */

export const BRIEFING_CHANNELS = ['email', 'in_app'] as const;
export const briefingPrefSchema = z.object({
  enabled: z.boolean().default(false),
  /** Local time of day, HH:MM. */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('08:00'),
  role: z.enum(['auto', ...BRIEFING_ROLES] as ['auto', ...BriefingRole[]]).default('auto'),
  channels: z.array(z.enum(BRIEFING_CHANNELS)).default(['email', 'in_app']),
});
export type BriefingPrefs = z.infer<typeof briefingPrefSchema>;

export function prefsOf(preferences: Record<string, unknown> | null | undefined): BriefingPrefs {
  const raw = preferences?.briefing;
  const parsed = briefingPrefSchema.safeParse(raw && typeof raw === 'object' ? raw : {});
  return parsed.success ? parsed.data : briefingPrefSchema.parse({});
}

function staffOnly(ctx: Ctx) {
  if (ctx.user.userType === 'customer') throw new ForbiddenError('Briefings are for the service provider\'s staff');
}

const zoneOf = (tz: string | null | undefined) => (tz && DateTime.local().setZone(tz).isValid ? tz : 'UTC');
export const localDay = (tz: string | null | undefined, now = new Date()) => DateTime.fromJSDate(now, { zone: zoneOf(tz) }).toISODate()!;

/** The role this person's briefing takes: their choice when allowed, else the detected one, else the engineer briefing. */
export function roleFor(ctx: Ctx, prefs: BriefingPrefs): BriefingRole {
  if (prefs.role !== 'auto') {
    const def = briefingDefinition(prefs.role);
    if (def?.allowed(ctx)) return def.key;
  }
  return detectRole(ctx);
}

// ---------------------------------------------------------------- rendering

const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** The deterministic briefing: greeting, the headline, one heading per section. */
export function renderBriefing(facts: BriefingFacts, userName: string): string {
  const out: string[] = [`Good morning, ${first(userName)}. Your ${facts.roleLabel.toLowerCase()} briefing for ${facts.day}:`, '', ...facts.headline.map((h) => `- ${h}`)];
  for (const s of facts.sections) {
    out.push('', `## ${s.title}`);
    if (s.summary) out.push(s.summary);
    for (const i of s.items) out.push(`- **${i.link ? `[${i.ref}](${i.link})` : i.ref}** ${i.title}${i.meta ? ` — ${i.meta}` : ''}`);
    if (!s.items.length && !s.summary) out.push('Nothing to report.');
  }
  return out.join('\n');
}

/** Markdown (the subset the briefings use) to email HTML with absolute links; everything is escaped first. */
export function markdownToHtml(md: string, appUrl: string): string {
  const base = appUrl.replace(/\/$/, '');
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/\[([^\]]+)\]\((\/[^)\s]*)\)/g, (_m, text, href) => `<a href="${base}${href}">${text}</a>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const html: string[] = [];
  let list = false;
  const closeList = () => {
    if (list) html.push('</ul>');
    list = false;
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeList();
      continue;
    }
    if (/^#{1,3}\s+/.test(line)) {
      closeList();
      html.push(`<h3 style="margin:18px 0 6px;font-size:14px">${inline(line.replace(/^#{1,3}\s+/, ''))}</h3>`);
    } else if (/^[-*]\s+/.test(line)) {
      if (!list) html.push('<ul style="margin:4px 0 8px;padding-left:18px">');
      list = true;
      html.push(`<li style="margin:3px 0">${inline(line.replace(/^[-*]\s+/, ''))}</li>`);
    } else {
      closeList();
      html.push(`<p style="margin:6px 0">${inline(line)}</p>`);
    }
  }
  closeList();
  return html.join('\n');
}

const briefingSchema = z.object({ text: z.string().trim().min(40).max(8000) });

// ---------------------------------------------------------------- limits on manual generation

export interface BriefingLimits {
  /** Generations on request per person per day (0 = unlimited). */
  maxPerDay: number;
  /** Minutes after a generation during which a request returns the stored briefing. */
  cooldownMinutes: number;
}
export const DEFAULT_LIMITS: BriefingLimits = { maxPerDay: 3, cooldownMinutes: 15 };
const clampNum = (v: unknown, fallback: number, min: number, max: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/** `ai.briefing.max_per_day` and `ai.briefing.cooldown_minutes` from system settings. */
export async function loadLimits(tx: Tx): Promise<BriefingLimits> {
  const rows = await tx.select({ key: schema.systemSettings.key, value: schema.systemSettings.value }).from(schema.systemSettings).where(inArray(schema.systemSettings.key, ['ai.briefing.max_per_day', 'ai.briefing.cooldown_minutes']));
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return { maxPerDay: clampNum(get('ai.briefing.max_per_day'), DEFAULT_LIMITS.maxPerDay, 0, 100), cooldownMinutes: clampNum(get('ai.briefing.cooldown_minutes'), DEFAULT_LIMITS.cooldownMinutes, 0, 1440) };
}

/** What the person may still do today: generations used, how many are left and when the cooldown ends. */
export function usageOf(row: { generations: number; generatedAt: Date } | null, limits: BriefingLimits, now = new Date()) {
  const used = row?.generations ?? 0;
  const remaining = limits.maxPerDay > 0 ? Math.max(0, limits.maxPerDay - used) : null;
  const coolUntil = row && limits.cooldownMinutes > 0 ? new Date(row.generatedAt.getTime() + limits.cooldownMinutes * 60_000) : null;
  const cooling = !!coolUntil && coolUntil.getTime() > now.getTime();
  return { ...limits, used, remaining, nextAllowedAt: cooling ? coolUntil : null, exhausted: remaining === 0, cooling };
}

// ---------------------------------------------------------------- generation

export interface GenerateOptions {
  /** The local day the briefing is for (defaults to the person's local today). */
  day?: string;
  role?: BriefingRole;
  /** Send it through the person's channels (the scheduler does; the dashboard button does not). */
  deliver?: boolean;
  now?: Date;
}

const view = (r: typeof schema.briefings.$inferSelect) => ({ id: r.id, userId: r.userId, role: r.roleKey as BriefingRole, roleLabel: briefingDefinition(r.roleKey)?.label ?? r.roleKey, day: r.day, text: r.text, html: r.html, ai: r.ai, facts: r.facts, channels: r.channels, generations: r.generations, generatedAt: r.generatedAt, deliveredAt: r.deliveredAt });

export type BriefingView = ReturnType<typeof view>;
export interface GenerateResult {
  briefing: BriefingView;
  /** True when the stored briefing came back without a new model call (cooldown or daily cap). */
  reused: boolean;
  /** Why it was reused, when it was. */
  reason: 'cooldown' | 'limit' | null;
  usage: ReturnType<typeof usageOf>;
}

/**
 * Builds (and stores) the briefing for the person behind `who`, phrasing it
 * with the model when one is on. On request (not delivered) the person's
 * daily cap and the cooldown apply: inside the cooldown, or once the cap is
 * reached, the stored briefing comes back and nothing is called.
 */
export async function generate(who: Ctx | Steps, opts: GenerateOptions = {}): Promise<GenerateResult> {
  const s = asSteps(who);
  const now = opts.now ?? new Date();
  const gathered = await s.tx(async (ctx) => {
    staffOnly(ctx);
    const prefs = prefsOf(ctx.user.preferences);
    const role = opts.role && briefingDefinition(opts.role)?.allowed(ctx) ? opts.role : roleFor(ctx, prefs);
    const def = briefingDefinition(role)!;
    const timezone = zoneOf(ctx.user.timezone);
    const day = opts.day ?? localDay(timezone, now);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ValidationError('day must be YYYY-MM-DD');
    const limits = await loadLimits(ctx.tx);
    const [existing] = await ctx.tx.select().from(schema.briefings).where(and(eq(schema.briefings.userId, ctx.user.id), eq(schema.briefings.day, day))).limit(1);
    if (!opts.deliver && existing) {
      const usage = usageOf(existing, limits, now);
      if (usage.exhausted) return { reuse: { briefing: view(existing), reused: true, reason: 'limit' as const, usage } };
      if (usage.cooling && existing.roleKey === role) return { reuse: { briefing: view(existing), reused: true, reason: 'cooldown' as const, usage } };
    }
    const built = await def.build(ctx, { day, timezone, now });
    const facts: BriefingFacts = { role, roleLabel: def.label, day, timezone, generatedAt: now.toISOString(), headline: built.headline, sections: built.sections };
    return { facts, prefs, limits, generations: existing ? existing.generations + (opts.deliver ? 0 : 1) : 1, useModel: aiEnabled() && featureEnabled(await loadAiSettings(ctx.tx), 'briefing') };
  });
  if ('reuse' in gathered && gathered.reuse) return gathered.reuse;
  const fallback = renderBriefing(gathered.facts, s.principal.name);
  let text = fallback;
  let ai = false;
  if (gathered.useModel) {
    const llm = await llmJson(BRIEFING_SYSTEM, JSON.stringify({ name: first(s.principal.name), role: gathered.facts.roleLabel, day: gathered.facts.day, headline: gathered.facts.headline, sections: gathered.facts.sections.map((sec) => ({ title: sec.title, summary: sec.summary, items: sec.items.map((i) => ({ ref: i.ref, title: i.title, meta: i.meta, link: i.link })) })) }), (v) => briefingSchema.parse(v), { maxTokens: 1200 });
    if (llm) {
      text = llm.data.text;
      ai = true;
    }
  }
  const html = markdownToHtml(text, config.APP_URL);
  return s.tx(async (ctx) => {
    const channels = opts.deliver ? gathered.prefs.channels : [];
    const [row] = await ctx.tx
      .insert(schema.briefings)
      .values({ userId: ctx.user.id, roleKey: gathered.facts.role, day: gathered.facts.day, facts: gathered.facts, text, html, ai, channels, generations: gathered.generations, generatedAt: now })
      .onConflictDoUpdate({ target: [schema.briefings.userId, schema.briefings.day], set: { roleKey: gathered.facts.role, facts: gathered.facts, text, html, ai, channels, generations: gathered.generations, generatedAt: now } })
      .returning();
    if (opts.deliver && channels.length) {
      await queueNotification(ctx.tx, {
        event: 'briefing.daily',
        recipients: [{ userId: ctx.user.id, email: ctx.user.email, name: ctx.user.name }],
        data: { briefing: { date: gathered.facts.day, roleLabel: gathered.facts.roleLabel.toLowerCase(), html, headline: gathered.facts.headline.join(' '), link: `${config.APP_URL.replace(/\/$/, '')}/?briefing=${gathered.facts.day}` } },
        channels,
        entityType: 'briefing',
        entityId: row.id,
        link: `/?briefing=${gathered.facts.day}`,
        title: `Your ${gathered.facts.roleLabel.toLowerCase()} briefing for ${gathered.facts.day}`,
        body: gathered.facts.headline.slice(0, 2).join(' '),
      });
      await ctx.tx.update(schema.briefings).set({ deliveredAt: now }).where(eq(schema.briefings.id, row.id));
    }
    await ctx.audit({ entityType: 'briefing', entityId: row.id, entityLabel: `${gathered.facts.roleLabel} ${gathered.facts.day}`, action: opts.deliver ? 'deliver' : 'generate', metadata: { role: gathered.facts.role, day: gathered.facts.day, ai, channels, generations: row.generations } });
    const stored = { ...row, deliveredAt: opts.deliver && channels.length ? now : row.deliveredAt };
    return { briefing: view(stored), reused: false, reason: null, usage: usageOf(stored, gathered.limits, now) };
  });
}

/** Today's briefing (the person's local day) with their preferences and the roles open to them. */
export async function today(ctx: Ctx, now = new Date()) {
  staffOnly(ctx);
  const prefs = prefsOf(ctx.user.preferences);
  const day = localDay(ctx.user.timezone, now);
  const [row] = await ctx.tx.select().from(schema.briefings).where(and(eq(schema.briefings.userId, ctx.user.id), eq(schema.briefings.day, day))).limit(1);
  return {
    day,
    briefing: row ? view(row) : null,
    usage: usageOf(row ?? null, await loadLimits(ctx.tx), now),
    prefs,
    role: roleFor(ctx, prefs),
    roles: BRIEFING_DEFINITIONS.map((d) => ({ key: d.key, label: d.label, description: d.description, allowed: d.allowed(ctx) })),
  };
}

// ---------------------------------------------------------------- scheduling

/** Whether a person's briefing is due: their local time has passed the chosen time and no briefing exists for their local day. */
export function isDue(prefs: BriefingPrefs, timezone: string | null | undefined, lastDay: string | null, now = new Date()): { due: boolean; day: string } {
  const local = DateTime.fromJSDate(now, { zone: zoneOf(timezone) });
  const day = local.toISODate()!;
  if (!prefs.enabled) return { due: false, day };
  if (lastDay === day) return { due: false, day };
  return { due: local.toFormat('HH:mm') >= prefs.time, day };
}

/** The people whose briefing is due now, read with the system identity. */
export async function dueBriefings(tx: Tx, now = new Date()) {
  const users = await tx
    .select({ id: schema.users.id, timezone: schema.users.timezone, preferences: schema.users.preferences, // plain `users.id`: in a single-table select drizzle drops the qualifier and `"id"` would bind to the briefing
    lastDay: sql<string | null>`(SELECT max(b.day)::text FROM briefings b WHERE b.user_id = users.id)` })
    .from(schema.users)
    .where(and(eq(schema.users.userType, 'msp'), eq(schema.users.status, 'active'), sql`${schema.users.preferences} -> 'briefing' ->> 'enabled' = 'true'`))
    .limit(5000);
  const due: { userId: string; day: string }[] = [];
  for (const u of users) {
    const r = isDue(prefsOf(u.preferences), u.timezone, u.lastDay, now);
    if (r.due) due.push({ userId: u.id, day: r.day });
  }
  return due;
}

export async function runScheduler(now = new Date()) {
  const due = await withSystem((tx) => dueBriefings(tx, now));
  let queued = 0;
  for (const d of due) {
    const job = await enqueue('ai', 'generate-briefing', d, { jobId: `briefing:${d.userId}:${d.day}`, attempts: 2 });
    if (job) queued++;
  }
  if (due.length) logger.info({ due: due.length, queued }, 'briefings scheduled');
  return { due: due.length, queued };
}

/** Generates and delivers one person's briefing under their own identity (row-level security and permissions as on their dashboard). */
export async function generateForUser(userId: string, day: string, now = new Date()) {
  // the preferences may have changed since the principal was cached
  invalidatePrincipal(userId);
  const principal: Principal | null = await loadPrincipal(userId);
  if (!principal || principal.status !== 'active' || principal.userType !== 'msp') return { skipped: 'inactive' as const };
  const prefs = prefsOf(principal.preferences);
  if (!prefs.enabled) return { skipped: 'disabled' as const };
  const steps = stepsFor(principal, { requestId: `briefing:${userId}:${day}` });
  const { briefing } = await generate(steps, { day, deliver: true, now });
  return { id: briefing.id, role: briefing.role, ai: briefing.ai, channels: briefing.channels };
}
