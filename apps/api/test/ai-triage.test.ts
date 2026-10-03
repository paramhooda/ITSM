/**
 * Triage on arrival: the job classifies, recommends an owner and checks
 * duplicates for a new ticket; above the confidence threshold the category is
 * applied, below it proposed; machine-raised look-alikes are linked as
 * duplicates (alert storm); an accepted proposal is applied through the ticket
 * services; the job is idempotent and respects the feature switch; the
 * resolution-notes draft falls back without a provider. Run with the dev
 * environment sourced: npx vitest run test/ai-triage.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { createTicket } from '../src/modules/tickets/service';
import { timeline } from '../src/modules/tickets/activity';
import * as ai from '../src/modules/ai/service';
import * as sug from '../src/modules/ai/suggestions';
import { triageTicket, parseTriageSettings, DEFAULT_TRIAGE_SETTINGS } from '../src/modules/ai/triage';
import { CLASSIFY_SYSTEM } from '../src/modules/ai/prompt';
import type { AiProvider, ChatOptions, ChatResponse } from '../src/lib/ai';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-triage-${S}`, ip: '127.0.0.1' };
let admin: Principal;
const ids = { customer: '', site: '', team: '', engineer: '', p3: '', monitoring: '', engineerSrc: '', backup: '' };
const created: string[] = [];
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);

async function optionId(tx: Tx, type: string, key: string) {
  const [row] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, type), eq(schema.configOptions.key, key))).limit(1);
  if (!row) throw new Error(`option ${type}:${key} missing (seed not applied?)`);
  return row.id;
}
async function roleId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  return row!.id;
}
const setSetting = (key: string, value: unknown) => withSystem((tx) => tx.insert(schema.systemSettings).values({ key, value, description: 'test' }).onConflictDoUpdate({ target: schema.systemSettings.key, set: { value } }));
const suggestionsFor = (ticketId: string) => withSystem((tx) => tx.select().from(schema.aiSuggestions).where(and(eq(schema.aiSuggestions.entityType, 'ticket'), eq(schema.aiSuggestions.entityId, ticketId))));
const json = (o: unknown): ChatResponse => ({ text: JSON.stringify(o), toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } });
/** A provider that is sure about backups and unsure about everything else. */
const fake = (confidence: number): AiProvider => ({
  name: 'fake',
  model: 'fake-1',
  chat: async (opts: ChatOptions) => (opts.system === CLASSIFY_SYSTEM ? json({ categoryKey: 'backup', subcategoryKey: null, impactKey: 'medium', urgencyKey: 'medium', priorityKey: null, confidence, rationale: 'The description names a backup job' }) : json({ notes: 'The nightly backup job had stalled on a locked file; the job was restarted and completed, and the next run is being watched.' })),
});

const newTicket = (title: string, extra: Record<string, unknown> = {}) =>
  asAdmin(async (ctx) => {
    const t = await createTicket(ctx, { type: 'incident', customerId: ids.customer, siteId: ids.site, title, description: 'The nightly backup job failed with a locked file error.', priorityId: ids.p3, ...extra } as never);
    created.push(t.id);
    return t;
  });

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [a] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    ids.p3 = await optionId(tx, 'ticket_priority', 'p3');
    ids.monitoring = await optionId(tx, 'ticket_source', 'monitoring');
    ids.engineerSrc = await optionId(tx, 'ticket_source', 'engineer');
    ids.backup = await optionId(tx, 'ticket_category', 'backup');
    const [c] = await tx.insert(schema.customers).values({ code: `TR${S.toUpperCase()}`, name: `Triage Customer ${S}`, timezone: 'Asia/Kolkata' }).returning();
    ids.customer = c!.id;
    const [site] = await tx.insert(schema.sites).values({ customerId: c!.id, code: 'HQ', name: 'HQ', isPrimary: true }).returning();
    ids.site = site!.id;
    const [eng] = await tx.insert(schema.users).values({ email: `tr-eng-${S}@example.test`, name: 'Triage Engineer', userType: 'msp', status: 'active' }).returning();
    ids.engineer = eng!.id;
    await tx.insert(schema.userRoles).values({ userId: eng!.id, roleId: await roleId(tx, 'engineer') });
    const [team] = await tx.insert(schema.teams).values({ key: `triage_${S}`, name: `Backup team ${S}`, teamType: 'general' }).returning();
    ids.team = team!.id;
    await tx.insert(schema.teamMembers).values({ teamId: team!.id, userId: eng!.id, isLead: true });
    invalidatePrincipal(a!.id);
    admin = (await loadPrincipal(a!.id))!;
  });
  await setSetting('ai.disabled_features', []);
  await setSetting('ai.triage.auto_apply_confidence', 85);
  await setSetting('ai.triage.storm_window_minutes', 30);
  await setSetting('ai.triage.storm_threshold', 3);
  await setSetting('ai.triage.storm_auto_link', true);
});

