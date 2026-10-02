import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { get } from '@/api/client';
import { Button, Checkbox, Drawer, Field, Input, Select, Textarea } from '@/components/ui';
import { useLookups, useEngineers, useCustomersLookup } from '@/hooks/useLookups';
import { useSites, useContracts, errorMessage } from '@/components/cmdb/hooks';
import { EntityPicker, type PickerItem } from '@/components/tickets/EntityPicker';
import { itemsOf } from '@/components/tickets/api';
import { ChecklistEditor, type ChecklistDraft } from '@/components/field/ChecklistEditor';
import type { Entitlement } from '@/components/contracts/types';
import { fmtNumber } from '@/lib/format';
import { pmApi } from './api';
import { FREQUENCY_LABELS, type PmFrequency, type ProgramDetail } from './types';

interface FormState {
  customerId: string;
  siteId: string;
  contractId: string;
  serviceId: string;
  entitlementId: string;
  name: string;
  description: string;
  frequency: PmFrequency;
  intervalDays: string;
  startDate: string;
  endDate: string;
  leadDays: string;
  graceDays: string;
  assignedTeamId: string;
  assignedEngineerId: string;
  requiresSiteVisit: boolean;
  isActive: boolean;
  checklist: ChecklistDraft[];
  cis: PickerItem[];
  assets: PickerItem[];
}

const today = () => new Date().toISOString().slice(0, 10);
const empty = (customerId = ''): FormState => ({ customerId, siteId: '', contractId: '', serviceId: '', entitlementId: '', name: '', description: '', frequency: 'quarterly', intervalDays: '', startDate: today(), endDate: '', leadDays: '14', graceDays: '7', assignedTeamId: '', assignedEngineerId: '', requiresSiteVisit: true, isActive: true, checklist: [], cis: [], assets: [] });

const fromProgram = (p: ProgramDetail): FormState => ({
  customerId: p.customerId,
  siteId: p.siteId ?? '',
  contractId: p.contractId ?? '',
  serviceId: p.serviceId ?? '',
  entitlementId: p.entitlementId ?? '',
  name: p.name,
  description: p.description ?? '',
  frequency: p.frequency,
  intervalDays: p.intervalDays ? String(p.intervalDays) : '',
  startDate: p.startDate,
  endDate: p.endDate ?? '',
  leadDays: String(p.leadDays),
  graceDays: String(p.graceDays),
  assignedTeamId: p.assignedTeamId ?? '',
  assignedEngineerId: p.assignedEngineerId ?? '',
  requiresSiteVisit: p.requiresSiteVisit,
  isActive: p.isActive,
  checklist: (p.checklist ?? []).map((c) => ({ item: c.item, required: !!c.required })),
  cis: (p.cis ?? []).map((c) => ({ id: c.id, label: c.name, sublabel: c.typeName })),
  assets: (p.assets ?? []).map((a) => ({ id: a.id, label: a.tag, sublabel: a.name })),
});

/**
 * Create / edit drawer for PM programs: cadence, window (lead / grace days),
 * checklist template, covered CIs / assets and the entitlement that each
 * completed occurrence consumes (auto-picked `pm_visits` when left blank).
 */
