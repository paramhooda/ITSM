import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Save, Copy, Trash2, Star, Plus, Unlink, Search, FileSignature, CalendarClock, Gauge, BarChart3 } from 'lucide-react';
import { SLA_METRICS, TICKET_TYPES } from '@itsm/shared';
import { get, post, patch, put, del } from '@/api/client';
import { Button, Badge, Card, Input, Textarea, Select, Toggle, LoadingBlock, ErrorBlock, Dialog, ConfirmDialog, EmptyState, Checkbox, ProgressBar } from '@/components/ui';
import type { MenuItem } from '@/components/Menu';
import { RecordLayout, RecordHeader, RecordRibbon, RecordForm, RelatedTabs, RailCard, RailRows, type FormSection } from '@/components/record';
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

/** One SLA policy: an editable record with its targets, the contracts mapped to it and its compliance. */
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
    setDeleting(true);
    try {
      await del(`/sla/policies/${id}`);
      void qc.invalidateQueries({ queryKey: ['sla'] });
      void qc.invalidateQueries({ queryKey: ['lookups'] });
      toast.success('Policy deleted');
      navigate('/sla');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (!isNew && policyQ.isLoading) return <LoadingBlock />;
  if (!isNew && policyQ.error) return <ErrorBlock error={policyQ.error} retry={() => policyQ.refetch()} />;
  const p = policyQ.data;
  const selectedCal = calendars.find((c) => c.id === calendarId);
  const ro = !canEdit;
  const mark = <T,>(set: (v: T) => void) => (v: T) => {
    if (ro) return;
    set(v);
    setDirty(true);
  };

  // ---- header: Save (+ Clone) up front, Delete in the overflow menu
  const primary = canEdit ? (
    <>
      <Button size="sm" icon={<Save className="h-3.5 w-3.5" />} onClick={save} loading={saving} disabled={!isNew && !dirty}>Save</Button>
      {!isNew && <Button size="sm" variant="outline" icon={<Copy className="h-3.5 w-3.5" />} onClick={clone}>Clone</Button>}
    </>
  ) : undefined;
  const menu: MenuItem[] = canEdit && !isNew ? [{ label: p?.isDefault ? 'Delete (default policy)' : 'Delete policy', icon: <Trash2 className="h-4 w-4" />, onClick: () => setConfirmDelete(true), danger: true, disabled: !!p?.isDefault }] : [];

  // ---- the policy record, edited in place
  const policySection: FormSection = {
    key: 'policy',
    title: 'Policy',
    fields: [
      { label: 'Name', edit: <Input value={name} disabled={ro} onChange={(e) => mark(setName)(e.target.value)} className="h-8 py-0 text-[13px] max-w-[420px]" placeholder="e.g. Gold support" /> },
      { label: 'Active', edit: <Toggle checked={isActive} onChange={mark(setIsActive)} label={<span className="text-[12.5px] text-muted">{isActive ? 'Applied to new tickets' : 'Not applied to new tickets'}</span>} /> },
      { label: 'Description', edit: <Textarea rows={2} value={description} disabled={ro} onChange={(e) => mark(setDescription)(e.target.value)} className="min-h-[56px] text-[13px]" />, span: 2 },
      {
        label: 'Business calendar',
        hint: 'Platform default calendar when empty',
        edit: (
          <div className="flex items-center gap-2 flex-wrap">
            <Select value={calendarId ?? ''} disabled={ro} placeholder="Platform default" options={calendars.map((c) => ({ value: c.id, label: c.name }))} onChange={(e) => mark(setCalendarId)(e.target.value || null)} className="h-8 py-0 text-[12.5px] max-w-[260px]" />
            {selectedCal && <span className="text-[12px] text-subtle">{selectedCal.timezone}{selectedCal.is24x7 ? ' · 24x7' : ''}</span>}
          </div>
        ),
      },
      { label: 'Holiday calendar', hint: "Overrides the calendar's own holiday list", edit: <Select value={holidayCalendarId ?? ''} disabled={ro} placeholder="Use calendar holidays" options={(holidayCals.data ?? []).map((c) => ({ value: c.id, label: c.name }))} onChange={(e) => mark(setHolidayCalendarId)(e.target.value || null)} className="h-8 py-0 text-[12.5px] max-w-[260px]" /> },
      { label: 'Default policy', hint: 'Used when neither the contract, service nor catalog item sets one', edit: <Toggle checked={isDefault} onChange={mark(setIsDefault)} label={<span className="text-[12.5px] text-muted">{isDefault ? 'Fallback for everything' : 'Not the fallback'}</span>} /> },
    ],
  };

  const targetsContent = (
    <RecordForm
      sections={[
        {
          key: 'targets',
          title: <span>Targets <span className="text-muted font-normal">· {targetCount} defined</span></span>,
          description: 'Durations like 30m, 4h or 2d · warn % · 24x7 clock · a priority row beats "Any priority"',
          actions: <Segmented size="sm" options={TICKET_TYPES.map((t) => ({ value: t, label: titleCase(t), count: Object.entries(cells).filter(([k, v]) => k.startsWith(`${t}|`) && v.minutes).length }))} value={ticketType} onChange={setTicketType} />,
          fields: [],
          children: (
            <div className="-mx-5 -my-1.5 overflow-auto">
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
          ),
        },
        {
          key: 'pause',
          title: 'Pause statuses',
          columns: 1,
          fields: [
            {
              label: 'Also pause in',
              hint: 'In addition to statuses that pause SLA by default',
              edit: <MultiSelect value={pauseStatusIds} disabled={ro} onChange={(v) => { setPauseStatusIds(v); setDirty(true); }} options={statuses.map((s) => ({ value: s.id, label: s.label, hint: s.pausesSla ? 'pauses by default' : titleCase(s.statusCategory ?? '') }))} maxHeight="max-h-40" />,
            },
          ],
        },
      ]}
    />
  );

  const ribbon = p
    ? [
        { label: 'Targets', value: String(targetCount), hint: 'Cells with a duration' },
        { label: 'Contracts', value: String(p.usage.contracts + p.usage.contractServices), hint: `${p.usage.contracts} at contract level · ${p.usage.contractServices} per service` },
        { label: 'Services', value: String(p.usage.services) },
        { label: 'Catalog items', value: String(p.usage.catalogItems) },
        { label: 'Tickets', value: String(p.usage.tickets) },
      ]
    : [];

  return (
    <>
      <RecordLayout
        header={
          <RecordHeader
            crumbs={[{ label: 'Service levels', to: '/sla' }, { label: isNew ? 'New policy' : name || p?.name || '' }]}
            title={isNew ? 'New SLA policy' : name || p?.name || ''}
            onTitleChange={canEdit && !isNew ? mark(setName) : undefined}
            badges={
              <>
                {p?.isDefault && <Badge color="amber" className="gap-1"><Star className="h-3 w-3" /> Default</Badge>}
                {p && !p.isActive && <Badge color="gray">Inactive</Badge>}
              </>
            }
            controls={
              <>
                {dirty && <Badge color="amber" dot>Unsaved changes</Badge>}
                {p && <span className="text-[12.5px] text-muted">Used by {usageSummary(p.usage)}</span>}
              </>
            }
            primary={primary}
            menu={menu}
            updatedAt={p?.updatedAt ?? null}
          >
            {ribbon.length > 0 && <RecordRibbon items={ribbon} columns={5} />}
          </RecordHeader>
        }
        main={
          <>
            <RecordForm sections={[policySection]} />
            {isNew ? (
              targetsContent
            ) : (
              <RelatedTabs
                tabs={[
                  { key: 'targets', label: 'Targets', count: targetCount, content: targetsContent },
                  { key: 'contracts', label: 'Contracts', count: (p?.usage.contracts ?? 0) + (p?.usage.contractServices ?? 0), content: <ContractsTab policy={p!} /> },
                  { key: 'compliance', label: 'Compliance', content: <ComplianceTab policyId={id!} /> },
                ]}
              />
            )}
          </>
        }
        aside={
          isNew ? undefined : (
            <>
              <PreviewPanel policyId={id!} dirty={dirty} />
              <RailCard title={<><Gauge className="h-3.5 w-3.5 text-subtle" /> In use</>}>
                <RailRows
                  rows={[
                    { label: 'Calendar', value: p?.calendarName ? `${p.calendarName}${p.calendarIs24x7 ? ' · 24x7' : ''}` : 'Platform default' },
                    { label: 'Holidays', value: p?.holidayCalendarName, hidden: !p?.holidayCalendarName },
                    { label: 'Pauses in', value: p?.pauseStatuses.length ? p.pauseStatuses.map((s) => s.label).join(', ') : null },
                    { label: 'Contracts', value: String(p?.usage.contracts ?? 0) },
                    { label: 'Contract services', value: String(p?.usage.contractServices ?? 0) },
                    { label: 'Services', value: String(p?.usage.services ?? 0) },
                    { label: 'Catalog items', value: String(p?.usage.catalogItems ?? 0) },
                    { label: 'Tickets', value: String(p?.usage.tickets ?? 0) },
                  ]}
                />
              </RailCard>
            </>
          )
        }
      />

      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={() => void remove()} title={`Delete "${name || p?.name}"?`} description={p ? `Used by ${usageSummary(p.usage)}. Contracts on this policy fall back to their service or the platform default.` : undefined} confirmLabel="Delete policy" danger loading={deleting} />
    </>
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
    <div className="flex flex-col gap-3">
      <Card
        title={<span>Contracts <span className="text-muted font-normal">· {contractLevel.length}</span></span>}
        padded={false}
        actions={canManage && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setAssigning(true)}>Assign contracts</Button>}
      >
        {q.isLoading ? <LoadingBlock /> : q.isError ? <ErrorBlock error={q.error} retry={() => q.refetch()} /> : contractLevel.length === 0 ? (
          <EmptyState icon={<FileSignature className="h-5 w-5" />} title="No contracts mapped" description="Assign contracts here or pick this policy on the contract itself." action={canManage && <Button size="sm" variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => setAssigning(true)}>Assign contracts</Button>} />
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
    <Card title="Compliance by metric" actions={<Segmented size="sm" options={[{ value: 7, label: '7 days' }, { value: 30, label: '30 days' }, { value: 90, label: '90 days' }]} value={days} onChange={setDays} />}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
        <Stat label="Compliance" value={fmtPct(t.compliancePct, 1)} tone={tone} />
        <Stat label="Completed" value={fmtNumber(t.completed)} />
        <Stat label="Breached" value={fmtNumber(t.breached)} tone={t.breached > 0 ? 'bad' : 'default'} />
        <Stat label="Overdue now" value={fmtNumber(t.overdueRunning)} tone={t.overdueRunning > 0 ? 'warn' : 'default'} />
      </div>
      {q.data.groups.length === 0 ? (
        <EmptyState icon={<BarChart3 className="h-5 w-5" />} title="No SLA clocks in this period" description="Clocks started under this policy appear here by metric." />
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
  );
}

// ---------------------------------------------------------------- preview (rail)

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
    <RailCard title={<><CalendarClock className="h-3.5 w-3.5 text-subtle" /> Preview due dates</>} action={dirty ? <span className="text-[11.5px] text-amber-600">as last saved</span> : undefined}>
      {!policyId ? (
        <div className="text-[12.5px] text-subtle">Save the policy to preview due dates.</div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <Select value={ticketType} options={TICKET_TYPES.map((t) => ({ value: t, label: titleCase(t) }))} onChange={(e) => setTicketType(e.target.value as TicketType)} className="h-8 py-0 text-[12.5px]" />
            <Select value={priorityId} placeholder="Any priority" options={priorities.map((p) => ({ value: p.id, label: p.label }))} onChange={(e) => setPriorityId(e.target.value)} className="h-8 py-0 text-[12.5px]" />
          </div>
          <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className="h-8 py-0 text-[12.5px]" />
          {q.isLoading && <LoadingBlock label="Calculating…" />}
          {q.error && <div className="text-[12.5px] text-red-600">{errorMessage(q.error)}</div>}
          {q.data && (
            <div>
              <div className="text-[11.5px] text-subtle mb-1">
                {q.data.calendar.name} · {q.data.calendar.timezone}{q.data.calendar.holidays ? ` · ${q.data.calendar.holidays} holidays` : ''}
              </div>
              {q.data.metrics.length === 0 ? (
                <div className="text-[12.5px] text-subtle">No targets for this combination.</div>
              ) : (
                <div className="text-[12.5px]">
                  {q.data.metrics.map((m) => (
                    <div key={m.metric} className="border-t border-default/60 py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{METRIC_LABEL[m.metric as Metric] ?? m.metric}</span>
                        <span className="text-muted">{formatDuration(m.minutes)} · {m.calendar === '24x7' ? '24x7' : 'business hrs'}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[12px]">
                        <span className="text-subtle">due</span>
                        <span className="tnum">{fmtDateTime(m.dueAt)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[11px] text-subtle">
                        <span>warn at {m.warnPct}%</span>
                        <span className="tnum">{fmtDateTime(m.warnAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </RailCard>
  );
}
