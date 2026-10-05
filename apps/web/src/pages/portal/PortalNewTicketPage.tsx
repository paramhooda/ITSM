import { useEffect, useMemo, useState, type ClipboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ClipboardList, ChevronLeft, Send, Search, ShieldCheck, Clock } from 'lucide-react';
import { PageHeader, Button, Card, Field, Input, Textarea, Select, Badge, LoadingBlock } from '@/components/ui';
import { useLookups } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { cn } from '@/lib/utils';
import { CatalogForm } from '@/components/tickets/CatalogForm';
import { KbSuggestions } from '@/components/knowledge/KbSuggestions';
import { KnownErrorSuggestions } from '@/components/known-errors/KnownErrorSuggestions';
import { portalApi, pk, type PortalCatalogItem } from '@/components/portal/api';
import { FilePicker, pastedFiles } from '@/components/attachments/FilePicker';
import { addFiles, uploadAttachments, reportUploadFailures } from '@/components/attachments/upload';

type Kind = 'issue' | 'request';

const IMPACT_HINT: Record<string, string> = { high: 'Everyone, or a whole site, is affected', medium: 'A team or several people are affected', low: 'Only I am affected' };
const URGENCY_HINT: Record<string, string> = { high: 'Work has stopped — I need this now', medium: 'It is slowing us down', low: 'It can wait a few days' };

const plain = (label: string, hints: Record<string, string>, key: string) => hints[key] ?? label;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Prefill parameters (from the assistant or a link): ids must be well formed, text is capped. */
const idParam = (v: string | null) => (v && UUID.test(v) ? v : '');
const textParam = (v: string | null, max: number) => (v ?? '').slice(0, max);

