import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sun, Moon, Monitor, LogOut, Laptop } from 'lucide-react';
import type { Principal } from '@itsm/shared';
import { api, get, patch, post, del, ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { Badge, Button, Card, ConfirmDialog, DataTable, Field, Input, KeyValue, PageHeader, Select, Toggle, type Column } from '@/components/ui';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';

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

type NotificationPrefs = { email: boolean; inApp: boolean };

function prefsOf(user: Principal): NotificationPrefs {
  const n = (user.preferences?.notifications ?? {}) as Partial<NotificationPrefs>;
  return { email: n.email ?? true, inApp: n.inApp ?? true };
}

export default function ProfilePage() {
  const user = useAuthStore((s) => s.user)!;
  const setUser = useAuthStore((s) => s.setUser);
  const clear = useAuthStore((s) => s.clear);
  const { theme, setTheme } = useUiStore();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const profile = (user.preferences?.profile ?? {}) as { phone?: string };
  const [name, setName] = useState(user.name);
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [timezone, setTimezone] = useState(user.timezone || 'UTC');
  const [prefs, setPrefs] = useState<NotificationPrefs>(() => prefsOf(user));
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);

  const tzOptions = (TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES]).map((t) => ({ value: t, label: t.replace(/_/g, ' ') }));

  const saveProfile = useMutation({
    mutationFn: () =>
      patch<{ user: Principal }>('/auth/me', {
        name: name.trim(),
        phone: phone.trim(),
        timezone,
        preferences: { ...user.preferences, profile: { ...profile, phone: phone.trim() } },
      }),
    onSuccess: (res) => {
      setUser(res.user);
      toast.success('Profile updated');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save profile'),
  });

  const savePrefs = useMutation({
    mutationFn: (next: NotificationPrefs) => patch<{ user: Principal }>('/auth/me', { preferences: { ...user.preferences, notifications: next } }),
    onSuccess: (res) => {
      setUser(res.user);
      toast.success('Notification preferences saved');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save preferences'),
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

  const themeOptions = [
    { value: 'light' as const, label: 'Light', Icon: Sun },
    { value: 'dark' as const, label: 'Dark', Icon: Moon },
    { value: 'system' as const, label: 'System', Icon: Monitor },
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

          <Card title="Appearance">
            <div className="flex items-center gap-2">
              {themeOptions.map(({ value, label, Icon }) => (
                <button key={value} type="button" onClick={() => setTheme(value)} className={cn('inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px]', theme === value ? 'border-brand-600 bg-brand-600/10 text-brand-700 dark:text-brand-300 font-medium' : 'border-default text-muted hover:bg-surface-2')}>
                  <Icon className="h-4 w-4" /> {label}
                </button>
              ))}
              <span className="text-xs text-subtle ml-2">Stored on this device.</span>
            </div>
          </Card>

          <Card title="Notifications">
            <div className="flex flex-col gap-3">
              <Toggle
                checked={prefs.email}
                onChange={(v) => {
                  const next = { ...prefs, email: v };
                  setPrefs(next);
                  savePrefs.mutate(next);
                }}
                label={
                  <span>
                    Email notifications <span className="text-subtle">— ticket updates, SLA alerts, approvals, contract milestones</span>
                  </span>
                }
              />
              <Toggle
                checked={prefs.inApp}
                onChange={(v) => {
                  const next = { ...prefs, inApp: v };
                  setPrefs(next);
                  savePrefs.mutate(next);
                }}
                label={
                  <span>
                    In-app notifications <span className="text-subtle">— bell icon and the notifications page</span>
                  </span>
                }
              />
            </div>
          </Card>

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
                <Button type="submit" variant="secondary" loading={changePassword.isPending}>
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
