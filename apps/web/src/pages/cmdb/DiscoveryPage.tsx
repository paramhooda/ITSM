import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Play, Radar, Pencil, Trash2, Check, X, RefreshCw, FileText, Minus } from 'lucide-react';
import { toast } from 'sonner';
import { get, post, patch, del } from '@/api/client';
import { PageHeader, Button, Badge, Select, Dialog, Drawer, Field, Input, Textarea, Checkbox, Toggle, LoadingBlock, EmptyState, Pagination, ConfirmDialog, Tabs, SearchInput } from '@/components/ui';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { cn } from '@/lib/utils';
import { fmtDateTime, relativeTime, fmtDuration } from '@/lib/format';
import { CiTypeBadge } from '@/components/cmdb/CiTypeBadge';
import { useSites, errorMessage, CRON_PRESETS } from '@/components/cmdb/hooks';

interface SourceConfig { subnets: string[]; snmp: { version: '2c' | '3'; communities: string[]; v3?: { username?: string; authProtocol?: string; authKey?: string; privProtocol?: string; privKey?: string } }; ports: number[]; timeoutMs: number; concurrency: number; dnsResolve: boolean; maxHosts: number; snmpAlways: boolean }
interface Source { id: string; customerId: string; customerName?: string | null; siteId?: string | null; siteName?: string | null; name: string; sourceType: string; config: SourceConfig; scheduleCron?: string | null; autoApply: boolean; isActive: boolean; lastRunAt?: string | null; lastRunStatus?: string | null; lastRunId?: string | null; pendingFindings: number }
interface Run { id: string; sourceId: string; status: string; startedAt?: string | null; finishedAt?: string | null; stats: Record<string, number>; error?: string | null; triggeredByName?: string | null; createdAt: string; log?: string | null }
interface Finding { id: string; runId: string; ipAddress: string; hostname?: string | null; fqdn?: string | null; macAddress?: string | null; manufacturer?: string | null; model?: string | null; serialNumber?: string | null; sysDescr?: string | null; suggestedTypeKey?: string | null; openPorts: number[]; interfaces: unknown[]; neighbors: unknown[]; matchedCiId?: string | null; matchedCiName?: string | null; diffStatus: string; status: string; createdAt: string; raw: Record<string, unknown> }

const RUN_COLORS: Record<string, string> = { queued: 'blue', running: 'amber', completed: 'green', failed: 'red', cancelled: 'slate' };
const DIFF_COLORS: Record<string, string> = { new: 'green', changed: 'amber', unchanged: 'slate' };
const STATUS_COLORS: Record<string, string> = { pending: 'blue', applied: 'green', ignored: 'slate' };
const DEFAULT_PORTS = '22, 80, 443, 161, 3389, 445, 8443';

const emptyForm = () => ({ customerId: '', siteId: '', name: '', sourceType: 'network_scan', subnets: '', version: '2c' as '2c' | '3', communities: [''], v3: { username: '', authProtocol: 'sha', authKey: '', privProtocol: 'aes', privKey: '' }, ports: DEFAULT_PORTS, timeoutMs: '1500', concurrency: '64', maxHosts: '2048', dnsResolve: true, snmpAlways: true, scheduleCron: '', autoApply: false, isActive: true });
type Form = ReturnType<typeof emptyForm>;

function toForm(s: Source): Form {
  return { customerId: s.customerId, siteId: s.siteId ?? '', name: s.name, sourceType: s.sourceType, subnets: (s.config.subnets ?? []).join('\n'), version: s.config.snmp?.version ?? '2c', communities: s.config.snmp?.communities?.length ? [...s.config.snmp.communities] : [''], v3: { username: s.config.snmp?.v3?.username ?? '', authProtocol: s.config.snmp?.v3?.authProtocol ?? 'sha', authKey: s.config.snmp?.v3?.authKey ?? '', privProtocol: s.config.snmp?.v3?.privProtocol ?? 'aes', privKey: s.config.snmp?.v3?.privKey ?? '' }, ports: (s.config.ports ?? []).join(', ') || DEFAULT_PORTS, timeoutMs: String(s.config.timeoutMs ?? 1500), concurrency: String(s.config.concurrency ?? 64), maxHosts: String(s.config.maxHosts ?? 2048), dnsResolve: s.config.dnsResolve ?? false, snmpAlways: s.config.snmpAlways ?? true, scheduleCron: s.scheduleCron ?? '', autoApply: s.autoApply, isActive: s.isActive };
}

