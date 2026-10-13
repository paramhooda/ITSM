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
import { numbersIn, groundedAgainst } from '@/modules/reports/insights';
import { normaliseFacts, type BriefingFacts, type BriefingNarrative, type BriefingRole } from '@/db/schema/briefings';
import { isCustomerUser } from '@/modules/tickets/common';
import { BRIEFING_ROLES, briefingDefinition, definitionsFor, detectRole, zoneOf } from './definitions';

/**
 * Daily briefings. A member of staff opts in on their profile (time of day in
 * their timezone, the role whose briefing they want, the channels); every
 * fifteen minutes the scheduler finds the people whose time has come and have
 * no briefing for their local day yet, and generates one for each under their
 * own identity, so the figures are exactly what they could see themselves. A
 * portal user generates the brief for their organisation on demand only.
 *
 * The facts are computed; the model only phrases them: it returns a bounded
 * narrative (a greeting, a summary, one lead per section, up to three picks)
 * that is grounded against the input before it is kept, field by field, with
 * the deterministic narrative behind every field that fails.
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

/** Staff may always read their briefing; a portal user only when their organisation's brief is open to them. */
function assertAllowed(ctx: Ctx) {
  if (isCustomerUser(ctx) && !briefingDefinition('customer')!.allowed(ctx)) throw new ForbiddenError('Briefings in the portal are for customer accounts with portal access');
}

export { zoneOf };
export const localDay = (tz: string | null | undefined, now = new Date()) => DateTime.fromJSDate(now, { zone: zoneOf(tz) }).toISODate()!;

/** The role this person's briefing takes: their choice when allowed, else the detected one (their organisation for a portal user, the engineer briefing otherwise). */
export function roleFor(ctx: Ctx, prefs: BriefingPrefs): BriefingRole {
  if (prefs.role !== 'auto') {
    const def = briefingDefinition(prefs.role);
    if (def?.allowed(ctx)) return def.key;
  }
  return detectRole(ctx);
}

// ---------------------------------------------------------------- the narrative

const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** "Good morning/afternoon/evening, <First>." from the hour of the generation in the person's own timezone. */
export function greetingFor(name: string, generatedAt: Date | string, timezone: string): string {
  const hour = DateTime.fromJSDate(new Date(generatedAt), { zone: zoneOf(timezone) }).hour;
  const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  return `Good ${part}, ${first(name)}.`;
}

/** The narrative written from the facts alone: the greeting, the headline as the summary, each section's own lead, no picks. */
export function fallbackNarrative(facts: Pick<BriefingFacts, 'headline' | 'sections' | 'generatedAt' | 'timezone'>, name: string): BriefingNarrative {
  return {
    greeting: greetingFor(name, facts.generatedAt || new Date(), facts.timezone),
    summary: facts.headline.join(' '),
    sections: facts.sections.map((s) => ({ key: s.key, lead: s.summary ?? (s.items.length ? `${s.items.length} item${s.items.length === 1 ? '' : 's'}.` : 'Nothing to report.'), picks: [] })),
    source: 'facts',
  };
}

/** What the model may return: bounded lengths, at most three picks a section, at most twelve sections. */
export const briefingNarrativeSchema = z.object({
  greeting: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(20).max(600),
  sections: z.array(z.object({ key: z.string().max(80), lead: z.string().trim().min(1).max(220), picks: z.array(z.string().max(80)).max(3).default([]) })).max(12),
});
export type ModelNarrative = z.infer<typeof briefingNarrativeSchema>;

/**
 * Keeps of the model's narrative only what the facts support: every number in
 * a kept field appears in the input; a section the input does not have is
 * dropped; a lead that invents a figure falls back to the deterministic lead;
 * picks are refs of that section's items; sections the model omitted get the
 * fallback lead. `source` is `model` only when the summary or a lead survived.
 */
