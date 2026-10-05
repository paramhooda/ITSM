import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Copy, Play, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge, Button, Checkbox, ConfirmDialog, DataTable, EmptyState, SearchInput, type Column } from '@/components/ui';
import { ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { REPORT_VISIBILITY_COLORS } from '@/lib/statusColors';
import { relativeTime } from '@/lib/format';
import { reportsApi, reportKeys } from '../api';
import { VISIBILITY_LABELS, visibilityOf, type CustomReport } from '../types';

/** The custom reports the person may see: open one in the builder, run it from the catalogue, duplicate or delete it; report managers can list retired ones and restore them. */
export function SavedReportsPanel() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const canManage = can('reports:manage');
  const canBuild = can('reports:build');
  const [q, setQ] = useState('');
  const [mine, setMine] = useState(false);
  const [retired, setRetired] = useState(false);
  const [open, setOpen] = useState(true);
  const [deleting, setDeleting] = useState<CustomReport | null>(null);
  const query = { q: q.trim() || undefined, mine: mine || undefined, includeInactive: canManage && retired ? true : undefined };
  const list = useQuery({ queryKey: reportKeys.custom(query), queryFn: () => reportsApi.custom(query), placeholderData: (p) => p });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['reports'] });
  const duplicate = useMutation({
    mutationFn: (id: string) => reportsApi.duplicate(id),
    onSuccess: (copy) => {
      invalidate();
      toast.success(`Copied as "${copy.name}"`);
      navigate(`/reports/builder/${copy.id}`);
    },
    onError: (e: ApiError) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => reportsApi.remove(id),
    onSuccess: () => {
      invalidate();
      setDeleting(null);
      toast.success('Report retired; its past runs stay in History');
    },
    onError: (e: ApiError) => toast.error(e.message),
  });
  const restore = useMutation({
    mutationFn: (id: string) => reportsApi.update(id, { isActive: true }),
    onSuccess: (r) => {
      invalidate();
      toast.success(`Restored "${r.name}"`);
    },
    onError: (e: ApiError) => toast.error(e.message),
  });
  const items = list.data?.items ?? [];
  const columns: Column<CustomReport>[] = [
    { key: 'name', header: 'Name', className: 'max-w-[420px] xl:max-w-[560px]', render: (r) => <div className="min-w-0"><div className="font-medium truncate flex items-center gap-1.5">{r.name} <Badge color={REPORT_VISIBILITY_COLORS[visibilityOf(r)]}>{VISIBILITY_LABELS[visibilityOf(r)]}</Badge>{!r.isActive && <Badge color="amber">Retired</Badge>}</div><div className="text-[11px] text-subtle truncate">{r.scopeCustomerName ? `Fixed to ${r.scopeCustomerName}` : 'Any customer'}{r.description ? ` · ${r.description}` : ''}</div></div> },
    { key: 'entity', header: 'Entity', render: (r) => <span className="text-muted">{r.entityLabel}</span> },
    { key: 'owner', header: 'Built by', className: 'whitespace-nowrap', render: (r) => <span className="text-muted">{r.ownerName ?? '—'}</span> },
    { key: 'runs', header: 'Runs', className: 'text-right tnum', render: (r) => <span>{r.runCount}</span> },
    { key: 'lastRun', header: 'Last run', render: (r) => <span className="text-muted whitespace-nowrap">{r.lastRunAt ? relativeTime(r.lastRunAt) : <span className="text-subtle">never</span>}</span> },
    {
      key: 'actions', header: '', className: 'text-right whitespace-nowrap',
      render: (r) => (
        <div className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {r.isActive ? (
            <Button size="sm" variant="outline" icon={<Play className="h-3.5 w-3.5" />} aria-label={`Run ${r.name}`} onClick={() => navigate(`/reports?tab=run&report=${r.key}`)}>Run</Button>
          ) : (
            r.canDelete && <Button size="sm" variant="outline" icon={<RotateCcw className="h-3.5 w-3.5" />} aria-label={`Restore ${r.name}`} loading={restore.isPending && restore.variables === r.id} onClick={() => restore.mutate(r.id)}>Restore</Button>
          )}
          {canBuild && <Button size="icon" variant="ghost" aria-label={`Duplicate ${r.name}`} loading={duplicate.isPending && duplicate.variables === r.id} onClick={() => duplicate.mutate(r.id)}><Copy className="h-3.5 w-3.5" /></Button>}
          {r.isActive && r.canDelete && <Button size="icon" variant="ghost" aria-label={`Delete ${r.name}`} onClick={() => setDeleting(r)}><Trash2 className="h-3.5 w-3.5" /></Button>}
        </div>
      ),
    },
  ];
  return (
    <div className="card" data-saved-reports>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="w-full flex items-center gap-2 px-5 py-3 text-left">
        {open ? <ChevronDown className="h-4 w-4 text-subtle" /> : <ChevronRight className="h-4 w-4 text-subtle" />}
        <span className="font-semibold text-[14px] text-default tracking-[-0.01em]">Your custom reports</span>
        <span className="text-[12px] text-subtle tnum">{list.data ? list.data.total : ''}</span>
      </button>
      {open && (
        <div className="border-t border-default">
          <div className="flex flex-wrap items-center gap-3 px-5 py-2.5">
            <SearchInput value={q} onChange={setQ} placeholder="Find a custom report…" className="w-full sm:w-72" />
            <Checkbox checked={mine} onChange={(e) => setMine(e.target.checked)} label="Mine only" />
            {canManage && <Checkbox checked={retired} onChange={(e) => setRetired(e.target.checked)} label="Include retired" />}
          </div>
          <DataTable columns={columns} rows={items} loading={list.isPending} dense onRowClick={(r) => navigate(`/reports/builder/${r.id}`)} empty={<EmptyState title={retired ? 'No custom reports' : 'No custom reports yet'} description={canBuild ? 'Pick an entity below to build the first one.' : 'Nobody has shared a custom report with you yet.'} />} />
        </div>
      )}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting.id)} title="Retire this report?" description={`"${deleting?.name}" leaves the catalogue and the picker. Its past runs stay in History; a report manager can restore it from this list with "Include retired" ticked.`} confirmLabel="Delete" danger loading={remove.isPending} />
    </div>
  );
}
