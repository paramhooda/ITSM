import { eq, and, inArray, sql } from 'drizzle-orm';
import { schema, withSystem, type Tx } from '@/db/client';
import type { Ctx } from '@/core/context';
import { logger } from '@/core/logger';
import { systemCtx, reloadTicket, addActivity, optionById, SYSTEM_PRINCIPAL } from '@/modules/tickets/common';
import { updateTicket, assignTicket } from '@/modules/tickets/service';
import { addLink } from '@/modules/tickets/activity';
import { aiCtx, stepsFor } from './service';
import { loadAiSettings, featureEnabled } from './guards';
import { gatherClassification, classifyLlm, finishClassification, recommendAssignmentIn, duplicateCheckIn, suggestKnowledge, storeSuggestion } from './suggestions';

/**
 * Triage on arrival. Every new incident or request is classified, given an
 * owner recommendation and checked for duplicates a moment after creation,
 * the way a desk lead would look at the queue. Above the confidence threshold
 * the classification and the owner are applied (the ticket shows "Grady
 * triage" in its activity and the suggestion rows read `applied`); otherwise
 * they wait as proposals the engineer accepts from the ticket page. Tickets
 * that monitoring or the SIEM raised during an alert storm are linked as
 * duplicates of the oldest open ticket of the same symptom.
 */

export interface TriageSettings {
  /** 50..100: at or above it the classification and the owner are applied without a person. */
  autoApplyConfidence: number;
  /** Similar tickets opened within this many minutes count towards a storm. */
  stormWindowMinutes: number;
  /** Link a machine-raised ticket as a duplicate of the oldest open look-alike. */
  stormAutoLink: boolean;
  /** This many look-alikes in the window (including the new ticket) is a storm. */
  stormThreshold: number;
}

export const TRIAGE_SETTING_KEYS = ['ai.triage.auto_apply_confidence', 'ai.triage.storm_window_minutes', 'ai.triage.storm_auto_link', 'ai.triage.storm_threshold'] as const;
export const DEFAULT_TRIAGE_SETTINGS: TriageSettings = { autoApplyConfidence: 85, stormWindowMinutes: 30, stormAutoLink: true, stormThreshold: 3 };
const MACHINE_SOURCES = new Set(['monitoring', 'siem', 'api']);