export function groundNarrative(llm: ModelNarrative, facts: Pick<BriefingFacts, 'sections'>, fallback: BriefingNarrative, input: unknown): BriefingNarrative {
  const allowed = numbersIn(input);
  const greeting = groundedAgainst(llm.greeting, allowed) ? llm.greeting : fallback.greeting;
  const summaryKept = groundedAgainst(llm.summary, allowed);
  let leadsKept = 0;
  const sections = facts.sections.map((sec) => {
    const fb = fallback.sections.find((s) => s.key === sec.key) ?? { key: sec.key, lead: sec.summary ?? 'Nothing to report.', picks: [] };
    const m = llm.sections.find((s) => s.key === sec.key);
    if (!m) return fb;
    const leadKept = groundedAgainst(m.lead, allowed);
    if (leadKept) leadsKept++;
    const refs = new Set(sec.items.map((i) => i.ref));
    const picks = [...new Set(m.picks.filter((p) => refs.has(p)))].slice(0, 3);
    return { key: sec.key, lead: leadKept ? m.lead : fb.lead, picks };
  });
  return { greeting, summary: summaryKept ? llm.summary : fallback.summary, sections, source: summaryKept || leadsKept > 0 ? 'model' : 'facts' };
}

// ---------------------------------------------------------------- rendering