export function ProgramForm({ open, onClose, program, defaultCustomerId, onSaved }: { open: boolean; onClose: () => void; program?: ProgramDetail | null; defaultCustomerId?: string; onSaved: (p: ProgramDetail) => void }) {
  const { lookups, byId } = useLookups();
  const engineers = useEngineers();
  const customers = useCustomersLookup();
  const [f, setF] = useState<FormState>(empty(defaultCustomerId));
  const set = (patch: Partial<FormState>) => setF((s) => ({ ...s, ...patch }));
  useEffect(() => {
    if (open) setF(program ? fromProgram(program) : empty(defaultCustomerId));
  }, [open, program, defaultCustomerId]);
  const sites = useSites(f.customerId || null);
  const contracts = useContracts(f.customerId || null);
  const entitlements = useQuery({ queryKey: ['customers', f.customerId, 'entitlements'], queryFn: () => get<Entitlement[]>(`/customers/${f.customerId}/entitlements`), enabled: open && !!f.customerId, staleTime: 30_000, retry: false });
  const visitEnts = useMemo(() => (entitlements.data ?? []).filter((e) => e.unit === 'visits' && (!f.contractId || e.contractId === f.contractId)), [entitlements.data, f.contractId]);
  const autoPick = useMemo(() => visitEnts.find((e) => byId(e.typeId)?.key === 'pm_visits') ?? visitEnts.find((e) => byId(e.typeId)?.key === 'site_visits') ?? visitEnts[0] ?? null, [visitEnts, byId]);

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: f.name.trim(),
        description: f.description.trim() || null,
        siteId: f.siteId || null,
        contractId: f.contractId || null,
        serviceId: f.serviceId || null,
        entitlementId: f.entitlementId || null,
        frequency: f.frequency,
        intervalDays: f.frequency === 'custom' ? Number(f.intervalDays) || null : null,
        startDate: f.startDate,
        endDate: f.endDate || null,
        leadDays: Number(f.leadDays) || 0,
        graceDays: Number(f.graceDays) || 0,
        assignedTeamId: f.assignedTeamId || null,
        assignedEngineerId: f.assignedEngineerId || null,
        requiresSiteVisit: f.requiresSiteVisit,
        isActive: f.isActive,
        checklist: f.checklist.filter((c) => c.item.trim()).map((c) => ({ item: c.item.trim(), required: !!c.required })),
        ciIds: f.cis.map((c) => c.id),
        assetIds: f.assets.map((a) => a.id),
      };
      return program ? pmApi.updateProgram(program.id, body) : pmApi.createProgram({ ...body, customerId: f.customerId });
    },
    onSuccess: (p) => {
      toast.success(program ? 'Program updated' : `Program created with ${p.occurrences.length} occurrence${p.occurrences.length === 1 ? '' : 's'}`);
      onSaved(p);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!f.customerId || f.name.trim().length < 2 || !f.startDate) {
      toast.error('Customer, name and start date are required');
      return;
    }
    if (f.frequency === 'custom' && !(Number(f.intervalDays) > 0)) {
      toast.error('Enter the interval in days for a custom frequency');
      return;
    }
    save.mutate();
  };
  const sel = 'h-8 py-0 text-[13px]';
  const customerItems = itemsOf<{ id: string; name: string; code: string }>(customers.data);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={program ? `Edit program · ${program.name}` : 'New PM program'}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="pm-program-form" loading={save.isPending}>{program ? 'Save changes' : 'Create program'}</Button>
        </>
      }
    >
      <form id="pm-program-form" onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Customer" required>
            <Select className={sel} value={f.customerId} disabled={!!program} placeholder="Select customer…" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} onChange={(e) => set({ customerId: e.target.value, siteId: '', contractId: '', entitlementId: '', cis: [], assets: [] })} />
          </Field>
          <Field label="Site">
            <Select className={sel} value={f.siteId} placeholder="All sites" disabled={!f.customerId} options={(sites.data ?? []).map((s) => ({ value: s.id, label: s.name }))} onChange={(e) => set({ siteId: e.target.value })} />
          </Field>
          <Field label="Program name" required className="sm:col-span-2"><Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Quarterly UPS and generator maintenance" /></Field>
          <Field label="Description / scope" className="sm:col-span-2"><Textarea rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} /></Field>
          <Field label="Service"><Select className={sel} value={f.serviceId} placeholder="Unspecified" options={(lookups?.services ?? []).map((s) => ({ value: s.id, label: s.name }))} onChange={(e) => set({ serviceId: e.target.value })} /></Field>
          <Field label="Contract" hint={!f.contractId ? 'Auto: the covering contract for the service/site.' : undefined}>
            <Select className={sel} value={f.contractId} placeholder="Auto-select" disabled={!f.customerId} options={(contracts.data ?? []).map((c) => ({ value: c.id, label: `${c.number} · ${c.name}` }))} onChange={(e) => set({ contractId: e.target.value, entitlementId: '' })} />
          </Field>
          <Field label="Entitlement" className="sm:col-span-2" hint={!f.entitlementId && autoPick ? `Auto: ${autoPick.name} (${fmtNumber(autoPick.utilization.remaining, 0)} of ${fmtNumber(autoPick.utilization.quantity, 0)} ${autoPick.unit} remaining)` : !f.entitlementId && f.customerId && !entitlements.isLoading ? 'No PM visit entitlement found; occurrences will not be metered.' : 'Each completed occurrence consumes one visit.'}>
            <Select className={sel} value={f.entitlementId} placeholder="Auto-select (pm_visits)" disabled={!f.customerId} options={visitEnts.map((e) => ({ value: e.id, label: `${e.name} · ${fmtNumber(e.utilization.remaining, 0)}/${fmtNumber(e.utilization.quantity, 0)} ${e.unit} left${e.contractNumber ? ` · ${e.contractNumber}` : ''}` }))} onChange={(e) => set({ entitlementId: e.target.value })} />
          </Field>
          <Field label="Frequency" required>
            <Select className={sel} value={f.frequency} options={(Object.keys(FREQUENCY_LABELS) as PmFrequency[]).map((k) => ({ value: k, label: FREQUENCY_LABELS[k] }))} onChange={(e) => set({ frequency: e.target.value as PmFrequency })} />
          </Field>
          {f.frequency === 'custom' ? (
            <Field label="Interval (days)" required><Input type="number" min={1} className={sel} value={f.intervalDays} onChange={(e) => set({ intervalDays: e.target.value })} /></Field>
          ) : (
            <div />
          )}
          <Field label="Start date" required><Input type="date" className={sel} value={f.startDate} onChange={(e) => set({ startDate: e.target.value })} /></Field>
          <Field label="End date" hint="Blank = open ended (12-month rolling horizon)"><Input type="date" className={sel} value={f.endDate} min={f.startDate || undefined} onChange={(e) => set({ endDate: e.target.value })} /></Field>
          <Field label="Lead days" hint="Due reminder this many days before the planned date"><Input type="number" min={0} className={sel} value={f.leadDays} onChange={(e) => set({ leadDays: e.target.value })} /></Field>
          <Field label="Grace days" hint="Marked missed this many days after the planned date"><Input type="number" min={0} className={sel} value={f.graceDays} onChange={(e) => set({ graceDays: e.target.value })} /></Field>
          <Field label="Assigned team"><Select className={sel} value={f.assignedTeamId} placeholder="No team" options={(lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name }))} onChange={(e) => set({ assignedTeamId: e.target.value })} /></Field>
          <Field label="Assigned engineer"><Select className={sel} value={f.assignedEngineerId} placeholder="Unassigned" options={(engineers.data ?? []).map((u) => ({ value: u.id, label: u.name }))} onChange={(e) => set({ assignedEngineerId: e.target.value })} /></Field>
          <Field label="Configuration items" className="sm:col-span-2">
            <EntityPicker queryKey={`cis-${f.customerId}`} multiple value={f.cis} onChange={(cis) => set({ cis })} disabled={!f.customerId} placeholder="Search CIs by name, hostname or IP…" search={async (q) => (await get<{ items: { id: string; name: string; hostname?: string | null; typeName?: string }[] }>('/cmdb/cis', { fields: 'min', customerId: f.customerId, q: q || undefined, pageSize: 20, sort: 'name', order: 'asc' })).items.map((c) => ({ id: c.id, label: c.name, sublabel: [c.typeName, c.hostname].filter(Boolean).join(' · ') }))} />
          </Field>
          <Field label="Assets" className="sm:col-span-2">
            <EntityPicker queryKey={`assets-${f.customerId}`} multiple value={f.assets} onChange={(assets) => set({ assets })} disabled={!f.customerId} placeholder="Search assets by tag, name or serial…" search={async (q) => (await get<{ items: { id: string; tag: string; name: string; serialNumber?: string | null }[] }>('/assets', { fields: 'min', customerId: f.customerId, q: q || undefined, pageSize: 20 })).items.map((a) => ({ id: a.id, label: a.tag, sublabel: [a.name, a.serialNumber].filter(Boolean).join(' · ') }))} />
          </Field>
          <div className="sm:col-span-2 flex flex-wrap items-center gap-4">
            <Checkbox checked={f.requiresSiteVisit} onChange={(e) => set({ requiresSiteVisit: e.target.checked })} label="Requires a site visit (scheduling creates a field visit)" />
            {program && <Checkbox checked={f.isActive} onChange={(e) => set({ isActive: e.target.checked })} label="Active" />}
          </div>
        </div>
        <Field label="Checklist template" hint="Copied onto every generated visit / occurrence.">
          <ChecklistEditor value={f.checklist} onChange={(checklist) => set({ checklist })} />
        </Field>
        {program && <div className="text-[12px] text-subtle">Changing the cadence or dates drops future untouched occurrences and regenerates them; scheduled and completed work is kept.</div>}
      </form>
    </Drawer>
  );
}
