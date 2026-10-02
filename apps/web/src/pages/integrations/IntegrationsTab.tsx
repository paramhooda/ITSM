import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, KeyRound, FlaskConical, Power, BookOpen } from 'lucide-react';
import { del, post, patch } from '@/api/client';
import { Button, Badge, EmptyState, ConfirmDialog, Dialog, Textarea, KeyValue, Drawer } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { IntegrationForm, ApiKeyDialog, DocsPanel } from '@/components/integrations/IntegrationForm';
import { SeverityBadge } from '@/components/integrations/SeverityBadge';
import { JsonView } from '@/components/integrations/JsonView';
import { errorMessage, type Integration, type IntegrationType, type ApiKeyReveal, type DryRunResult } from '@/components/integrations/types';
import { TypeIcon } from './EventsTab';

const OUTCOME_COLORS: Record<string, string> = { ticket: 'green', deduplicated: 'purple', recovered: 'green', recovery_noted: 'teal', reopen: 'purple', ignored: 'gray', customer_unresolved: 'red', below_threshold: 'slate', no_ticket: 'slate', info: 'slate', acknowledged: 'teal' };
const OUTCOME_LABELS: Record<string, string> = { ticket: 'Ticket would be created', deduplicated: 'Attach to existing ticket', recovered: 'Resolve existing ticket', recovery_noted: 'Work note on existing ticket', reopen: 'Reopen ticket', ignored: 'Ignored', customer_unresolved: 'Customer unresolved', below_threshold: 'Correlate only (below threshold)', no_ticket: 'Correlate only', info: 'Informational', acknowledged: 'Acknowledgement note' };

function TestDialog({ integration, onClose }: { integration: Integration | null; onClose: () => void }) {
  const [payload, setPayload] = useState('');
  const [result, setResult] = useState<DryRunResult | null>(null);
  const run = useMutation({
    mutationFn: () => {
      let parsed: unknown = undefined;
      if (payload.trim()) {
        try {
          parsed = JSON.parse(payload);
        } catch (e) {
          throw new Error(`Payload is not valid JSON: ${(e as Error).message}`);
        }
      }
      return post<DryRunResult>(`/integrations/${integration!.id}/test`, { payload: parsed });
    },
    onSuccess: setResult,
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={!!integration} onClose={() => { onClose(); setResult(null); setPayload(''); }} title={`Test ${integration?.name ?? ''}`} width="max-w-3xl" footer={<><Button variant="ghost" onClick={() => { onClose(); setResult(null); setPayload(''); }}>Close</Button><Button loading={run.isPending} onClick={() => run.mutate()} icon={<FlaskConical className="h-4 w-4" />}>Run dry-run</Button></>}>
      <div className="text-[13px] text-muted mb-2">Runs the adapter and the correlation rules without storing anything: parsed fields, matched customer / CI and what the pipeline would do. Leave empty to use the sample payload.</div>
      <Textarea className="font-mono text-xs min-h-[120px]" value={payload} onChange={(e) => setPayload(e.target.value)} placeholder={integration ? JSON.stringify({ '…': `sample ${integration.typeLabel} payload is used when empty` }) : ''} />
      {result && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge color={OUTCOME_COLORS[result.outcome] ?? 'slate'} dot>{OUTCOME_LABELS[result.outcome] ?? result.outcome}</Badge>
            <span className="text-[13px] text-muted">{result.note}</span>
            {!result.autoCreateTickets && <Badge color="amber">auto-create off</Badge>}
            {!result.isActive && <Badge color="red">integration disabled</Badge>}
          </div>
          <KeyValue
            columns={3}
            items={[
              { label: 'Severity / status', value: <span className="flex items-center gap-1"><SeverityBadge severity={String(result.event.severity ?? '')} /> <Badge color="slate">{String(result.event.status ?? '')}</Badge></span> },
              { label: 'Host / IP', value: [result.event.host, result.event.ipAddress].filter(Boolean).join(' / ') || '—' },
              { label: 'External id', value: <span className="font-mono text-xs">{String(result.event.externalId ?? '')}</span> },
              { label: 'Customer', value: result.customer ? `${result.customer.name ?? result.customer.id} (via ${result.customer.source})` : <Badge color="amber">unresolved</Badge> },
              { label: 'Configuration item', value: result.ci ? `${result.ci.name} (by ${result.ci.matchedBy}${result.ci.learnRef ? `, learns ${result.ci.learnRef}` : ''})` : <span className="text-muted">no match</span> },
              { label: 'Existing ticket', value: result.existingTicket ? `${result.existingTicket.number} (${result.existingTicket.statusCategory})` : '—' },
              ...(result.ticket ? [
                { label: 'Title', value: result.ticket.title, span: 3 as const },
                { label: 'Priority / category', value: `${result.ticket.priorityKey.toUpperCase()} · ${result.ticket.categoryLabel ?? result.ticket.categoryKey ?? 'no category'} · ${result.ticket.domain.toUpperCase()}` },
                { label: 'Team', value: result.ticket.teamKey ?? 'assignment rules' },
                { label: 'Security severity', value: result.ticket.securitySeverityKey ?? '—' },
              ] : []),
            ]}
          />
          <JsonView value={result.event} maxHeight="max-h-56" />
        </div>
      )}
    </Dialog>
  );
}

