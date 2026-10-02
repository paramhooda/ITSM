import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Save, Copy, Trash2, Star, Plus, Unlink, Search, FileSignature } from 'lucide-react';
import { SLA_METRICS, TICKET_TYPES } from '@itsm/shared';
import { get, post, patch, put, del } from '@/api/client';
import { Button, Badge, Card, Field, Input, Textarea, Select, Tabs, Toggle, LoadingBlock, ErrorBlock, Dialog, EmptyState, Checkbox, ProgressBar } from '@/components/ui';
import { useLookups } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { fmtDate, fmtDateTime, fmtNumber, fmtPct, titleCase } from '@/lib/format';
import { DurationInput, formatDuration } from '@/components/admin/DurationInput';
import { MultiSelect } from '@/components/admin/inputs';
import { errorMessage, useConfigKind } from '@/components/admin/api';
import { ContractStatusBadge } from '@/components/contracts/ContractBits';
import { Segmented, Stat } from '@/components/dashboards/Panel';
import { cn } from '@/lib/utils';
import { usageSummary, METRIC_LABEL, type SlaPolicy, type SlaTarget, type PolicyContract, type Compliance } from './types';

type TicketType = (typeof TICKET_TYPES)[number];
type Metric = (typeof SLA_METRICS)[number];
type Tab = 'targets' | 'contracts' | 'compliance';

interface CellValue {
  minutes: number | null;
  warnPct: number;
  calendarTime: boolean;
}

const cellKey = (t: string, p: string | null, m: string) => `${t}|${p ?? 'any'}|${m}`;

interface Preview {
  calendar: { name: string; timezone: string; is24x7: boolean; holidays: number };
  start: string;
  metrics: { metric: string; minutes: number; warnPct: number; calendar: string; appliesTo: string; dueAt: string; warnAt: string; elapsedHours: number }[];
}

