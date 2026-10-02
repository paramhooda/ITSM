import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Save, RotateCcw } from 'lucide-react';
import { get, put } from '@/api/client';
import { Button, Card, Input, Toggle, LoadingBlock, ErrorBlock } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { titleCase, fmtDateTime } from '@/lib/format';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { useAdminMutation } from '@/components/admin/api';
import { cn } from '@/lib/utils';

interface Setting {
  key: string;
  value: unknown;
  description: string | null;
  updatedAt: string;
}

const GROUP_LABELS: Record<string, string> = { platform: 'Platform', tickets: 'Tickets', contracts: 'Contracts', entitlements: 'Entitlements', portal: 'Customer portal', security: 'Security', audit: 'Audit retention', events: 'Integration events retention', ai: 'AI', smtp: 'Email delivery' };
const GROUP_ORDER = ['platform', 'tickets', 'contracts', 'entitlements', 'portal', 'security', 'audit', 'events', 'ai', 'smtp'];

type Kind = 'boolean' | 'number' | 'number[]' | 'string[]' | 'string' | 'secret' | 'json';
function kindOf(key: string, value: unknown): Kind {
  if (value === '********' || key.endsWith('.password') || key.endsWith('.secret') || key.endsWith('.api_key')) return 'secret';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return value.every((v) => typeof v === 'number') ? 'number[]' : 'string[]';
  if (typeof value === 'string') return 'string';
  return 'json';
}

export default function SettingsPage() {
  const can = useAuthStore((s) => s.can);
  const canWrite = can('admin:system');
  const q = useQuery({ queryKey: ['config', 'settings'], queryFn: () => get<Setting[]>('/config/settings') });
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  useEffect(() => setDraft({}), [q.data]);
  const save = useAdminMutation((body: Record<string, unknown>) => put('/config/settings', body), { invalidate: [['config', 'settings']], lookups: true, success: 'Settings saved' });

  const groups = useMemo(() => {
    const map = new Map<string, Setting[]>();
    for (const s of q.data ?? []) {
      const g = s.key.split('.')[0];
      map.set(g, [...(map.get(g) ?? []), s]);
    }
    return [...map.entries()].sort((a, b) => (GROUP_ORDER.indexOf(a[0]) + 100) % 100 - ((GROUP_ORDER.indexOf(b[0]) + 100) % 100) || a[0].localeCompare(b[0]));
  }, [q.data]);

  if (q.isLoading) return <LoadingBlock />;
  if (q.error) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  const dirtyKeys = Object.keys(draft);

  return (
    <div>
      <SectionHeader
        title="Settings"
        description="Platform-wide behaviour. Changes apply immediately to new operations."
        actions={
          <>
            <Button variant="ghost" icon={<RotateCcw className="h-4 w-4" />} disabled={!dirtyKeys.length} onClick={() => setDraft({})}>
              Reset
            </Button>
            <Button icon={<Save className="h-4 w-4" />} disabled={!dirtyKeys.length || !canWrite} loading={save.isPending} onClick={() => save.mutate(draft)} title={canWrite ? undefined : 'Requires the admin:system permission'}>
              Save {dirtyKeys.length ? `(${dirtyKeys.length})` : ''}
            </Button>
          </>
        }
      />
      {!canWrite && <div className="mb-3 text-[12.5px] text-amber-700">Read-only: saving settings requires the admin:system permission.</div>}
      <div className="flex flex-col gap-4">
        {groups.map(([group, items]) => (
          <Card key={group} title={GROUP_LABELS[group] ?? titleCase(group)} padded={false}>
            <div className="divide-y divide-[var(--border)]">
              {items.map((s) => {
                const kind = kindOf(s.key, s.value);
                const value = s.key in draft ? draft[s.key] : s.value;
                const dirty = s.key in draft;
                const setValue = (v: unknown) => setDraft((d) => ({ ...d, [s.key]: v }));
                return (
                  <div key={s.key} className={cn('grid grid-cols-1 md:grid-cols-5 gap-2 px-4 py-2.5', dirty && 'bg-brand-600/5')}>
                    <div className="md:col-span-3 min-w-0">
                      <div className="text-[13px] font-medium">{titleCase(s.key.split('.').slice(1).join(' '))}</div>
                      <div className="text-[12px] text-muted">{s.description ?? <span className="font-mono">{s.key}</span>}</div>
                    </div>
                    <div className="md:col-span-2 flex items-center">
                      <SettingInput kind={kind} value={value} onChange={setValue} disabled={!canWrite} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="px-4 py-1.5 text-[11px] text-subtle border-t border-default">Last updated {fmtDateTime(items.reduce((m, s) => (s.updatedAt > m ? s.updatedAt : m), items[0].updatedAt))}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function SettingInput({ kind, value, onChange, disabled }: { kind: Kind; value: unknown; onChange: (v: unknown) => void; disabled: boolean }) {
  switch (kind) {
    case 'boolean':
      return <Toggle checked={!!value} onChange={(v) => !disabled && onChange(v)} label={value ? 'Enabled' : 'Disabled'} />;
    case 'number':
      return <Input type="number" value={value === null || value === undefined ? '' : String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
    case 'number[]':
      return <ListInput value={(value as number[]).map(String)} disabled={disabled} onChange={(list) => onChange(list.map(Number).filter((n) => !isNaN(n)))} hint="comma-separated numbers" />;
    case 'string[]':
      return <ListInput value={value as string[]} disabled={disabled} onChange={onChange} hint="comma-separated" />;
    case 'secret':
      return <Input type="password" placeholder="••••••••" value={value === '********' ? '' : String(value ?? '')} disabled={disabled} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" />;
    case 'string':
      return <Input value={String(value ?? '')} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <JsonInput value={value} disabled={disabled} onChange={onChange} />;
  }
}

function ListInput({ value, onChange, disabled, hint }: { value: string[]; onChange: (v: string[]) => void; disabled: boolean; hint: string }) {
  const [text, setText] = useState(value.join(', '));
  useEffect(() => setText(value.join(', ')), [value]);
  return <Input value={text} placeholder={hint} disabled={disabled} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(text.split(',').map((s) => s.trim()).filter(Boolean))} />;
}

function JsonInput({ value, onChange, disabled }: { value: unknown; onChange: (v: unknown) => void; disabled: boolean }) {
  const [text, setText] = useState(JSON.stringify(value));
  const [bad, setBad] = useState(false);
  useEffect(() => setText(JSON.stringify(value)), [value]);
  return (
    <Input
      value={text}
      disabled={disabled}
      className={cn('font-mono text-[12px]', bad && 'border-red-500')}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        try {
          onChange(JSON.parse(text));
          setBad(false);
        } catch {
          setBad(true);
        }
      }}
    />
  );
}