const num = (v: unknown, fallback: number, min: number, max: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

export function parseTriageSettings(rows: { key: string; value: unknown }[]): TriageSettings {
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return {
    autoApplyConfidence: num(get('ai.triage.auto_apply_confidence'), DEFAULT_TRIAGE_SETTINGS.autoApplyConfidence, 50, 100),
    stormWindowMinutes: num(get('ai.triage.storm_window_minutes'), DEFAULT_TRIAGE_SETTINGS.stormWindowMinutes, 5, 1440),
    stormAutoLink: get('ai.triage.storm_auto_link') !== false,
    stormThreshold: num(get('ai.triage.storm_threshold'), DEFAULT_TRIAGE_SETTINGS.stormThreshold, 2, 50),
  };
}

export async function loadTriageSettings(tx: Tx): Promise<TriageSettings> {
  const rows = await tx.select({ key: schema.systemSettings.key, value: schema.systemSettings.value }).from(schema.systemSettings).where(inArray(schema.systemSettings.key, [...TRIAGE_SETTING_KEYS]));
  return parseTriageSettings(rows);
}

export interface TriageOutcome {
  ticketId: string;
  skipped?: string;
  classification?: { status: 'applied' | 'proposed'; confidence: number; aiGenerated: boolean; labels: Record<string, string | null>; applied: string[] };
  assignment?: { status: 'applied' | 'proposed' | 'none'; userName: string | null; teamName: string | null; confidence: number };
  duplicates?: { likely: number; linkedTo: string | null; storm: boolean; recent: number };
  knowledge?: number;
}

const CLOSED = new Set(['resolved', 'closed', 'cancelled']);

/** Runs once per ticket (job `triage-ticket`); safe to call again, the second run is a no-op. */
export async function triageTicket(ticketId: string): Promise<TriageOutcome> {
  // Step 1 (short transaction): the ticket, the switches and the classification inputs.
  const g = await withSystem(async (tx) => {
    const ctx = aiCtx(systemCtx(tx, 'triage'));
    const [row] = await tx.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).limit(1);
    if (!row) throw new Error(`Ticket ${ticketId} not found (not committed yet?)`);
    const settings = await loadAiSettings(tx);
    if (!featureEnabled(settings, 'triage')) return { skipped: 'triage is switched off' as const };
    if (row.type !== 'incident' && row.type !== 'request') return { skipped: `${row.type}s are not triaged` };
    const status = await optionById(tx, row.statusId);
    if (status?.statusCategory && CLOSED.has(status.statusCategory)) return { skipped: 'the ticket is closed' };
    const [done] = await tx.select({ id: schema.aiSuggestions.id }).from(schema.aiSuggestions).where(and(eq(schema.aiSuggestions.entityType, 'ticket'), eq(schema.aiSuggestions.entityId, row.id), sql`${schema.aiSuggestions.payload}->>'triage' = 'true'`)).limit(1);
    if (done) return { skipped: 'already triaged' };
    const triage = await loadTriageSettings(tx);
    const gathered = featureEnabled(settings, 'classify') ? await gatherClassification(ctx, { title: row.title, description: row.description, type: row.type, domainHint: row.domain }) : null;
    const source = await optionById(tx, row.sourceId);
    return { row, settings, triage, gathered, sourceKey: source?.key ?? null };
  });
  if ('skipped' in g) return { ticketId, skipped: g.skipped };

  // Step 2 (no transaction): the model's classification.
  const llm = g.gathered ? await classifyLlm(g.gathered) : null;

  // Knowledge runs as its own short steps (it may call the model once more).
  let knowledge = 0;
  if (featureEnabled(g.settings, 'suggest_kb')) {
    try {
      const kb = await suggestKnowledge(stepsFor(SYSTEM_PRINCIPAL, { requestId: 'triage' }), g.row.id);
      knowledge = kb.items.length;
    } catch (err) {
      logger.warn({ err, ticketId }, 'triage: knowledge suggestion failed');
    }
  }

  // Step 3 (short transaction): store, apply above the threshold, record what happened.
  return withSystem(async (tx) => {
    const ctx = aiCtx(systemCtx(tx, 'triage'));
    let row = await reloadTicket(tx, g.row.id);
    const out: TriageOutcome = { ticketId, knowledge };
    const lines: string[] = [];

    if (g.gathered) {
      const { result, aiGenerated } = await finishClassification(ctx, g.gathered, llm);
      const current = { categoryId: row.categoryId, subcategoryId: row.subcategoryId, impactId: row.impactId, urgencyId: row.urgencyId, priorityId: row.priorityId };
      // Applied without a person: category (and subcategory) when the ticket arrived without one and the model is sure;
      // impact and urgency only when unset. Priority is never changed automatically: it moves SLA targets.
      const patch: Record<string, string> = {};
      if (result.confidence >= g.triage.autoApplyConfidence && !row.categoryId && result.categoryId) {
        patch.categoryId = result.categoryId;
        if (result.subcategoryId) patch.subcategoryId = result.subcategoryId;
        if (!row.impactId && result.impactId) patch.impactId = result.impactId;
        if (!row.urgencyId && result.urgencyId) patch.urgencyId = result.urgencyId;
      }
      const applied = Object.keys(patch);
      const differs = (['categoryId', 'subcategoryId', 'impactId', 'urgencyId', 'priorityId'] as const).some((k) => result[k] && result[k] !== (applied.includes(k) ? result[k] : current[k]));
      const status = applied.length && !differs ? 'applied' : applied.length ? 'applied' : 'proposed';
      await storeSuggestion(ctx, {
        customerId: row.customerId,
        entityType: 'ticket',
        entityId: row.id,
        kind: 'classification',
        payload: { ...(result as unknown as Record<string, unknown>), triage: true, aiGenerated, current, applied, pending: differs },
        rationale: result.rationale,
        confidence: result.confidence,
        status: differs ? 'proposed' : status,
      });
      if (applied.length) {
        await updateTicket(ctx, row.id, patch);
        row = await reloadTicket(tx, row.id);
        lines.push(`classified as ${[result.labels.category, result.labels.subcategory].filter(Boolean).join(' / ')} (${result.confidence}% sure)`);
      } else if (result.categoryId) {
        lines.push(`${result.labels.category}${result.labels.subcategory ? ` / ${result.labels.subcategory}` : ''} proposed (${result.confidence}% sure)`);
      }
      out.classification = { status: applied.length ? 'applied' : 'proposed', confidence: result.confidence, aiGenerated, labels: result.labels, applied };
    }

    if (featureEnabled(g.settings, 'assign')) {
      const rec = await recommendAssignmentIn(ctx, row.id);
      const confidence = rec.userId ? 70 : rec.teamId ? 50 : 20;
      const canAssign = !row.assigneeId && !!rec.userId && confidence >= g.triage.autoApplyConfidence;
      if (canAssign) {
        await assignTicket(ctx, row.id, { teamId: rec.teamId ?? row.assignedTeamId ?? undefined, assigneeId: rec.userId, autoProgress: false });
        await tx.update(schema.aiSuggestions).set({ status: 'applied', payload: sql`${schema.aiSuggestions.payload} || '{"triage": true}'::jsonb` }).where(eq(schema.aiSuggestions.id, rec.suggestionId));
        row = await reloadTicket(tx, row.id);
        lines.push(`assigned to ${rec.userName}`);
      } else {
        await tx.update(schema.aiSuggestions).set({ payload: sql`${schema.aiSuggestions.payload} || '{"triage": true}'::jsonb` }).where(eq(schema.aiSuggestions.id, rec.suggestionId));
        if (rec.userId && rec.userId !== row.assigneeId) lines.push(`owner proposed: ${rec.userName}${rec.teamName ? ` (${rec.teamName})` : ''}`);
        else if (!rec.userId && rec.teamId && rec.teamId !== row.assignedTeamId) lines.push(`team proposed: ${rec.teamName}`);
      }
      out.assignment = { status: canAssign ? 'applied' : rec.userId || rec.teamId ? 'proposed' : 'none', userName: rec.userName ?? null, teamName: rec.teamName ?? null, confidence };
    }

    if (featureEnabled(g.settings, 'duplicates') && row.type === 'incident') {
      const dup = await duplicateCheckIn(ctx, row.id);
      const since = Date.now() - g.triage.stormWindowMinutes * 60_000;
      const recent = dup.items.filter((i) => new Date(i.createdAt).getTime() >= since);
      const storm = recent.length + 1 >= g.triage.stormThreshold;
      const likely = dup.items.filter((i) => dup.likely.includes(i.number)).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      let linkedTo: string | null = null;
      if (likely.length && g.triage.stormAutoLink && g.sourceKey && MACHINE_SOURCES.has(g.sourceKey)) {
        const oldest = likely[0]!;
        try {
          await addLink(ctx, row.id, { targetTicketId: oldest.id, linkType: 'duplicate_of' });
          linkedTo = oldest.number;
          await tx.update(schema.aiSuggestions).set({ status: 'applied', payload: sql`${schema.aiSuggestions.payload} || ${JSON.stringify({ triage: true, linkedTo: oldest.number, storm })}::jsonb` }).where(eq(schema.aiSuggestions.id, dup.suggestionId));
          lines.push(`linked as a duplicate of ${oldest.number}${storm ? ` (alert storm: ${recent.length + 1} similar tickets in ${g.triage.stormWindowMinutes} min)` : ''}`);
        } catch (err) {
          logger.warn({ err, ticketId }, 'triage: duplicate link failed');
        }
      }
      if (!linkedTo) {
        await tx.update(schema.aiSuggestions).set({ payload: sql`${schema.aiSuggestions.payload} || ${JSON.stringify({ triage: true, storm })}::jsonb` }).where(eq(schema.aiSuggestions.id, dup.suggestionId));
        if (dup.likely.length) lines.push(`${dup.likely.length} possible duplicate${dup.likely.length === 1 ? '' : 's'}: ${dup.likely.slice(0, 3).join(', ')}${storm ? ' (alert storm)' : ''}`);
        else if (storm) lines.push(`${recent.length + 1} similar tickets in ${g.triage.stormWindowMinutes} min`);
      }
      out.duplicates = { likely: dup.likely.length, linkedTo, storm, recent: recent.length };
    }

    if (knowledge) lines.push(`${knowledge} knowledge article${knowledge === 1 ? '' : 's'} suggested`);
    await addActivity(ctx, row, { type: 'ai', summary: `Grady triage: ${lines.join('; ') || 'nothing to suggest'}`, data: out as unknown as Record<string, unknown>, customerVisible: false });
    await ctx.audit({ entityType: 'ticket', entityId: row.id, entityLabel: row.number, action: 'ai.triage', customerId: row.customerId, metadata: out as unknown as Record<string, unknown> });
    return out;
  });
}

