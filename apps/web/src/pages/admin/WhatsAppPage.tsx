import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Copy, MessageCircle, RefreshCw, RotateCcw, Send, ShieldAlert, Stethoscope, CheckCircle2, AlertTriangle, XCircle, Loader2 } from 'lucide-react';
import { get, post, put, ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { Badge, Button, Card, Field, Input, Toggle, type Column } from '@/components/ui';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, MutedCell, MonoCell } from '@/components/admin/ConfigTable';
import { fmtDateTime, relativeTime, titleCase } from '@/lib/format';

interface Setting {
  key: string;
  value: unknown;
}
interface Status {
  enabled: boolean;
  configured: boolean;
  phoneNumberId: string;
  businessAccountId: string;
  apiVersion: string;
  defaultCountryCode: string;
  templates: Record<string, { name: string; language?: string; params?: string[] } | undefined>;
  missing: string[];
  /** The URL to register in Meta: the override when one is saved, otherwise the platform URL. */
  webhookUrl: string;
  webhookUrlDefault: string;
  webhookUrlIsCustom: boolean;
  hasOptIns: boolean;
  /** Active rules whose event has a WhatsApp text but whose channels leave WhatsApp out. */
  rulesWithoutWhatsApp: { id: string; event: string; name: string }[];
}
interface OutboxRow {
  id: string;
  channel: string;
  recipient: string;
  subject: string | null;
  status: string;
  deliveryStatus: string | null;
  providerMessageId: string | null;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
  event: string | null;
}

/** Event groups a template can be mapped to; anything else falls back to `default`. */
const GROUPS: { key: string; label: string; hint: string }[] = [
  { key: 'default', label: 'Default', hint: 'Used for every event without its own mapping' },
  { key: 'ticket', label: 'Ticket updates', hint: 'created, assigned, status, comments, resolved, closed, escalated' },
  { key: 'sla', label: 'SLA warnings and breaches', hint: 'sla.warning, sla.breached' },
  { key: 'incident', label: 'Major incident updates', hint: 'stakeholder updates during a major incident' },
  { key: 'page', label: 'On-call pages', hint: 'alerts to the engineer on call' },
  { key: 'handover', label: 'Shift handover', hint: 'handover published to the incoming shift' },
  { key: 'briefing', label: 'Daily briefing', hint: 'the morning digest' },
];
const PARAM_SOURCES = ['subject', 'text', 'link', 'event'];
const STATUS_COLOR: Record<string, string> = { pending: 'amber', sending: 'blue', sent: 'green', failed: 'red', cancelled: 'gray' };
const DELIVERY_COLOR: Record<string, string> = { accepted: 'slate', sent: 'blue', delivered: 'green', read: 'green', failed: 'red' };

const KEYS = {
  enabled: 'whatsapp.enabled',
  phoneNumberId: 'whatsapp.phone_number_id',
  businessAccountId: 'whatsapp.business_account_id',
  accessToken: 'whatsapp.access_token.secret',
  appSecret: 'whatsapp.app.secret',
  verifyToken: 'whatsapp.verify_token.secret',
  apiVersion: 'whatsapp.api_version',
  countryCode: 'whatsapp.default_country_code',
  templates: 'whatsapp.templates',
  webhookUrl: 'whatsapp.webhook_url',
} as const;

const WEBHOOK_PATH = '/api/webhooks/whatsapp';
/** An origin on its own (`https://abcd.ngrok-free.app`) becomes the full webhook route; anything else is kept as typed. */
function normaliseWebhookUrl(value: string): string {
  const raw = value.trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.pathname === '/' || u.pathname === '') u.pathname = WEBHOOK_PATH;
    return u.toString();
  } catch {
    return raw;
  }
}

