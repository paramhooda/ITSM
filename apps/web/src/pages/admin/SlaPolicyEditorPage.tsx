import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Save, Copy, Trash2, Star } from 'lucide-react';
import { SLA_METRICS, TICKET_TYPES } from '@itsm/shared';
import { get, post, patch, put, del } from '@/api/client';
import { Button, Badge, Card, Field, Input, Textarea, Select, Tabs, Toggle, LoadingBlock, ErrorBlock } from '@/components/ui';
import { useLookups } from '@/hooks/useLookups';
import { fmtDateTime, titleCase } from '@/lib/format';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { DurationInput, formatDuration } from '@/components/admin/DurationInput';
import { MultiSelect } from '@/components/admin/inputs';
import { errorMessage } from '@/components/admin/api';
import { useConfigKind } from '@/components/admin/api';
import { usageSummary, type SlaPolicy, type SlaTarget } from './SlaPoliciesPage';

type TicketType = (typeof TICKET_TYPES)[number];
type Metric = (typeof SLA_METRICS)[number];

interface CellValue {
  minutes: number | null;
  warnPct: number;
  calendarTime: boolean;
}

const cellKey = (t: string, p: string | null, m: string) => `${t}|${p ?? 'any'}|${m}`;
const METRIC_LABEL: Record<Metric, string> = { acknowledgement: 'Acknowledge', response: 'Respond', restoration: 'Restore', resolution: 'Resolve' };

interface Preview {
  calendar: { name: string; timezone: string; is24x7: boolean; holidays: number };
  start: string;
  metrics: { metric: string; minutes: number; warnPct: number; calendar: string; appliesTo: string; dueAt: string; warnAt: string; elapsedHours: number }[];
}

