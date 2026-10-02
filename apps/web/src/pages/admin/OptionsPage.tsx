import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, ChevronUp, ChevronDown, Ban, Star } from 'lucide-react';
import { OPTION_TYPES, OPTION_PARENT_TYPES, TICKET_TYPES, DOMAINS, STATUS_CATEGORIES } from '@itsm/shared';
import { get, post, patch, del } from '@/api/client';
import { Button, Select, Badge, type Column } from '@/components/ui';
import { useLookups, type ConfigOption } from '@/hooks/useLookups';
import { titleCase } from '@/lib/format';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, MonoCell, ActiveDot } from '@/components/admin/ConfigTable';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { ColorSwatch } from '@/components/admin/inputs';
import { useAdminMutation } from '@/components/admin/api';

export const OPTION_GROUPS: { group: string; types: [string, string][] }[] = [
  { group: 'Tickets', types: [['ticket_category', 'Categories'], ['ticket_subcategory', 'Subcategories'], ['ticket_priority', 'Priorities'], ['ticket_impact', 'Impact'], ['ticket_urgency', 'Urgency'], ['ticket_status', 'Statuses'], ['ticket_source', 'Sources'], ['resolution_code', 'Resolution codes'], ['closure_code', 'Closure codes']] },
  { group: 'Customers', types: [['customer_type', 'Customer types'], ['customer_status', 'Customer statuses'], ['customer_industry', 'Industries'], ['site_type', 'Site types']] },
  { group: 'Contracts & Scope', types: [['contract_type', 'Contract types'], ['contract_status', 'Contract statuses'], ['entitlement_type', 'Entitlement types'], ['scope_header', 'Scope headers'], ['scope_category', 'Scope categories'], ['scope_type', 'Scope types'], ['scope_status', 'Scope statuses']] },
  { group: 'Services', types: [['service_category', 'Service categories'], ['service_subcategory', 'Service subcategories'], ['service_status', 'Service statuses']] },
  { group: 'Assets', types: [['asset_category', 'Asset categories'], ['asset_status', 'Asset statuses']] },
  { group: 'Field & Maintenance', types: [['field_visit_type', 'Visit types'], ['field_visit_status', 'Visit statuses'], ['pm_frequency', 'PM frequencies']] },
  { group: 'Changes & Security', types: [['change_type', 'Change types'], ['change_risk', 'Change risk levels'], ['security_severity', 'Security severities']] },
  { group: 'Other', types: [['kb_type', 'Knowledge article types'], ['team_type', 'Team types']] },
];
// Any option type added to the shared constants but not grouped above still shows up.
const known = new Set(OPTION_GROUPS.flatMap((g) => g.types.map((t) => t[0])));
for (const t of OPTION_TYPES) if (!known.has(t)) OPTION_GROUPS[OPTION_GROUPS.length - 1].types.push([t, titleCase(t)]);

export const optionTypeLabel = (type: string) => OPTION_GROUPS.flatMap((g) => g.types).find((t) => t[0] === type)?.[1] ?? titleCase(type);
const singular = (label: string) => (label.endsWith('ies') ? label.slice(0, -3) + 'y' : label.endsWith('ses') ? label.slice(0, -2) : label.endsWith('s') ? label.slice(0, -1) : label).toLowerCase();

const LEVEL_TYPES = ['ticket_priority', 'ticket_impact', 'ticket_urgency', 'change_risk', 'security_severity'];
const APPLIES_TYPES = ['ticket_status', 'ticket_priority', 'ticket_category', 'ticket_subcategory', 'ticket_source', 'resolution_code', 'closure_code'];
const DOMAIN_TYPES = ['ticket_category', 'ticket_subcategory', 'service_category', 'service_subcategory', 'scope_header', 'scope_category'];

type OptionValues = Record<string, unknown>;