type TemplateRow = { name: string; language: string; params: string };
type TestResult = { ok: boolean; to: string; template: string; providerMessageId: string | null; outboxId: string; note: string | null };
type TestStatus = { id: string; recipient: string; status: string; deliveryStatus: string | null; lastError: string | null; providerMessageId: string | null; sentAt: string | null };
type Finding = { level: 'ok' | 'warn' | 'error'; text: string };
const FINDING_ICON = { ok: CheckCircle2, warn: AlertTriangle, error: XCircle } as const;
const FINDING_TONE = { ok: 'text-emerald-600', warn: 'text-amber-600', error: 'text-red-600' } as const;
const DELIVERY_LABEL: Record<string, string> = { accepted: 'Accepted by Meta, waiting for the delivery state…', sent: 'Sent: left Meta, not yet on the phone', delivered: 'Delivered to the phone', read: 'Read on the phone', failed: 'Failed' };
/** How long the page waits for a delivery callback before saying none came. */
const TRACK_MS = 120_000;

/**
 * Administration > WhatsApp: the one place WhatsApp is configured. Everyone else only
 * adds a mobile number and ticks "WhatsApp notifications" on their profile.
 */
export default function WhatsAppPage() {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const canWrite = can('admin:system');
  const settingsQ = useQuery({ queryKey: ['config', 'settings'], queryFn: () => get<Setting[]>('/config/settings') });
  const statusQ = useQuery({ queryKey: ['notifications', 'whatsapp', 'status'], queryFn: () => get<Status>('/notifications/whatsapp/status') });
  const outboxQ = useQuery({ queryKey: ['notifications', 'outbox', 'whatsapp'], queryFn: () => get<{ byStatus: Record<string, number>; recent: OutboxRow[] }>('/notifications/outbox', { channel: 'whatsapp', limit: 50 }), refetchInterval: 30_000 });

  const [form, setForm] = useState({ enabled: false, phoneNumberId: '', businessAccountId: '', accessToken: '', appSecret: '', verifyToken: '', apiVersion: 'v21.0', countryCode: '91', webhookUrl: '' });
  const [templates, setTemplates] = useState<Record<string, TemplateRow>>({});
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    // The webhook field shows the effective URL, so wait for the status too (or give up on it when it fails).
    if (!settingsQ.data || loaded || (!statusQ.data && !statusQ.isError)) return;
    const value = (k: string) => settingsQ.data?.find((s) => s.key === k)?.value;
    const t = (value(KEYS.templates) ?? {}) as Record<string, { name?: string; language?: string; params?: string[] } | undefined>;
    setForm({
      enabled: value(KEYS.enabled) === true,
      phoneNumberId: String(value(KEYS.phoneNumberId) ?? ''),
      businessAccountId: String(value(KEYS.businessAccountId) ?? ''),
      accessToken: String(value(KEYS.accessToken) ?? ''),
      appSecret: String(value(KEYS.appSecret) ?? ''),
      verifyToken: String(value(KEYS.verifyToken) ?? ''),
      apiVersion: String(value(KEYS.apiVersion) ?? 'v21.0'),
      countryCode: String(value(KEYS.countryCode) ?? '91'),
      webhookUrl: String(value(KEYS.webhookUrl) ?? '').trim() || statusQ.data?.webhookUrlDefault || '',
    });
    setTemplates(Object.fromEntries(GROUPS.map((g) => [g.key, { name: t[g.key]?.name ?? '', language: t[g.key]?.language ?? 'en', params: (t[g.key]?.params ?? (g.key === 'default' ? ['subject', 'text', 'link'] : [])).join(', ') }])));
    setLoaded(true);
  }, [settingsQ.data, statusQ.data, statusQ.isError, loaded]);

  /** What the page shows, copies and saves: the field normalised, or the platform URL while the field is empty. */
  const webhookUrl = normaliseWebhookUrl(form.webhookUrl) || statusQ.data?.webhookUrlDefault || '';
  const webhookIsDefault = !statusQ.data || webhookUrl === statusQ.data.webhookUrlDefault;
  const save = useMutation({
    mutationFn: () => {
      const tpl: Record<string, { name: string; language: string; params: string[] }> = {};
      for (const g of GROUPS) {
        const row = templates[g.key];
        if (!row?.name.trim()) continue;
        const params = row.params.split(',').map((p) => p.trim()).filter((p) => PARAM_SOURCES.includes(p));
        // an empty list is kept as is: the template has no placeholders (Meta's hello_world, for example)
        tpl[g.key] = { name: row.name.trim(), language: row.language.trim() || 'en', params };
      }
      return put('/config/settings', {
        [KEYS.enabled]: form.enabled,
        [KEYS.phoneNumberId]: form.phoneNumberId.trim(),
        [KEYS.businessAccountId]: form.businessAccountId.trim(),
        [KEYS.accessToken]: form.accessToken,
        [KEYS.appSecret]: form.appSecret,
        [KEYS.verifyToken]: form.verifyToken,
        [KEYS.apiVersion]: form.apiVersion.trim() || 'v21.0',
        [KEYS.countryCode]: form.countryCode.replace(/\D/g, '') || '91',
        [KEYS.templates]: tpl,
        // Equal to the platform URL means no override, so a later APP_URL change still flows through.
        [KEYS.webhookUrl]: webhookIsDefault ? '' : webhookUrl,
      });
    },
    onSuccess: () => {
      toast.success('WhatsApp settings saved');
      qc.invalidateQueries({ queryKey: ['config', 'settings'] });
      qc.invalidateQueries({ queryKey: ['notifications', 'whatsapp'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save'),
  });

  const [testTo, setTestTo] = useState('');
  const [tracking, setTracking] = useState<{ id: string; startedAt: number } | null>(null);
  const test = useMutation({
    mutationFn: () => post<TestResult>('/notifications/whatsapp/test', { to: testTo }),
    onSuccess: (r) => {
      toast.success(`Meta accepted "${r.template}" for ${r.to}`, { description: 'Watching for the delivery state below' });
      if (r.note) toast.warning(r.note, { duration: 12_000 });
      setTracking({ id: r.outboxId, startedAt: Date.now() });
      qc.invalidateQueries({ queryKey: ['notifications', 'outbox', 'whatsapp'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Test failed'),
  });
  const track = useQuery({
    queryKey: ['notifications', 'whatsapp', 'test', tracking?.id],
    queryFn: () => get<TestStatus>(`/notifications/whatsapp/test/${tracking!.id}`),
    enabled: !!tracking,
    refetchInterval: (q) => {
      const d = q.state.data?.deliveryStatus;
      if (!tracking || d === 'delivered' || d === 'read' || d === 'failed') return false;
      return Date.now() - tracking.startedAt > TRACK_MS ? false : 3000;
    },
  });
  const trackTimedOut = !!tracking && Date.now() - tracking.startedAt > TRACK_MS && !['delivered', 'read', 'failed'].includes(track.data?.deliveryStatus ?? '');
  const enableRules = useMutation({
    mutationFn: () => post<{ updated: number; rules: { event: string }[] }>('/notifications/whatsapp/enable-rules', {}),
    onSuccess: (r) => {
      toast.success(r.updated ? `WhatsApp added to ${r.updated} rule${r.updated === 1 ? '' : 's'}` : 'Every rule already lists WhatsApp');
      qc.invalidateQueries({ queryKey: ['notifications', 'whatsapp'] });
      qc.invalidateQueries({ queryKey: ['config', 'notification-rules'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update the rules'),
  });
  const check = useMutation({
    mutationFn: () => post<{ checkedAt: string; findings: Finding[]; phone: Record<string, unknown> | null }>('/notifications/whatsapp/check', {}),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Check failed'),
  });

  const status = statusQ.data;
  const copyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      toast.success('Webhook URL copied');
    } catch {
      toast.error('Copy the URL manually');
    }
  };
  const outboxColumns = useMemo<Column<OutboxRow>[]>(
    () => [
      { key: 'createdAt', header: 'Queued', render: (r) => <MutedCell><span title={fmtDateTime(r.createdAt)}>{relativeTime(r.createdAt)}</span></MutedCell> },
      { key: 'recipient', header: 'Number', render: (r) => <MonoCell>{r.recipient}</MonoCell> },
      { key: 'subject', header: 'Message', render: (r) => <div className="min-w-0"><div className="truncate max-w-md">{r.subject ?? '—'}</div>{r.event && <MonoCell>{r.event}</MonoCell>}</div> },
      { key: 'status', header: 'Status', render: (r) => <Badge color={STATUS_COLOR[r.status] ?? 'slate'} dot>{titleCase(r.status)}</Badge> },
      { key: 'deliveryStatus', header: 'Delivery', render: (r) => (r.deliveryStatus ? <Badge color={DELIVERY_COLOR[r.deliveryStatus] ?? 'slate'}>{titleCase(r.deliveryStatus)}</Badge> : <MutedCell>—</MutedCell>) },
      { key: 'lastError', header: 'Error', render: (r) => (r.lastError ? <span className="text-[12px] text-red-600 break-all">{r.lastError}</span> : <MutedCell>—</MutedCell>) },
    ],
    [],
  );

  return (
    <div>
      <SectionHeader
        title="WhatsApp"
        description="Configure the WhatsApp Business account once. People then add a mobile number on their profile and tick WhatsApp notifications."
        actions={
          <span className="inline-flex items-center gap-2">
            {status && (status.configured ? <Badge color={status.enabled ? 'green' : 'amber'} dot>{status.enabled ? 'Enabled' : 'Configured, not enabled'}</Badge> : <Badge color="slate" dot>Not configured</Badge>)}
            <Button variant="outline" icon={<RefreshCw className="h-4 w-4" />} onClick={() => { statusQ.refetch(); outboxQ.refetch(); }} loading={statusQ.isFetching}>Refresh</Button>
          </span>
        }
      />
      {status && status.missing.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900 flex items-start gap-2">
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <div>Still needed: {status.missing.join(', ')}.</div>
        </div>
      )}
      {status && status.rulesWithoutWhatsApp.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900 flex flex-wrap items-start gap-2" data-testid="whatsapp-rules-warning">
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{status.rulesWithoutWhatsApp.length} notification rule{status.rulesWithoutWhatsApp.length === 1 ? '' : 's'} never send WhatsApp.</div>
            <div className="mt-0.5">A rule decides the channels of an event; the opt-in only decides who. These rules deliver by email and in-app only: {[...new Set(status.rulesWithoutWhatsApp.map((r) => r.event))].join(', ')}. Add the channel here, or tick WhatsApp per rule under Notification rules.</div>
          </div>
          <Button size="sm" onClick={() => enableRules.mutate()} loading={enableRules.isPending} disabled={!can('admin:config')}>Add WhatsApp to these rules</Button>
        </div>
      )}

      <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_360px] gap-4 items-start">
        <div className="flex flex-col gap-4">
          <Card title="Connection" actions={<Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Send WhatsApp notifications" />}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Phone number id" required hint="WhatsApp Manager › API setup">
                <Input value={form.phoneNumberId} onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })} disabled={!canWrite} placeholder="1234567890123456" />
              </Field>
              <Field label="WhatsApp Business Account id" hint="For reference only">
                <Input value={form.businessAccountId} onChange={(e) => setForm({ ...form, businessAccountId: e.target.value })} disabled={!canWrite} />
              </Field>
              <Field label="Access token" required hint="A permanent system-user token with whatsapp_business_messaging">
                <Input type="password" value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.target.value })} disabled={!canWrite} autoComplete="off" />
              </Field>
              <Field label="App secret" hint="Lets the platform verify delivery callbacks from Meta">
                <Input type="password" value={form.appSecret} onChange={(e) => setForm({ ...form, appSecret: e.target.value })} disabled={!canWrite} autoComplete="off" />
              </Field>
              <Field label="Webhook verify token" hint="Any phrase; enter the same one when subscribing the webhook in Meta">
                <Input type="password" value={form.verifyToken} onChange={(e) => setForm({ ...form, verifyToken: e.target.value })} disabled={!canWrite} autoComplete="off" />
              </Field>
              <Field label="Default country code" hint="Assumed for ten-digit numbers">
                <Input value={form.countryCode} onChange={(e) => setForm({ ...form, countryCode: e.target.value })} disabled={!canWrite} className="w-28" />
              </Field>
              <Field label="Graph API version">
                <Input value={form.apiVersion} onChange={(e) => setForm({ ...form, apiVersion: e.target.value })} disabled={!canWrite} className="w-32" />
              </Field>
              <Field
                label="Webhook URL"
                className="sm:col-span-2"
                hint={
                  webhookIsDefault
                    ? 'Subscribe this URL to the messages field of your WhatsApp app. Running on localhost? Expose the API with a tunnel such as ngrok and paste that URL here; the webhook path is added for you.'
                    : <>Overrides the platform URL <span className="font-mono">{status?.webhookUrlDefault}</span>. Subscribe it to the messages field of your WhatsApp app.</>
                }
              >
                <div className="flex items-center gap-2">
                  <Input value={form.webhookUrl} onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })} disabled={!canWrite} placeholder={status?.webhookUrlDefault ?? 'https://your-host/api/webhooks/whatsapp'} className="font-mono text-[12px]" spellCheck={false} aria-label="Webhook URL" />
                  <Button variant="outline" size="sm" icon={<Copy className="h-3.5 w-3.5" />} onClick={copyWebhook} aria-label="Copy webhook URL" title="Copy webhook URL" />
                  {canWrite && !webhookIsDefault && <Button variant="ghost" size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => setForm({ ...form, webhookUrl: status?.webhookUrlDefault ?? '' })} title="Use the platform URL">Use default</Button>}
                </div>
              </Field>
            </div>
          </Card>

          <Card title="Templates" actions={<span className="text-[11.5px] text-subtle">Approved in WhatsApp Manager; parameters in order: subject, text, link, event</span>}>
            <div className="text-[12.5px] text-muted mb-3">
              Business-initiated messages must use a template Meta has approved. Create one named <span className="font-mono">progression_update</span> with the body <span className="font-mono">{'{{1}}'}</span> (subject), <span className="font-mono">{'{{2}}'}</span> (text) and <span className="font-mono">{'{{3}}'}</span> (link), then enter it as the default. Groups left blank use the default.
            </div>
            <div className="divide-y divide-[var(--border)] rounded-lg border border-default">
              {GROUPS.map((g) => {
                const row = templates[g.key] ?? { name: '', language: 'en', params: '' };
                const set = (patch: Partial<TemplateRow>) => setTemplates({ ...templates, [g.key]: { ...row, ...patch } });
                return (
                  <div key={g.key} className="grid grid-cols-1 md:grid-cols-[180px_1fr_90px_200px] gap-2 px-3 py-2 items-center">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">{g.label}</div>
                      <div className="text-[11.5px] text-subtle truncate" title={g.hint}>{g.hint}</div>
                    </div>
                    <Input value={row.name} onChange={(e) => set({ name: e.target.value })} placeholder={g.key === 'default' ? 'progression_update' : 'leave blank to use the default'} disabled={!canWrite} className="font-mono text-[12.5px]" />
                    <Input value={row.language} onChange={(e) => set({ language: e.target.value })} placeholder="en" disabled={!canWrite} className="font-mono text-[12.5px]" />
                    <Input value={row.params} onChange={(e) => set({ params: e.target.value })} placeholder="subject, text, link (empty = no placeholders)" disabled={!canWrite} className="font-mono text-[12.5px]" />
                  </div>
                );
              })}
            </div>
            {canWrite && (
              <div className="flex justify-end mt-3">
                <Button icon={<Check className="h-4 w-4" />} onClick={() => save.mutate()} loading={save.isPending}>Save settings</Button>
              </div>
            )}
          </Card>

          <Card title="Recent WhatsApp messages" actions={<span className="text-[11.5px] text-subtle">Delivery states arrive through the webhook</span>} padded={false}>
            <ConfigTable<OutboxRow> columns={outboxColumns} rows={outboxQ.data?.recent ?? []} loading={outboxQ.isLoading} error={outboxQ.error} retry={() => outboxQ.refetch()} emptyTitle="Nothing sent yet" emptyDescription="Messages appear here once a notification rule includes WhatsApp and someone has opted in." />
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card title="Send a test message">
            <div className="flex flex-col gap-2">
              <Field label="Mobile number" hint="Sends the default template, or Meta's hello_world sample when none is mapped">
                <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="+91 98765 43210" />
              </Field>
              <Button icon={<Send className="h-4 w-4" />} onClick={() => test.mutate()} loading={test.isPending} disabled={!canWrite || !testTo.trim() || !status?.configured}>Send test</Button>
              {!status?.configured && <div className="text-[12px] text-subtle">Save the phone number id and access token first.</div>}
              {tracking && track.data && (
                <div className="rounded-lg border border-default bg-surface-2 p-3 text-[12.5px] flex flex-col gap-1" data-testid="whatsapp-test-track">
                  <div className="flex items-center gap-2">
                    {track.data.deliveryStatus === 'failed' ? <XCircle className="h-4 w-4 text-red-600" /> : track.data.deliveryStatus === 'delivered' || track.data.deliveryStatus === 'read' ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : trackTimedOut ? <AlertTriangle className="h-4 w-4 text-amber-600" /> : <Loader2 className="h-4 w-4 animate-spin text-brand-600" />}
                    <span className="font-medium">{DELIVERY_LABEL[track.data.deliveryStatus ?? 'accepted'] ?? track.data.deliveryStatus}</span>
                  </div>
                  {track.data.lastError && <div className="text-red-700">{track.data.lastError}</div>}
                  {trackTimedOut && (
                    <div className="text-muted">
                      No delivery state arrived in two minutes. Meta accepted the message, so the phone number and token are fine; the state comes back only through the webhook. Run <strong>Check connection</strong> below: it tells you whether the webhook is subscribed and whether the template is approved. If everything is green and the phone still shows nothing, the recipient's number may have no WhatsApp account, may have blocked the business, or Meta is holding the template back (marketing limits, number quality).
                    </div>
                  )}
                  <div className="text-subtle">{track.data.recipient}{track.data.providerMessageId ? ` · ${track.data.providerMessageId}` : ''}</div>
                </div>
              )}
            </div>
          </Card>
          <Card title="Check connection" actions={<Button size="sm" variant="outline" icon={<Stethoscope className="h-3.5 w-3.5" />} onClick={() => check.mutate()} loading={check.isPending} disabled={!canWrite || !status?.configured}>Run check</Button>}>
            {!check.data && <div className="text-[12.5px] text-muted">Asks Meta about the phone number (registration, display name, quality, messaging tier), every mapped template (exists, approved, placeholders match the parameters) and the webhook subscription, and says what to fix.</div>}
            {check.data && (
              <ul className="flex flex-col gap-2" data-testid="whatsapp-check">
                {check.data.findings.map((f, i) => {
                  const Icon = FINDING_ICON[f.level];
                  return (
                    <li key={i} className="flex items-start gap-2 text-[12.5px]">
                      <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${FINDING_TONE[f.level]}`} />
                      <span>{f.text}</span>
                    </li>
                  );
                })}
                <li className="text-[11.5px] text-subtle">Checked {relativeTime(check.data.checkedAt)}</li>
              </ul>
            )}
          </Card>
          <Card title="How it works">
            <ol className="text-[12.5px] text-muted flex flex-col gap-2 list-decimal pl-4">
              <li>In Meta for Developers create an app with the WhatsApp product, add a phone number and generate a permanent system-user token.</li>
              <li>In WhatsApp Manager create the message template and wait for approval (usually within a day).</li>
              <li>Enter the ids and token here, map the template, save and send a test to your own number.</li>
              <li>Subscribe the webhook URL above with your verify token so delivery states come back. On a laptop, expose the API with a tunnel (ngrok, Cloudflare Tunnel) and enter that URL as the webhook URL; save, then copy it into Meta.</li>
              <li>Tick WhatsApp on the notification rules that should reach people on their phones.</li>
              <li>Everyone opts in on their profile with a mobile number; customer administrators can do it for their users.</li>
            </ol>
            <div className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-subtle"><MessageCircle className="h-3.5 w-3.5" /> {status?.hasOptIns ? 'At least one person has opted in.' : 'Nobody has opted in yet.'}</div>
          </Card>
        </div>
      </div>
    </div>
  );
}