export default function SlaPolicyEditorPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const navigate = useNavigate();
  const qc = useQueryClient();
  const lookups = useLookups();
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
  const [tab, setTab] = useState<TicketType>('incident');
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
        const [ticketType, p, metric] = k.split('|');
        return { ticketType, priorityId: p === 'any' ? null : p, metric, minutes: v.minutes!, warnPct: v.warnPct, calendarTime: v.calendarTime };
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
      if (isNew) navigate(`/admin/sla/${policyId}`, { replace: true });
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
      navigate(`/admin/sla/${copy.id}`);
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
      navigate('/admin/sla');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  if (!isNew && policyQ.isLoading) return <LoadingBlock />;
  if (!isNew && policyQ.error) return <ErrorBlock error={policyQ.error} retry={() => policyQ.refetch()} />;
  const p = policyQ.data;
  const selectedCal = calendars.find((c) => c.id === calendarId);

  return (
    <div>
      <SectionHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Link to="/admin/sla" className="text-muted hover:text-default" title="Back to policies">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            {isNew ? 'New SLA policy' : name || p?.name}
            {p?.isDefault && <Badge color="amber"><Star className="h-3 w-3" /> default</Badge>}
          </span>
        }
        description={p ? `Used by: ${usageSummary(p.usage)}` : 'Define targets per ticket type and priority; leave a cell empty when no commitment applies.'}
        actions={
          <>
            {!isNew && (
              <>
                <Button variant="outline" icon={<Copy className="h-4 w-4" />} onClick={clone}>
                  Clone
                </Button>
                <Button variant="outline" icon={<Trash2 className="h-4 w-4" />} disabled={p?.isDefault} title={p?.isDefault ? 'The default policy cannot be deleted' : undefined} onClick={remove}>
                  Delete
                </Button>
              </>
            )}
            <Button icon={<Save className="h-4 w-4" />} onClick={save} loading={saving} disabled={!isNew && !dirty}>
              Save
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2">
          <Card title="Policy">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
              <Field label="Name" required>
                <Input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} />
              </Field>
              <Field label="Business calendar" hint={selectedCal ? `${selectedCal.timezone}${selectedCal.is24x7 ? ' · 24x7' : ''}` : 'Platform default calendar'}>
                <Select value={calendarId ?? ''} placeholder="Platform default" options={calendars.map((c) => ({ value: c.id, label: c.name }))} onChange={(e) => { setCalendarId(e.target.value || null); setDirty(true); }} />
              </Field>
              <Field label="Description" className="sm:col-span-2">
                <Textarea rows={2} value={description} onChange={(e) => { setDescription(e.target.value); setDirty(true); }} />
              </Field>
              <Field label="Holiday calendar" hint="Overrides the calendar's own holiday list">
                <Select value={holidayCalendarId ?? ''} placeholder="Use calendar holidays" options={(holidayCals.data ?? []).map((c) => ({ value: c.id, label: c.name }))} onChange={(e) => { setHolidayCalendarId(e.target.value || null); setDirty(true); }} />
              </Field>
              <div className="flex items-end gap-6 pb-1">
                <Toggle checked={isDefault} onChange={(v) => { setIsDefault(v); setDirty(true); }} label="Default policy" />
                <Toggle checked={isActive} onChange={(v) => { setIsActive(v); setDirty(true); }} label="Active" />
              </div>
            </div>
          </Card>
        </div>
        <PreviewPanel policyId={isNew ? null : id!} dirty={dirty} />
        <div className="xl:col-span-3 flex flex-col gap-4">
          <Card title={`Targets · ${targetCount} defined`} padded={false}>
            <Tabs tabs={TICKET_TYPES.map((t) => ({ key: t, label: titleCase(t), count: Object.entries(cells).filter(([k, v]) => k.startsWith(`${t}|`) && v.minutes).length }))} value={tab} onChange={setTab} className="px-3" />
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
                  {rowsFor(tab).map((row) => (
                    <tr key={row.id ?? 'any'}>
                      <td className="align-top pt-3">{row.id ? <Badge color={row.color ?? undefined}>{row.label}</Badge> : <span className="text-muted text-[12.5px]">{row.label}</span>}</td>
                      {SLA_METRICS.map((m) => {
                        const key = cellKey(tab, row.id, m);
                        const v = cells[key];
                        return (
                          <td key={m} className="align-top">
                            <div className="flex items-center gap-1.5">
                              <DurationInput size="sm" width={68} value={v?.minutes ?? null} onChange={(min) => setCell(key, { minutes: min })} placeholder="—" />
                              <input type="number" min={1} max={100} title="Warn at % of target" style={{ width: 52, flex: 'none' }} className="input h-7 py-1 px-1 text-[12px] text-center disabled:opacity-40" disabled={!v?.minutes} value={v?.warnPct ?? 75} onChange={(e) => setCell(key, { warnPct: Math.min(100, Math.max(1, Number(e.target.value) || 75)) })} />
                              <label className="inline-flex items-center gap-1 text-[11px] text-muted cursor-pointer select-none" title="Measure on calendar time (24x7) regardless of business hours">
                                <input type="checkbox" className="h-3.5 w-3.5 accent-brand-600 disabled:opacity-40" disabled={!v?.minutes} checked={!!v?.calendarTime} onChange={(e) => setCell(key, { calendarTime: e.target.checked })} />
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
            <div className="px-3 py-2 text-[12px] text-subtle border-t border-default">Duration · warn % · 24x7 clock. Enter durations like <code className="font-mono">30m</code>, <code className="font-mono">4h</code> or <code className="font-mono">2d</code>. Priority-specific targets win over "Any priority".</div>
          </Card>

          <Card title="Pause statuses">
            <div className="text-[12.5px] text-muted mb-2">SLA clocks pause while a ticket is in any status marked "pauses SLA" in the option list, plus these policy-specific statuses.</div>
            <MultiSelect value={pauseStatusIds} onChange={(v) => { setPauseStatusIds(v); setDirty(true); }} options={statuses.map((s) => ({ value: s.id, label: s.label, hint: s.pausesSla ? 'pauses by default' : titleCase(s.statusCategory ?? '') }))} maxHeight="max-h-40" />
          </Card>
        </div>
      </div>
    </div>
  );
}

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