/** The briefing as Markdown for the email (and the dashboard card): the narrative's greeting and summary, the headline, one heading per section with its lead and items. */
export function renderBriefing(facts: BriefingFacts, userName: string): string {
  const narrative = facts.narrative ?? fallbackNarrative(facts, userName);
  const what = facts.role === 'customer' ? "Your organisation's briefing" : `Your ${facts.roleLabel.toLowerCase()} briefing`;
  // The summary paragraph only when it says something the headline bullets do not (the deterministic one is the headline itself).
  const summary = narrative.summary === facts.headline.join(' ') ? [] : [narrative.summary, ''];
  const out: string[] = [`${narrative.greeting} ${what} for ${facts.day}:`, '', ...summary, ...facts.headline.map((h) => `- ${h}`)];
  for (const s of facts.sections) {
    const lead = narrative.sections.find((n) => n.key === s.key)?.lead ?? s.summary;
    out.push('', `## ${s.title}`);
    if (lead) out.push(lead);
    for (const i of s.items) out.push(`- **${i.link ? `[${i.ref}](${i.link})` : i.ref}** ${i.title}${i.meta ? ` — ${i.meta}` : ''}`);
    if (!s.items.length && !lead) out.push('Nothing to report.');
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

/** A stored row as the API serves it: the facts normalised (old rows gain empty KPIs and doors) and the narrative beside them, from the facts when none was stored. */
const view = (r: typeof schema.briefings.$inferSelect, userName: string) => {
  const facts = normaliseFacts(r.facts);
  const narrative: BriefingNarrative | null = facts ? facts.narrative ?? fallbackNarrative(facts, userName) : null;
  return { id: r.id, userId: r.userId, role: r.roleKey as BriefingRole, roleLabel: briefingDefinition(r.roleKey)?.label ?? r.roleKey, day: r.day, text: r.text, html: r.html, ai: r.ai, facts: facts ? { ...facts, narrative } : null, narrative, channels: r.channels, generations: r.generations, generatedAt: r.generatedAt, deliveredAt: r.deliveredAt };
};

export type BriefingView = ReturnType<typeof view>;
export interface GenerateResult {
  briefing: BriefingView;
  /** True when the stored briefing came back without a new model call (cooldown or daily cap). */
  reused: boolean;
  /** Why it was reused, when it was. */
  reason: 'cooldown' | 'limit' | null;
  usage: ReturnType<typeof usageOf>;
}

/** What the model sees: the facts without links (the panel links from the facts, never from the model), at most eight items a section. */
export function narrativeInput(facts: Pick<BriefingFacts, 'role' | 'roleLabel' | 'day' | 'headline' | 'kpis' | 'sections'>, name: string) {
  return {
    name: first(name),
    role: facts.roleLabel,
    day: facts.day,
    headline: facts.headline,
    kpis: facts.kpis.map((k) => ({ label: k.label, value: k.value })),
    sections: facts.sections.map((s) => ({ key: s.key, title: s.title, summary: s.summary, doors: s.doors.map((d) => ({ label: d.label, value: d.value })), items: s.items.slice(0, 8).map((i) => ({ ref: i.ref, title: i.title, meta: i.meta })) })),
  };
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
  const name = s.principal.name;
  const gathered = await s.tx(async (ctx) => {
    assertAllowed(ctx);
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
      if (usage.exhausted) return { reuse: { briefing: view(existing, name), reused: true, reason: 'limit' as const, usage } };
      if (usage.cooling && existing.roleKey === role) return { reuse: { briefing: view(existing, name), reused: true, reason: 'cooldown' as const, usage } };
    }
    const built = await def.build(ctx, { day, timezone, now });
    const facts: BriefingFacts = { role, roleLabel: def.label, day, timezone, generatedAt: now.toISOString(), headline: built.headline, kpis: built.kpis, sections: built.sections, narrative: null };
    return { facts, prefs, limits, generations: existing ? existing.generations + (opts.deliver ? 0 : 1) : 1, useModel: aiEnabled() && featureEnabled(await loadAiSettings(ctx.tx), 'briefing') };
  });
  if ('reuse' in gathered && gathered.reuse) return gathered.reuse;
  const facts = gathered.facts;
  const fallback = fallbackNarrative(facts, name);
  let narrative = fallback;
  if (gathered.useModel) {
    const input = narrativeInput(facts, name);
    const llm = await llmJson(BRIEFING_SYSTEM, JSON.stringify(input), (v) => briefingNarrativeSchema.parse(v), { maxTokens: 1800 });
    if (llm) narrative = groundNarrative(llm.data, facts, fallback, input);
  }
  facts.narrative = narrative;
  const ai = narrative.source === 'model';
  const text = renderBriefing(facts, name);
  const html = markdownToHtml(text, config.APP_URL);
  return s.tx(async (ctx) => {
    const channels = opts.deliver ? gathered.prefs.channels : [];
    const [row] = await ctx.tx
      .insert(schema.briefings)
      .values({ userId: ctx.user.id, roleKey: facts.role, day: facts.day, facts, text, html, ai, channels, generations: gathered.generations, generatedAt: now })
      .onConflictDoUpdate({ target: [schema.briefings.userId, schema.briefings.day], set: { roleKey: facts.role, facts, text, html, ai, channels, generations: gathered.generations, generatedAt: now } })
      .returning();
    if (opts.deliver && channels.length) {
      await queueNotification(ctx.tx, {
        event: 'briefing.daily',
        recipients: [{ userId: ctx.user.id, email: ctx.user.email, name: ctx.user.name }],
        data: { briefing: { date: facts.day, roleLabel: facts.roleLabel.toLowerCase(), html, headline: facts.headline.join(' '), link: `${config.APP_URL.replace(/\/$/, '')}/?briefing=${facts.day}` } },
        channels,
        entityType: 'briefing',
        entityId: row.id,
        link: `/?briefing=${facts.day}`,
        title: `Your ${facts.roleLabel.toLowerCase()} briefing for ${facts.day}`,
        body: facts.headline.slice(0, 2).join(' '),
      });
      await ctx.tx.update(schema.briefings).set({ deliveredAt: now }).where(eq(schema.briefings.id, row.id));
    }
    await ctx.audit({ entityType: 'briefing', entityId: row.id, entityLabel: `${facts.roleLabel} ${facts.day}`, action: opts.deliver ? 'deliver' : 'generate', customerId: isCustomerUser(ctx) ? ctx.user.customerId : null, metadata: { role: facts.role, day: facts.day, ai, channels, generations: row.generations } });
    const stored = { ...row, deliveredAt: opts.deliver && channels.length ? now : row.deliveredAt };
    return { briefing: view(stored, name), reused: false, reason: null, usage: usageOf(stored, gathered.limits, now) };
  });
}

/** Today's briefing (the person's local day) with their preferences and the roles open to their audience (staff never see the customer brief, a customer sees only theirs). */
export async function today(ctx: Ctx, now = new Date()) {
  assertAllowed(ctx);
  const prefs = prefsOf(ctx.user.preferences);
  const day = localDay(ctx.user.timezone, now);
  const [row] = await ctx.tx.select().from(schema.briefings).where(and(eq(schema.briefings.userId, ctx.user.id), eq(schema.briefings.day, day))).limit(1);
  return {
    day,
    briefing: row ? view(row, ctx.user.name) : null,
    usage: usageOf(row ?? null, await loadLimits(ctx.tx), now),
    prefs,
    role: roleFor(ctx, prefs),
    roles: definitionsFor(ctx).map((d) => ({ key: d.key, label: d.label, description: d.description, allowed: d.allowed(ctx) })),
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

/** The people whose briefing is due now, read with the system identity (staff only: the portal brief is on demand). */
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
