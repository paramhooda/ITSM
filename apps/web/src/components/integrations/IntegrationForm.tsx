import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, Check } from 'lucide-react';
import { get, post, patch } from '@/api/client';
import { Button, Drawer, Dialog, Field, Input, Textarea, Select, Checkbox, Toggle, Tabs } from '@/components/ui';
import { useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { RulesEditor } from './RulesEditor';
import { JsonView } from './JsonView';
import { errorMessage, type Integration, type IntegrationType, type Rules, type ApiKeyReveal } from './types';

interface Props {
  open: boolean;
  onClose: () => void;
  integration?: Integration | null;
  types: IntegrationType[];
}

interface FormState {
  integrationType: string;
  name: string;
  description: string;
  customerId: string;
  autoCreateTickets: boolean;
  isActive: boolean;
  createApiKey: boolean;
  rules: Rules;
}

const toForm = (i: Integration | null | undefined, types: IntegrationType[]): FormState => {
  const type = i?.integrationType ?? types[0]?.type ?? 'prtg';
  const defaults = types.find((t) => t.type === type)?.defaultRules;
  return {
    integrationType: type,
    name: i?.name ?? '',
    description: i?.description ?? '',
    customerId: i?.customerId ?? '',
    autoCreateTickets: i?.autoCreateTickets ?? true,
    isActive: i?.isActive ?? true,
    createApiKey: true,
    rules: i?.rules ?? defaults ?? ({ ticketType: 'incident', domain: 'noc', severityToPriority: {}, minSeverityForTicket: 'medium', dedupeWindowMinutes: 240, autoResolve: true, reopenOnRecurrence: false, customerMapping: [], titleTemplate: '{{host}}: {{message}}', ignorePatterns: [] } as Rules),
  };
};

/** Very small markdown renderer for adapter docs (headings, lists, code, inline code, tables, bold). */
function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const out: ReactElement[] = [];
  let i = 0;
  let key = 0;
  const inline = (s: string) => {
    const parts = s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    return parts.map((p, idx) => (p.startsWith('`') ? <code key={idx} className="font-mono text-[11.5px] bg-surface-2 rounded px-1 break-all">{p.slice(1, -1)}</code> : p.startsWith('**') ? <strong key={idx}>{p.slice(2, -2)}</strong> : <span key={idx}>{p}</span>));
  };
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(<pre key={key++} className="font-mono text-[11.5px] bg-surface-2 rounded-md p-2 overflow-auto whitespace-pre-wrap break-all my-1">{buf.join('\n').trim()}</pre>);
      continue;
    }
    if (l.startsWith('### ')) {
      out.push(<div key={key++} className="font-semibold text-[13px] mt-1">{l.slice(4)}</div>);
      i++;
      continue;
    }
    if (l.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim());
        if (!cells.every((c) => /^-+$/.test(c))) rows.push(cells);
        i++;
      }
      out.push(
        <table key={key++} className="text-[12px] my-1 w-full">
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className={ri === 0 ? 'text-muted' : 'border-t border-default'}>
                {r.map((c, ci) => <td key={ci} className="py-0.5 pr-2 align-top">{inline(c)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    const m = l.match(/^(\s*)(\d+\.|[*-])\s+(.*)$/);
    if (m) {
      out.push(<div key={key++} className="flex gap-1.5" style={{ paddingLeft: m[1].length * 6 }}><span className="text-subtle shrink-0">{m[2] === '*' || m[2] === '-' ? '•' : m[2]}</span><span>{inline(m[3])}</span></div>);
      i++;
      continue;
    }
    if (l.trim()) out.push(<p key={key++}>{inline(l)}</p>);
    i++;
  }
  return <div className="text-[12.5px] leading-5 flex flex-col gap-1">{out}</div>;
}

export function DocsPanel({ type, integration, apiKey }: { type?: IntegrationType; integration?: Integration | null; apiKey?: string | null }) {
  const [tab, setTab] = useState<'docs' | 'sample'>('docs');
  if (!type) return null;
  const url = integration?.webhookUrl ?? type.webhookUrlPattern;
  const docs = type.docs.replace(/\{\{webhookUrl\}\}/g, url).replace(/\{\{apiKey\}\}/g, apiKey ?? '<api key>');
  return (
    <div className="rounded-lg border border-default bg-surface-2/40 p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold text-[13px]">{type.label}</div>
          <div className="text-xs text-muted">{type.description}</div>
        </div>
      </div>
      <div className="text-[12px]">
        <div className="text-[11px] uppercase tracking-wide text-subtle">Webhook URL</div>
        <div className="flex items-center gap-1">
          <code className="font-mono text-[11.5px] break-all flex-1 select-all">{url}</code>
          <Button variant="ghost" size="icon" aria-label="Copy URL" onClick={() => { void navigator.clipboard?.writeText(url); toast.success('Copied'); }}><Copy className="h-3.5 w-3.5" /></Button>
        </div>
      </div>
      <Tabs tabs={[{ key: 'docs', label: 'How to configure' }, { key: 'sample', label: 'Sample payload' }]} value={tab} onChange={setTab} />
      {tab === 'docs' ? <Markdown text={docs} /> : <JsonView value={type.samplePayload} maxHeight="max-h-72" />}
    </div>
  );
}

export function ApiKeyDialog({ reveal, name, webhookUrl, onClose }: { reveal: ApiKeyReveal | null; name: string; webhookUrl?: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open={!!reveal} onClose={onClose} title={`API key for ${name}`} width="max-w-lg" footer={<Button onClick={onClose}>Done</Button>}>
      <div className="text-[13px] text-muted mb-3">Copy the key now – it cannot be displayed again. Send it as the <code className="font-mono">X-API-Key</code> header or as <code className="font-mono">?key=</code> for systems that cannot set headers (PRTG).</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 font-mono text-[12.5px] rounded-lg border border-default bg-surface-2 px-3 py-2 break-all select-all">{reveal?.key}</code>
        <Button variant="outline" icon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} onClick={() => { void navigator.clipboard?.writeText(reveal?.key ?? ''); setCopied(true); toast.success('Copied'); }}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {webhookUrl && <div className="mt-3 text-[12px] text-subtle font-mono break-all">curl -X POST "{webhookUrl}" -H "X-API-Key: {reveal?.key?.slice(0, 12)}…" -H "Content-Type: application/json" -d @event.json</div>}
    </Dialog>
  );
}

export function IntegrationForm({ open, onClose, integration, types }: Props) {
  const qc = useQueryClient();
  const customers = useCustomersLookup();
  const can = useAuthStore((s) => s.can);
  const canMulti = can('tenant:all');
  const [f, setF] = useState<FormState>(() => toForm(integration, types));
  const [reveal, setReveal] = useState<{ reveal: ApiKeyReveal; name: string; webhookUrl?: string } | null>(null);
  useEffect(() => {
    if (open) setF(toForm(integration, types));
  }, [open, integration, types]);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((x) => ({ ...x, [k]: v }));
  const type = useMemo(() => types.find((t) => t.type === f.integrationType), [types, f.integrationType]);
  const multi = !f.customerId;

  const save = useMutation({
    mutationFn: async () => {
      const body = { name: f.name.trim(), description: f.description.trim() || null, customerId: f.customerId || null, autoCreateTickets: f.autoCreateTickets, isActive: f.isActive, rules: { ...f.rules, customerMapping: (f.rules.customerMapping ?? []).filter((m) => m.customerId) } };
      if (integration) return patch<Integration & { apiKey?: ApiKeyReveal | null }>(`/integrations/${integration.id}`, body);
      return post<Integration & { apiKey?: ApiKeyReveal | null }>('/integrations', { ...body, integrationType: f.integrationType, createApiKey: f.createApiKey });
    },
    onSuccess: (r) => {
      toast.success(integration ? 'Integration updated' : 'Integration created');
      qc.invalidateQueries({ queryKey: ['integrations'] });
      onClose();
      if (r.apiKey) setReveal({ reveal: r.apiKey, name: r.name, webhookUrl: r.webhookUrl });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const valid = f.name.trim().length >= 2 && !!f.rules.defaultCategoryKey && (f.customerId || canMulti);

  return (
    <>
      <Drawer open={open} onClose={onClose} title={integration ? `Edit ${integration.name}` : 'New integration'} width="max-w-5xl" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!valid} onClick={() => save.mutate()}>{integration ? 'Save changes' : 'Create integration'}</Button></>}>
        <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-5 items-start">
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Type" required>
                <Select value={f.integrationType} disabled={!!integration} onChange={(e) => { const t = types.find((x) => x.type === e.target.value); setF((x) => ({ ...x, integrationType: e.target.value, rules: t?.defaultRules ?? x.rules })); }} options={types.map((t) => ({ value: t.type, label: t.label }))} />
              </Field>
              <Field label="Name" required><Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder={type ? `${type.label} – HQ` : 'Name'} /></Field>
              <Field label="Customer" hint={canMulti ? 'Leave empty for a multi-customer source; events are then mapped per rule, CMDB match or manually.' : 'Multi-customer integrations require MSP-wide visibility.'} className="sm:col-span-2">
                <Select value={f.customerId} onChange={(e) => set('customerId', e.target.value)} placeholder={canMulti ? 'Multi-customer (resolve per event)' : 'Select customer…'} options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))} />
              </Field>
              <Field label="Description" className="sm:col-span-2"><Textarea className="min-h-[56px]" value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
              <div className="flex flex-wrap items-center gap-5 sm:col-span-2">
                <Toggle checked={f.autoCreateTickets} onChange={(v) => set('autoCreateTickets', v)} label="Create tickets automatically" />
                <Toggle checked={f.isActive} onChange={(v) => set('isActive', v)} label="Active" />
                {!integration && <Checkbox label="Generate an API key now" checked={f.createApiKey} onChange={(e) => set('createApiKey', e.target.checked)} />}
              </div>
            </div>
            <div>
              <div className="text-[13px] font-semibold mb-2">Correlation & ticket rules</div>
              <RulesEditor value={f.rules} onChange={(r) => set('rules', r)} multiCustomer={multi} integrationType={f.integrationType} />
            </div>
          </div>
          <div className="lg:sticky lg:top-0">
            <DocsPanel type={type} integration={integration} />
          </div>
        </div>
      </Drawer>
      <ApiKeyDialog reveal={reveal?.reveal ?? null} name={reveal?.name ?? ''} webhookUrl={reveal?.webhookUrl} onClose={() => setReveal(null)} />
    </>
  );
}

/** Query options for the adapter catalogue (types, docs, sample payloads). */
export const integrationTypesQuery = () => ({ queryKey: ['integrations', 'types'] as const, queryFn: () => get<{ items: IntegrationType[] }>('/integrations/types'), staleTime: 300_000 });
