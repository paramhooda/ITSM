import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Users, Shield, UsersRound, ListChecks, Timer, ClipboardList, Mail, History, BookOpen, ExternalLink, AlertCircle, CheckCircle2, ChevronRight } from 'lucide-react';
import { get } from '@/api/client';
import { StatTile, LoadingBlock } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { isNotFound } from '@/components/admin/api';
import { fmtNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { OPTION_TYPES } from '@itsm/shared';

interface OutboxStats {
  byStatus: Record<string, number>;
  recent: unknown[];
}

interface AttentionItem {
  key: string;
  label: string;
  count: number;
  tone: 'bad' | 'warn' | 'info';
  to: string;
}

function useCount<T>(key: string[], path: string, query: Record<string, unknown> | undefined, pick: (d: T) => number, enabled = true) {
  return useQuery({ queryKey: key, queryFn: async () => pick(await get<T>(path, query)), enabled, retry: false });
}

export default function OverviewPage() {
  const can = useAuthStore((s) => s.can);
  const navigate = useNavigate();
  const canUsers = can('admin:users');
  const canConfig = can('admin:config');
  const canAttention = can('admin:config', 'admin:system');
  const attention = useQuery({ queryKey: ['admin', 'attention'], queryFn: () => get<{ items: AttentionItem[] }>('/admin/attention'), enabled: canAttention, retry: false, refetchInterval: 60_000 });
  const users = useCount<{ total: number }>(['admin', 'overview', 'users'], '/iam/users', { pageSize: 1 }, (d) => d.total, canUsers);
  const roles = useCount<unknown[]>(['admin', 'overview', 'roles'], '/iam/roles', undefined, (d) => d.length, canUsers);
  const teams = useCount<unknown[]>(['admin', 'overview', 'teams'], '/iam/teams', undefined, (d) => d.length, true);
  const options = useCount<{ type: string; isActive: boolean }[]>(['admin', 'overview', 'options'], '/config/options', undefined, (d) => d.filter((o) => o.isActive).length, canConfig);
  const sla = useCount<{ items: unknown[] }>(['admin', 'overview', 'sla'], '/sla/policies', undefined, (d) => d.items.length, true);
  const catalog = useCount<{ items: { isActive: boolean }[] }>(['admin', 'overview', 'catalog'], '/catalog/items', undefined, (d) => d.items.filter((i) => i.isActive).length, true);
  const outbox = useQuery({ queryKey: ['admin', 'overview', 'outbox'], queryFn: () => get<OutboxStats>('/notifications/outbox'), enabled: can('admin:system', 'admin:config'), retry: false });
  const audit = useQuery({ queryKey: ['admin', 'overview', 'audit'], queryFn: () => get<{ total?: number; count?: number; byAction?: Record<string, number> }>('/audit/summary', { days: 7 }), enabled: can('admin:audit'), retry: false });

  const val = (q: { data?: number; isError?: boolean; isLoading?: boolean }) => (q.isError ? '—' : q.isLoading ? '…' : q.data ?? '—');
  const pending = outbox.data?.byStatus?.pending ?? 0;
  const failed = outbox.data?.byStatus?.failed ?? 0;
  const sent = outbox.data?.byStatus?.sent ?? 0;
  const auditCount = audit.isError ? (isNotFound(audit.error) ? 'n/a' : '—') : audit.isLoading ? '…' : audit.data?.total ?? audit.data?.count ?? (audit.data?.byAction ? Object.values(audit.data.byAction).reduce((a, b) => a + b, 0) : '—');
  const items = (attention.data?.items ?? []).filter((i) => i.count > 0);

  return (
    <div>
      <SectionHeader title="Overview" description="The operating model, SLA & automation rules, access and system health of the platform at a glance." />
      {canAttention && (
        <div className="card p-4 mb-4">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="font-semibold text-[13px] inline-flex items-center gap-1.5"><AlertCircle className="h-4 w-4 text-subtle" /> Needs attention</div>
            <span className="text-[12px] text-subtle">Failures, expiring access and configuration gaps · refreshed every minute</span>
          </div>
          {attention.isLoading ? (
            <LoadingBlock label="Checking…" />
          ) : attention.isError ? (
            <div className="text-[13px] text-muted">Could not load what needs attention right now.</div>
          ) : items.length === 0 ? (
            <div className="text-[13px] text-emerald-700 inline-flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4" /> All clear — nothing needs your attention right now.</div>
          ) : (
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {items.map((i) => (
                <li key={i.key}>
                  <Link to={i.to} className="flex items-center gap-3 rounded-lg border border-default px-3 py-2 hover:bg-surface-2/70 hover:border-strong transition-colors">
                    <span className={cn('h-2 w-2 rounded-full shrink-0', i.tone === 'bad' ? 'bg-red-500' : i.tone === 'warn' ? 'bg-amber-500' : 'bg-blue-500')} />
                    <span className="flex-1 text-[13px] min-w-0 truncate">{i.label}</span>
                    <span className={cn('tnum font-semibold text-[13px]', i.tone === 'bad' ? 'text-red-600' : i.tone === 'warn' ? 'text-amber-600' : 'text-default')}>{fmtNumber(i.count)}</span>
                    <ChevronRight className="h-3.5 w-3.5 text-subtle shrink-0" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {canUsers && <StatTile label="Users" value={val(users)} icon={<Users className="h-4 w-4" />} to={'/admin/users'} />}
        {canUsers && <StatTile label="Roles" value={val(roles)} icon={<Shield className="h-4 w-4" />} to={'/admin/roles'} />}
        {canUsers && <StatTile label="Teams" value={val(teams)} icon={<UsersRound className="h-4 w-4" />} to={'/admin/teams'} />}
        {canConfig && <StatTile label="Option list entries" value={val(options)} hint={`${OPTION_TYPES.length} configurable lists`} icon={<ListChecks className="h-4 w-4" />} to={'/admin/options'} />}
        {canConfig && <StatTile label="SLA policies" value={val(sla)} icon={<Timer className="h-4 w-4" />} to={'/admin/sla'} />}
        {canConfig && <StatTile label="Catalog items" value={val(catalog)} hint="active request types" icon={<ClipboardList className="h-4 w-4" />} to={'/admin/catalog'} />}
        {can('admin:system', 'admin:config') && (
          <StatTile label="Notification outbox" value={outbox.isError ? '—' : outbox.isLoading ? '…' : pending} hint={outbox.data ? `${sent} sent · ${failed} failed` : 'pending messages'} tone={failed > 0 ? 'bad' : pending > 50 ? 'warn' : 'default'} icon={<Mail className="h-4 w-4" />} to={'/admin/outbox'} />
        )}
        {can('admin:audit') && <StatTile label="Audit activity" value={auditCount} hint="last 7 days" icon={<History className="h-4 w-4" />} to={'/admin/audit'} />}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
        <div className="card p-4">
          <div className="font-semibold text-[13px] mb-1">Getting started</div>
          <ol className="text-[13px] text-muted list-decimal pl-4 space-y-1">
            <li>Review option lists (categories, statuses, priorities) and the priority matrix.</li>
            <li>Define business calendars, holidays and SLA policies; mark one policy as the default.</li>
            <li>Set up teams and users, then assignment and escalation rules.</li>
            <li>Tune notification templates and rules; publish request catalog items for the portal.</li>
          </ol>
        </div>
        <div className="card p-4">
          <div className="font-semibold text-[13px] mb-1">Developer resources</div>
          <div className="text-[13px] text-muted mb-2">The platform exposes every administration operation through the REST API.</div>
          <a href="/api/docs" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[13px] text-brand-600 hover:underline">
            <BookOpen className="h-4 w-4" /> API documentation <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </div>
  );
}
