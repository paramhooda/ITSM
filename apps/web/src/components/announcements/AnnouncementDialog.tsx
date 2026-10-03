import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui';
import { FormDialog, type FieldSpec } from '@/components/admin/FormDialog';
import { MultiSelect } from '@/components/admin/inputs';
import { useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { announcementsApi, announcementKeys, type Announcement, type AnnouncementInput, type AnnouncementType, type AnnouncementAudience } from './api';

type Values = Record<string, unknown>;

export const TYPE_OPTIONS: { value: AnnouncementType; label: string }[] = [
  { value: 'info', label: 'Notice' },
  { value: 'maintenance', label: 'Planned maintenance' },
  { value: 'outage', label: 'Service disruption' },
];
export const AUDIENCE_OPTIONS: { value: AnnouncementAudience; label: string }[] = [
  { value: 'all', label: 'Everyone (customers and staff)' },
  { value: 'customers', label: 'Customers only' },
  { value: 'staff', label: 'Staff only' },
];

/** ISO → the value a datetime-local input wants (local time, minutes). */
const toLocal = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const toIso = (v: unknown) => (typeof v === 'string' && v ? new Date(v).toISOString() : null);

export interface AnnouncementSeed extends Partial<AnnouncementInput> {
  id?: string;
  /** Shown as the ticket the announcement is about; `sourceTicketId` carries its id. */
  sourceTicket?: { id: string; number: string } | null;
}

/**
 * Create or edit an announcement. "Draft with Grady" fills the title and body from the
 * source ticket (or the text already typed) for the chosen type and audience; the person
 * reads and edits before publishing.
 */
export function AnnouncementDialog({ open, onClose, seed, onSaved }: { open: boolean; onClose: () => void; seed?: AnnouncementSeed | null; onSaved?: (a: Announcement) => void }) {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const customers = useCustomersLookup();
  const [drafting, setDrafting] = useState(false);
  const [provenance, setProvenance] = useState<string | null>(null);
  const editing = !!seed?.id;
  const customerOpts = (customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name, hint: c.code }));

  const fields: FieldSpec<Values>[] = [
    { key: 'type', label: 'Type', type: 'select', options: TYPE_OPTIONS, required: true },
    { key: 'audience', label: 'Audience', type: 'select', options: AUDIENCE_OPTIONS, required: true },
    { key: 'title', label: 'Title', type: 'text', required: true, span: 2, placeholder: 'What people see first' },
    { key: 'body', label: 'Message', type: 'textarea', rows: 6, required: true, span: 2, placeholder: 'What is affected, what is being done, when the next update or the end of the window is' },
    ...(can('ai:use')
      ? [
          {
            key: 'draft',
            type: 'custom' as const,
            span: 2 as const,
            render: ({ values, setValues, disabled }: { values: Values; setValues: (p: Partial<Values>) => void; disabled: boolean }) => (
              <div className="flex flex-wrap items-center gap-2 -mt-2">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Sparkles className="h-3.5 w-3.5" />}
                  loading={drafting}
                  disabled={disabled}
                  title="Let Grady write the title and the message for this type and audience"
                  onClick={async () => {
                    setDrafting(true);
                    try {
                      const notes = [values.title, values.body].filter((x) => typeof x === 'string' && x.trim()).join('\n');
                      const d = await announcementsApi.draft({ ticketId: (seed?.sourceTicketId as string | undefined) ?? undefined, type: values.type as AnnouncementType, audience: values.audience as AnnouncementAudience, notes: notes || undefined });
                      setValues({ title: d.title, body: d.body, type: d.type });
                      setProvenance(d.aiGenerated ? 'Drafted by Grady; read it before publishing.' : 'Template draft (the AI provider is not configured); edit before publishing.');
                    } catch (err) {
                      toast.error((err as Error).message || 'Could not draft the announcement');
                    } finally {
                      setDrafting(false);
                    }
                  }}
                >
                  Draft with Grady
                </Button>
                {seed?.sourceTicket && <span className="text-[12px] text-subtle">from {seed.sourceTicket.number}</span>}
                {provenance && <span className="text-[12px] text-subtle inline-flex items-center gap-1"><Sparkles className="h-3 w-3" /> {provenance}</span>}
              </div>
            ),
          } satisfies FieldSpec<Values>,
        ]
      : []),
    {
      key: 'customerIds',
      label: 'Customers',
      type: 'custom',
      span: 2,
      visible: (v) => v.audience !== 'staff',
      hint: 'Leave empty for every customer',
      render: ({ value, onChange, disabled }) => <MultiSelect value={(value as string[]) ?? []} onChange={(ids) => onChange(ids)} options={customerOpts} disabled={disabled} placeholder="Search customers…" />,
    },
    { key: 'startsAt', label: 'Show from', type: 'datetime', hint: 'Empty = now' },
    { key: 'endsAt', label: 'Take down at', type: 'datetime', hint: 'Empty = until someone ends it' },
    { key: 'pinned', label: 'Pinned (cannot be dismissed)', type: 'boolean' },
    { key: 'isActive', label: 'Active', type: 'boolean' },
  ];

  const initial: Values = {
    type: seed?.type ?? 'info',
    audience: seed?.audience ?? 'all',
    title: seed?.title ?? '',
    body: seed?.body ?? '',
    customerIds: seed?.customerIds ?? [],
    startsAt: toLocal(seed?.startsAt ?? null),
    endsAt: toLocal(seed?.endsAt ?? null),
    pinned: seed?.pinned ?? false,
    isActive: seed?.isActive ?? true,
  };

  async function submit(v: Values) {
    const body: AnnouncementInput = {
      title: String(v.title ?? '').trim(),
      body: String(v.body ?? '').trim(),
      type: v.type as AnnouncementType,
      audience: v.audience as AnnouncementAudience,
      customerIds: v.audience === 'staff' ? [] : ((v.customerIds as string[]) ?? []),
      startsAt: toIso(v.startsAt) ?? undefined,
      endsAt: toIso(v.endsAt),
      pinned: !!v.pinned,
      isActive: !!v.isActive,
      sourceTicketId: seed?.sourceTicketId ?? null,
    };
    const saved = editing ? await announcementsApi.update(seed!.id!, body) : await announcementsApi.create(body);
    await qc.invalidateQueries({ queryKey: announcementKeys.all });
    await qc.invalidateQueries({ queryKey: ['portal', 'banners'] });
    toast.success(editing ? 'Announcement updated' : 'Announcement published');
    onSaved?.(saved);
  }

  return (
    <FormDialog<Values>
      open={open}
      onClose={() => {
        setProvenance(null);
        onClose();
      }}
      title={editing ? 'Edit announcement' : 'New announcement'}
      description="Shown as a banner above every page for its audience, and on the customer status page."
      fields={fields}
      initial={initial}
      onSubmit={submit}
      submitLabel={editing ? 'Save' : 'Publish'}
      variant="drawer"
      width="max-w-2xl"
    />
  );
}
