import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Save, RotateCcw, Bot, Users, Coins, Wrench, ThumbsUp, Timer, ShieldCheck } from 'lucide-react';
import { get, put } from '@/api/client';
import { Button, Card, Field, Input, Select, Toggle, LoadingBlock, ErrorBlock, DataTable, Badge, type Column } from '@/components/ui';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { useAdminMutation } from '@/components/admin/api';
import { AiConnectionCard } from '@/components/admin/AiConnectionCard';
import { KpiGrid } from '@/components/dashboards/KpiGrid';
import { TrendChart } from '@/components/dashboards/TrendChart';
import { PeriodPicker } from '@/components/dashboards/Hero';
import { Stat } from '@/components/dashboards/Panel';
import { aiQk } from '@/components/ai/api';
import { useAuthStore } from '@/stores/auth';

interface AiAdminSettings {
  assistantEnabled: boolean;
  disabledFeatures: string[];
  autonomy: 'confirm_all' | 'auto_low';
  effort: 'low' | 'medium' | 'high';
  dailyTokenBudget: number;
  turnTimeoutSeconds: number;
  retentionDays: number;
  features: string[];
  rateLimitPerMinute: number;
  triage: { autoApplyConfidence: number; stormWindowMinutes: number; stormThreshold: number; stormAutoLink: boolean };
}
interface UsageDay { day: string; turns: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; toolCalls: number; up: number; down: number; avgDurationMs: number }
interface ToolRow { id?: string; tool: string; calls: number; ok: number; proposed: number; failed: number; action: boolean }
interface AiUsage {
  days: number;
  totals: { turns: number; users: number; conversations: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheHitPct: number; toolCalls: number; up: number; down: number; avgDurationMs: number };
  series: UsageDay[];
  byTool: ToolRow[];
  guardrails: { tenantFence: number; answerFence: number; forbiddenToolCalls: number; invalidToolCalls: number; toolErrors: number; proposals: number; outcomes: Record<string, number> };
}

const FEATURE_LABELS: Record<string, string> = {
  assistant: 'Chat assistant (Grady)',
  summarize: 'Ticket summaries',
  classify: 'Classification suggestions',
  assign: 'Assignment recommendations',
  similar: 'Similar tickets',
  suggest_kb: 'Knowledge suggestions',
  resolution: 'Resolution suggestions',
  draft: 'Drafted updates',
  duplicates: 'Duplicate check',
  change_impact: 'Change impact summaries',
  problem_clusters: 'Problem clusters',
  triage: 'Triage on arrival (classify, owner, duplicates)',
  sentiment: 'Customer sentiment on comments',
};
const fmt = (n: number) => n.toLocaleString('en-GB');
const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : fmt(n));
const SETTINGS_KEY = ['ai', 'admin', 'settings'] as const;

type Editable = Omit<AiAdminSettings, 'features' | 'rateLimitPerMinute'>;

