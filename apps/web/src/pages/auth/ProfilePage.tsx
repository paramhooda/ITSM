import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { LogOut, Laptop, Sparkles } from 'lucide-react';
import type { Principal } from '@itsm/shared';
import { api, get, patch, post, del, ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { Badge, Button, Card, ConfirmDialog, DataTable, Field, Input, KeyValue, PageHeader, Select, Toggle, type Column } from '@/components/ui';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { briefingsApi, briefingKeys, BRIEFING_TIMES, type BriefingPrefs, type BriefingChannel } from '@/components/briefings/api';
import { NotificationsCard } from '@/components/notifications/NotificationsCard';
import { notificationPrefsKeys } from '@/components/notifications/api';
import { WhatsAppLinkCard } from '@/components/whatsapp/WhatsAppLinkCard';

const TIMEZONES = [
  'UTC',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Riyadh',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Asia/Karachi',
  'Asia/Dhaka',
  'Asia/Bangkok',
  'Asia/Jakarta',
  'Asia/Manila',
  'Australia/Sydney',
  'Australia/Perth',
  'Pacific/Auckland',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Amsterdam',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Zurich',
  'Europe/Stockholm',
  'Europe/Warsaw',
  'Europe/Istanbul',
  'Europe/Moscow',
  'Africa/Johannesburg',
  'Africa/Nairobi',
  'Africa/Cairo',
  'Africa/Lagos',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Vancouver',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'America/Bogota',
  'America/Argentina/Buenos_Aires',
];

interface Session {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

function describeAgent(ua: string | null) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /curl|PostmanRuntime|python-requests|node/i.test(ua) ? 'API client' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export default function ProfilePage() {
  const user = useAuthStore((s) => s.user)!;
  const setUser = useAuthStore((s) => s.setUser);
  const clear = useAuthStore((s) => s.clear);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [name, setName] = useState(user.name);
  const [phone, setPhone] = useState(user.phone ?? '');
  const knownPhone = useRef(user.phone ?? '');
  knownPhone.current = user.phone ?? '';
  const [timezone, setTimezone] = useState(user.timezone || 'UTC');
  const briefingToday = useQuery({ queryKey: briefingKeys.today, queryFn: briefingsApi.today, enabled: user.userType === 'msp', staleTime: 60_000 });
  const [briefing, setBriefing] = useState<BriefingPrefs | null>(null);
  const briefingPrefs: BriefingPrefs = briefing ?? briefingToday.data?.prefs ?? { enabled: false, time: '08:00', role: 'auto', channels: ['email', 'in_app'] };
  const saveBriefing = useMutation({
    // Only the briefing key travels: every other key of preferences has a server-side writer of its own.
    mutationFn: (next: BriefingPrefs) => patch<{ user: Principal }>('/auth/me', { preferences: { briefing: next } }),
    onSuccess: (res, next) => {
      setUser(res.user);
      setBriefing(null);
      qc.setQueryData(briefingKeys.today, (prev: typeof briefingToday.data) => (prev ? { ...prev, prefs: next } : prev));
      void qc.invalidateQueries({ queryKey: briefingKeys.today });
      toast.success(next.enabled ? `Daily briefing on, at ${next.time}` : 'Daily briefing off');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the briefing settings'),
  });
  const setBriefingField = (patchPrefs: Partial<BriefingPrefs>) => setBriefing({ ...briefingPrefs, ...patchPrefs });
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);

  const tzOptions = (TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES]).map((t) => ({ value: t, label: t.replace(/_/g, ' ') }));

  const saveProfile = useMutation({
    mutationFn: () => patch<{ user: Principal }>('/auth/me', { name: name.trim(), phone: phone.trim(), timezone }),
    onSuccess: (res) => {
      setUser(res.user);
      setPhone(res.user.phone ?? '');
      // A changed number clears the verification and gates the WhatsApp column; the card reads the fresh state.
      void qc.invalidateQueries({ queryKey: notificationPrefsKeys.matrix });
      toast.success('Profile updated');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save profile'),
  });

  const changePassword = useMutation({
    mutationFn: () => post('/auth/change-password', { currentPassword: pw.current, newPassword: pw.next }),
    onSuccess: () => {
      setPw({ current: '', next: '', confirm: '' });
      toast.success('Password changed');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change password'),
  });

  const sessions = useQuery({ queryKey: ['auth', 'sessions'], queryFn: () => get<{ items: Session[] }>('/auth/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/auth/sessions/${id}`),
    onSuccess: () => {
      toast.success('Session revoked');
      qc.invalidateQueries({ queryKey: ['auth', 'sessions'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not revoke session'),
  });
  const revokeAll = useMutation({
    mutationFn: () => post('/auth/sessions/revoke-all', {}),
    onSuccess: async () => {
      setRevokeAllOpen(false);
      toast.success('All sessions revoked. Please sign in again.');
      try {
        await api('/auth/logout', { method: 'POST', body: {} });
      } catch {
        /* already revoked */
      }
      clear();
      navigate('/login');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not revoke sessions'),
  });

  function submitPassword(e: FormEvent) {
    e.preventDefault();
    if (pw.next !== pw.confirm) return toast.error('New passwords do not match');
    if (pw.next.length < 10 || !/[a-z]/.test(pw.next) || !/[A-Z]/.test(pw.next) || !/[0-9]/.test(pw.next)) return toast.error('Use at least 10 characters with upper and lower case letters and a number');
    changePassword.mutate();
  }

  const sessionColumns: Column<Session>[] = [
    { key: 'device', header: 'Device', render: (s) => <span className="inline-flex items-center gap-1.5"><Laptop className="h-3.5 w-3.5 text-subtle" /> {describeAgent(s.userAgent)}</span> },
    { key: 'ip', header: 'IP', render: (s) => <span className="font-mono text-xs">{s.ip ?? '—'}</span> },
    { key: 'lastSeenAt', header: 'Last active', render: (s) => <span title={fmtDateTime(s.lastSeenAt)}>{relativeTime(s.lastSeenAt)}</span> },
    { key: 'createdAt', header: 'Signed in', render: (s) => <span title={fmtDateTime(s.createdAt)}>{relativeTime(s.createdAt)}</span> },
    { key: 'expiresAt', header: 'Expires', render: (s) => fmtDateTime(s.expiresAt) },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (s) => (
        <Button size="sm" variant="ghost" onClick={() => revoke.mutate(s.id)} loading={revoke.isPending && revoke.variables === s.id}>
          Revoke
        </Button>
      ),
    },
  ];


  return (
    <div className="max-w-5xl">
      <PageHeader title="Profile & preferences" subtitle={user.email} />
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <div className="space-y-4">
          <Card title="Profile">
            <form
              className="grid grid-cols-1 sm:grid-cols-2 gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                saveProfile.mutate();
              }}
            >
              <Field label="Full name" required>
                <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
              </Field>
              <Field label="Email">
                <Input value={user.email} disabled />
              </Field>
              <Field label="Phone">
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 …" maxLength={50} />
              </Field>
              <Field label="Timezone" hint="Used for dates, SLA clocks and reports">
                <Select value={timezone} onChange={(e) => setTimezone(e.target.value)} options={tzOptions} />
              </Field>
              <div className="sm:col-span-2 flex justify-end">
                <Button type="submit" loading={saveProfile.isPending}>
                  Save profile
                </Button>
              </div>
            </form>
          </Card>


          <NotificationsCard
            onUser={(u) => {
              // Follow the server only when the number itself changed (Remove number); an opt-in toggle must not discard a half-typed number.
              const next = u.phone ?? '';
              if (next !== knownPhone.current) setPhone(next);
            }}
          />

          <WhatsAppLinkCard />

          {user.userType === 'msp' && (
            <Card title="Daily briefing" actions={<Sparkles className="h-4 w-4 text-brand-600" />}>
              <div className="flex flex-col gap-3">
                <Toggle checked={briefingPrefs.enabled} onChange={(v) => saveBriefing.mutate({ ...briefingPrefs, enabled: v })} label={<span>Send me a briefing every morning <span className="text-subtle">— what matters for your role, written by Grady from the live figures</span></span>} />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Time" hint={`In your timezone (${user.timezone || 'UTC'})`}>
                    <Select value={briefingPrefs.time} onChange={(e) => setBriefingField({ time: e.target.value })} options={(BRIEFING_TIMES.includes(briefingPrefs.time) ? BRIEFING_TIMES : [briefingPrefs.time, ...BRIEFING_TIMES]).map((t) => ({ value: t, label: t }))} />
                  </Field>
                  <Field label="Briefing" hint="Chosen from your roles when left on automatic">
                    <Select value={briefingPrefs.role} onChange={(e) => setBriefingField({ role: e.target.value as BriefingPrefs['role'] })} options={[{ value: 'auto', label: `Automatic${briefingToday.data ? ` (${briefingToday.data.roles.find((r) => r.key === briefingToday.data!.role)?.label ?? ''})` : ''}` }, ...(briefingToday.data?.roles ?? []).filter((r) => r.allowed).map((r) => ({ value: r.key, label: r.label }))]} />
                  </Field>
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  {(['email', 'in_app'] as BriefingChannel[]).map((ch) => (
                    <label key={ch} className="inline-flex items-center gap-1.5 text-[13px] cursor-pointer">
                      <input type="checkbox" className="h-3.5 w-3.5 accent-brand-600" checked={briefingPrefs.channels.includes(ch)} onChange={(e) => setBriefingField({ channels: e.target.checked ? [...briefingPrefs.channels, ch] : briefingPrefs.channels.filter((c) => c !== ch) })} />
                      {ch === 'email' ? 'Email' : 'In-app'}
                    </label>
                  ))}
                  <div className="ml-auto flex items-center gap-2">
                    {briefing && <Button size="sm" variant="ghost" onClick={() => setBriefing(null)}>Discard</Button>}
                    <Button size="sm" disabled={!briefing} loading={saveBriefing.isPending} onClick={() => saveBriefing.mutate(briefingPrefs)}>Save briefing settings</Button>
                  </div>
                </div>
                {briefingToday.data?.roles.find((r) => r.key === (briefingPrefs.role === 'auto' ? briefingToday.data?.role : briefingPrefs.role))?.description && (
                  <div className="text-[12.5px] text-muted">{briefingToday.data.roles.find((r) => r.key === (briefingPrefs.role === 'auto' ? briefingToday.data?.role : briefingPrefs.role))?.description}</div>
                )}
              </div>
            </Card>
          )}

          <Card
            title="Change password"
          >
            <form className="grid grid-cols-1 sm:grid-cols-3 gap-3" onSubmit={submitPassword}>
              <Field label="Current password" required>
                <Input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
              </Field>
              <Field label="New password" required hint="10+ characters, upper & lower case, a number">
                <Input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />
              </Field>
              <Field label="Confirm new password" required>
                <Input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required />
              </Field>
              <div className="sm:col-span-3 flex justify-end">
                <Button type="submit" variant="outline" loading={changePassword.isPending}>
                  Update password
                </Button>
              </div>
            </form>
          </Card>

          <Card
            title="Active sessions"
            actions={
              <Button size="sm" variant="outline" icon={<LogOut className="h-3.5 w-3.5" />} onClick={() => setRevokeAllOpen(true)}>
                Sign out everywhere
              </Button>
            }
            padded={false}
          >
            <DataTable columns={sessionColumns} rows={sessions.data?.items ?? []} loading={sessions.isLoading} dense empty={<div className="px-4 py-6 text-[13px] text-muted">No active sessions.</div>} />
          </Card>
        </div>

        <div className="space-y-4">
          <Card
            title="Roles & teams"
          >
            <KeyValue
              columns={1}
              items={[
                { label: 'Account type', value: user.userType === 'customer' ? 'Customer portal user' : 'MSP staff' },
                {
                  label: 'Roles',
                  value: user.roles.length ? (
                    <span className="flex flex-wrap gap-1">
                      {user.roles.map((r) => (
                        <Badge key={`${r.id}-${r.customerId ?? 'global'}`} color={r.customerId ? 'violet' : 'blue'} title={r.customerId ? `Scoped to customer ${r.customerId}` : 'Global role'}>
                          {r.name}
                          {r.customerId ? ' (customer)' : ''}
                        </Badge>
                      ))}
                    </span>
                  ) : (
                    '—'
                  ),
                },
                {
                  label: 'Teams',
                  value: user.teams.length ? (
                    <span className="flex flex-wrap gap-1">
                      {user.teams.map((t) => (
                        <Badge key={t.id}>{t.name}</Badge>
                      ))}
                    </span>
                  ) : (
                    '—'
                  ),
                },
                { label: 'Customer visibility', value: user.customerScope === 'all' ? 'All customers' : `${user.customerScope.length} customer${user.customerScope.length === 1 ? '' : 's'}` },
                { label: 'Permissions', value: `${user.permissions.length} granted` },
              ]}
            />
          </Card>

          <Card
            title="Developers"
          >
            <p className="text-[13px] text-muted mb-2">The REST API is documented with OpenAPI. Integrations authenticate with an API key issued in Administration.</p>
            <a href="/api/docs" target="_blank" rel="noreferrer" className="text-[13px] text-brand-600 hover:underline">
              Open API documentation →
            </a>
          </Card>
        </div>
      </div>

      <ConfirmDialog open={revokeAllOpen} onClose={() => setRevokeAllOpen(false)} onConfirm={() => revokeAll.mutate()} title="Sign out everywhere?" description="All active sessions, including this one, will be revoked. You will need to sign in again." confirmLabel="Sign out everywhere" danger loading={revokeAll.isPending} />
    </div>
  );
}