function SourceDrawer({ open, onClose, source, providers }: { open: boolean; onClose: () => void; source?: Source | null; providers: { type: string; label: string }[] }) {
  const qc = useQueryClient();
  const customers = useCustomersLookup();
  const [f, setF] = useState<Form>(emptyForm());
  const sites = useSites(f.customerId);
  useEffect(() => {
    if (open) setF(source ? toForm(source) : emptyForm());
  }, [open, source]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const config = {
        subnets: f.subnets.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean),
        snmp: { version: f.version, communities: f.communities.map((c) => c.trim()).filter(Boolean), ...(f.version === '3' ? { v3: { username: f.v3.username || undefined, authProtocol: f.v3.authProtocol, authKey: f.v3.authKey || undefined, privProtocol: f.v3.privProtocol, privKey: f.v3.privKey || undefined } } : {}) },
        ports: f.ports.split(/[\s,;]+/).map(Number).filter((n) => n > 0 && n < 65536),
        timeoutMs: Number(f.timeoutMs) || 1500,
        concurrency: Number(f.concurrency) || 64,
        maxHosts: Number(f.maxHosts) || 2048,
        dnsResolve: f.dnsResolve,
        snmpAlways: f.snmpAlways,
      };
      const body = { siteId: f.siteId || null, name: f.name, sourceType: f.sourceType, config, scheduleCron: f.scheduleCron || null, autoApply: f.autoApply, isActive: f.isActive };
      return source ? patch<Source>(`/discovery/sources/${source.id}`, body) : post<Source>('/discovery/sources', { ...body, customerId: f.customerId });
    },
    onSuccess: () => {
      toast.success(source ? 'Source updated' : 'Source created');
      qc.invalidateQueries({ queryKey: ['discovery'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const preset = CRON_PRESETS.find((p) => p.value === f.scheduleCron)?.value ?? (f.scheduleCron ? 'custom' : '');
  return (
    <Drawer open={open} onClose={onClose} title={source ? `Edit ${source.name}` : 'New discovery source'} width="max-w-2xl" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!f.name || !f.customerId || !f.subnets.trim()} onClick={() => save.mutate()}>{source ? 'Save changes' : 'Create source'}</Button></>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Customer" required>
          <Select value={f.customerId} disabled={!!source} onChange={(e) => { set('customerId', e.target.value); set('siteId', ''); }} placeholder="Select customer…" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))} />
        </Field>
        <Field label="Site" hint="Discovered CIs are created at this site.">
          <Select value={f.siteId} onChange={(e) => set('siteId', e.target.value)} placeholder="—" options={(sites.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))} />
        </Field>
        <Field label="Name" required><Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="HQ server VLANs" /></Field>
        <Field label="Source type"><Select value={f.sourceType} onChange={(e) => set('sourceType', e.target.value)} options={providers.map((p) => ({ value: p.type, label: p.label }))} /></Field>
        <Field label="Targets" required hint="One per line: CIDR (10.0.0.0/24), range (10.0.0.1-10.0.0.50) or single IP." className="sm:col-span-2">
          <Textarea className="font-mono text-xs min-h-[90px]" value={f.subnets} onChange={(e) => set('subnets', e.target.value)} placeholder={'10.0.0.0/24\n10.0.1.1-10.0.1.100'} />
        </Field>
        <Field label="SNMP version"><Select value={f.version} onChange={(e) => set('version', e.target.value as '2c' | '3')} options={[{ value: '2c', label: 'v2c (community)' }, { value: '3', label: 'v3 (user security)' }]} /></Field>
        <Field label="Ports (TCP)" hint="Comma separated."><Input className="font-mono text-xs" value={f.ports} onChange={(e) => set('ports', e.target.value)} /></Field>
        {f.version === '2c' ? (
          <Field label="SNMP communities" hint="Tried in order; stored encrypted. Leave as ******** to keep an existing value." className="sm:col-span-2">
            <div className="flex flex-col gap-1.5">
              {f.communities.map((c, i) => (
                <div key={i} className="flex gap-2">
                  <Input type="password" autoComplete="new-password" value={c} onChange={(e) => set('communities', f.communities.map((x, j) => (j === i ? e.target.value : x)))} placeholder="public" />
                  <Button variant="ghost" size="icon" onClick={() => set('communities', f.communities.filter((_, j) => j !== i))} disabled={f.communities.length === 1} aria-label="Remove"><Minus className="h-4 w-4" /></Button>
                </div>
              ))}
              <Button variant="outline" size="sm" className="self-start" icon={<Plus className="h-4 w-4" />} onClick={() => set('communities', [...f.communities, ''])} disabled={f.communities.length >= 10}>Add community</Button>
            </div>
          </Field>
        ) : (
          <>
            <Field label="v3 user" required><Input value={f.v3.username} onChange={(e) => set('v3', { ...f.v3, username: e.target.value })} /></Field>
            <div />
            <Field label="Auth protocol"><Select value={f.v3.authProtocol} onChange={(e) => set('v3', { ...f.v3, authProtocol: e.target.value })} options={['none', 'md5', 'sha', 'sha256', 'sha512'].map((v) => ({ value: v, label: v.toUpperCase() }))} /></Field>
            <Field label="Auth key"><Input type="password" autoComplete="new-password" value={f.v3.authKey} onChange={(e) => set('v3', { ...f.v3, authKey: e.target.value })} /></Field>
            <Field label="Privacy protocol"><Select value={f.v3.privProtocol} onChange={(e) => set('v3', { ...f.v3, privProtocol: e.target.value })} options={['none', 'des', 'aes', 'aes256'].map((v) => ({ value: v, label: v.toUpperCase() }))} /></Field>
            <Field label="Privacy key"><Input type="password" autoComplete="new-password" value={f.v3.privKey} onChange={(e) => set('v3', { ...f.v3, privKey: e.target.value })} /></Field>
          </>
        )}
        <Field label="Timeout (ms)"><Input type="number" min={200} max={10000} value={f.timeoutMs} onChange={(e) => set('timeoutMs', e.target.value)} /></Field>
        <Field label="Concurrency"><Input type="number" min={1} max={256} value={f.concurrency} onChange={(e) => set('concurrency', e.target.value)} /></Field>
        <Field label="Max hosts per run"><Input type="number" min={1} max={65536} value={f.maxHosts} onChange={(e) => set('maxHosts', e.target.value)} /></Field>
        <div className="flex flex-col gap-2 justify-end pb-1">
          <Checkbox label="Resolve hostnames via reverse DNS" checked={f.dnsResolve} onChange={(e) => set('dnsResolve', e.target.checked)} />
          <Checkbox label="Always try SNMP (not only when a port answers)" checked={f.snmpAlways} onChange={(e) => set('snmpAlways', e.target.checked)} />
        </div>
        <Field label="Schedule"><Select value={preset} onChange={(e) => set('scheduleCron', e.target.value === 'custom' ? f.scheduleCron || '0 2 * * *' : e.target.value)} options={[...CRON_PRESETS, { value: 'custom', label: 'Custom cron…' }]} /></Field>
        <Field label="Cron expression" hint="minute hour day month weekday (UTC)"><Input className="font-mono text-xs" value={f.scheduleCron} onChange={(e) => set('scheduleCron', e.target.value)} placeholder="0 2 * * *" /></Field>
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Checkbox label="Auto-apply new and changed findings (create/update CIs without review)" checked={f.autoApply} onChange={(e) => set('autoApply', e.target.checked)} />
          <Checkbox label="Active (scheduled runs enabled)" checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} />
        </div>
      </div>
    </Drawer>
  );
}