/** The assistant's control page: connection, switches, limits and the usage report. */
export default function AiPage() {
  const can = useAuthStore((s) => s.can);
  const canWrite = can('admin:system');
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => get<AiAdminSettings>('/ai/admin/settings') });
  const [draft, setDraft] = useState<Partial<Editable>>({});
  useEffect(() => setDraft({}), [settings.data]);
  const [days, setDays] = useState(30);
  const usage = useQuery({ queryKey: ['ai', 'admin', 'usage', days], queryFn: () => get<AiUsage>('/ai/admin/usage', { days }), staleTime: 30_000 });
  const save = useAdminMutation(({ triage, ...body }: Partial<Editable>) => put('/ai/admin/settings', { ...body, ...(triage ? { triageAutoApplyConfidence: triage.autoApplyConfidence, stormWindowMinutes: triage.stormWindowMinutes, stormThreshold: triage.stormThreshold, stormAutoLink: triage.stormAutoLink } : {}) }), { invalidate: [[...SETTINGS_KEY], [...aiQk.status], ['config', 'settings']], success: 'Assistant settings saved' });

  const current = useMemo(() => (settings.data ? { ...settings.data, ...draft } : null), [settings.data, draft]);
  const dirty = Object.keys(draft).length > 0;
  const set = <K extends keyof Editable>(k: K, v: Editable[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setTriage = (patch: Partial<AiAdminSettings['triage']>) => setDraft((d) => ({ ...d, triage: { ...(settings.data?.triage ?? { autoApplyConfidence: 85, stormWindowMinutes: 30, stormThreshold: 3, stormAutoLink: true }), ...(d.triage ?? {}), ...patch } }));
  const toggleFeature = (f: string, on: boolean) => {
    const list = new Set(current?.disabledFeatures ?? []);
    if (on) list.delete(f);
    else list.add(f);
    set('disabledFeatures', [...list]);
  };
  const toolColumns: Column<ToolRow>[] = [
    { key: 'tool', header: 'Tool', render: (r) => <span className="font-mono text-[12px]">{r.tool}</span> },
    { key: 'kind', header: 'Kind', render: (r) => (r.action ? <Badge color="amber">action</Badge> : <Badge color="gray">read</Badge>) },
    { key: 'calls', header: 'Calls', className: 'text-right tnum', render: (r) => fmt(r.calls) },
    { key: 'ok', header: 'Ran', className: 'text-right tnum', render: (r) => fmt(r.ok) },
    { key: 'proposed', header: 'Proposed', className: 'text-right tnum', render: (r) => fmt(r.proposed) },
    { key: 'failed', header: 'Failed', className: 'text-right tnum', render: (r) => (r.failed ? <span className="text-red-600">{fmt(r.failed)}</span> : '0') },
  ];

  if (settings.isLoading) return <LoadingBlock />;
  if (settings.error || !current) return <ErrorBlock error={settings.error} retry={() => settings.refetch()} />;
  const u = usage.data;
  const outcomes = u?.guardrails.outcomes ?? {};
  const limitHits = (outcomes.timeout ?? 0) + (outcomes.tool_limit ?? 0);

  return (
    <div>
      <SectionHeader
        title="AI assistant"
        description="Grady's connection, switches, limits and usage. Changes apply to the next message."
        actions={
          <>
            <Button variant="ghost" icon={<RotateCcw className="h-4 w-4" />} disabled={!dirty} onClick={() => setDraft({})}>Reset</Button>
            <Button icon={<Save className="h-4 w-4" />} disabled={!dirty || !canWrite} loading={save.isPending} onClick={() => save.mutate(draft)} title={canWrite ? undefined : 'Requires the admin:system permission'}>Save</Button>
          </>
        }
      />
      {!canWrite && <div className="mb-3 text-[12.5px] text-amber-700">Read-only: changing the assistant's settings requires the admin:system permission.</div>}
      <div className="flex flex-col gap-4">
        <AiConnectionCard canTest={can('admin:system') || can('admin:config')} />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card title="Assistant">
            <div className="flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[13px] font-medium">Assistant switched on</div>
                  <div className="text-[12px] text-muted">The kill switch. Off: chat answers 503 and every AI feature is unavailable, whatever the provider.</div>
                </div>
                <Toggle checked={current.assistantEnabled} onChange={(v) => canWrite && set('assistantEnabled', v)} />
              </div>
              <Field label="Autonomy" hint="What runs without a confirmation. Outbound, configuration and destructive actions always wait.">
                <Select value={current.autonomy} disabled={!canWrite} onChange={(e) => set('autonomy', e.target.value as Editable['autonomy'])} options={[{ value: 'confirm_all', label: 'Confirm every change' }, { value: 'auto_low', label: 'Auto-apply low-risk internal writes (work notes, tasks, links, watching, time)' }]} />
              </Field>
              <Field label="Reasoning effort" hint="How much the model deliberates per reply (models that support it). Low is fastest and cheapest.">
                <Select value={current.effort} disabled={!canWrite} onChange={(e) => set('effort', e.target.value as Editable['effort'])} options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} />
              </Field>
              <div>
                <div className="text-[13px] font-medium mb-1.5">Features</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
                  {current.features.map((f) => (
                    <div key={f} className="flex items-center justify-between gap-3 text-[12.5px]">
                      <span className={current.disabledFeatures.includes(f) ? 'text-muted' : 'text-default'}>{FEATURE_LABELS[f] ?? f}</span>
                      <Toggle checked={!current.disabledFeatures.includes(f)} onChange={(v) => canWrite && toggleFeature(f, v)} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Card>

          <Card title="Limits">
            <div className="flex flex-col gap-4">
              <Field label="Daily token budget per person" hint="Input plus output tokens per person per day (UTC). 0 means unlimited.">
                <Input type="number" min={0} max={100000000} step={1000} value={current.dailyTokenBudget} disabled={!canWrite} onChange={(e) => set('dailyTokenBudget', Math.max(0, Math.round(Number(e.target.value) || 0)))} />
              </Field>
              <Field label="Reply timeout (seconds)" hint="Wall-clock budget for one reply including tool calls; 15 to 600.">
                <Input type="number" min={15} max={600} value={current.turnTimeoutSeconds} disabled={!canWrite} onChange={(e) => set('turnTimeoutSeconds', Math.round(Number(e.target.value) || 0))} />
              </Field>
              <Field label="Conversation retention (days)" hint="Conversations untouched for longer are deleted nightly. 0 keeps them forever; otherwise at least 7.">
                <Input type="number" min={0} max={3650} value={current.retentionDays} disabled={!canWrite} onChange={(e) => set('retentionDays', Math.round(Number(e.target.value) || 0))} />
              </Field>
              <div className="rounded-lg border border-default bg-app px-3 py-2 text-[12.5px] text-muted">
                <span className="font-medium text-default">Rate limit:</span> {current.rateLimitPerMinute} messages per minute per person, on top of the API-wide limit. Fixed in the deployment.
              </div>
              <div className="pt-2 border-t border-default">
                <div className="text-[13px] font-medium mb-0.5">Triage on arrival</div>
                <div className="text-[12px] text-muted mb-3">A moment after a ticket is raised Grady classifies it, recommends an owner and looks for duplicates. Priority is never changed without a person.</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Apply without asking at (% confidence)" hint="Below it the category and the owner wait as proposals on the ticket; 50 to 100.">
                    <Input type="number" min={50} max={100} value={current.triage.autoApplyConfidence} disabled={!canWrite} onChange={(e) => setTriage({ autoApplyConfidence: Math.round(Number(e.target.value) || 0) })} />
                  </Field>
                  <Field label="Alert storm window (minutes)" hint="Similar tickets opened within it count towards a storm; 5 to 1440.">
                    <Input type="number" min={5} max={1440} value={current.triage.stormWindowMinutes} disabled={!canWrite} onChange={(e) => setTriage({ stormWindowMinutes: Math.round(Number(e.target.value) || 0) })} />
                  </Field>
                  <Field label="Storm threshold (tickets)" hint="This many look-alikes in the window, the new ticket included; 2 to 50.">
                    <Input type="number" min={2} max={50} value={current.triage.stormThreshold} disabled={!canWrite} onChange={(e) => setTriage({ stormThreshold: Math.round(Number(e.target.value) || 0) })} />
                  </Field>
                  <div className="flex items-start justify-between gap-3 pt-5">
                    <div className="text-[12.5px]">
                      <div className="font-medium">Link machine-raised duplicates</div>
                      <div className="text-muted text-[12px]">Monitoring and SIEM tickets that look like an open one are linked as duplicates of the oldest.</div>
                    </div>
                    <Toggle checked={current.triage.stormAutoLink} onChange={(v) => canWrite && setTriage({ stormAutoLink: v })} />
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </div>

        <Card title="Usage" actions={<PeriodPicker days={days} onChange={setDays} />}>
          {usage.isLoading && <LoadingBlock />}
          {usage.error && <ErrorBlock error={usage.error} retry={() => usage.refetch()} />}
          {u && (
            <div className="flex flex-col gap-5">
              <KpiGrid
                columns={4}
                items={[
                  { label: 'Replies', value: fmt(u.totals.turns), hint: `${fmt(u.totals.conversations)} conversations`, icon: <Bot className="h-4 w-4" />, spark: u.series.map((d) => d.turns) },
                  { label: 'People', value: fmt(u.totals.users), hint: 'asked at least once', icon: <Users className="h-4 w-4" /> },
                  { label: 'Tokens', value: compact(u.totals.inputTokens + u.totals.outputTokens), hint: `${compact(u.totals.inputTokens)} in · ${compact(u.totals.outputTokens)} out · ${u.totals.cacheHitPct}% from cache`, icon: <Coins className="h-4 w-4" />, spark: u.series.map((d) => d.inputTokens + d.outputTokens) },
                  { label: 'Tool calls', value: fmt(u.totals.toolCalls), hint: `${fmt(u.guardrails.proposals)} proposals`, icon: <Wrench className="h-4 w-4" />, spark: u.series.map((d) => d.toolCalls) },
                  { label: 'Feedback', value: `${fmt(u.totals.up)} / ${fmt(u.totals.down)}`, hint: 'helpful / not helpful', icon: <ThumbsUp className="h-4 w-4" />, tone: u.totals.down > u.totals.up ? 'warn' : 'default' },
                  { label: 'Average reply', value: u.totals.avgDurationMs ? `${(u.totals.avgDurationMs / 1000).toFixed(1)} s` : '—', hint: `${fmt(limitHits)} hit the time or tool limit`, icon: <Timer className="h-4 w-4" />, tone: limitHits ? 'warn' : 'default' },
                  { label: 'Fenced', value: fmt(u.guardrails.tenantFence + u.guardrails.answerFence), hint: `${fmt(u.guardrails.tenantFence)} tenant · ${fmt(u.guardrails.answerFence)} answer`, icon: <ShieldCheck className="h-4 w-4" />, tone: u.guardrails.tenantFence ? 'bad' : 'good' },
                  { label: 'Denied tool calls', value: fmt(u.guardrails.forbiddenToolCalls), hint: `${fmt(u.guardrails.invalidToolCalls)} invalid · ${fmt(u.guardrails.toolErrors)} failed`, icon: <ShieldCheck className="h-4 w-4" />, tone: u.guardrails.forbiddenToolCalls ? 'warn' : 'default' },
                ]}
              />
              <div>
                <div className="text-[13px] font-medium mb-2">Replies and tool calls per day</div>
                <TrendChart data={u.series as unknown as Record<string, unknown>[]} x="day" kind="bar" height={200} series={[{ key: 'turns', label: 'Replies' }, { key: 'toolCalls', label: 'Tool calls' }]} />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat label="Answered" value={fmt(outcomes.answered ?? 0)} />
                <Stat label="Actions done" value={fmt(outcomes.done ?? 0)} tone="good" />
                <Stat label="Cancelled or stale" value={fmt((outcomes.cancelled ?? 0) + (outcomes.stale ?? 0))} />
                <Stat label="Refused / timed out" value={fmt((outcomes.refused ?? 0) + (outcomes.timeout ?? 0) + (outcomes.tool_limit ?? 0))} tone={(outcomes.refused ?? 0) + limitHits ? 'warn' : 'default'} />
              </div>
              <div>
                <div className="text-[13px] font-medium mb-2">By tool</div>
                <DataTable dense columns={toolColumns} rows={u.byTool.map((r) => ({ ...r, id: r.tool }))} empty="No tool calls in this period." />
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