/** Applies an accepted suggestion through the ticket services under the accepting person's permissions. Returns the changes made. */
export async function applySuggestion(ctx: Ctx, s: typeof schema.aiSuggestions.$inferSelect, opts: { targetTicketId?: string | null } = {}): Promise<string[]> {
  if (s.entityType !== 'ticket') return [];
  const p = s.payload as Record<string, unknown>;
  const row = await reloadTicket(ctx.tx, s.entityId);
  const changes: string[] = [];
  if (s.kind === 'classification') {
    const patch: Record<string, string> = {};
    for (const k of ['categoryId', 'subcategoryId', 'impactId', 'urgencyId', 'priorityId'] as const) {
      const v = p[k];
      if (typeof v === 'string' && v && v !== row[k]) patch[k] = v;
    }
    if (Object.keys(patch).length) {
      await updateTicket(ctx, row.id, patch);
      changes.push(...Object.keys(patch));
    }
  } else if (s.kind === 'assignment') {
    const teamId = typeof p.teamId === 'string' ? p.teamId : null;
    const userId = typeof p.userId === 'string' ? p.userId : null;
    if ((teamId && teamId !== row.assignedTeamId) || (userId && userId !== row.assigneeId)) {
      await assignTicket(ctx, row.id, { teamId: teamId ?? row.assignedTeamId ?? undefined, assigneeId: userId ?? row.assigneeId ?? null, autoProgress: true });
      if (teamId && teamId !== row.assignedTeamId) changes.push('assignedTeamId');
      if (userId && userId !== row.assigneeId) changes.push('assigneeId');
    }
  } else if (s.kind === 'duplicates') {
    const items = (Array.isArray(p.items) ? p.items : []) as { id: string; number: string }[];
    const likely = (Array.isArray(p.likely) ? p.likely : []) as string[];
    const target = opts.targetTicketId ? items.find((i) => i.id === opts.targetTicketId) : items.find((i) => likely.includes(i.number));
    if (target) {
      await addLink(ctx, row.id, { targetTicketId: target.id, linkType: 'duplicate_of' });
      changes.push(`duplicate_of:${target.number}`);
    }
  }
  return changes;
}