export default function DiscoveryPage() {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const canManage = can('discovery:manage');
  const { state, set, page, pageSize, setPage } = useListState({ tab: 'findings', status: 'pending' });
  const customers = useCustomersLookup();
  const providers = useQuery({ queryKey: ['discovery', 'providers'], queryFn: () => get<{ items: { type: string; label: string }[] }>('/discovery/providers'), staleTime: 300_000 });
  const sources = useQuery({ queryKey: ['discovery', 'sources', state.customerId ?? ''], queryFn: () => get<{ items: Source[] }>('/discovery/sources', { customerId: state.customerId, includeInactive: true }), refetchInterval: 15_000 });
  const selected = useMemo(() => sources.data?.items.find((s) => s.id === state.sourceId) ?? null, [sources.data, state.sourceId]);
  const runs = useQuery({ queryKey: ['discovery', 'runs', state.sourceId], queryFn: () => get<{ items: Run[]; total: number }>(`/discovery/sources/${state.sourceId}/runs`, { pageSize: 25 }), enabled: !!state.sourceId, refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === 'queued' || r.status === 'running') ? 3000 : false) });
  const findingsQuery = useMemo(() => ({ sourceId: state.sourceId, status: state.status || undefined, diffStatus: state.diffStatus || undefined, q: state.q || undefined, page, pageSize, sort: 'ipAddress', order: 'asc' }), [state, page, pageSize]);
  const findings = useQuery({ queryKey: ['discovery', 'findings', findingsQuery], queryFn: () => get<{ items: Finding[]; total: number }>('/discovery/findings', findingsQuery), enabled: !!state.sourceId, placeholderData: (p) => p });
  const [drawer, setDrawer] = useState<{ open: boolean; source?: Source | null }>({ open: false });
  const [runDetail, setRunDetail] = useState<string | null>(null);
  const runView = useQuery({ queryKey: ['discovery', 'run', runDetail], queryFn: () => get<Run & { sourceName?: string }>(`/discovery/runs/${runDetail}`), enabled: !!runDetail, refetchInterval: (q) => (q.state.data?.status === 'running' || q.state.data?.status === 'queued' ? 2000 : false) });
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; results: { host: string; reachable: boolean; openPorts: number[]; snmp: boolean; hostname?: string | null; sysDescr?: string | null; latencyMs: number }[] } | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [findingView, setFindingView] = useState<Finding | null>(null);

  useEffect(() => setSelectedIds([]), [findingsQuery]);
  useEffect(() => {
    if (!state.sourceId && sources.data?.items.length) set({ sourceId: sources.data.items[0].id }, false);
  }, [sources.data, state.sourceId, set]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['discovery'] });
  const runNow = useMutation({ mutationFn: (id: string) => post<Run>(`/discovery/sources/${id}/run`), onSuccess: (r) => { toast.success('Run queued'); invalidate(); set({ tab: 'runs' }, false); setRunDetail(r.id); }, onError: (e) => toast.error(errorMessage(e)) });
  const test = useMutation({ mutationFn: (id: string) => post<NonNullable<typeof testResult>>(`/discovery/sources/${id}/test`), onSuccess: (r) => setTestResult(r), onError: (e) => toast.error(errorMessage(e)) });
  const toggleActive = useMutation({ mutationFn: (s: Source) => patch(`/discovery/sources/${s.id}`, { isActive: !s.isActive }), onSuccess: invalidate, onError: (e) => toast.error(errorMessage(e)) });
  const remove = useMutation({ mutationFn: (id: string) => del(`/discovery/sources/${id}`), onSuccess: () => { toast.success('Source deleted'); setDeleteId(null); set({ sourceId: undefined }, false); invalidate(); }, onError: (e) => toast.error(errorMessage(e)) });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'apply' | 'ignore' }) => post<{ ciName?: string; created?: boolean }>(`/discovery/findings/${id}/${action}`),
    onSuccess: (r, v) => { toast.success(v.action === 'apply' ? `${r.created ? 'Created' : 'Updated'} CI ${r.ciName ?? ''}` : 'Finding ignored'); invalidate(); qc.invalidateQueries({ queryKey: ['cmdb'] }); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const bulk = useMutation({
    mutationFn: (action: 'apply' | 'ignore') => post<{ applied: number; failed: number; results: { message?: string }[] }>('/discovery/findings/bulk', { ids: selectedIds, action }),
    onSuccess: (r) => { toast[r.failed ? 'warning' : 'success'](`${r.applied} ${r.applied === 1 ? 'finding' : 'findings'} processed${r.failed ? `, ${r.failed} failed` : ''}`); setSelectedIds([]); invalidate(); qc.invalidateQueries({ queryKey: ['cmdb'] }); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const items = findings.data?.items ?? [];
  const pendingIds = items.filter((f) => f.status === 'pending').map((f) => f.id);
  const allSelected = pendingIds.length > 0 && pendingIds.every((id) => selectedIds.includes(id));

  return (
    <div>
      <PageHeader title="Network discovery" subtitle="Scan customer networks, review findings and reconcile them into the CMDB" actions={canManage ? <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setDrawer({ open: true, source: null })}>New source</Button> : undefined} />
      <div className="grid grid-cols-1 lg:grid-cols-[330px_1fr] gap-4 items-start">
        <div className="flex flex-col gap-2">
          <Select value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value, sourceId: undefined })} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
          {sources.isLoading && <LoadingBlock />}
          {sources.data && !sources.data.items.length && <div className="card"><EmptyState icon={<Radar className="h-5 w-5" />} title="No discovery sources" description="Create a source with the subnets and SNMP credentials of a customer network." action={canManage ? <Button size="sm" onClick={() => setDrawer({ open: true, source: null })}>New source</Button> : undefined} /></div>}
          {sources.data?.items.map((s) => (
            <button key={s.id} onClick={() => set({ sourceId: s.id })} className={cn('card p-3 text-left hover:border-brand-400 transition-colors', state.sourceId === s.id && 'border-brand-500 ring-2 ring-brand-500/20', !s.isActive && 'opacity-70')}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium truncate">{s.name}</div>
                  <div className="text-xs text-muted truncate">{s.customerName}{s.siteName ? ` · ${s.siteName}` : ''}</div>
                </div>
                {s.lastRunStatus && <Badge color={RUN_COLORS[s.lastRunStatus]} dot>{s.lastRunStatus}</Badge>}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-subtle">
                <span>{providers.data?.items.find((p) => p.type === s.sourceType)?.label ?? s.sourceType}</span>
                <span className="font-mono">{s.config.subnets?.length ?? 0} target(s)</span>
                <span>{s.scheduleCron ? <span className="font-mono">{s.scheduleCron}</span> : 'manual'}</span>
                {s.lastRunAt && <span>last run {relativeTime(s.lastRunAt)}</span>}
                {s.pendingFindings > 0 && <Badge color="blue">{s.pendingFindings} to review</Badge>}
                {s.autoApply && <Badge color="green">auto-apply</Badge>}
              </div>
            </button>
          ))}
        </div>

        <div className="min-w-0">
          {!selected && !sources.isLoading && <div className="card"><EmptyState title="Select a source" description="Runs and findings for the selected source appear here." /></div>}
          {selected && (
            <div className="flex flex-col gap-3">
              <div className="card p-3 flex flex-wrap items-center gap-2">
                <div className="min-w-0 mr-auto">
                  <div className="font-semibold flex items-center gap-2">{selected.name} {!selected.isActive && <Badge color="slate">inactive</Badge>}</div>
                  <div className="text-xs text-muted font-mono truncate">{selected.config.subnets?.join(', ')}</div>
                </div>
                {canManage && <Toggle checked={selected.isActive} onChange={() => toggleActive.mutate(selected)} label="Active" />}
                <Button variant="outline" size="sm" icon={<RefreshCw className="h-4 w-4" />} loading={test.isPending} onClick={() => test.mutate(selected.id)}>Test</Button>
                <Button size="sm" icon={<Play className="h-4 w-4" />} loading={runNow.isPending} onClick={() => runNow.mutate(selected.id)} disabled={!selected.isActive}>Run now</Button>
                {canManage && <Button variant="ghost" size="icon" title="Edit" onClick={() => setDrawer({ open: true, source: selected })}><Pencil className="h-4 w-4" /></Button>}
                {canManage && <Button variant="ghost" size="icon" title="Delete" onClick={() => setDeleteId(selected.id)}><Trash2 className="h-4 w-4" /></Button>}
              </div>
              <Tabs value={state.tab ?? 'findings'} onChange={(t) => set({ tab: t }, false)} tabs={[{ key: 'findings', label: 'Findings', count: findings.data?.total }, { key: 'runs', label: 'Runs', count: runs.data?.total }]} />

              {state.tab === 'runs' && (
                <div className="card">
                  {runs.isLoading && <LoadingBlock />}
                  {runs.data && (runs.data.items.length ? (
                    <table className="table">
                      <thead><tr><th>Status</th><th>Started</th><th>Finished</th><th>Duration</th><th>Scanned</th><th>Responsive</th><th>SNMP</th><th>Findings</th><th>Trigger</th></tr></thead>
                      <tbody>
                        {runs.data.items.map((r) => (
                          <tr key={r.id} className="clickable" onClick={() => setRunDetail(r.id)}>
                            <td><Badge color={RUN_COLORS[r.status]} dot>{r.status}</Badge></td>
                            <td className="text-muted whitespace-nowrap">{r.startedAt ? fmtDateTime(r.startedAt) : fmtDateTime(r.createdAt)}</td>
                            <td className="text-muted whitespace-nowrap">{r.finishedAt ? fmtDateTime(r.finishedAt) : '—'}</td>
                            <td>{r.startedAt && r.finishedAt ? fmtDuration((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 60000) : '—'}</td>
                            <td>{r.stats?.hostsScanned ?? '—'}</td><td>{r.stats?.responsive ?? '—'}</td><td>{r.stats?.snmp ?? '—'}</td>
                            <td>{r.stats?.findings !== undefined ? <span>{r.stats.findings} <span className="text-xs text-subtle">({r.stats.newCis} new · {r.stats.changed} changed · {r.stats.unchanged} same)</span></span> : '—'}</td>
                            <td className="text-muted">{r.triggeredByName ?? 'schedule'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <EmptyState title="No runs yet" description="Click Run now to start a scan." />)}
                </div>
              )}

              {state.tab !== 'runs' && (
                <div className="card">
                  <div className="flex flex-wrap items-center gap-2 p-3 border-b border-default">
                    <SearchInput value={state.q ?? ''} onChange={(v) => set({ q: v })} placeholder="IP, hostname, serial…" className="w-56" />
                    <Select className="w-36" value={state.status ?? ''} onChange={(e) => set({ status: e.target.value })} placeholder="Any status" options={['pending', 'applied', 'ignored'].map((v) => ({ value: v, label: v }))} />
                    <Select className="w-36" value={state.diffStatus ?? ''} onChange={(e) => set({ diffStatus: e.target.value })} placeholder="Any diff" options={['new', 'changed', 'unchanged'].map((v) => ({ value: v, label: v }))} />
                    {selectedIds.length > 0 && (
                      <div className="ml-auto flex items-center gap-2 text-[13px]">
                        <span className="text-muted">{selectedIds.length} selected</span>
                        <Button size="sm" icon={<Check className="h-4 w-4" />} loading={bulk.isPending} onClick={() => bulk.mutate('apply')}>Apply</Button>
                        <Button size="sm" variant="outline" icon={<X className="h-4 w-4" />} loading={bulk.isPending} onClick={() => bulk.mutate('ignore')}>Ignore</Button>
                      </div>
                    )}
                  </div>
                  {findings.isLoading && <LoadingBlock />}
                  {findings.data && (items.length ? (
                    <div className="overflow-auto">
                      <table className="table">
                        <thead>
                          <tr>
                            <th className="w-8"><input type="checkbox" className="h-4 w-4 accent-brand-600" checked={allSelected} onChange={(e) => setSelectedIds(e.target.checked ? pendingIds : [])} /></th>
                            <th>IP</th><th>Hostname</th><th>Suggested type</th><th>Manufacturer / model</th><th>Serial</th><th>Open ports</th><th>Matched CI</th><th>Diff</th><th>Status</th><th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((f) => (
                            <tr key={f.id} className="clickable" onClick={() => setFindingView(f)}>
                              <td onClick={(e) => e.stopPropagation()}>{f.status === 'pending' && <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={selectedIds.includes(f.id)} onChange={(e) => setSelectedIds((ids) => (e.target.checked ? [...ids, f.id] : ids.filter((x) => x !== f.id)))} />}</td>
                              <td className="font-mono text-xs">{f.ipAddress}</td>
                              <td><div className="leading-tight"><div>{f.hostname ?? <span className="text-subtle">—</span>}</div>{f.fqdn && f.fqdn !== f.hostname && <div className="text-[11px] text-subtle font-mono">{f.fqdn}</div>}</div></td>
                              <td><CiTypeBadge typeKey={f.suggestedTypeKey ?? 'other'} /></td>
                              <td className="text-xs">{[f.manufacturer, f.model].filter(Boolean).join(' ') || '—'}</td>
                              <td className="font-mono text-xs">{f.serialNumber ?? '—'}</td>
                              <td><div className="flex flex-wrap gap-1 max-w-[200px]">{f.openPorts.slice(0, 8).map((p) => <Badge key={p} color="slate">{p}</Badge>)}{f.openPorts.length > 8 && <Badge color="slate">+{f.openPorts.length - 8}</Badge>}{(f.raw as { snmp?: boolean }).snmp && <Badge color="indigo">snmp</Badge>}</div></td>
                              <td onClick={(e) => e.stopPropagation()}>{f.matchedCiId ? <Link to={`/cmdb/${f.matchedCiId}`} className="text-brand-600 hover:underline">{f.matchedCiName ?? 'CI'}</Link> : <span className="text-subtle">—</span>}</td>
                              <td><Badge color={DIFF_COLORS[f.diffStatus]}>{f.diffStatus}</Badge></td>
                              <td><Badge color={STATUS_COLORS[f.status]} dot>{f.status}</Badge></td>
                              <td onClick={(e) => e.stopPropagation()}>
                                {f.status === 'pending' && (
                                  <div className="flex gap-1">
                                    <Button size="sm" variant="outline" title={f.matchedCiId ? 'Update the matched CI' : 'Create a new CI'} onClick={() => act.mutate({ id: f.id, action: 'apply' })} loading={act.isPending && act.variables?.id === f.id}>{f.matchedCiId ? 'Update' : 'Create'}</Button>
                                    <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: f.id, action: 'ignore' })}>Ignore</Button>
                                  </div>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : <EmptyState title="No findings" description={state.status === 'pending' ? 'Nothing waiting for review. Run a scan or change the status filter.' : 'No findings match the filters.'} />)}
                  <Pagination page={page} pageSize={pageSize} total={findings.data?.total ?? 0} onPage={setPage} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <SourceDrawer open={drawer.open} onClose={() => setDrawer({ open: false })} source={drawer.source} providers={providers.data?.items ?? [{ type: 'network_scan', label: 'Network scan' }]} />

      <Dialog open={!!runDetail} onClose={() => setRunDetail(null)} title={<span className="inline-flex items-center gap-2"><FileText className="h-4 w-4" /> Run detail {runView.data && <Badge color={RUN_COLORS[runView.data.status]} dot>{runView.data.status}</Badge>}</span>} width="max-w-3xl">
        {runView.isLoading && <LoadingBlock />}
        {runView.data && (
          <div className="flex flex-col gap-3 text-[13px]">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {Object.entries(runView.data.stats ?? {}).map(([k, v]) => (
                <div key={k} className="card p-2"><div className="text-[11px] uppercase tracking-wide text-subtle">{k.replace(/([A-Z])/g, ' $1')}</div><div className="text-lg font-semibold">{v}</div></div>
              ))}
            </div>
            <div className="text-xs text-muted">Started {runView.data.startedAt ? fmtDateTime(runView.data.startedAt) : '—'} · finished {runView.data.finishedAt ? fmtDateTime(runView.data.finishedAt) : '—'} · by {runView.data.triggeredByName ?? 'schedule'}</div>
            {runView.data.error && <div className="rounded-md bg-red-50 text-red-700 p-2 text-xs">{runView.data.error}</div>}
            <pre className="bg-surface-2 rounded-md p-3 text-[11.5px] font-mono whitespace-pre-wrap max-h-80 overflow-auto">{runView.data.log || 'No log output yet.'}</pre>
          </div>
        )}
      </Dialog>

      <Dialog open={!!testResult} onClose={() => setTestResult(null)} title="Connectivity test" width="max-w-2xl">
        {testResult && (
          <div className="flex flex-col gap-2">
            <div className={cn('text-[13px] font-medium', testResult.ok ? 'text-emerald-600' : 'text-red-600')}>{testResult.message}</div>
            <table className="table">
              <thead><tr><th>Host</th><th>Reachable</th><th>Open ports</th><th>SNMP</th><th>Hostname</th><th>Latency</th></tr></thead>
              <tbody>
                {testResult.results.map((r) => (
                  <tr key={r.host}>
                    <td className="font-mono text-xs">{r.host}</td>
                    <td>{r.reachable ? <Badge color="green" dot>yes</Badge> : <Badge color="slate" dot>no</Badge>}</td>
                    <td><div className="flex flex-wrap gap-1">{r.openPorts.map((p) => <Badge key={p} color="slate">{p}</Badge>)}</div></td>
                    <td>{r.snmp ? <Badge color="indigo">answered</Badge> : <span className="text-subtle">—</span>}</td>
                    <td className="text-xs">{r.hostname ?? '—'}{r.sysDescr && <div className="text-subtle truncate max-w-[220px]" title={r.sysDescr}>{r.sysDescr}</div>}</td>
                    <td className="text-muted">{r.latencyMs} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Dialog>

      <Dialog open={!!findingView} onClose={() => setFindingView(null)} title={findingView ? `${findingView.ipAddress}${findingView.hostname ? ` · ${findingView.hostname}` : ''}` : ''} width="max-w-2xl">
        {findingView && (
          <div className="flex flex-col gap-3 text-[13px]">
            <div className="flex flex-wrap gap-2"><CiTypeBadge typeKey={findingView.suggestedTypeKey ?? 'other'} /><Badge color={DIFF_COLORS[findingView.diffStatus]}>{findingView.diffStatus}</Badge><Badge color={STATUS_COLORS[findingView.status]} dot>{findingView.status}</Badge>{findingView.matchedCiId && <Link to={`/cmdb/${findingView.matchedCiId}`} className="text-brand-600 hover:underline">matched: {findingView.matchedCiName}</Link>}</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div><span className="text-subtle">MAC:</span> <span className="font-mono">{findingView.macAddress ?? '—'}</span></div>
              <div><span className="text-subtle">Serial:</span> <span className="font-mono">{findingView.serialNumber ?? '—'}</span></div>
              <div><span className="text-subtle">Manufacturer:</span> {findingView.manufacturer ?? '—'}</div>
              <div><span className="text-subtle">Model:</span> {findingView.model ?? '—'}</div>
              <div className="col-span-2"><span className="text-subtle">sysDescr:</span> {findingView.sysDescr ?? '—'}</div>
              <div className="col-span-2"><span className="text-subtle">Changed fields:</span> {((findingView.raw.changedFields as string[]) ?? []).join(', ') || '—'}</div>
            </div>
            <div><div className="text-[11px] uppercase tracking-wide text-subtle mb-1">Interfaces ({findingView.interfaces.length})</div>
              {findingView.interfaces.length ? <pre className="bg-surface-2 rounded-md p-2 text-[11px] max-h-40 overflow-auto">{JSON.stringify(findingView.interfaces, null, 1)}</pre> : <span className="text-subtle text-xs">none</span>}
            </div>
            <div><div className="text-[11px] uppercase tracking-wide text-subtle mb-1">Neighbours ({findingView.neighbors.length})</div>
              {findingView.neighbors.length ? <pre className="bg-surface-2 rounded-md p-2 text-[11px] max-h-40 overflow-auto">{JSON.stringify(findingView.neighbors, null, 1)}</pre> : <span className="text-subtle text-xs">none</span>}
            </div>
            <div className="text-xs text-subtle">Discovered {fmtDateTime(findingView.createdAt)}</div>
          </div>
        )}
      </Dialog>

      <ConfirmDialog open={!!deleteId} onClose={() => setDeleteId(null)} onConfirm={() => deleteId && remove.mutate(deleteId)} loading={remove.isPending} danger confirmLabel="Delete source" title="Delete discovery source?" description="All runs and findings of this source are removed. CIs already created remain." />
    </div>
  );
}
