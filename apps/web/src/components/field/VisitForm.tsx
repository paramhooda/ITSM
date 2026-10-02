import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { get } from '@/api/client';
import { Button, Checkbox, Drawer, Field, Input, Select, Textarea } from '@/components/ui';
import { useLookups, useEngineers, useCustomersLookup } from '@/hooks/useLookups';
import { useSites, useContracts, errorMessage } from '@/components/cmdb/hooks';
import { EntityPicker, type PickerItem } from '@/components/tickets/EntityPicker';
import { ticketsApi, itemsOf } from '@/components/tickets/api';
import type { Entitlement } from '@/components/contracts/types';
import { fmtNumber } from '@/lib/format';
import { ChecklistEditor, type ChecklistDraft } from './ChecklistEditor';
import { fieldApi } from './api';
import type { VisitDetail } from './types';

/** ISO → value for <input type="datetime-local"> (local time). */
export function toLocalInput(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

interface FormState {
  customerId: string;
  siteId: string;
  contractId: string;
  entitlementId: string;
  serviceId: string;
  typeId: string;
  title: string;
  purpose: string;
  scheduledStart: string;
  scheduledEnd: string;
  engineerId: string;
  teamId: string;
  additionalEngineers: PickerItem[];
  ticket: PickerItem[];
  billable: boolean;
  checklist: ChecklistDraft[];
}

const empty = (customerId = ''): FormState => ({ customerId, siteId: '', contractId: '', entitlementId: '', serviceId: '', typeId: '', title: '', purpose: '', scheduledStart: '', scheduledEnd: '', engineerId: '', teamId: '', additionalEngineers: [], ticket: [], billable: false, checklist: [] });

function fromVisit(v: VisitDetail): FormState {
  return {
    customerId: v.customerId,
    siteId: v.siteId ?? '',
    contractId: v.contractId ?? '',
    entitlementId: v.entitlementId ?? '',
    serviceId: v.serviceId ?? '',
    typeId: v.typeId ?? '',
    title: v.title,
    purpose: v.purpose ?? '',
    scheduledStart: toLocalInput(v.scheduledStart),
    scheduledEnd: toLocalInput(v.scheduledEnd),
    engineerId: v.engineerId ?? '',
    teamId: v.teamId ?? '',
    additionalEngineers: (v.additionalEngineers ?? []).map((e) => ({ id: e.id, label: e.name })),
    ticket: v.ticket ? [{ id: v.ticket.id, label: v.ticket.number, sublabel: v.ticket.title }] : [],
    billable: !!v.billable,
    checklist: (v.checklist ?? []).map((c) => ({ item: c.item, required: !!c.required })),
  };
}

/**
 * Create / edit drawer for field visits. Customer drives the site, contract,
 * entitlement (with remaining visits) and ticket pickers; leaving contract or
 * entitlement blank lets the API pick the covering contract and a matching
 * visit entitlement automatically.
 */
export function VisitForm({ open, onClose, visit, defaultCustomerId, onSaved }: { open: boolean; onClose: () => void; visit?: VisitDetail | null; defaultCustomerId?: string; onSaved: (v: VisitDetail) => void }) {
  const { options, lookups, byId } = useLookups();
  const engineers = useEngineers();
  const customers = useCustomersLookup();
  const [f, setF] = useState<FormState>(empty(defaultCustomerId));
  const set = (patch: Partial<FormState>) => setF((s) => ({ ...s, ...patch }));
  useEffect(() => {
    if (open) setF(visit ? fromVisit(visit) : empty(defaultCustomerId));
  }, [open, visit, defaultCustomerId]);

  const sites = useSites(f.customerId || null);
  const contracts = useContracts(f.customerId || null);
  const entitlements = useQuery({
    queryKey: ['customers', f.customerId, 'entitlements'],
    queryFn: () => get<Entitlement[]>(`/customers/${f.customerId}/entitlements`),
    enabled: open && !!f.customerId,
    staleTime: 30_000,
    retry: false,
  });
  const visitEntitlements = useMemo(() => (entitlements.data ?? []).filter((e) => e.unit === 'visits' && (!f.contractId || e.contractId === f.contractId)), [entitlements.data, f.contractId]);
  const selectedType = options('field_visit_type').find((o) => o.id === f.typeId);
  const autoKey = selectedType?.key === 'preventive_maintenance' ? 'pm_visits' : 'site_visits';
  const autoPick = useMemo(() => {
    const keyOf = (e: Entitlement) => byId(e.typeId)?.key ?? null;
    return visitEntitlements.find((e) => keyOf(e) === autoKey) ?? visitEntitlements.find((e) => ['site_visits', 'pm_visits'].includes(keyOf(e) ?? '')) ?? visitEntitlements[0] ?? null;
  }, [visitEntitlements, autoKey, byId]);

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        siteId: f.siteId || null,
        contractId: f.contractId || null,
        entitlementId: f.entitlementId || null,
        serviceId: f.serviceId || null,
        ticketId: f.ticket[0]?.id ?? null,
        typeId: f.typeId,
        title: f.title.trim(),
        purpose: f.purpose.trim() || null,
        scheduledStart: fromLocalInput(f.scheduledStart),
        scheduledEnd: fromLocalInput(f.scheduledEnd),
        engineerId: f.engineerId || null,
        teamId: f.teamId || null,
        additionalEngineerIds: f.additionalEngineers.map((e) => e.id),
        billable: f.billable,
        checklist: f.checklist.filter((c) => c.item.trim()).map((c) => ({ item: c.item.trim(), required: !!c.required })),
      };
      return visit ? fieldApi.update(visit.id, body) : fieldApi.create({ ...body, customerId: f.customerId });
    },
    onSuccess: (v) => {
      toast.success(visit ? 'Visit updated' : `Visit ${v.number} created`);
      onSaved(v);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!f.customerId || !f.typeId || f.title.trim().length < 3) {
      toast.error('Customer, visit type and a title are required');
      return;
    }
    save.mutate();
  };

  const engineerItems = useMemo(() => (engineers.data ?? []).map((u) => ({ id: u.id, label: u.name, sublabel: u.email })), [engineers.data]);
  const customerItems = itemsOf<{ id: string; name: string; code: string }>(customers.data);
  const sel = 'h-8 py-0 text-[13px]';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={visit ? `Edit ${visit.number}` : 'New field visit'}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button type="submit" form="visit-form" loading={save.isPending}>
            {visit ? 'Save changes' : 'Create visit'}
          </Button>
        </>
      }
    >
      <form id="visit-form" onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Customer" required>
            <Select className={sel} value={f.customerId} disabled={!!visit} placeholder="Select customer…" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} onChange={(e) => set({ customerId: e.target.value, siteId: '', contractId: '', entitlementId: '', ticket: [] })} />
          </Field>
          <Field label="Site">
            <Select className={sel} value={f.siteId} placeholder="Any / unspecified" disabled={!f.customerId} options={(sites.data ?? []).map((s) => ({ value: s.id, label: s.name }))} onChange={(e) => set({ siteId: e.target.value })} />
          </Field>
          <Field label="Visit type" required>
            <Select className={sel} value={f.typeId} placeholder="Select type…" options={options('field_visit_type').map((o) => ({ value: o.id, label: o.label }))} onChange={(e) => set({ typeId: e.target.value })} />
          </Field>
          <Field label="Service">
            <Select className={sel} value={f.serviceId} placeholder="Unspecified" options={(lookups?.services ?? []).map((s) => ({ value: s.id, label: s.name }))} onChange={(e) => set({ serviceId: e.target.value })} />
          </Field>
          <Field label="Title" required className="sm:col-span-2">
            <Input value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Replace faulty core switch PSU" maxLength={300} />
          </Field>
          <Field label="Purpose / scope" className="sm:col-span-2">
            <Textarea value={f.purpose} onChange={(e) => set({ purpose: e.target.value })} rows={3} placeholder="What should happen on site" />
          </Field>
          <Field label="Linked ticket" className="sm:col-span-2" hint="Search by number or title; the ticket's contract becomes the default.">
            <EntityPicker queryKey={`tickets-${f.customerId}`} value={f.ticket} onChange={(items) => set({ ticket: items.slice(-1) })} placeholder="INC-000123…" disabled={!f.customerId} minChars={2} search={async (q) => (await ticketsApi.lookup(q, f.customerId || undefined)).items.map((t) => ({ id: t.id, label: t.number, sublabel: t.title }))} />
          </Field>
          <Field label="Contract" hint={!f.contractId ? 'Auto: the covering contract for the service/site.' : undefined}>
            <Select className={sel} value={f.contractId} placeholder="Auto-select" disabled={!f.customerId} options={(contracts.data ?? []).map((c) => ({ value: c.id, label: `${c.number} · ${c.name}` }))} onChange={(e) => set({ contractId: e.target.value, entitlementId: '' })} />
          </Field>
          <Field label="Entitlement" hint={!f.entitlementId && autoPick ? `Auto: ${autoPick.name} (${fmtNumber(autoPick.utilization.remaining, 0)} of ${fmtNumber(autoPick.utilization.quantity, 0)} remaining)` : !f.entitlementId && f.customerId && !entitlements.isLoading ? 'No visit entitlement on the contract; the visit will not be metered.' : undefined}>
            <Select className={sel} value={f.entitlementId} placeholder="Auto-select" disabled={!f.customerId} options={visitEntitlements.map((e) => ({ value: e.id, label: `${e.name} · ${fmtNumber(e.utilization.remaining, 0)}/${fmtNumber(e.utilization.quantity, 0)} ${e.unit} left${e.contractNumber ? ` · ${e.contractNumber}` : ''}` }))} onChange={(e) => set({ entitlementId: e.target.value })} />
          </Field>
          <Field label="Scheduled start">
            <Input type="datetime-local" className={sel} value={f.scheduledStart} onChange={(e) => set({ scheduledStart: e.target.value })} />
          </Field>
          <Field label="Scheduled end">
            <Input type="datetime-local" className={sel} value={f.scheduledEnd} min={f.scheduledStart || undefined} onChange={(e) => set({ scheduledEnd: e.target.value })} />
          </Field>
          <Field label="Engineer" hint={!visit && f.scheduledStart && !f.engineerId ? 'Without an engineer the visit stays "requested".' : undefined}>
            <Select className={sel} value={f.engineerId} placeholder="Unassigned" options={(engineers.data ?? []).map((u) => ({ value: u.id, label: u.name }))} onChange={(e) => set({ engineerId: e.target.value })} />
          </Field>
          <Field label="Team">
            <Select className={sel} value={f.teamId} placeholder="No team" options={(lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name }))} onChange={(e) => set({ teamId: e.target.value })} />
          </Field>
          <Field label="Additional engineers" className="sm:col-span-2">
            <EntityPicker queryKey="engineers" multiple value={f.additionalEngineers} onChange={(items) => set({ additionalEngineers: items.filter((i) => i.id !== f.engineerId) })} placeholder="Add engineer…" minChars={0} search={async (q) => engineerItems.filter((e) => e.id !== f.engineerId && (!q || e.label.toLowerCase().includes(q.toLowerCase()))).slice(0, 10)} />
          </Field>
          <div className="sm:col-span-2">
            <Checkbox checked={f.billable} onChange={(e) => set({ billable: e.target.checked })} label="Billable visit (outside entitlement / chargeable)" />
          </div>
        </div>
        <Field label="Checklist" hint="Items the engineer ticks off on site; required items are highlighted in the completion dialog.">
          <ChecklistEditor value={f.checklist} onChange={(checklist) => set({ checklist })} />
        </Field>
      </form>
    </Drawer>
  );
}
