import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { TicketPlus, RefreshCw, EyeOff, UserPlus, ExternalLink } from 'lucide-react';
import { get, post } from '@/api/client';
import { Drawer, Button, Badge, KeyValue, LoadingBlock, ErrorBlock, Select, Field, Dialog } from '@/components/ui';
import { useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { SeverityBadge, EventStatusBadge } from './SeverityBadge';
import { ProcessingBadge } from './ProcessingBadge';
import { JsonView } from './JsonView';
import { errorMessage, typeLabel, type EventDetail } from './types';

export function EventDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const customers = useCustomersLookup();
  const q = useQuery({ queryKey: ['integrations', 'event', id], queryFn: () => get<EventDetail>(`/integrations/events/${id}`), enabled: !!id, refetchInterval: (query) => (query.state.data?.processingStatus === 'received' ? 2000 : false) });
  const ev = q.data;
  const [pick, setPick] = useState<null | 'create' | 'assign'>(null);
  const [customerId, setCustomerId] = useState('');
  useEffect(() => setCustomerId(''), [id]);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['integrations'] });
    qc.invalidateQueries({ queryKey: ['tickets'] });
  };
  const act = useMutation({
    mutationFn: ({ action, body }: { action: 'reprocess' | 'ignore' | 'assign-customer' | 'create-ticket'; body?: unknown }) => post<Record<string, unknown>>(`/integrations/events/${id}/${action}`, body),
    onSuccess: (r, v) => {
      const status = (r.processingStatus as string | undefined) ?? ((r.event as { processingStatus?: string } | undefined)?.processingStatus ?? '');
      const note = (r.processingNote as string | undefined) ?? (r.note as string | undefined) ?? '';
      toast.success(v.action === 'create-ticket' ? `${r.created ? 'Created' : 'Attached to'} ${r.ticketNumber}` : `${status.replace(/_/g, ' ')}${note ? ` – ${note}` : ''}`);
      setPick(null);
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const needsCustomer = !!ev && !ev.customerId && !ev.integrationCustomerId;
  const canCreate = !!ev && !ev.ticketId && ev.processingStatus !== 'received' && can('tickets:create');

  return (
    <Drawer open={!!id} onClose={onClose} title={ev ? <span className="flex items-center gap-2">{typeLabel(ev.integrationType)} event <ProcessingBadge status={ev.processingStatus} title={ev.processingNote ?? undefined} /></span> : 'Event'} width="max-w-2xl">
      {q.isLoading && <LoadingBlock />}
      {q.error && <ErrorBlock error={q.error} retry={() => q.refetch()} />}
      {ev && (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-default p-3">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <SeverityBadge severity={ev.severity} />
              <EventStatusBadge status={ev.status} />
              <span className="font-mono text-xs text-muted">{ev.eventType}</span>
              <span className="text-xs text-subtle ml-auto" title={fmtDateTime(ev.receivedAt)}>received {relativeTime(ev.receivedAt)}</span>
            </div>
            <div className="text-[13.5px] font-medium break-words">{ev.message}</div>
            {ev.processingNote && <div className={`text-xs mt-1 ${ev.processingStatus === 'error' ? 'text-red-600' : 'text-muted'}`}>{ev.processingNote}</div>}
          </div>

          <div className="flex flex-wrap gap-2">
            {canCreate && <Button size="sm" icon={<TicketPlus className="h-4 w-4" />} loading={act.isPending && act.variables?.action === 'create-ticket'} onClick={() => (needsCustomer ? setPick('create') : act.mutate({ action: 'create-ticket', body: {} }))}>Create ticket</Button>}
            {!ev.integrationCustomerId && !ev.ticketId && <Button size="sm" variant="outline" icon={<UserPlus className="h-4 w-4" />} onClick={() => setPick('assign')}>{ev.customerId ? 'Change customer' : 'Assign customer'}</Button>}
            <Button size="sm" variant="outline" icon={<RefreshCw className="h-4 w-4" />} loading={act.isPending && act.variables?.action === 'reprocess'} onClick={() => act.mutate({ action: 'reprocess' })}>Reprocess</Button>
            {ev.processingStatus !== 'ignored' && !ev.ticketId && <Button size="sm" variant="ghost" icon={<EyeOff className="h-4 w-4" />} loading={act.isPending && act.variables?.action === 'ignore'} onClick={() => act.mutate({ action: 'ignore' })}>Ignore</Button>}
          </div>

          <KeyValue
            columns={2}
            items={[
              { label: 'Integration', value: ev.integrationName ?? '—' },
              { label: 'Customer', value: ev.customerName ?? (ev.customerId ? ev.customerId : <Badge color="amber">unresolved</Badge>) },
              { label: 'Host / IP', value: [ev.host, ev.ipAddress].filter(Boolean).join(' / ') || '—' },
              { label: 'Sensor / rule', value: ev.sensor ?? '—' },
              { label: 'External id', value: <span className="font-mono text-xs">{ev.externalId}</span> },
              { label: 'Occurred', value: ev.normalized?.occurredAt ? fmtDateTime(ev.normalized.occurredAt) : '—' },
              { label: 'Configuration item', value: ev.matchedCiId ? <Link className="text-brand-600 hover:underline inline-flex items-center gap-1" to={`/cmdb/cis/${ev.matchedCiId}`}>{ev.ciName ?? 'CI'} <ExternalLink className="h-3 w-3" /></Link> : <span className="text-muted">not matched</span> },
              { label: 'Ticket', value: ev.ticket ? <Link className="text-brand-600 hover:underline inline-flex items-center gap-1" to={`/tickets/${ev.ticket.id}`}>{ev.ticket.number} <Badge color={ev.ticket.statusColor ?? undefined}>{ev.ticket.statusLabel}</Badge></Link> : <span className="text-muted">none</span> },
              { label: 'Processed', value: ev.processedAt ? fmtDateTime(ev.processedAt) : <span className="text-muted">pending</span> },
              { label: 'Tags', value: ev.normalized?.tags?.length ? <span className="flex flex-wrap gap-1">{ev.normalized.tags.map((t) => <Badge key={t} color="slate">{t}</Badge>)}</span> : '—' },
              ...(ev.normalized?.group || ev.normalized?.probe ? [{ label: 'Group / probe', value: [ev.normalized?.group, ev.normalized?.probe].filter(Boolean).join(' / ') }] : []),
              ...(ev.normalized?.monitoringRef || ev.normalized?.siemRef ? [{ label: 'Reference', value: <span className="font-mono text-xs">{ev.normalized?.monitoringRef ?? ev.normalized?.siemRef}</span> }] : []),
            ]}
          />

          <div>
            <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium mb-1">Payload</div>
            <JsonView value={ev.payload} />
          </div>
          <div className="text-xs text-subtle font-mono">{ev.id}</div>
        </div>
      )}

      <Dialog open={!!pick} onClose={() => setPick(null)} title={pick === 'create' ? 'Create ticket' : 'Assign customer'} width="max-w-md" footer={<><Button variant="ghost" onClick={() => setPick(null)}>Cancel</Button><Button disabled={!customerId} loading={act.isPending} onClick={() => act.mutate(pick === 'create' ? { action: 'create-ticket', body: { customerId } } : { action: 'assign-customer', body: { customerId } })}>{pick === 'create' ? 'Create ticket' : 'Assign & reprocess'}</Button></>}>
        <Field label="Customer" required hint={pick === 'assign' ? 'The event is reprocessed for this customer: CI correlation, dedupe and ticket rules apply.' : 'The ticket is created for this customer using the integration rules.'}>
          <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="Select customer…" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))} />
        </Field>
      </Dialog>
    </Drawer>
  );
}
