import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, RefreshCw, Trash2, CalendarPlus, Ticket, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Badge, Button, ConfirmDialog, Drawer, KeyValue, LoadingBlock, ProgressBar, EmptyState } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { errorMessage } from '@/components/cmdb/hooks';
import { fmtDate, fmtNumber, titleCase } from '@/lib/format';
import { pmApi, pmKeys } from './api';
import { ProgramForm } from './ProgramForm';
import { OccurrenceStatusBadge, FrequencyBadge, DueIn } from './OccurrenceStatusBadge';
import type { ProgramDetail } from './types';

/**
 * Program detail drawer: definition, entitlement utilisation, covered CIs /
 * assets, checklist template and the occurrence timeline with quick actions.
 */
export function ProgramDrawer({ programId, onClose, onSchedule }: { programId: string | null; onClose: () => void; onSchedule: (occurrenceId: string) => void }) {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const q = useQuery({ queryKey: pmKeys.program(programId ?? ''), queryFn: () => pmApi.program(programId!), enabled: !!programId });
  const [edit, setEdit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: pmKeys.all });
  const regenerate = useMutation({ mutationFn: () => pmApi.regenerate(programId!), onSuccess: (r) => { toast.success(`${r.created} occurrence${r.created === 1 ? '' : 's'} generated${r.removed ? `, ${r.removed} dropped` : ''}`); invalidate(); }, onError: (e) => toast.error(errorMessage(e)) });
  const remove = useMutation({ mutationFn: () => pmApi.deleteProgram(programId!), onSuccess: (r) => { toast.success(r.deleted ? 'Program deleted' : 'Program deactivated (completed occurrences are kept)'); setConfirmDelete(false); invalidate(); onClose(); }, onError: (e) => toast.error(errorMessage(e)) });
  const p: ProgramDetail | undefined = q.data;
  const canManage = can('pm:manage');

  return (
    <Drawer open={!!programId} onClose={onClose} title={p ? p.name : 'Program'} width="max-w-3xl" footer={p && canManage ? (
      <>
        <Button variant="ghost" size="sm" className="text-red-600 mr-auto" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setConfirmDelete(true)}>{p.completed12m > 0 || p.occurrences.some((o) => o.status === 'completed') ? 'Deactivate' : 'Delete'}</Button>
        <Button variant="outline" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => regenerate.mutate()} loading={regenerate.isPending}>Regenerate schedule</Button>
        <Button size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEdit(true)}>Edit</Button>
      </>
    ) : undefined}>
      {q.isLoading || !p ? (
        <LoadingBlock />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge color={p.isActive ? 'green' : 'gray'} dot>{p.isActive ? 'Active' : 'Inactive'}</Badge>
            <FrequencyBadge frequency={p.frequency} intervalDays={p.intervalDays} />
            {p.requiresSiteVisit ? <Badge color="blue">Site visit</Badge> : <Badge color="slate">Remote / paperwork</Badge>}
            {p.overdue > 0 && <Badge color="red">{p.overdue} overdue</Badge>}
          </div>
          <KeyValue
            columns={3}
            items={[
              { label: 'Customer', value: <Link to={`/customers/${p.customerId}`} className="hover:underline">{p.customerName}</Link> },
              { label: 'Site', value: p.siteName ?? 'All sites' },
              { label: 'Service', value: p.serviceName ?? '—' },
              { label: 'Contract', value: p.contractId ? <Link to={`/contracts/${p.contractId}`} className="hover:underline">{p.contractNumber}</Link> : <span className="text-subtle">None</span> },
              { label: 'Schedule', value: `${fmtDate(p.startDate)} → ${p.endDate ? fmtDate(p.endDate) : 'open ended'}` },
              { label: 'Lead / grace', value: `${p.leadDays} / ${p.graceDays} days` },
              { label: 'Team', value: p.teamName ?? '—' },
              { label: 'Engineer', value: p.engineerName ?? '—' },
              { label: 'Next due', value: p.nextDue ? fmtDate(p.nextDue) : '—' },
              { label: 'Last 12 months', value: <span><span className="text-emerald-600">{p.completed12m} completed</span> · <span className={p.missed12m ? 'text-red-600' : ''}>{p.missed12m} missed</span></span> },
              { label: 'Description', value: p.description ? <span className="whitespace-pre-wrap">{p.description}</span> : '—', span: 2 },
            ]}
          />
          {p.entitlement && (
            <div className="card p-3">
              <div className="flex items-center justify-between text-[12.5px]"><span className="font-medium">{p.entitlement.name}</span><span className="tabular-nums text-muted">{fmtNumber(p.entitlement.utilization.used, 0)} / {fmtNumber(p.entitlement.utilization.quantity, 0)} {p.entitlement.unit}</span></div>
              <ProgressBar pct={p.entitlement.utilization.pct} className="mt-1.5" />
              <div className="text-[11px] text-subtle mt-1">{fmtDate(p.entitlement.utilization.periodStart)} – {fmtDate(p.entitlement.utilization.periodEnd)} · {p.entitlement.utilization.exhausted ? 'exhausted' : `${fmtNumber(p.entitlement.utilization.remaining, 0)} remaining`} · each completed occurrence consumes 1</div>
            </div>
          )}
          {(p.cis.length > 0 || p.assets.length > 0) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium mb-1">Configuration items ({p.cis.length})</div>
                <div className="flex flex-wrap gap-1.5">{p.cis.map((c) => <Link key={c.id} to={`/cmdb/${c.id}`} className="rounded-md border border-default bg-surface-2 px-2 py-0.5 text-[12px] hover:underline">{c.name}</Link>)}{p.cis.length === 0 && <span className="text-[12px] text-subtle">—</span>}</div>
              </div>
              <div>
                <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium mb-1">Assets ({p.assets.length})</div>
                <div className="flex flex-wrap gap-1.5">{p.assets.map((a) => <Link key={a.id} to={`/assets/${a.id}`} className="rounded-md border border-default bg-surface-2 px-2 py-0.5 text-[12px] font-mono hover:underline" title={a.name}>{a.tag}</Link>)}{p.assets.length === 0 && <span className="text-[12px] text-subtle">—</span>}</div>
              </div>
            </div>
          )}
          <div>
            <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium mb-1">Checklist template ({p.checklist.length})</div>
            {p.checklist.length === 0 ? <div className="text-[12px] text-subtle">No checklist.</div> : <ol className="list-decimal pl-5 text-[13px] space-y-0.5">{p.checklist.map((c, i) => <li key={i}>{c.item}{c.required && <span className="text-red-500 ml-0.5">*</span>}</li>)}</ol>}
          </div>
          <div>
            <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium mb-1">Occurrences ({p.occurrences.length})</div>
            {p.occurrences.length === 0 ? (
              <EmptyState title="No occurrences" description="Regenerate the schedule or activate the program." />
            ) : (
              <table className="table [&_td]:py-1.5 [&_th]:py-1.5">
                <thead><tr><th>Planned</th><th>Scheduled</th><th>Status</th><th>Engineer</th><th>Visit</th><th>Ticket</th><th /></tr></thead>
                <tbody>
                  {p.occurrences.map((o) => (
                    <tr key={o.id}>
                      <td className="whitespace-nowrap">{fmtDate(o.plannedDate)} <DueIn days={o.daysUntil} status={o.status} /></td>
                      <td>{o.scheduledDate ? fmtDate(o.scheduledDate) : <span className="text-subtle">—</span>}</td>
                      <td><OccurrenceStatusBadge status={o.status} /></td>
                      <td>{o.engineerName ?? <span className="text-subtle">—</span>}</td>
                      <td>{o.fieldVisitId ? <Link to={`/field/${o.fieldVisitId}`} className="font-mono text-[12px] text-brand-700 dark:text-brand-300 hover:underline inline-flex items-center gap-1">{o.fieldVisitNumber} <ExternalLink className="h-3 w-3" /></Link> : <span className="text-subtle">—</span>}</td>
                      <td>{o.ticketId ? <Link to={`/tickets/${o.ticketId}`} className="font-mono text-[12px] text-brand-700 dark:text-brand-300 hover:underline inline-flex items-center gap-1"><Ticket className="h-3 w-3" />{o.ticketNumber}</Link> : <span className="text-subtle">—</span>}</td>
                      <td className="text-right">{canManage && ['planned', 'scheduled', 'rescheduled', 'missed'].includes(o.status) && <Button size="sm" variant="ghost" icon={<CalendarPlus className="h-3.5 w-3.5" />} onClick={() => onSchedule(o.id)}>{o.status === 'planned' || o.status === 'missed' ? 'Schedule' : 'Move'}</Button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="text-[11.5px] text-subtle">Created {fmtDate(p.createdAt)} · {titleCase(p.frequency)}{p.intervalDays ? ` (${p.intervalDays} days)` : ''}</div>
        </div>
      )}
      <ProgramForm open={edit} program={p ?? null} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); invalidate(); }} />
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={() => remove.mutate()} title="Delete program?" description="Programs with completed occurrences are deactivated instead of deleted so the history stays intact." confirmLabel="Confirm" danger loading={remove.isPending} />
    </Drawer>
  );
}