/** One SLA policy: targets, the contracts mapped to it and its compliance. */
export default function SlaPolicyPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const navigate = useNavigate();
  const qc = useQueryClient();
  const lookups = useLookups();
  const can = useAuthStore((s) => s.can);
  const canEdit = can('admin:config');
  const policyQ = useQuery({ queryKey: ['sla', 'policy', id], queryFn: () => get<SlaPolicy>(`/sla/policies/${id}`), enabled: !isNew });
  const holidayCals = useConfigKind<{ id: string; name: string }>('holiday-calendars');

  const [tab, setTab] = useState<Tab>('targets');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [calendarId, setCalendarId] = useState<string | null>(null);
  const [holidayCalendarId, setHolidayCalendarId] = useState<string | null>(null);
  const [isDefault, setIsDefault] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [cells, setCells] = useState<Record<string, CellValue>>({});
  const [pauseStatusIds, setPauseStatusIds] = useState<string[]>([]);
  const [ticketType, setTicketType] = useState<TicketType>('incident');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const p = policyQ.data;
    if (!p) return;
    setName(p.name);
    setDescription(p.description ?? '');
    setCalendarId(p.calendarId);
    setHolidayCalendarId(p.holidayCalendarId);
    setIsDefault(p.isDefault);
    setIsActive(p.isActive);
    setCells(Object.fromEntries(p.targets.map((t) => [cellKey(t.ticketType, t.priorityId, t.metric), { minutes: t.minutes, warnPct: t.warnPct, calendarTime: t.calendarTime }])));
    setPauseStatusIds(p.pauseStatusIds);
    setDirty(false);
  }, [policyQ.data]);

  const priorities = lookups.options('ticket_priority');
  const statuses = lookups.options('ticket_status');
  const calendars = lookups.lookups?.calendars ?? [];
  const rowsFor = (t: TicketType) => [...priorities.filter((p) => !p.appliesTo.length || p.appliesTo.includes(t)).map((p) => ({ id: p.id as string | null, label: p.label, color: p.color })), { id: null, label: 'Any priority', color: null }];
  const targetCount = useMemo(() => Object.values(cells).filter((c) => c.minutes && c.minutes > 0).length, [cells]);

  const setCell = (key: string, patchValue: Partial<CellValue>) => {
    setCells((c) => ({ ...c, [key]: { ...(c[key] ?? { minutes: null, warnPct: 75, calendarTime: false }), ...patchValue } }));
    setDirty(true);
  };

  const toTargets = (): SlaTarget[] =>
    Object.entries(cells)
      .filter(([, v]) => v.minutes && v.minutes > 0)
      .map(([k, v]) => {
        const [tt, p, metric] = k.split('|');
        return { ticketType: tt!, priorityId: p === 'any' ? null : p!, metric: metric!, minutes: v.minutes!, warnPct: v.warnPct, calendarTime: v.calendarTime };
      });

  async function save() {
    if (!name.trim()) {
      toast.error('Give the policy a name');
      return;
    }
    setSaving(true);
    try {
      const base = { name: name.trim(), description: description.trim() || null, calendarId, holidayCalendarId, isDefault, isActive };
      let policyId = id!;
      if (isNew) {
        const created = await post<SlaPolicy>('/sla/policies', { ...base, targets: toTargets() });
        policyId = created.id;
        if (pauseStatusIds.length) await put(`/sla/policies/${policyId}/pause-statuses`, { statusIds: pauseStatusIds });
      } else {
        const current = policyQ.data!;
        const patchBody: Record<string, unknown> = { ...base };
        if (current.isDefault && isDefault) delete patchBody.isDefault;
        await patch(`/sla/policies/${policyId}`, patchBody);
        await put(`/sla/policies/${policyId}/targets`, { targets: toTargets() });
        await put(`/sla/policies/${policyId}/pause-statuses`, { statusIds: pauseStatusIds });
      }
      toast.success('SLA policy saved');
      void qc.invalidateQueries({ queryKey: ['sla'] });
      void qc.invalidateQueries({ queryKey: ['lookups'] });
      setDirty(false);
      if (isNew) navigate(`/sla/${policyId}`, { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function clone() {
    try {
      const copy = await post<SlaPolicy>(`/sla/policies/${id}/clone`, {});
      void qc.invalidateQueries({ queryKey: ['sla'] });
      toast.success('Policy cloned');
      navigate(`/sla/${copy.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function remove() {
    if (!confirm(`Delete policy "${name}"?`)) return;
    try {
      await del(`/sla/policies/${id}`);
      void qc.invalidateQueries({ queryKey: ['sla'] });
      void qc.invalidateQueries({ queryKey: ['lookups'] });
      toast.success('Policy deleted');
      navigate('/sla');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  if (!isNew && policyQ.isLoading) return <LoadingBlock />;
  if (!isNew && policyQ.error) return <ErrorBlock error={policyQ.error} retry={() => policyQ.refetch()} />;
  const p = policyQ.data;
  const selectedCal = calendars.find((c) => c.id === calendarId);
  const ro = !canEdit;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div className="min-w-0">
          <Link to="/sla" className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-default mb-1.5"><ArrowLeft className="h-3.5 w-3.5" /> Service levels</Link>
          <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.025em] flex items-center gap-2 flex-wrap">
            {isNew ? 'New SLA policy' : name || p?.name}
            {p?.isDefault && <Badge color="amber"><Star className="h-3 w-3" /> default</Badge>}
            {p && !p.isActive && <Badge color="gray">inactive</Badge>}
          </h1>
          <div className="text-[13.5px] text-muted mt-1">{p ? `Used by ${usageSummary(p.usage)}` : 'Targets per ticket type and priority; leave a cell empty when no commitment applies.'}</div>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2 shrink-0">
            {!isNew && (
              <>
                <Button variant="outline" icon={<Copy className="h-4 w-4" />} onClick={clone}>Clone</Button>
                <Button variant="outline" icon={<Trash2 className="h-4 w-4" />} disabled={p?.isDefault} title={p?.isDefault ? 'The default policy cannot be deleted' : undefined} onClick={remove}>Delete</Button>
              </>
            )}
            <Button icon={<Save className="h-4 w-4" />} onClick={save} loading={saving} disabled={!isNew && !dirty}>Save</Button>
          </div>
        )}
      </div>

      {!isNew && (
        <Tabs<Tab>
          className="mb-5"
          value={tab}
          onChange={setTab}
          tabs={[
            { key: 'targets', label: 'Targets', count: targetCount },
            { key: 'contracts', label: 'Contracts', count: (p?.usage.contracts ?? 0) + (p?.usage.contractServices ?? 0) },
            { key: 'compliance', label: 'Compliance' },
          ]}
        />
      )}

      {(isNew || tab === 'targets') && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
          <div className="xl:col-span-2">
            <Card title="Policy">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                <Field label="Name" required>
                  <Input value={name} disabled={ro} onChange={(e) => { setName(e.target.value); setDirty(true); }} />
                </Field>
                <Field label="Business calendar" hint={selectedCal ? `${selectedCal.timezone}${selectedCal.is24x7 ? ' · 24x7' : ''}` : 'Platform default calendar'}>
                  <Select value={calendarId ?? ''} disabled={ro} placeholder="Platform default" options={calendars.map((c) => ({ value: c.id, label: c.name }))} onChange={(e) => { setCalendarId(e.target.value || null); setDirty(true); }} />
                </Field>
                <Field label="Description" className="sm:col-span-2">
                  <Textarea rows={2} value={description} disabled={ro} onChange={(e) => { setDescription(e.target.value); setDirty(true); }} />
                </Field>
                <Field label="Holiday calendar" hint="Overrides the calendar's own holiday list">
                  <Select value={holidayCalendarId ?? ''} disabled={ro} placeholder="Use calendar holidays" options={(holidayCals.data ?? []).map((c) => ({ value: c.id, label: c.name }))} onChange={(e) => { setHolidayCalendarId(e.target.value || null); setDirty(true); }} />
                </Field>
                <div className="flex items-end gap-6 pb-1">
                  <Toggle checked={isDefault} onChange={(v) => { if (ro) return; setIsDefault(v); setDirty(true); }} label="Default policy" />
                  <Toggle checked={isActive} onChange={(v) => { if (ro) return; setIsActive(v); setDirty(true); }} label="Active" />
                </div>
              </div>
            </Card>
          </div>
          <PreviewPanel policyId={isNew ? null : id!} dirty={dirty} />
          <div className="xl:col-span-3 flex flex-col gap-5">
            <Card
              title={<span>Targets <span className="text-muted font-normal">· {targetCount} defined</span></span>}
              padded={false}
              actions={<Segmented size="sm" options={TICKET_TYPES.map((t) => ({ value: t, label: titleCase(t), count: Object.entries(cells).filter(([k, v]) => k.startsWith(`${t}|`) && v.minutes).length }))} value={ticketType} onChange={setTicketType} />}
            >
              <div className="overflow-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th className="w-40">Priority</th>
                      {SLA_METRICS.map((m) => (
                        <th key={m}>{METRIC_LABEL[m]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rowsFor(ticketType).map((row) => (
                      <tr key={row.id ?? 'any'}>
                        <td className="align-top pt-3">{row.id ? <Badge color={row.color ?? undefined}>{row.label}</Badge> : <span className="text-muted text-[12.5px]">{row.label}</span>}</td>
                        {SLA_METRICS.map((m) => {
                          const key = cellKey(ticketType, row.id, m);
                          const v = cells[key];
                          return (
                            <td key={m} className="align-top">
                              <div className="flex items-center gap-1.5">
                                <DurationInput size="sm" width={72} value={v?.minutes ?? null} disabled={ro} onChange={(min) => setCell(key, { minutes: min })} placeholder="—" />
                                <input type="number" min={1} max={100} title="Warn at % of target" style={{ width: 54, flex: 'none' }} className="input h-8 py-0 px-1 text-[12px] text-center disabled:opacity-40" disabled={ro || !v?.minutes} value={v?.warnPct ?? 75} onChange={(e) => setCell(key, { warnPct: Math.min(100, Math.max(1, Number(e.target.value) || 75)) })} />
                                <label className="inline-flex items-center gap-1 text-[11px] text-muted cursor-pointer select-none" title="Measure on calendar time (24x7) regardless of business hours">
                                  <input type="checkbox" className="h-3.5 w-3.5 accent-navy-800 disabled:opacity-40" disabled={ro || !v?.minutes} checked={!!v?.calendarTime} onChange={(e) => setCell(key, { calendarTime: e.target.checked })} />
                                  24x7
                                </label>
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-2.5 text-[12px] text-subtle border-t border-default">Duration · warn % · 24x7 clock. Enter durations like <code className="font-mono">30m</code>, <code className="font-mono">4h</code> or <code className="font-mono">2d</code>. Priority-specific targets win over "Any priority".</div>
            </Card>

            <Card title="Pause statuses">
              <div className="text-[12.5px] text-muted mb-2">SLA clocks pause while a ticket is in any status marked "pauses SLA" in the option list, plus these policy-specific statuses.</div>
              <MultiSelect value={pauseStatusIds} disabled={ro} onChange={(v) => { setPauseStatusIds(v); setDirty(true); }} options={statuses.map((s) => ({ value: s.id, label: s.label, hint: s.pausesSla ? 'pauses by default' : titleCase(s.statusCategory ?? '') }))} maxHeight="max-h-40" />
            </Card>
          </div>
        </div>
      )}

      {!isNew && tab === 'contracts' && <ContractsTab policy={p!} />}
      {!isNew && tab === 'compliance' && <ComplianceTab policyId={id!} />}
    </div>
  );
}

// ---------------------------------------------------------------- contracts

interface ContractPick {
  id: string;
  number: string;
  name: string;
  customerName: string;
  status: string;
  statusLabel: string;
  statusColor: string;
  endDate: string;
}

function ContractsTab({ policy }: { policy: SlaPolicy }) {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const canManage = can('contracts:manage');
  const q = useQuery({ queryKey: ['sla', 'policy', policy.id, 'contracts'], queryFn: () => get<{ items: PolicyContract[]; total: number }>(`/sla/policies/${policy.id}/contracts`) });
  const [assigning, setAssigning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const items = q.data?.items ?? [];
  const contractLevel = items.filter((c) => c.level === 'contract');
  const serviceLevel = items.filter((c) => c.level === 'service');
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['sla'] });
    void qc.invalidateQueries({ queryKey: ['contracts'] });
  };

  async function unassign(c: PolicyContract) {
    setBusy(c.contractId);
    try {
      await del(`/sla/policies/${policy.id}/contracts/${c.contractId}`);
      toast.success(`${c.number} now falls back to its service or the platform default`);
      invalidate();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const Row = ({ c }: { c: PolicyContract }) => (
    <tr key={`${c.level}-${c.contractId}`}>
      <td><Link to={`/contracts/${c.contractId}`} className="font-mono text-[12.5px] font-medium text-default hover:underline">{c.number}</Link></td>
      <td>
        <div className="font-medium text-default">{c.name}</div>
        {c.level === 'service' && <div className="text-[12px] text-muted">{c.serviceNames.join(', ')}</div>}
      </td>
      <td><Link to={`/customers/${c.customerId}`} className="hover:underline">{c.customerName}</Link></td>
      <td><ContractStatusBadge status={c.status} label={c.statusLabel} color={c.statusColor} /></td>
      <td className="tnum text-muted whitespace-nowrap">{fmtDate(c.startDate)} – {fmtDate(c.endDate)}</td>
      <td className="text-right">
        {canManage && c.level === 'contract' && (
          <Button variant="ghost" size="sm" icon={<Unlink className="h-3.5 w-3.5" />} loading={busy === c.contractId} onClick={() => unassign(c)} title="Remove this policy from the contract">Unassign</Button>
        )}
        {c.level === 'service' && <Link to={`/contracts/${c.contractId}?tab=services`} className="text-[12.5px] text-muted hover:text-default">Edit on contract</Link>}
      </td>
    </tr>
  );

  return (
    <div className="flex flex-col gap-5">
      <Card
        title={<span>Contracts on this policy <span className="text-muted font-normal">· {contractLevel.length}</span></span>}
        padded={false}
        actions={canManage && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setAssigning(true)}>Assign contracts</Button>}
      >
        {q.isLoading ? <LoadingBlock /> : q.isError ? <ErrorBlock error={q.error} retry={() => q.refetch()} /> : contractLevel.length === 0 ? (
          <EmptyState icon={<FileSignature className="h-5 w-5" />} title="No contracts mapped" description="Assign contracts here, or pick this policy on the contract itself. Contracts without a policy use their service default, then the platform default." action={canManage && <Button size="sm" variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => setAssigning(true)}>Assign contracts</Button>} />
        ) : (
          <div className="overflow-auto">
            <table className="table">
              <thead><tr><th className="w-32">Number</th><th>Contract</th><th>Customer</th><th>Status</th><th>Term</th><th className="w-36" /></tr></thead>
              <tbody>{contractLevel.map((c) => <Row key={c.contractId} c={c} />)}</tbody>
            </table>
          </div>
        )}
      </Card>
      {serviceLevel.length > 0 && (
        <Card title={<span>Service-level overrides <span className="text-muted font-normal">· {serviceLevel.length}</span></span>} padded={false}>
          <div className="px-5 py-2.5 text-[12.5px] text-muted border-b border-default">Contracts where a specific service is mapped to this policy, overriding the contract-level policy for that service.</div>
          <div className="overflow-auto">
            <table className="table">
              <thead><tr><th className="w-32">Number</th><th>Contract · services</th><th>Customer</th><th>Status</th><th>Term</th><th className="w-36" /></tr></thead>
              <tbody>{serviceLevel.map((c) => <Row key={`s-${c.contractId}`} c={c} />)}</tbody>
            </table>
          </div>
        </Card>
      )}
      <AssignDialog open={assigning} onClose={() => setAssigning(false)} policy={policy} already={new Set(contractLevel.map((c) => c.contractId))} onDone={invalidate} />
    </div>
  );
}

function AssignDialog({ open, onClose, policy, already, onDone }: { open: boolean; onClose: () => void; policy: SlaPolicy; already: Set<string>; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const list = useQuery({ queryKey: ['contracts', 'pick', q], queryFn: () => get<{ items: ContractPick[]; total: number }>('/contracts', { q: q || undefined, pageSize: 50, sort: 'endDate', order: 'desc' }), enabled: open });
  useEffect(() => {
    if (!open) {
      setPicked(new Set());
      setQ('');
    }
  }, [open]);
  const candidates = (list.data?.items ?? []).filter((c) => !already.has(c.id));
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  async function submit() {
    if (!picked.size) return;
    setSaving(true);
    try {
      await post(`/sla/policies/${policy.id}/contracts`, { contractIds: [...picked] });
      toast.success(`${picked.size} contract${picked.size > 1 ? 's' : ''} mapped to ${policy.name}`);
      onDone();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title={`Assign contracts to ${policy.name}`} width="max-w-2xl" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={saving} disabled={!picked.size}>Assign {picked.size || ''}</Button></>}>
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-subtle pointer-events-none" />
          <input className="input pl-9" placeholder="Search by number, name or customer…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        </div>
        <div className="text-[12.5px] text-muted">The policy applies to every ticket raised under the contract unless a contract service or catalog item sets its own.</div>
        <div className="border border-default rounded-lg max-h-[46vh] overflow-y-auto divide-y divide-[var(--border)]">
          {list.isLoading && <LoadingBlock />}
          {!list.isLoading && candidates.length === 0 && <div className="py-8 text-center text-[13px] text-subtle">No contracts match.</div>}
          {candidates.map((c) => (
            <label key={c.id} className={cn('flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-surface-2/70', picked.has(c.id) && 'bg-brand-50/60')}>
              <Checkbox checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
              <span className="font-mono text-[12.5px] text-default w-28 shrink-0">{c.number}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] text-default truncate">{c.name}</span>
                <span className="block text-[12px] text-muted truncate">{c.customerName} · ends {fmtDate(c.endDate)}</span>
              </span>
              <ContractStatusBadge status={c.status} label={c.statusLabel} color={c.statusColor} />
            </label>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- compliance

function ComplianceTab({ policyId }: { policyId: string }) {
  const [days, setDays] = useState(30);
  const q = useQuery({ queryKey: ['sla', 'policy', policyId, 'compliance', days], queryFn: () => get<Compliance>(`/sla/policies/${policyId}/compliance`, { days }) });
  if (q.isLoading) return <LoadingBlock />;
  if (q.isError || !q.data) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  const t = q.data.totals;
  const tone = t.compliancePct === null ? 'default' : t.compliancePct >= 95 ? 'good' : t.compliancePct >= 85 ? 'warn' : 'bad';
  return (
    <div className="flex flex-col gap-5">
      <Card title="Compliance by metric" actions={<Segmented size="sm" options={[{ value: 7, label: '7 days' }, { value: 30, label: '30 days' }, { value: 90, label: '90 days' }]} value={days} onChange={setDays} />}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
          <Stat label="Compliance" value={fmtPct(t.compliancePct, 1)} tone={tone} />
          <Stat label="Completed" value={fmtNumber(t.completed)} />
          <Stat label="Breached" value={fmtNumber(t.breached)} tone={t.breached > 0 ? 'bad' : 'default'} />
          <Stat label="Overdue now" value={fmtNumber(t.overdueRunning)} tone={t.overdueRunning > 0 ? 'warn' : 'default'} />
        </div>
        {q.data.groups.length === 0 ? (
          <div className="text-[13px] text-subtle py-4 text-center">No SLA clocks started under this policy in the period.</div>
        ) : (
          <div className="flex flex-col gap-3">
            {q.data.groups.map((g) => (
              <div key={g.key} className="grid grid-cols-[120px_1fr_auto] items-center gap-4">
                <div className="text-[13px] font-medium text-default">{METRIC_LABEL[g.label] ?? titleCase(g.label)}</div>
                <ProgressBar pct={g.compliancePct ?? 0} tone={g.compliancePct === null ? 'neutral' : g.compliancePct >= 95 ? 'good' : g.compliancePct >= 85 ? 'warn' : 'bad'} />
                <div className="text-[12.5px] text-muted tnum text-right whitespace-nowrap">
                  <span className="text-default font-medium">{fmtPct(g.compliancePct, 1)}</span> · {g.met} met · {g.breached} breached · {g.running} running
                  {g.avgElapsedMinutes !== null && <span className="text-subtle"> · avg {formatDuration(g.avgElapsedMinutes)}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- preview

function PreviewPanel({ policyId, dirty }: { policyId: string | null; dirty: boolean }) {
  const lookups = useLookups();
  const [ticketType, setTicketType] = useState<TicketType>('incident');
  const [priorityId, setPriorityId] = useState<string>('');
  const [start, setStart] = useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  const priorities = lookups.options('ticket_priority', { ticketType });
  const startIso = start ? new Date(start).toISOString() : undefined;
  const q = useQuery({
    queryKey: ['sla', 'preview', policyId, ticketType, priorityId, startIso],
    queryFn: () => get<Preview>('/sla/preview', { policyId, ticketType, priorityId: priorityId || undefined, start: startIso }),
    enabled: !!policyId && !!startIso,
  });
  return (
    <Card title="Preview due dates">
      {!policyId ? (
        <div className="text-[12.5px] text-muted">Save the policy to preview due dates.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {dirty && <div className="text-[12px] text-amber-600">Preview reflects the last saved version.</div>}
          <div className="grid grid-cols-2 gap-2">
            <Select value={ticketType} options={TICKET_TYPES.map((t) => ({ value: t, label: titleCase(t) }))} onChange={(e) => setTicketType(e.target.value as TicketType)} />
            <Select value={priorityId} placeholder="Any priority" options={priorities.map((p) => ({ value: p.id, label: p.label }))} onChange={(e) => setPriorityId(e.target.value)} />
          </div>
          <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          {q.isLoading && <LoadingBlock label="Calculating…" />}
          {q.error && <div className="text-[12.5px] text-red-600">{errorMessage(q.error)}</div>}
          {q.data && (
            <div>
              <div className="text-[12px] text-subtle mb-2">
                Calendar: {q.data.calendar.name} ({q.data.calendar.timezone}){q.data.calendar.holidays ? ` · ${q.data.calendar.holidays} holidays` : ''}
              </div>
              {q.data.metrics.length === 0 ? (
                <div className="text-[12.5px] text-muted">No targets apply to this combination.</div>
              ) : (
                <div className="text-[12.5px]">
                  {q.data.metrics.map((m) => (
                    <div key={m.metric} className="border-t border-default py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{METRIC_LABEL[m.metric as Metric] ?? m.metric}</span>
                        <span className="text-muted">{formatDuration(m.minutes)} · {m.calendar === '24x7' ? '24x7' : 'business hrs'}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[12px]">
                        <span className="text-subtle">due</span>
                        <span>{fmtDateTime(m.dueAt)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[11px] text-subtle">
                        <span>warn at {m.warnPct}%</span>
                        <span>{fmtDateTime(m.warnAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