export default function PortalNewTicketPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const can = useAuthStore((s) => s.can);
  const kind = (search.get('kind') as Kind) || (search.get('type') === 'request' ? 'request' : 'issue');
  const setKind = (k: Kind) => setSearch(k === 'issue' ? {} : { kind: k }, { replace: true });
  const { options } = useLookups();

  const me = useQuery({ queryKey: pk.me, queryFn: portalApi.me, staleTime: 5 * 60_000 });
  const services = useQuery({ queryKey: pk.services, queryFn: portalApi.services, staleTime: 5 * 60_000, enabled: can('portal:contracts') });
  const catalog = useQuery({ queryKey: pk.catalog, queryFn: portalApi.catalog, staleTime: 5 * 60_000, enabled: kind === 'request' });
  const canDevices = can('portal:assets');
  const assets = useQuery({ queryKey: pk.assets({ picker: true }), queryFn: () => portalApi.assets({ pageSize: 200, sort: 'name', order: 'asc' }), enabled: canDevices && kind === 'issue', staleTime: 5 * 60_000 });
  const cis = useQuery({ queryKey: pk.cis({ picker: true }), queryFn: () => portalApi.cis({ pageSize: 200, sort: 'name', order: 'asc' }), enabled: canDevices && kind === 'issue', staleTime: 5 * 60_000 });

  // ---- issue form
  const [title, setTitle] = useState(() => textParam(search.get('title'), 300));
  const [description, setDescription] = useState(() => textParam(search.get('description'), 20000));
  const [siteId, setSiteId] = useState(() => idParam(search.get('siteId')));
  const [serviceId, setServiceId] = useState(() => idParam(search.get('serviceId')));
  const [impactId, setImpactId] = useState('');
  const [urgencyId, setUrgencyId] = useState('');
  const [device, setDevice] = useState('');
  // ---- request form
  const [itemQ, setItemQ] = useState('');
  const [itemId, setItemId] = useState(() => idParam(search.get('catalogItemId')));
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [reqSummary, setReqSummary] = useState('');
  const [reqNotes, setReqNotes] = useState(() => (search.get('type') === 'request' || search.get('kind') === 'request' ? textParam(search.get('description'), 20000) : ''));
  // Screenshots and files chosen now go onto the ticket as soon as it is raised.
  const [files, setFiles] = useState<File[]>([]);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const pasteFiles = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const fs = pastedFiles(e);
    if (fs.length) {
      e.preventDefault();
      setFiles((cur) => addFiles(cur, fs));
    }
  };

  const sites = me.data?.sites ?? [];
  useEffect(() => {
    if (!siteId && sites.length === 1) setSiteId(sites[0].id);
  }, [sites, siteId]);
  const coveredServices = services.data?.services ?? [];
  const item = useMemo(() => (catalog.data?.items ?? []).find((i) => i.id === itemId) ?? null, [catalog.data, itemId]);
  useEffect(() => {
    setFormData({});
    setReqSummary(item ? item.name : '');
    if (item?.serviceId) setServiceId(item.serviceId);
  }, [item]);

  const impacts = options('ticket_impact');
  const urgencies = options('ticket_urgency');
  const devices = useMemo(() => {
    const a = (assets.data?.items ?? []).map((x) => ({ value: `asset:${x.id}`, label: `${x.name} (${x.tag})${x.siteName ? ` · ${x.siteName}` : ''}` }));
    const c = (cis.data?.items ?? []).map((x) => ({ value: `ci:${x.id}`, label: `${x.name}${x.hostname ? ` · ${x.hostname}` : x.ipAddress ? ` · ${x.ipAddress}` : ''}` }));
    return [...a, ...c];
  }, [assets.data, cis.data]);

  const create = useMutation({
    mutationFn: async () => {
      const t = await raise();
      let attached = 0;
      if (files.length) {
        const r = await uploadAttachments(files, { entityType: 'ticket', entityId: t.id, customerVisible: true }, (done, total, name) => setUploadNote(name ? `Uploading ${done + 1}/${total}…` : null));
        reportUploadFailures(r);
        attached = r.ok.length;
      }
      return { ticket: t, attached };
    },
    onSuccess: ({ ticket: t, attached }) => {
      toast.success(`${t.number} raised. We will keep you posted here.`, { description: attached ? `${attached} file${attached === 1 ? '' : 's'} attached.` : 'You can add screenshots or files on the ticket page.' });
      navigate(`/portal/tickets/${t.id}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  function raise() {
    if (kind === 'issue') {
      return portalApi.createTicket({
        type: 'incident',
        title: title.trim(),
        description: description.trim() || null,
        siteId: siteId || null,
        serviceId: serviceId || null,
        impactId: impactId || null,
        urgencyId: urgencyId || null,
        assetId: device.startsWith('asset:') ? device.slice(6) : null,
        ciId: device.startsWith('ci:') ? device.slice(3) : null,
      });
    }
    return portalApi.createTicket({ type: 'request', title: reqSummary.trim(), description: reqNotes.trim() || null, siteId: siteId || null, catalogItemId: itemId || null, formData, serviceId: item?.serviceId ?? (serviceId || null) });
  }

  const issueValid = title.trim().length >= 3;
  const requestValid = !!item && reqSummary.trim().length >= 3 && (item.formSchema ?? []).every((f) => !f.required || (formData[f.key] !== undefined && formData[f.key] !== '' && formData[f.key] !== null));
  const valid = kind === 'issue' ? issueValid : requestValid;

  const items = (catalog.data?.items ?? []).filter((i) => !itemQ.trim() || `${i.name} ${i.description ?? ''} ${i.categoryLabel ?? ''}`.toLowerCase().includes(itemQ.trim().toLowerCase()));
  const grouped = useMemo(() => {
    const m = new Map<string, PortalCatalogItem[]>();
    for (const i of items) {
      const k = i.categoryLabel ?? 'Other requests';
      m.set(k, [...(m.get(k) ?? []), i]);
    }
    return [...m.entries()];
  }, [items]);

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Raise a ticket"
        breadcrumb={
          <button className="inline-flex items-center gap-1 hover:underline" onClick={() => navigate('/portal/tickets')}>
            <ChevronLeft className="h-3 w-3" /> My tickets
          </button>
        }
        subtitle="Tell us what you need. We confirm every ticket by e-mail and track it to a target."
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
        <button onClick={() => setKind('issue')} className={cn('card text-left px-4 py-3 transition-colors', kind === 'issue' ? 'border-brand-500 ring-2 ring-brand-500/20' : 'hover:border-brand-300')}>
          <div className="flex items-center gap-2 font-medium">
            <span className="h-7 w-7 rounded-md bg-red-100 text-red-700 flex items-center justify-center">
              <AlertTriangle className="h-4 w-4" />
            </span>
            Report an issue
          </div>
          <div className="text-[12.5px] text-muted mt-1">Something is broken, slow or not working as expected.</div>
        </button>
        <button onClick={() => setKind('request')} className={cn('card text-left px-4 py-3 transition-colors', kind === 'request' ? 'border-brand-500 ring-2 ring-brand-500/20' : 'hover:border-brand-300')}>
          <div className="flex items-center gap-2 font-medium">
            <span className="h-7 w-7 rounded-md bg-blue-100 text-blue-700 flex items-center justify-center">
              <ClipboardList className="h-4 w-4" />
            </span>
            Request something
          </div>
          <div className="text-[12.5px] text-muted mt-1">Access, a new user, equipment, a change or scheduled work.</div>
        </button>
      </div>

      {kind === 'issue' ? (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 items-start">
          <Card title="What is wrong?">
            <div className="flex flex-col gap-3">
              <Field label="Summary" required hint="One line, as you would say it to the service desk.">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Internet is down at the Pune office" autoFocus maxLength={300} />
              </Field>
              <Field label="Details" hint="What happened, since when, what you already tried, who is affected.">
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-[120px]" onPaste={pasteFiles} />
              </Field>
              <Field label="Screenshots or files" hint="Optional · a screenshot pasted into the details box is attached too.">
                <FilePicker files={files} onChange={setFiles} disabled={create.isPending} />
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Site">
                  <Select value={siteId} onChange={(e) => setSiteId(e.target.value)} placeholder={sites.length ? 'Select site…' : 'No sites on record'} options={sites.map((s) => ({ value: s.id, label: s.name }))} />
                </Field>
                <Field label="Service" hint={coveredServices.length ? 'Optional — helps route the ticket to the right team.' : undefined}>
                  <Select value={serviceId} onChange={(e) => setServiceId(e.target.value)} placeholder="Not sure / general" options={coveredServices.map((s) => ({ value: s.id, label: s.name }))} />
                </Field>
                <Field label="Who is affected?">
                  <Select value={impactId} onChange={(e) => setImpactId(e.target.value)} placeholder="Select…" options={impacts.map((o) => ({ value: o.id, label: plain(o.label, IMPACT_HINT, o.key) }))} />
                </Field>
                <Field label="How urgent is it?">
                  <Select value={urgencyId} onChange={(e) => setUrgencyId(e.target.value)} placeholder="Select…" options={urgencies.map((o) => ({ value: o.id, label: plain(o.label, URGENCY_HINT, o.key) }))} />
                </Field>
                {canDevices && (
                  <Field label="Affected device" hint="Optional" className="sm:col-span-2">
                    <Select value={device} onChange={(e) => setDevice(e.target.value)} placeholder={devices.length ? 'Pick a device or system…' : 'No devices on record'} options={devices} />
                  </Field>
                )}
              </div>
            </div>
          </Card>
          <div className="flex flex-col gap-3">
            <KnownErrorSuggestions q={title} serviceId={serviceId || null} title="Known issues with a workaround" />
            <KbSuggestions q={title} serviceId={serviceId || null} title="This might help right away" />
            <Card title="What happens next">
              <ul className="text-[12.5px] text-muted flex flex-col gap-2">
                <li className="flex gap-2">
                  <Clock className="h-4 w-4 text-subtle shrink-0" /> Your ticket gets a priority and response targets from your contract.
                </li>
                <li className="flex gap-2">
                  <ShieldCheck className="h-4 w-4 text-subtle shrink-0" /> An engineer picks it up and keeps you updated here and by e-mail.
                </li>
                <li className="flex gap-2">
                  <Send className="h-4 w-4 text-subtle shrink-0" /> Reply on the ticket any time; attach screenshots or files now or later.
                </li>
              </ul>
            </Card>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 items-start">
          <div className="flex flex-col gap-4">
            {!item ? (
              <Card title="What would you like to request?" actions={<div className="relative w-56"><Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-subtle" /><input className="input pl-8 h-8 py-0 text-[13px]" placeholder="Filter…" value={itemQ} onChange={(e) => setItemQ(e.target.value)} /></div>}>
                {catalog.isLoading ? (
                  <LoadingBlock />
                ) : grouped.length === 0 ? (
                  <div className="text-[13px] text-muted">No request types match. Clear the filter or report an issue instead.</div>
                ) : (
                  <div className="flex flex-col gap-4">
                    {grouped.map(([group, list]) => (
                      <div key={group}>
                        <div className="text-[11.5px] uppercase tracking-wide text-subtle font-semibold mb-2">{group}</div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {list.map((i) => (
                            <button key={i.id} onClick={() => setItemId(i.id)} className="card text-left px-3 py-2.5 hover:border-brand-400 transition-colors">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-[13px]">{i.name}</span>
                                {i.requiresApproval && <Badge color="purple" className="py-0 text-[10.5px]">Needs approval</Badge>}
                              </div>
                              {i.description && <div className="text-[12px] text-muted mt-0.5 line-clamp-2">{i.description}</div>}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            ) : (
              <Card
                title={item.name}
                actions={
                  <Button size="sm" variant="ghost" onClick={() => setItemId('')}>
                    Choose another
                  </Button>
                }
              >
                {item.description && <div className="text-[13px] text-muted mb-3">{item.description}</div>}
                {item.requiresApproval && (
                  <div className="mb-3 rounded-md bg-purple-50 text-purple-800 text-[12.5px] px-3 py-2">This request needs approval from one of your organisation&apos;s administrators before we start work.</div>
                )}
                <div className="flex flex-col gap-3">
                  <Field label="Summary" required>
                    <Input value={reqSummary} onChange={(e) => setReqSummary(e.target.value)} maxLength={300} />
                  </Field>
                  <CatalogForm schema={item.formSchema ?? []} value={formData} onChange={setFormData} />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label="Site">
                      <Select value={siteId} onChange={(e) => setSiteId(e.target.value)} placeholder={sites.length ? 'Select site…' : 'No sites on record'} options={sites.map((s) => ({ value: s.id, label: s.name }))} />
                    </Field>
                  </div>
                  <Field label="Anything else we should know?">
                    <Textarea value={reqNotes} onChange={(e) => setReqNotes(e.target.value)} onPaste={pasteFiles} />
                  </Field>
                  <Field label="Screenshots or files" hint="Optional">
                    <FilePicker files={files} onChange={setFiles} disabled={create.isPending} />
                  </Field>
                </div>
              </Card>
            )}
          </div>
          <Card title="How requests work">
            <ul className="text-[12.5px] text-muted flex flex-col gap-2">
              <li className="flex gap-2">
                <ClipboardList className="h-4 w-4 text-subtle shrink-0" /> Pick a request type; the form asks only for what we need.
              </li>
              <li className="flex gap-2">
                <ShieldCheck className="h-4 w-4 text-subtle shrink-0" /> Some requests are approved by your own administrators first.
              </li>
              <li className="flex gap-2">
                <Clock className="h-4 w-4 text-subtle shrink-0" /> You can follow progress and reply on the ticket page.
              </li>
            </ul>
          </Card>
        </div>
      )}

      <div className="sticky bottom-0 mt-4 -mx-4 md:-mx-5 px-4 md:px-5 py-3 bg-surface/90 backdrop-blur border-t border-default flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => navigate('/portal/tickets')}>
          Cancel
        </Button>
        <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!valid} icon={<Send className="h-4 w-4" />}>
          {uploadNote ?? (kind === 'issue' ? 'Report issue' : 'Submit request')}
        </Button>
      </div>
    </div>
  );
}
