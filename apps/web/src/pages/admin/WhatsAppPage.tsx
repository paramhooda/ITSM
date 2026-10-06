import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Copy, MessageCircle, RefreshCw, RotateCcw, Send, ShieldAlert, Stethoscope, CheckCircle2, AlertTriangle, XCircle, Loader2 } from 'lucide-react';
import { get, post, put, ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { Badge, Button, Card, Checkbox, ErrorBlock, Field, Input, LoadingBlock, Textarea, Toggle, type Column } from '@/components/ui';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, MutedCell, MonoCell } from '@/components/admin/ConfigTable';
import { fmtDateTime, relativeTime, titleCase } from '@/lib/format';
import { WHATSAPP_INBOUND_COLORS } from '@/lib/statusColors';
import { whatsappApi, whatsappKeys, INBOUND_OUTCOME_LABELS, type InboundRow } from '@/components/whatsapp/api';

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
  { key: 'user', label: 'Account messages', hint: 'the verification code sent to a person\'s own number (an authentication-category template fits)' },
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
  assistantEnabled: 'whatsapp.assistant.enabled',
  assistantAudiences: 'whatsapp.assistant.audiences',
  assistantCap: 'whatsapp.assistant.daily_message_cap',
  assistantIdleHours: 'whatsapp.assistant.thread_idle_hours',
  assistantGreeting: 'whatsapp.assistant.greeting',
  assistantUnlinkedReply: 'whatsapp.assistant.unlinked_reply',
  displayNumber: 'whatsapp.display_number',
} as const;

