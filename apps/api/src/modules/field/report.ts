import { eq } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { ConflictError } from '@/core/errors';
import { escapeHtml } from '@/lib/templates';
import { createAttachment } from '@/modules/attachments/service';
import { getVisit } from './service';
import { requireExecute, loadVisit } from './common';

type VisitView = Awaited<ReturnType<typeof getVisit>>;

const fmtDt = (v: Date | string | null | undefined) => (v ? new Date(v).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false, dateStyle: 'medium', timeStyle: 'short' }) + ' UTC' : '—');
const fmtMin = (m: number | null | undefined) => (m === null || m === undefined ? '—' : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim());
const e = (v: unknown) => escapeHtml(v === null || v === undefined ? '' : String(v));
const para = (v: string | null | undefined) => (v ? `<p>${e(v).replace(/\n/g, '<br>')}</p>` : '<p class="muted">—</p>');

/** Self-contained, printable HTML visit report (no external assets). */
export function renderVisitReport(v: VisitView): string {
  const checklist = (v.checklist ?? []) as { item?: string; required?: boolean; done?: boolean; result?: string | null; notes?: string | null }[];
  const parts = v.parts ?? [];
  const partsTotal = parts.reduce((s, p) => s + (p.unitCost ?? 0) * (p.quantity ?? 0), 0);
  const notes = (v.notes ?? []).filter((n) => !n.isInternal);
  const stars = v.customerRating ? '★'.repeat(v.customerRating) + '☆'.repeat(5 - v.customerRating) : '';
  const statusLabel = v.status.replace(/_/g, ' ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visit report ${e(v.number)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; font: 13px/1.5 "Segoe UI", Helvetica, Arial, sans-serif; color: #1f2933; background: #f4f5f7; }
  .sheet { max-width: 860px; margin: 0 auto; background: #fff; border: 1px solid #e4e7eb; border-radius: 8px; padding: 32px 40px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 24px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #e4e7eb; text-transform: uppercase; letter-spacing: .04em; color: #52606d; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 600; text-transform: capitalize; background: #e3f9e5; color: #0b6b2b; }
  .badge.cancelled { background: #fde2e1; color: #9f1d1d; } .badge.in_progress, .badge.scheduled, .badge.requested { background: #e0ecff; color: #1e429f; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 24px; }
  .grid dt { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #7b8794; margin: 0; }
  .grid dd { margin: 0 0 6px; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e4e7eb; vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #7b8794; }
  .muted { color: #7b8794; }
  .ok { color: #0b6b2b; font-weight: 600; } .issue { color: #9f1d1d; font-weight: 600; } .na { color: #7b8794; }
  .sig { margin-top: 12px; padding: 12px 16px; border: 1px dashed #cbd2d9; border-radius: 6px; }
  .foot { margin-top: 28px; font-size: 11px; color: #7b8794; display: flex; justify-content: space-between; }
  @media print { body { padding: 0; background: #fff; } .sheet { border: 0; padding: 0; max-width: none; } }
</style></head>
<body><div class="sheet">
  <div class="head">
    <div><div class="muted">Field service visit report</div><h1>${e(v.number)} · ${e(v.title)}</h1><div class="muted">${e(v.typeLabel ?? '')}${v.pmProgramName ? ` · PM program: ${e(v.pmProgramName)}` : ''}${v.ticketNumber ? ` · Ticket ${e(v.ticketNumber)}` : ''}</div></div>
    <span class="badge ${e(v.status)}">${e(statusLabel)}</span>
  </div>
  <h2>Customer and site</h2>
  <dl class="grid">
    <div><dt>Customer</dt><dd>${e(v.customerName ?? '—')}</dd></div>
    <div><dt>Site</dt><dd>${e(v.siteName ?? '—')}</dd></div>
    <div><dt>Engineer</dt><dd>${e(v.engineerName ?? '—')}${(v as { additionalEngineers?: { name: string }[] }).additionalEngineers?.length ? ` (with ${e((v as { additionalEngineers: { name: string }[] }).additionalEngineers.map((x) => x.name).join(', '))})` : ''}</dd></div>
    <div><dt>Team</dt><dd>${e(v.teamName ?? '—')}</dd></div>
    <div><dt>Scheduled</dt><dd>${fmtDt(v.scheduledStart)}${v.scheduledEnd ? ` – ${fmtDt(v.scheduledEnd)}` : ''}</dd></div>
    <div><dt>Actual</dt><dd>${fmtDt(v.actualStart)}${v.actualEnd ? ` – ${fmtDt(v.actualEnd)}` : ''}</dd></div>
    <div><dt>Work time</dt><dd>${fmtMin(v.workMinutes)}</dd></div>
    <div><dt>Travel time</dt><dd>${fmtMin(v.travelMinutes)}</dd></div>
  </dl>
  <h2>Purpose</h2>${para(v.purpose)}
  <h2>Work summary</h2>${para(v.workSummary)}
  <h2>Findings</h2>${para(v.findings)}
  <h2>Recommendations</h2>${para(v.recommendations)}
  <h2>Checklist</h2>
  ${checklist.length ? `<table><thead><tr><th>#</th><th>Item</th><th>Result</th><th>Notes</th></tr></thead><tbody>${checklist.map((c, i) => `<tr><td>${i + 1}</td><td>${e(c.item)}${c.required ? ' <span class="muted">(required)</span>' : ''}</td><td class="${e(c.result ?? (c.done ? 'ok' : 'na'))}">${e(c.result ? c.result.toUpperCase() : c.done ? 'DONE' : 'NOT DONE')}</td><td>${e(c.notes ?? '')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No checklist.</p>'}
  <h2>Parts used</h2>
  ${parts.length ? `<table><thead><tr><th>Part</th><th>Part no.</th><th>Serial</th><th>Qty</th><th>Unit cost</th><th>Billable</th></tr></thead><tbody>${parts.map((p) => `<tr><td>${e(p.name)}${p.assetTag ? ` <span class="muted">(${e(p.assetTag)})</span>` : ''}${p.notes ? `<div class="muted">${e(p.notes)}</div>` : ''}</td><td>${e(p.partNumber ?? '')}</td><td>${e(p.serialNumber ?? '')}</td><td>${e(p.quantity)}</td><td>${p.unitCost === null ? '—' : e(p.unitCost.toFixed(2))}</td><td>${p.billable ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody>${partsTotal ? `<tfoot><tr><th colspan="4">Total</th><th>${e(partsTotal.toFixed(2))}</th><th></th></tr></tfoot>` : ''}</table>` : '<p class="muted">No parts used.</p>'}
  ${notes.length ? `<h2>Notes</h2><table><tbody>${notes.map((n) => `<tr><td class="muted" style="width:170px">${fmtDt(n.createdAt)}<br>${e(n.authorName ?? '')}</td><td>${e(n.body).replace(/\n/g, '<br>')}</td></tr>`).join('')}</tbody></table>` : ''}
  <h2>Customer acknowledgement</h2>
  <div class="sig">${v.customerAckAt ? `<div><strong>${e(v.customerAckName)}</strong>${v.customerAckTitle ? `, ${e(v.customerAckTitle)}` : ''}</div><div class="muted">Acknowledged ${fmtDt(v.customerAckAt)}${stars ? ` · Rating ${stars}` : ''}</div>${v.customerAckNotes ? `<div style="margin-top:6px">${e(v.customerAckNotes)}</div>` : ''}` : `<div class="muted">Not yet acknowledged.</div><div style="margin-top:28px;border-top:1px solid #cbd2d9;width:260px"></div><div class="muted">Name, title and signature</div>`}</div>
  <div class="foot"><span>Generated ${fmtDt(new Date())}</span><span>${e(v.number)}</span></div>
</div></body></html>`;
}

/** Renders the report for viewing/printing (read access is enough). */
export async function visitReportHtml(ctx: Ctx, id: string): Promise<string> {
  const v = await getVisit(ctx, id);
  return renderVisitReport(v);
}

/** Renders the report, stores it as a customer-visible attachment and stamps `reportGeneratedAt`. */
export async function generateVisitReport(ctx: Ctx, id: string) {
  const v = await loadVisit(ctx, id);
  requireExecute(ctx, v);
  if (v.status !== 'completed' && v.status !== 'in_progress') throw new ConflictError('Reports can be generated for in-progress or completed visits');
  const view = await getVisit(ctx, id);
  const html = renderVisitReport(view);
  const stamp = new Date();
  const filename = `${v.number}-report-${stamp.toISOString().slice(0, 10)}.html`;
  const attachment = await createAttachment(ctx, { entityType: 'field_visit', entityId: v.id, filename, contentType: 'text/html', buffer: Buffer.from(html, 'utf8'), customerId: v.customerId, customerVisible: true, docType: 'report', title: `Visit report ${v.number}` });
  await ctx.tx.update(schema.fieldVisits).set({ reportGeneratedAt: stamp, updatedAt: stamp }).where(eq(schema.fieldVisits.id, v.id));
  await ctx.audit({ entityType: 'field_visit', entityId: v.id, entityLabel: v.number, action: 'report.generate', customerId: v.customerId, metadata: { attachmentId: attachment.id, filename } });
  return { attachment, reportGeneratedAt: stamp };
}
