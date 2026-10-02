import { Download, Trash2 } from 'lucide-react';
import { Badge, Button, Toggle, DataTable, type Column } from '@/components/ui';
import { download } from '@/api/client';
import { fmtDateTime, fmtBytes, fmtNumber } from '@/lib/format';
import type { ReportRun } from './types';

const STATUS_COLOR: Record<string, string> = { completed: 'green', failed: 'red', running: 'blue', queued: 'slate' };

export function RunsTable({ runs, loading, canManage, isCustomer, onToggleVisible, onDelete }: { runs: ReportRun[]; loading?: boolean; canManage: boolean; isCustomer: boolean; onToggleVisible?: (run: ReportRun, visible: boolean) => void; onDelete?: (run: ReportRun) => void }) {
  const columns: Column<ReportRun>[] = [
    { key: 'name', header: 'Report', render: (r) => <div className="min-w-0"><div className="font-medium truncate">{r.name}</div>{r.scheduleName && <div className="text-[11px] text-subtle">Schedule: {r.scheduleName}</div>}</div> },
    ...(isCustomer ? [] : [{ key: 'customer', header: 'Customer', render: (r: ReportRun) => <span className="text-muted">{r.customerName ?? <span className="text-subtle">MSP-wide</span>}</span> }]),
    { key: 'period', header: 'Period', render: (r) => <span className="text-muted">{String(r.parameters?.period ?? '—')}</span> },
    { key: 'createdAt', header: 'Generated', render: (r) => <span className="text-muted whitespace-nowrap">{fmtDateTime(r.createdAt)}{r.requestedByName ? <span className="text-subtle"> · {r.requestedByName}</span> : ''}</span> },
    { key: 'rowCount', header: 'Rows', className: 'text-right', render: (r) => <span className="tabular-nums">{r.rowCount === null ? '—' : fmtNumber(r.rowCount)}</span> },
    { key: 'format', header: 'Format', render: (r) => <Badge color="slate">{r.format.toUpperCase()}</Badge> },
    { key: 'status', header: 'Status', render: (r) => <span title={r.error ?? undefined}><Badge color={STATUS_COLOR[r.status] ?? 'slate'}>{r.status}</Badge></span> },
    ...(isCustomer ? [] : [{ key: 'deliveredTo', header: 'Delivered to', render: (r: ReportRun) => (r.deliveredTo.length ? <span className="text-muted text-[12px]" title={r.deliveredTo.join(', ')}>{r.deliveredTo.length} recipient{r.deliveredTo.length === 1 ? '' : 's'}</span> : <span className="text-subtle">—</span>) }]),
    ...(canManage ? [{ key: 'portalVisible', header: 'Portal', render: (r: ReportRun) => <Toggle checked={r.portalVisible} onChange={(v) => onToggleVisible?.(r, v)} /> }] : []),
    {
      key: 'actions',
      header: '',
      className: 'text-right whitespace-nowrap',
      render: (r) => (
        <div className="inline-flex items-center gap-1">
          {r.attachmentId && r.status === 'completed' && (
            <Button size="sm" variant="outline" icon={<Download className="h-3.5 w-3.5" />} onClick={() => download(`/attachments/${r.attachmentId}/download`, r.filename ?? `${r.name}.${r.format}`)} title={r.size ? fmtBytes(r.size) : undefined}>
              Download
            </Button>
          )}
          {canManage && <Button size="icon" variant="ghost" aria-label="Delete run" onClick={() => onDelete?.(r)}><Trash2 className="h-3.5 w-3.5" /></Button>}
        </div>
      ),
    },
  ];
  return <DataTable columns={columns} rows={runs} loading={loading} dense empty={<div className="text-[13px] text-subtle py-8 text-center">No report runs yet</div>} />;
}