afterAll(async () => {
  ai.setProviderForTests(null);
  await setSetting('ai.disabled_features', []);
  await withSystem(async (tx) => {
    if (created.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, created));
    await tx.delete(schema.teams).where(eq(schema.teams.id, ids.team));
    await tx.delete(schema.users).where(eq(schema.users.id, ids.engineer));
    await tx.delete(schema.customers).where(eq(schema.customers.id, ids.customer));
  });
  await closeDb();
});

describe('triage settings', () => {
  it('fail closed to the defaults and clamp the ranges', () => {
    expect(parseTriageSettings([])).toEqual(DEFAULT_TRIAGE_SETTINGS);
    const s = parseTriageSettings([
      { key: 'ai.triage.auto_apply_confidence', value: 10 },
      { key: 'ai.triage.storm_window_minutes', value: '9999' },
      { key: 'ai.triage.storm_threshold', value: 1 },
      { key: 'ai.triage.storm_auto_link', value: false },
    ]);
    expect(s).toEqual({ autoApplyConfidence: 50, stormWindowMinutes: 1440, stormThreshold: 2, stormAutoLink: false });
  });
});

describe('triage on arrival', () => {
  it('applies a confident classification to a ticket that arrived without a category', async () => {
    ai.setProviderForTests(fake(92));
    try {
      const t = await newTicket(`Backup job failed on FS01 ${S}`, { sourceId: ids.engineerSrc });
      expect(t.categoryId).toBeNull();
      const out = await triageTicket(t.id);
      expect(out.skipped).toBeUndefined();
      expect(out.classification?.status).toBe('applied');
      expect(out.classification?.confidence).toBe(92);
      expect(out.classification?.applied).toContain('categoryId');
      const [row] = await withSystem((tx) => tx.select({ categoryId: schema.tickets.categoryId, priorityId: schema.tickets.priorityId }).from(schema.tickets).where(eq(schema.tickets.id, t.id)));
      expect(row!.categoryId).toBe(ids.backup);
      expect(row!.priorityId).toBe(ids.p3); // never changed by triage
      const rows = await suggestionsFor(t.id);
      const cls = rows.find((r) => r.kind === 'classification')!;
      expect(cls.status).toBe('applied');
      expect(cls.payload.triage).toBe(true);
      expect(rows.some((r) => r.kind === 'assignment')).toBe(true);
      expect(rows.some((r) => r.kind === 'duplicates')).toBe(true);
      const tl = await asAdmin((ctx) => timeline(ctx, t.id));
      const act = tl.items.find((i) => i.kind === 'activity' && (i as { type?: string }).type === 'ai') as { summary?: string } | undefined;
      expect(act?.summary).toMatch(/^Grady triage: classified as Backup/);
      // Idempotent: a second run (a retried job) does nothing.
      expect((await triageTicket(t.id)).skipped).toBe('already triaged');
      expect((await suggestionsFor(t.id)).filter((r) => r.kind === 'classification')).toHaveLength(1);
    } finally {
      ai.setProviderForTests(null);
    }
  });

  it('proposes instead of applying below the threshold, and accepting with apply carries it out', async () => {
    ai.setProviderForTests(fake(60));
    try {
      const t = await newTicket(`Backup job failed on FS02 ${S}`, { sourceId: ids.engineerSrc });
      const out = await triageTicket(t.id);
      expect(out.classification?.status).toBe('proposed');
      const [before] = await withSystem((tx) => tx.select({ categoryId: schema.tickets.categoryId }).from(schema.tickets).where(eq(schema.tickets.id, t.id)));
      expect(before!.categoryId).toBeNull();
      const cls = (await suggestionsFor(t.id)).find((r) => r.kind === 'classification')!;
      expect(cls.status).toBe('proposed');
      // Without apply the decision is only recorded (the Assist rail applies itself).
      const recorded = await asAdmin((ctx) => sug.decide(ctx, cls.id, 'accepted', null));
      expect(recorded.status).toBe('accepted');
      expect(recorded.changes).toEqual([]);
      // With apply the category lands on the ticket.
      await withSystem((tx) => tx.update(schema.aiSuggestions).set({ status: 'proposed' }).where(eq(schema.aiSuggestions.id, cls.id)));
      const applied = await asAdmin((ctx) => sug.decide(ctx, cls.id, 'accepted', null, { apply: true }));
      expect(applied.status).toBe('applied');
      expect(applied.changes).toContain('categoryId');
      const [after] = await withSystem((tx) => tx.select({ categoryId: schema.tickets.categoryId }).from(schema.tickets).where(eq(schema.tickets.id, t.id)));
      expect(after!.categoryId).toBe(ids.backup);
    } finally {
      ai.setProviderForTests(null);
    }
  });

  it('links a monitoring ticket as a duplicate of the oldest look-alike during an alert storm', async () => {
    const first = await newTicket(`Interface Gi0/1 down on core-sw-01 ${S}`, { sourceId: ids.monitoring });
    await newTicket(`Interface Gi0/2 down on core-sw-01 ${S}`, { sourceId: ids.monitoring });
    const third = await newTicket(`Interface Gi0/3 down on core-sw-01 ${S}`, { sourceId: ids.monitoring });
    const out = await triageTicket(third.id);
    expect(out.duplicates?.likely).toBeGreaterThanOrEqual(2);
    expect(out.duplicates?.storm).toBe(true);
    expect(out.duplicates?.linkedTo).toBe(first.number);
    const links = await withSystem((tx) => tx.select().from(schema.ticketLinks).where(and(eq(schema.ticketLinks.sourceTicketId, third.id), eq(schema.ticketLinks.linkType, 'duplicate_of'))));
    expect(links).toHaveLength(1);
    expect(links[0]!.targetTicketId).toBe(first.id);
    const dup = (await suggestionsFor(third.id)).find((r) => r.kind === 'duplicates')!;
    expect(dup.status).toBe('applied');
    expect(dup.payload.storm).toBe(true);
    // An engineer-raised look-alike is only told about the duplicates.
    const fourth = await newTicket(`Interface Gi0/4 down on core-sw-01 ${S}`, { sourceId: ids.engineerSrc });
    const out4 = await triageTicket(fourth.id);
    expect(out4.duplicates?.linkedTo).toBeNull();
    expect(out4.duplicates?.likely).toBeGreaterThanOrEqual(2);
    expect((await suggestionsFor(fourth.id)).find((r) => r.kind === 'duplicates')!.status).toBe('proposed');
  });

  it('accepting a duplicate proposal with apply links the chosen ticket', async () => {
    const a = await newTicket(`VPN tunnel flapping to branch-7 ${S}`, { sourceId: ids.engineerSrc });
    const b = await newTicket(`VPN tunnel flapping to branch-7 again ${S}`, { sourceId: ids.engineerSrc });
    await triageTicket(b.id);
    const dup = (await suggestionsFor(b.id)).find((r) => r.kind === 'duplicates')!;
    expect(dup.status).toBe('proposed');
    const res = await asAdmin((ctx) => sug.decide(ctx, dup.id, 'accepted', null, { apply: true, targetTicketId: a.id }));
    expect(res.status).toBe('applied');
    expect(res.changes[0]).toBe(`duplicate_of:${a.number}`);
  });

  it('skips closed types and respects the feature switch', async () => {
    const change = await asAdmin(async (ctx) => {
      const t = await createTicket(ctx, { type: 'change', customerId: ids.customer, siteId: ids.site, title: `Firmware upgrade ${S}`, description: 'x' } as never);
      created.push(t.id);
      return t;
    });
    expect((await triageTicket(change.id)).skipped).toMatch(/not triaged/);
    await setSetting('ai.disabled_features', ['triage']);
    try {
      const t = await newTicket(`Printer offline ${S}`, { sourceId: ids.engineerSrc });
      expect((await triageTicket(t.id)).skipped).toMatch(/switched off/);
      expect(await suggestionsFor(t.id)).toHaveLength(0);
    } finally {
      await setSetting('ai.disabled_features', []);
    }
    await expect(triageTicket('00000000-0000-0000-0000-000000000001')).rejects.toThrow(/not found/);
  });

  it('drafts resolution notes from the work notes, with and without a provider', async () => {
    const t = await newTicket(`Backup job stalled ${S}`, { sourceId: ids.engineerSrc });
    const { addComment } = await import('../src/modules/tickets/activity');
    await asAdmin((ctx) => addComment(ctx, t.id, { kind: 'work_note', body: 'Restarted the backup job after clearing the locked file. Completed at 02:10.' }));
    const plain = await asAdmin((ctx) => sug.draftResolutionNotes(ctx, t.id));
    expect(plain.aiGenerated).toBe(false);
    expect(plain.notes).toContain('Restarted the backup job');
    ai.setProviderForTests(fake(90));
    try {
      const drafted = await asAdmin((ctx) => sug.draftResolutionNotes(ctx, t.id));
      expect(drafted.aiGenerated).toBe(true);
      expect(drafted.notes).toMatch(/backup job/);
    } finally {
      ai.setProviderForTests(null);
    }
    expect((await suggestionsFor(t.id)).filter((r) => r.kind === 'resolution_notes')).toHaveLength(2);
  });
});
