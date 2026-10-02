import { Plus, Minus } from 'lucide-react';
import { Field, Input, Select, Checkbox, Button, Textarea } from '@/components/ui';
import { useLookups, useCustomersLookup } from '@/hooks/useLookups';
import { SEVERITIES, type Rules, type Severity, type CustomerMapping } from './types';
import { SEVERITY_LABELS } from './SeverityBadge';

interface Props {
  value: Rules;
  onChange: (next: Rules) => void;
  multiCustomer: boolean;
  integrationType: string;
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** Editor for `integrations.rules`: ticket defaults, severity mappings, dedupe/auto-resolve behaviour, customer mapping and ignore patterns. */
export function RulesEditor({ value, onChange, multiCustomer, integrationType }: Props) {
  const lookups = useLookups();
  const customers = useCustomersLookup();
  const set = <K extends keyof Rules>(k: K, v: Rules[K]) => onChange({ ...value, [k]: v });
  const categories = lookups.options('ticket_category', { domain: value.domain, ticketType: 'incident' }).filter((c) => c.domain === value.domain || c.domain === 'general');
  const subcategories = lookups.options('ticket_subcategory');
  const selectedCategory = categories.find((c) => c.key === value.defaultCategoryKey);
  const priorities = lookups.options('ticket_priority');
  const securitySeverities = lookups.options('security_severity');
  const teams = lookups.lookups?.teams ?? [];
  const mapping = value.customerMapping ?? [];
  const setMapping = (rows: CustomerMapping[]) => set('customerMapping', rows);
  const updateRow = (i: number, patch: Partial<CustomerMapping> & { match?: CustomerMapping['match'] }) => setMapping(mapping.map((m, j) => (j === i ? { ...m, ...patch, match: { ...m.match, ...(patch.match ?? {}) } } : m)));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Domain" hint="Decides which categories are offered; the category's domain sets the ticket domain.">
          <Select value={value.domain} onChange={(e) => onChange({ ...value, domain: e.target.value as Rules['domain'], defaultCategoryKey: null, defaultSubcategoryKey: null })} options={[{ value: 'noc', label: 'NOC – infrastructure monitoring' }, { value: 'soc', label: 'SOC – security' }]} />
        </Field>
        <Field label="Default category" required hint="Applied to every ticket created by this integration.">
          <Select value={value.defaultCategoryKey ?? ''} onChange={(e) => onChange({ ...value, defaultCategoryKey: e.target.value || null, defaultSubcategoryKey: null })} placeholder="Select category…" options={categories.map((c) => ({ value: c.key, label: `${c.label}${c.domain !== 'general' ? ` (${c.domain.toUpperCase()})` : ''}` }))} />
        </Field>
        <Field label="Default subcategory">
          <Select value={value.defaultSubcategoryKey ?? ''} onChange={(e) => set('defaultSubcategoryKey', e.target.value || null)} placeholder="—" options={subcategories.filter((s) => !selectedCategory || !s.parentId || s.parentId === selectedCategory.id).map((s) => ({ value: s.key, label: s.label }))} />
        </Field>
        <Field label="Assign to team" hint="Leave empty to let assignment rules decide.">
          <Select value={value.assignTeamKey ?? ''} onChange={(e) => set('assignTeamKey', e.target.value || null)} placeholder="Assignment rules" options={teams.map((t) => ({ value: t.key, label: t.name }))} />
        </Field>
        <Field label="Title template" hint="Placeholders: {{host}} {{ipAddress}} {{sensor}} {{message}} {{statusText}} {{severity}} {{customer}} {{group}} {{raw.<field>}}" className="sm:col-span-2">
          <Input className="font-mono text-xs" value={value.titleTemplate} onChange={(e) => set('titleTemplate', e.target.value)} placeholder="{{host}}: {{message}}" />
        </Field>
      </div>

      <div className="rounded-lg border border-default p-3">
        <div className="text-[12.5px] font-medium text-muted mb-2">Severity → priority{value.domain === 'soc' ? ' / security severity' : ''}</div>
        <div className={value.domain === 'soc' ? 'grid grid-cols-[auto_1fr_1fr] gap-2 items-center' : 'grid grid-cols-[auto_1fr] gap-2 items-center'}>
          <div className="text-[11.5px] uppercase tracking-wide text-subtle">Severity</div>
          <div className="text-[11.5px] uppercase tracking-wide text-subtle">Priority</div>
          {value.domain === 'soc' && <div className="text-[11.5px] uppercase tracking-wide text-subtle">Security severity</div>}
          {SEVERITY_ORDER.map((s) => (
            <SeverityRow key={s} s={s} value={value} priorities={priorities} securitySeverities={securitySeverities} onChange={onChange} />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Create tickets from severity" hint="Lower severities are stored and correlated only.">
          <Select value={value.minSeverityForTicket} onChange={(e) => set('minSeverityForTicket', e.target.value as Severity)} options={SEVERITIES.map((s) => ({ value: s, label: SEVERITY_LABELS[s] }))} />
        </Field>
        <Field label="Dedupe window (minutes)" hint="Repeated events for the same alarm attach to the existing ticket.">
          <Input type="number" min={0} max={43200} value={value.dedupeWindowMinutes} onChange={(e) => set('dedupeWindowMinutes', Math.max(0, Number(e.target.value) || 0))} />
        </Field>
        <div className="flex flex-col gap-2 justify-end pb-1">
          <Checkbox label="Auto-resolve on recovery (unless an engineer commented)" checked={value.autoResolve} onChange={(e) => set('autoResolve', e.target.checked)} />
          <Checkbox label="Reopen resolved ticket on recurrence within the window" checked={value.reopenOnRecurrence} onChange={(e) => set('reopenOnRecurrence', e.target.checked)} />
        </div>
      </div>

      <Field label="Ignore patterns" hint="One regular expression per line, matched case-insensitively against message, sensor, event type and host.">
        <Textarea className="font-mono text-xs min-h-[70px]" value={(value.ignorePatterns ?? []).join('\n')} onChange={(e) => set('ignorePatterns', e.target.value.split('\n').map((l) => l.trim()).filter(Boolean))} placeholder={'maintenance window\n^Paused'} />
      </Field>

      {multiCustomer && (
        <div className="rounded-lg border border-default p-3">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="text-[12.5px] font-medium text-muted">Customer mapping</div>
              <div className="text-xs text-subtle">Rules are evaluated top-down; every filled criterion must match. Without a match the event is resolved through the CMDB (host / IP) or flagged for review. {integrationType === 'prtg' ? 'Group / probe are the PRTG group and probe names.' : integrationType === 'fortisiem' ? 'Group is the FortiSIEM organization name.' : 'Group is the "group" field of the event.'}</div>
            </div>
            <Button variant="outline" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setMapping([...mapping, { match: {}, customerId: '' }])} disabled={mapping.length >= 500}>
              Add rule
            </Button>
          </div>
          {mapping.length === 0 && <div className="text-xs text-subtle py-2">No mapping rules yet.</div>}
          <div className="flex flex-col gap-2">
            {mapping.map((m, i) => (
              <div key={i} className="grid grid-cols-2 sm:grid-cols-[1fr_1fr_1fr_1fr_1.4fr_auto] gap-2 items-center">
                <Input placeholder="Group (glob *)" value={m.match.group ?? ''} onChange={(e) => updateRow(i, { match: { group: e.target.value || undefined } })} />
                <Input placeholder="Probe (glob *)" value={m.match.probe ?? ''} onChange={(e) => updateRow(i, { match: { probe: e.target.value || undefined } })} />
                <Input placeholder="Host regex" className="font-mono text-xs" value={m.match.hostPattern ?? ''} onChange={(e) => updateRow(i, { match: { hostPattern: e.target.value || undefined } })} />
                <Input placeholder="IP CIDR" className="font-mono text-xs" value={m.match.ipCidr ?? ''} onChange={(e) => updateRow(i, { match: { ipCidr: e.target.value || undefined } })} />
                <Select value={m.customerId} onChange={(e) => updateRow(i, { customerId: e.target.value })} placeholder="→ customer…" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))} />
                <Button variant="ghost" size="icon" aria-label="Remove rule" onClick={() => setMapping(mapping.filter((_, j) => j !== i))}>
                  <Minus className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SeverityRow({ s, value, priorities, securitySeverities, onChange }: { s: Severity; value: Rules; priorities: { key: string; label: string }[]; securitySeverities: { key: string; label: string }[]; onChange: (r: Rules) => void }) {
  return (
    <>
      <div className="text-[13px] pr-2">{SEVERITY_LABELS[s]}</div>
      <Select value={value.severityToPriority?.[s] ?? ''} onChange={(e) => onChange({ ...value, severityToPriority: { ...value.severityToPriority, [s]: e.target.value } })} options={priorities.map((p) => ({ value: p.key, label: p.label }))} />
      {value.domain === 'soc' && (
        <Select value={value.severityToSecuritySeverity?.[s] ?? ''} onChange={(e) => onChange({ ...value, severityToSecuritySeverity: { ...(value.severityToSecuritySeverity ?? {}), [s]: e.target.value } })} placeholder="—" options={securitySeverities.map((p) => ({ value: p.key, label: p.label }))} />
      )}
    </>
  );
}