export default function OptionsPage() {
  const { type: typeParam } = useParams();
  const navigate = useNavigate();
  const type = typeParam && (OPTION_TYPES as readonly string[]).includes(typeParam) ? typeParam : 'ticket_category';
  const lookups = useLookups();
  const q = useQuery({ queryKey: ['config', 'options', type], queryFn: () => get<ConfigOption[]>('/config/options', { type, includeInactive: true }) });
  const rows = useMemo(() => [...(q.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label)), [q.data]);
  const editor = useEditor<ConfigOption>();
  const invalidate = [['config', 'options', type]];

  const create = useAdminMutation((body: OptionValues) => post('/config/options', body), { invalidate, lookups: true, success: 'Option added' });
  const update = useAdminMutation(({ id, ...body }: OptionValues & { id: string }) => patch(`/config/options/${id}`, body), { invalidate, lookups: true, success: 'Option updated' });
  const remove = useAdminMutation((id: string) => del<{ deleted?: boolean; deactivated?: boolean }>(`/config/options/${id}`), { invalidate, lookups: true, onSuccess: (r) => toast.success(r.deactivated ? 'Entry deactivated' : 'Entry deleted') });
  const reorder = useAdminMutation((ids: string[]) => post('/config/options/reorder', { ids }), { invalidate, lookups: true });

  const parentType = (OPTION_PARENT_TYPES as Record<string, string>)[type];
  const parentOptions = (parentType ? lookups.options(parentType, { includeInactive: true }) ?? [] : []).map((o) => ({ value: o.id, label: o.label }));
  const hasLevel = LEVEL_TYPES.includes(type);
  const hasApplies = APPLIES_TYPES.includes(type);
  const hasDomain = DOMAIN_TYPES.includes(type);
  const isStatus = type === 'ticket_status';
  const isSub = !!parentType;

  const fields: FieldSpec<OptionValues>[] = [
    { key: 'label', label: 'Label', type: 'text', required: true },
    { key: 'key', label: 'Key', type: 'key', required: true, hint: 'Stable identifier used by rules and integrations', disabled: (v) => !!v.id },
    { key: 'description', label: 'Description', type: 'textarea', rows: 2 },
    ...(isSub ? [{ key: 'parentId', label: 'Parent category', type: 'select', options: parentOptions, required: true, hint: 'The main header this entry sits under' } as FieldSpec<OptionValues>] : []),
    ...(hasDomain ? [{ key: 'domain', label: 'Domain', type: 'select', options: DOMAINS.map((d) => ({ value: d, label: d === 'general' ? 'General (all)' : d.toUpperCase().replace('_', ' ') })) } as FieldSpec<OptionValues>] : []),
    ...(isStatus ? [{ key: 'statusCategory', label: 'Status category', type: 'select', required: true, options: STATUS_CATEGORIES.map((s) => ({ value: s, label: titleCase(s) })), hint: 'Drives SLA clocks and reports for any custom status' } as FieldSpec<OptionValues>, { key: 'pausesSla', label: 'Pauses SLA clocks', type: 'boolean', placeholder: 'Clock stops while tickets are in this status' } as FieldSpec<OptionValues>] : []),
    ...(hasLevel ? [{ key: 'level', label: 'Level', type: 'number', min: 1, hint: '1 = highest' } as FieldSpec<OptionValues>] : []),
    { key: 'icon', label: 'Icon', type: 'text', placeholder: 'lucide icon name, e.g. server', mono: true },
    { key: 'color', label: 'Colour', type: 'color' },
    ...(hasApplies ? [{ key: 'appliesTo', label: 'Applies to ticket types', type: 'custom', hint: 'Leave all unticked to apply to every type', render: ({ value, onChange }) => <AppliesTo value={(value as string[]) ?? []} onChange={onChange} /> } as FieldSpec<OptionValues>] : []),
    { key: 'isDefault', label: 'Default', type: 'boolean', placeholder: 'Pre-selected in forms' },
    { key: 'isActive', label: 'Active', type: 'boolean', placeholder: 'Available for selection' },
  ];

  const columns: Column<ConfigOption>[] = [
    { key: 'label', header: 'Label', render: (r) => (
      <span className="inline-flex items-center gap-2">
        <span className={!r.isActive ? 'text-subtle line-through' : ''}>{r.label}</span>
        {r.isDefault && <Star className="h-3.5 w-3.5 text-amber-500" aria-label="Default" />}
        {r.isSystem && <Badge color="slate">system</Badge>}
      </span>
    ) },
    { key: 'key', header: 'Key', render: (r) => <MonoCell>{r.key}</MonoCell> },
    ...(isSub ? [{ key: 'parentId', header: 'Parent', render: (r: ConfigOption) => lookups.byId(r.parentId)?.label ?? '—' }] : []),
    ...(hasDomain ? [{ key: 'domain', header: 'Domain', render: (r: ConfigOption) => <span className="text-muted">{r.domain === 'general' ? 'General' : r.domain.toUpperCase().replace('_', ' ')}</span> }] : []),
    ...(isStatus ? [{ key: 'statusCategory', header: 'Category', render: (r: ConfigOption) => <span className="inline-flex items-center gap-2"><Badge color={r.color ?? undefined}>{titleCase(r.statusCategory ?? '')}</Badge>{r.pausesSla && <span className="text-[11.5px] text-subtle">pauses SLA</span>}</span> }] : []),
    ...(hasLevel ? [{ key: 'level', header: 'Level', render: (r: ConfigOption) => r.level ?? '—' }] : []),
    ...(!isStatus ? [{ key: 'color', header: 'Colour', render: (r: ConfigOption) => <ColorSwatch color={r.color} /> }] : []),
    ...(hasApplies ? [{ key: 'appliesTo', header: 'Applies to', render: (r: ConfigOption) => <span className="text-muted text-[12.5px]">{r.appliesTo.length ? r.appliesTo.map(titleCase).join(', ') : 'All'}</span> }] : []),
    { key: 'isActive', header: 'Status', render: (r) => <ActiveDot active={r.isActive} /> },
  ];

  const move = (row: ConfigOption, dir: -1 | 1) => {
    const ids = rows.map((r) => r.id);
    const i = ids.indexOf(row.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder.mutate(ids);
  };

  const initial: OptionValues = editor.row
    ? { ...editor.row }
    : { type, key: '', label: '', description: '', domain: 'general', statusCategory: isStatus ? 'open' : null, pausesSla: false, level: null, color: null, icon: '', appliesTo: [], isDefault: false, isActive: true, parentId: null };

  async function submit(values: OptionValues) {
    const body: OptionValues = {
      key: values.key, label: values.label, description: values.description || null, color: values.color ?? null, icon: values.icon || null, isDefault: !!values.isDefault, isActive: !!values.isActive,
      ...(hasDomain ? { domain: values.domain ?? 'general' } : {}),
      ...(isSub ? { parentId: values.parentId ?? null } : {}),
      ...(isStatus ? { statusCategory: values.statusCategory ?? null, pausesSla: !!values.pausesSla } : {}),
      ...(hasLevel ? { level: values.level === '' || values.level === undefined ? null : values.level } : {}),
      ...(hasApplies ? { appliesTo: values.appliesTo ?? [] } : {}),
    };
    if (editor.row) {
      const { key: _k, ...rest } = body;
      await update.mutateAsync({ id: editor.row.id, ...rest });
    } else await create.mutateAsync({ type, ...body });
  }

  return (
    <div>
      <SectionHeader
        title="Option lists"
        description="Pick-lists used across tickets, customers, contracts, services, assets and more. System entries can be renamed or deactivated but not removed."
        actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>Add entry</Button>}
      />
      <ConfigTable<ConfigOption>
        toolbar={
          <>
            <Select value={type} onChange={(e) => navigate(`/admin/options/${e.target.value}`)} className="max-w-xs">
              {OPTION_GROUPS.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.types.map(([t, label]) => (
                    <option key={t} value={t}>
                      {label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
            <span className="text-[12.5px] text-muted ml-auto">{rows.length} entries · {rows.filter((r) => r.isActive).length} active</span>
          </>
        }
        columns={columns}
        rows={rows}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={editor.edit}
        actions={[
          { label: 'Move up', icon: <ChevronUp className="h-4 w-4" />, inline: true, onClick: (r) => move(r, -1), disabled: (r) => rows[0]?.id === r.id },
          { label: 'Move down', icon: <ChevronDown className="h-4 w-4" />, inline: true, onClick: (r) => move(r, 1), disabled: (r) => rows[rows.length - 1]?.id === r.id },
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
          { label: 'Deactivate', icon: <Ban className="h-4 w-4" />, hidden: (r) => !r.isSystem || !r.isActive, onClick: (r) => update.mutate({ id: r.id, isActive: false }) },
          { label: 'Activate', icon: <Star className="h-4 w-4" />, hidden: (r) => r.isActive, onClick: (r) => update.mutate({ id: r.id, isActive: true }) },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, hidden: (r) => r.isSystem, onClick: (r) => { if (confirm(`Delete "${r.label}"? Records referencing it keep working but lose the label.`)) remove.mutate(r.id); } },
        ]}
      />
      <FormDialog<OptionValues> open={editor.open} onClose={editor.close} title={editor.row ? `Edit ${singular(optionTypeLabel(type))}` : `New ${singular(optionTypeLabel(type))}`} fields={fields} initial={initial} onSubmit={submit} />
    </div>
  );
}

function AppliesTo({ value, onChange }: { value: string[]; onChange: (v: unknown) => void }) {
  return (
    <div className="flex flex-wrap gap-3">
      {TICKET_TYPES.map((t) => (
        <label key={t} className="inline-flex items-center gap-1.5 text-[13px] cursor-pointer">
          <input type="checkbox" className="h-4 w-4 rounded border-default accent-brand-600" checked={value.includes(t)} onChange={(e) => onChange(e.target.checked ? [...value, t] : value.filter((x) => x !== t))} />
          {titleCase(t)}
        </label>
      ))}
    </div>
  );
}