/** The assistant card's fields as typed (numbers as text so a half-typed value never snaps). */
interface AssistantForm {
  enabled: boolean;
  audiences: string[];
  dailyMessageCap: string;
  threadIdleHours: string;
  greeting: string;
  unlinkedReply: string;
  displayNumber: string;
}
const EMPTY_ASSISTANT: AssistantForm = { enabled: false, audiences: ['staff', 'customers'], dailyMessageCap: '100', threadIdleHours: '24', greeting: '', unlinkedReply: '', displayNumber: '' };
const AUDIENCE_OPTIONS = [{ value: 'staff', label: 'Staff' }, { value: 'customers', label: 'Customers (portal users)' }];
function assistantFromSettings(value: (k: string) => unknown): AssistantForm {
  const audiences = value(KEYS.assistantAudiences);
  return {
    enabled: value(KEYS.assistantEnabled) === true,
    audiences: Array.isArray(audiences) ? (audiences as unknown[]).filter((a): a is string => a === 'staff' || a === 'customers') : EMPTY_ASSISTANT.audiences,
    dailyMessageCap: String(value(KEYS.assistantCap) ?? EMPTY_ASSISTANT.dailyMessageCap),
    threadIdleHours: String(value(KEYS.assistantIdleHours) ?? EMPTY_ASSISTANT.threadIdleHours),
    greeting: String(value(KEYS.assistantGreeting) ?? ''),
    unlinkedReply: String(value(KEYS.assistantUnlinkedReply) ?? ''),
    displayNumber: String(value(KEYS.displayNumber) ?? ''),
  };
}
/** The same rules the assistant tool applies, so a refused value never reaches the settings table. */
function assistantProblem(a: AssistantForm): string | null {
  const cap = Number(a.dailyMessageCap);
  const idle = Number(a.threadIdleHours);
  if (!a.audiences.length) return 'Pick at least one audience: staff, customers or both';
  if (!Number.isInteger(cap) || cap < 1 || cap > 2000) return 'The daily message cap is a whole number from 1 to 2000';
  if (!Number.isInteger(idle) || idle < 1 || idle > 168) return 'Thread idle hours is a whole number from 1 to 168';
  if (a.greeting.trim().length < 10 || a.greeting.trim().length > 500) return 'The greeting is 10 to 500 characters';
  if (a.unlinkedReply.trim().length < 10 || a.unlinkedReply.trim().length > 500) return 'The reply to unknown numbers is 10 to 500 characters';
  if (a.displayNumber.trim().length > 30) return 'The display number is at most 30 characters';
  return null;
}

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
  const [assistant, setAssistant] = useState<AssistantForm>(EMPTY_ASSISTANT);
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
    setAssistant(assistantFromSettings(value));
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

  // The assistant on WhatsApp: its seven settings, the readiness list and the inbound log.
  const assistantQ = useQuery({ queryKey: whatsappKeys.status, queryFn: () => whatsappApi.assistantStatus(), refetchInterval: 30_000 });
  const inboundQ = useQuery({ queryKey: whatsappKeys.inbound({ limit: 50 }), queryFn: () => whatsappApi.inbound({ limit: 50 }), refetchInterval: 30_000 });
  const saveAssistant = useMutation({
    mutationFn: async () => {
      const problem = assistantProblem(assistant);
      if (problem) throw new Error(problem);
      return put('/config/settings', {
        [KEYS.assistantEnabled]: assistant.enabled,
        [KEYS.assistantAudiences]: AUDIENCE_OPTIONS.map((o) => o.value).filter((v) => assistant.audiences.includes(v)),
        [KEYS.assistantCap]: Number(assistant.dailyMessageCap),
        [KEYS.assistantIdleHours]: Number(assistant.threadIdleHours),
        [KEYS.assistantGreeting]: assistant.greeting.trim(),
        [KEYS.assistantUnlinkedReply]: assistant.unlinkedReply.trim(),
        [KEYS.displayNumber]: assistant.displayNumber.trim(),
      });
    },
    onSuccess: () => {
      toast.success('Assistant settings saved');
      qc.invalidateQueries({ queryKey: ['config', 'settings'] });
      qc.invalidateQueries({ queryKey: whatsappKeys.status });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save'),
  });
  const setAudience = (key: string, on: boolean) => setAssistant((a) => ({ ...a, audiences: on ? [...new Set([...a.audiences, key])] : a.audiences.filter((x) => x !== key) }));

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
  const inboundColumns = useMemo<Column<InboundRow>[]>(
    () => [
      { key: 'receivedAt', header: 'Received', render: (r) => <MutedCell><span className="whitespace-nowrap" title={fmtDateTime(r.receivedAt)}>{relativeTime(r.receivedAt)}</span></MutedCell> },
      { key: 'phone', header: 'Number', render: (r) => <div className="min-w-0"><MonoCell>{r.phone}</MonoCell>{r.displayName && <div className="text-[11.5px] text-subtle truncate max-w-[160px]" title="The WhatsApp profile name, as the sender set it">{r.displayName}</div>}</div> },
      { key: 'user', header: 'Person', render: (r) => (r.user ? <div className="min-w-0"><div className="text-[12.5px] truncate max-w-[180px]">{r.user.name}</div><div className="text-[11.5px] text-subtle">{r.user.userType === 'customer' ? 'Customer' : 'Staff'}</div></div> : <MutedCell>—</MutedCell>) },
      { key: 'text', header: 'Message', render: (r) => (r.text ? <div className="truncate max-w-md text-[12.5px]" title={r.text}>{r.text}</div> : <MutedCell>({r.kind})</MutedCell>) },
      { key: 'outcome', header: 'Outcome', render: (r) => <div className="min-w-0"><Badge color={r.outcome ? WHATSAPP_INBOUND_COLORS[r.outcome] ?? 'slate' : 'blue'} dot>{r.outcome ? INBOUND_OUTCOME_LABELS[r.outcome] ?? titleCase(r.outcome) : titleCase(r.status)}</Badge>{r.error && <div className="text-[11.5px] text-red-600 break-words max-w-xs" title={r.error}>{r.error}</div>}</div> },
      { key: 'reply', header: 'Reply', render: (r) => (r.reply ? <div className="min-w-0"><Badge color={r.reply.status === 'failed' ? 'red' : DELIVERY_COLOR[r.reply.deliveryStatus ?? ''] ?? STATUS_COLOR[r.reply.status] ?? 'slate'}>{titleCase(r.reply.deliveryStatus ?? r.reply.status)}</Badge>{r.reply.lastError && <div className="text-[11.5px] text-red-600 break-words max-w-xs">{r.reply.lastError}</div>}</div> : <MutedCell>—</MutedCell>) },
    ],
    [],
  );

  return (
    <div>
      <SectionHeader
        title="WhatsApp"
        description="Configure the WhatsApp Business account once. People then add a mobile number on their profile and tick WhatsApp notifications; a verified number can also chat with Grady."
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

          <Card title="Assistant on WhatsApp" actions={<Toggle checked={assistant.enabled} onChange={(v) => setAssistant({ ...assistant, enabled: v })} label="Answer messages with Grady" disabled={!canWrite} />} data-testid="assistant-card">
            <div className="text-[12.5px] text-muted mb-3">
              People who verified their mobile number and switched the chat on under Profile &amp; preferences message the business number and get Grady: the same tools, permissions, confirmations and audit trail as in the web application, rendered as WhatsApp text. Inbound messages are read only when the app secret above is set, because Meta signs every delivery with it.
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Who may chat" hint="Staff, customers (portal users), or both">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 min-h-9" data-testid="assistant-audiences">
                  {AUDIENCE_OPTIONS.map((o) => (
                    <Checkbox key={o.value} label={o.label} checked={assistant.audiences.includes(o.value)} onChange={(e) => setAudience(o.value, e.target.checked)} disabled={!canWrite} />
                  ))}
                </div>
              </Field>
              <Field label="Display number" hint="The business number people message, as shown on the profile page and in the wa.me link">
                <Input value={assistant.displayNumber} onChange={(e) => setAssistant({ ...assistant, displayNumber: e.target.value })} disabled={!canWrite} placeholder="+91 11 4000 0000" maxLength={30} aria-label="Display number" />
              </Field>
              <Field label="Daily message cap per person" hint="Messages one person may send per day (UTC), 1 to 2000; the AI token budget applies as well">
                <Input type="number" min={1} max={2000} value={assistant.dailyMessageCap} onChange={(e) => setAssistant({ ...assistant, dailyMessageCap: e.target.value })} disabled={!canWrite} aria-label="Daily message cap" />
              </Field>
              <Field label="Thread idle hours" hint="A conversation continues until it has been quiet for this long (1 to 168); then a fresh one starts">
                <Input type="number" min={1} max={168} value={assistant.threadIdleHours} onChange={(e) => setAssistant({ ...assistant, threadIdleHours: e.target.value })} disabled={!canWrite} aria-label="Thread idle hours" />
              </Field>
              <Field label="Greeting" className="sm:col-span-2" hint={<>Sent once, before the first reply to a person; <span className="font-mono">{'{{name}}'}</span> and <span className="font-mono">{'{{platform}}'}</span> are filled in</>}>
                <Textarea rows={3} value={assistant.greeting} onChange={(e) => setAssistant({ ...assistant, greeting: e.target.value })} disabled={!canWrite} maxLength={500} aria-label="Greeting" />
              </Field>
              <Field label="Reply to unknown numbers" className="sm:col-span-2" hint="What an unknown or unverified number receives, at most once an hour">
                <Textarea rows={3} value={assistant.unlinkedReply} onChange={(e) => setAssistant({ ...assistant, unlinkedReply: e.target.value })} disabled={!canWrite} maxLength={500} aria-label="Reply to unknown numbers" />
              </Field>
            </div>
            {canWrite && (
              <div className="flex justify-end mt-3">
                <Button icon={<Check className="h-4 w-4" />} onClick={() => saveAssistant.mutate()} loading={saveAssistant.isPending} data-testid="assistant-save">Save assistant settings</Button>
              </div>
            )}
            <div className="mt-4 pt-4 border-t border-default">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <div className="text-[13px] font-medium">Readiness</div>
                {assistantQ.data && (
                  <Badge color={assistantQ.data.ready ? 'green' : assistantQ.data.enabled ? 'amber' : 'slate'} dot data-testid="assistant-ready">
                    {assistantQ.data.ready ? 'Ready' : assistantQ.data.enabled ? 'Something to fix' : 'Off'}
                  </Badge>
                )}
              </div>
              {assistantQ.isLoading && <LoadingBlock />}
              {assistantQ.error && <ErrorBlock error={assistantQ.error} retry={() => assistantQ.refetch()} />}
              {assistantQ.data && (
                <>
                  <ul className="flex flex-col gap-1.5" data-testid="assistant-checks">
                    {assistantQ.data.checks.map((f, i) => {
                      const Icon = FINDING_ICON[f.level];
                      return (
                        <li key={i} className="flex items-start gap-2 text-[12.5px]" data-level={f.level}>
                          <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${FINDING_TONE[f.level]}`} />
                          <span>{f.text}</span>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="mt-3 text-[12px] text-subtle" data-testid="assistant-counts">
                    Today: {assistantQ.data.inboundToday} received · {assistantQ.data.repliedToday} answered · {assistantQ.data.failedToday} failed · {assistantQ.data.linkedUsers} {assistantQ.data.linkedUsers === 1 ? 'person has' : 'people have'} linked a number ({assistantQ.data.verifiedUsers} verified)
                  </div>
                </>
              )}
            </div>
          </Card>

          <Card title="Recent inbound messages" actions={<span className="text-[11.5px] text-subtle">What people sent to the business number and what Grady did with it</span>} padded={false} data-testid="inbound-card">
            <ConfigTable<InboundRow> columns={inboundColumns} rows={inboundQ.data?.items ?? []} loading={inboundQ.isLoading} error={inboundQ.error} retry={() => inboundQ.refetch()} emptyTitle="Nothing received yet" emptyDescription="Messages people send to the business number appear here with what Grady did with them." />
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
              <li>Turn on the assistant here, set the display number, and people verify their number and switch on chat with Grady on their profile; the Users pages show who is linked and let you revoke a number.</li>
            </ol>
            <div className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-subtle"><MessageCircle className="h-3.5 w-3.5" /> {status?.hasOptIns ? 'At least one person has opted in.' : 'Nobody has opted in yet.'}</div>
          </Card>
        </div>
      </div>
    </div>
  );
}