export function IntegrationsTab({ integrations, types, loading }: { integrations: Integration[]; types: IntegrationType[]; loading: boolean }) {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const canManage = can('integrations:manage');
  const [form, setForm] = useState<{ open: boolean; integration?: Integration | null }>({ open: false });
  const [reveal, setReveal] = useState<{ reveal: ApiKeyReveal; name: string; webhookUrl: string } | null>(null);
  const [testing, setTesting] = useState<Integration | null>(null);
  const [docs, setDocs] = useState<Integration | null>(null);
  const [deleting, setDeleting] = useState<Integration | null>(null);
  const [rotating, setRotating] = useState<Integration | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['integrations'] });
  const rotate = useMutation({ mutationFn: (i: Integration) => post<ApiKeyReveal>(`/integrations/${i.id}/rotate-key`), onSuccess: (r, i) => { setRotating(null); setReveal({ reveal: r, name: i.name, webhookUrl: i.webhookUrl }); invalidate(); }, onError: (e) => toast.error(errorMessage(e)) });
  const remove = useMutation({ mutationFn: (i: Integration) => del(`/integrations/${i.id}`), onSuccess: () => { toast.success('Integration deleted and key revoked'); setDeleting(null); invalidate(); }, onError: (e) => toast.error(errorMessage(e)) });
  const toggle = useMutation({ mutationFn: (i: Integration) => patch(`/integrations/${i.id}`, { isActive: !i.isActive }), onSuccess: invalidate, onError: (e) => toast.error(errorMessage(e)) });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[13px] text-muted">{integrations.length} {integrations.length === 1 ? 'integration' : 'integrations'} · events arrive on each integration's webhook URL, authenticated with its own API key.</div>
        {canManage && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ open: true, integration: null })}>New integration</Button>}
      </div>
      {!loading && integrations.length === 0 && (
        <div className="card">
          <EmptyState title="No integrations yet" description="Create a PRTG, FortiSIEM or generic webhook integration. You get a webhook URL, an API key and configuration instructions for the external system." action={canManage ? <Button size="sm" onClick={() => setForm({ open: true, integration: null })}>New integration</Button> : undefined} />
        </div>
      )}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {integrations.map((i) => (
          <div key={i.id} className={`card p-4 flex flex-col gap-3 ${!i.isActive ? 'opacity-70' : ''}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2 min-w-0">
                <div className="h-8 w-8 rounded-lg bg-surface-2 flex items-center justify-center shrink-0"><TypeIcon type={i.integrationType} /></div>
                <div className="min-w-0">
                  <div className="font-semibold truncate">{i.name}</div>
                  <div className="text-xs text-muted truncate">{i.typeLabel} · {i.customerName ?? (i.customerId ? 'Customer' : 'Multi-customer')}{i.description ? ` · ${i.description}` : ''}</div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {i.isActive ? <Badge color="green" dot>Active</Badge> : <Badge color="gray">Disabled</Badge>}
                {i.autoCreateTickets ? <Badge color="blue">auto-ticket</Badge> : <Badge color="slate">correlate only</Badge>}
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2 text-center">
              {[
                { label: '24h', value: i.counts?.last24h ?? 0 },
                { label: '7 days', value: i.counts?.last7d ?? 0 },
                { label: 'open tickets', value: i.openTickets ?? 0, tone: (i.openTickets ?? 0) > 0 ? 'text-amber-600' : '' },
                { label: 'errors 7d', value: i.counts?.errors7d ?? 0, tone: (i.counts?.errors7d ?? 0) > 0 ? 'text-red-600' : '' },
              ].map((s) => (
                <div key={s.label} className="rounded-lg bg-surface-2/60 py-1.5">
                  <div className={`text-lg font-semibold leading-tight ${s.tone ?? ''}`}>{s.value}</div>
                  <div className="text-[11px] text-subtle">{s.label}</div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
              <span>Last event: {i.lastEventAt ? <span title={fmtDateTime(i.lastEventAt)}>{relativeTime(i.lastEventAt)}</span> : 'never'}</span>
              <span className="inline-flex items-center gap-1"><KeyRound className="h-3 w-3" /> {i.apiKeyPrefix ? <span className="font-mono">{i.apiKeyPrefix}…</span> : 'no key'}{i.apiKeyRevokedAt && <Badge color="red">revoked</Badge>}</span>
              <span>{i.rules.domain.toUpperCase()} · {i.rules.defaultCategoryKey ?? 'no category'} · dedupe {i.rules.dedupeWindowMinutes} min{i.rules.autoResolve ? ' · auto-resolve' : ''}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1 pt-1 border-t border-default">
              <Button variant="ghost" size="sm" icon={<BookOpen className="h-4 w-4" />} onClick={() => setDocs(i)}>Setup guide</Button>
              {canManage && <Button variant="ghost" size="sm" icon={<FlaskConical className="h-4 w-4" />} onClick={() => setTesting(i)}>Test</Button>}
              {canManage && <Button variant="ghost" size="sm" icon={<Pencil className="h-4 w-4" />} onClick={() => setForm({ open: true, integration: i })}>Edit</Button>}
              {canManage && <Button variant="ghost" size="sm" icon={<KeyRound className="h-4 w-4" />} onClick={() => setRotating(i)}>{i.apiKeyPrefix && !i.apiKeyRevokedAt ? 'Rotate key' : 'Issue key'}</Button>}
              {canManage && <Button variant="ghost" size="sm" icon={<Power className="h-4 w-4" />} loading={toggle.isPending && toggle.variables?.id === i.id} onClick={() => toggle.mutate(i)}>{i.isActive ? 'Disable' : 'Enable'}</Button>}
              {canManage && <Button variant="ghost" size="sm" className="ml-auto text-red-600" icon={<Trash2 className="h-4 w-4" />} onClick={() => setDeleting(i)}>Delete</Button>}
            </div>
          </div>
        ))}
      </div>

      <IntegrationForm open={form.open} onClose={() => setForm({ open: false })} integration={form.integration} types={types} />
      <ApiKeyDialog reveal={reveal?.reveal ?? null} name={reveal?.name ?? ''} webhookUrl={reveal?.webhookUrl} onClose={() => setReveal(null)} />
      <TestDialog integration={testing} onClose={() => setTesting(null)} />
      <Drawer open={!!docs} onClose={() => setDocs(null)} title={docs ? `Setup guide – ${docs.name}` : ''} width="max-w-xl">
        {docs && <DocsPanel type={types.find((t) => t.type === docs.integrationType)} integration={docs} />}
      </Drawer>
      <ConfirmDialog open={!!rotating} onClose={() => setRotating(null)} onConfirm={() => rotating && rotate.mutate(rotating)} loading={rotate.isPending} title={rotating?.apiKeyPrefix && !rotating.apiKeyRevokedAt ? 'Rotate API key?' : 'Issue API key?'} description={rotating?.apiKeyPrefix && !rotating.apiKeyRevokedAt ? `The current key (${rotating.apiKeyPrefix}…) stops working immediately. Update ${rotating?.typeLabel} with the new key afterwards.` : 'A new key scoped to this integration will be generated and shown once.'} confirmLabel={rotating?.apiKeyPrefix && !rotating.apiKeyRevokedAt ? 'Rotate key' : 'Issue key'} danger={!!rotating?.apiKeyPrefix && !rotating.apiKeyRevokedAt} />
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting)} loading={remove.isPending} title={`Delete ${deleting?.name ?? ''}?`} description="The API key is revoked and the external system will receive 401 responses. Stored events and tickets are kept." confirmLabel="Delete integration" danger />
    </div>
  );
}
