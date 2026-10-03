import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Server, AlertOctagon, EyeOff, Radar, Link2, Boxes, Plus, Upload, Download, Workflow } from 'lucide-react';
import { PageHeader, Button, Select, ErrorBlock, Badge } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel, RowList, Stat } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { SlaGauge } from '@/components/dashboards/SlaGauge';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { fmtNumber, fmtPct, relativeTime, titleCase } from '@/lib/format';
import { CRITICALITY_COLORS, CI_STATUS_COLORS } from '@/lib/statusColors';
import { CmdbNav } from '@/components/cmdb/CmdbNav';
import { CiTypeIcon } from '@/components/cmdb/CiTypeBadge';
import { cmdbApi, cmdbKeys, RUN_COLORS } from '@/components/cmdb/api';
import { humanizeAction } from '@/components/audit/AuditTrail';

/** Configuration (CMDB) home: health of the data, what needs attention, where discovery stands. */
export default function CmdbOverviewPage() {
  const navigate = useNavigate();
  const can = useAuthStore((s) => s.can);
  const { state, set } = useListState();
  const customers = useCustomersLookup();
  const q = useQuery({ queryKey: cmdbKeys.overview(state.customerId), queryFn: () => cmdbApi.overview(state.customerId), refetchInterval: 60_000, placeholderData: (p) => p });
  const d = q.data;
  const cust = state.customerId ? `&customerId=${state.customerId}` : '';
  const toCis = (qs: string) => navigate(`/cmdb/cis?${qs.replace(/^&/, '')}${cust}`);
  const tone = (v: number | null | undefined, good: number, warn: number) => (v === null || v === undefined ? 'default' : v >= good ? 'good' : v >= warn ? 'warn' : 'bad');

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Configuration"
        subtitle="Configuration items, their relationships and the business services they support"
        actions={
          <>
            <Select className="w-48 h-8 py-0 text-[13px]" value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value }, false)} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
            {can('cmdb:manage') && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/cmdb/cis?new=1')}>New CI</Button>}
          </>
        }
      />
      <CmdbNav />
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}

      <InsightBand
        id="cmdb-overview"
        loading={q.isLoading}
        columns={5}
        summary={d ? `${fmtNumber(d.totals.total)} configuration items · ${fmtNumber(d.totals.openIncidents)} open tickets on CIs` : undefined}
        kpis={
          d
            ? [
                { label: 'Configuration items', value: fmtNumber(d.totals.total), icon: <Server className="h-4 w-4" />, hint: `${fmtNumber(d.totals.active)} active · ${fmtNumber(d.totals.retired)} retired`, onClick: () => toCis('') },
                { label: 'Critical', value: fmtNumber(d.totals.critical), tone: d.totals.critical ? 'bad' : 'good', icon: <AlertOctagon className="h-4 w-4" />, hint: `${fmtNumber(d.totals.openIncidents)} open tickets on CIs`, onClick: () => toCis('criticality=critical') },
                { label: 'Stale', value: fmtNumber(d.totals.stale), tone: d.totals.stale ? 'warn' : 'good', icon: <EyeOff className="h-4 w-4" />, hint: 'discovered, not seen for 30 days', onClick: () => toCis('stale=true') },
                { label: 'Without relationships', value: fmtNumber(d.totals.withoutRelationships), tone: d.totals.withoutRelationships ? 'warn' : 'good', icon: <Link2 className="h-4 w-4" />, hint: 'active CIs no map can reach', onClick: () => toCis('withoutRelationships=true&status=active') },
                { label: 'Findings to review', value: fmtNumber(d.discovery.pendingFindings), tone: d.discovery.pendingFindings ? 'warn' : 'good', icon: <Radar className="h-4 w-4" />, hint: `${fmtNumber(d.discovery.newFindings)} new devices · ${fmtNumber(d.discovery.activeSources)} active sources`, to: '/cmdb/discovery/findings' },
              ]
            : []
        }
        panels={
          d && (
            <>
              <Panel title="By class" subtitle="Click a class to list its items" to="/cmdb/classes" toLabel="CI classes">
                <BreakdownBar dense items={d.byType.slice(0, 12).map((t) => ({ label: t.name, value: t.count, color: t.color, href: `/cmdb/cis?typeKey=${t.key}${cust}` }))} emptyText="No configuration items yet" />
              </Panel>
              <Panel title="Data health" subtitle="How trustworthy the CMDB is right now">
                <div className="flex flex-wrap items-center gap-5">
                  <SlaGauge pct={d.health.completenessPct} label="Completeness" target={90} size={112} stroke={10} />
                  <div className="grid grid-cols-1 gap-3 min-w-[150px] flex-1">
                    <Stat label="Freshness" value={fmtPct(d.health.freshnessPct, 0)} tone={tone(d.health.freshnessPct, 90, 75)} />
                    <Stat label="Relationships" value={fmtPct(d.health.relationshipCoveragePct, 0)} tone={tone(d.health.relationshipCoveragePct, 80, 60)} />
                    <Stat label="No owner · no site" value={`${fmtNumber(d.totals.unowned)} · ${fmtNumber(d.totals.noSite)}`} tone={d.totals.unowned + d.totals.noSite > 0 ? 'warn' : 'good'} />
                  </div>
                </div>
              </Panel>
            </>
          )
        }
      />

      {d && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Panel title="Most impacted" subtitle="CIs with the most open tickets">
            <RowList dense empty="No open tickets on CIs" items={d.topImpacted.map((c) => ({ key: c.id, primary: c.name, secondary: c.typeName, right: <Badge color="amber">{c.openTickets} open</Badge>, href: `/cmdb/cis/${c.id}?tab=tickets` }))} />
          </Panel>
          <Panel title="By criticality" subtitle="Where attention concentrates">
            <BreakdownBar dense items={d.byCriticality.map((b) => ({ label: titleCase(b.criticality), value: b.count, color: CRITICALITY_COLORS[b.criticality] ?? null, href: `/cmdb/cis?criticality=${b.criticality}${cust}` }))} />
            <div className="mt-3 pt-3 border-t border-default">
              <BreakdownBar dense items={d.byStatus.map((b) => ({ label: titleCase(b.status), value: b.count, color: CI_STATUS_COLORS[b.status] ?? null, href: `/cmdb/cis?status=${b.status}${cust}` }))} />
            </div>
          </Panel>
          <Panel
            title="Discovery"
            subtitle={d.discovery.lastRun ? <>Last run <Badge color={RUN_COLORS[d.discovery.lastRun.status] ?? 'slate'} dot>{d.discovery.lastRun.status}</Badge> {d.discovery.lastRun.finishedAt ? relativeTime(d.discovery.lastRun.finishedAt) : d.discovery.lastRun.startedAt ? relativeTime(d.discovery.lastRun.startedAt) : ''} · {d.discovery.lastRun.sourceName}</> : 'No runs yet'}
            to="/cmdb/discovery"
            toLabel="Open discovery"
          >
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Sources" value={`${fmtNumber(d.discovery.activeSources)}/${fmtNumber(d.discovery.sources)}`} />
              <Stat label="To review" value={fmtNumber(d.discovery.pendingFindings)} tone={d.discovery.pendingFindings ? 'warn' : 'good'} />
              <Stat label="New devices" value={fmtNumber(d.discovery.newFindings)} tone={d.discovery.newFindings ? 'warn' : 'default'} />
            </div>
            <div className="mt-3 pt-3 border-t border-default">
              <div className="text-[12px] text-muted mb-1.5">Recent changes</div>
              <RowList
                dense
                empty="No recent changes"
                items={d.recentChanges.slice(0, 6).map((c) => ({ key: c.id, leading: <CiTypeIcon icon={null} className="h-3.5 w-3.5 text-subtle" />, primary: c.ciName ?? 'Configuration item', secondary: `${humanizeAction(c.action)}${c.actorName ? ` · ${c.actorName}` : ''}`, right: relativeTime(c.at), href: c.entityId ? `/cmdb/cis/${c.entityId}?tab=history` : undefined }))}
              />
            </div>
          </Panel>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
        <span>Quick actions:</span>
        <Button size="sm" variant="outline" icon={<Workflow className="h-3.5 w-3.5" />} onClick={() => navigate('/cmdb/map')}>Service map</Button>
        <Button size="sm" variant="outline" icon={<Boxes className="h-3.5 w-3.5" />} onClick={() => toCis('hasAsset=false')}>CIs without an asset</Button>
        <Button size="sm" variant="outline" icon={<Download className="h-3.5 w-3.5" />} onClick={() => navigate('/cmdb/cis?export=1')}>Export</Button>
        {can('cmdb:manage') && <Button size="sm" variant="outline" icon={<Upload className="h-3.5 w-3.5" />} onClick={() => navigate('/cmdb/cis?import=1')}>Import</Button>}
      </div>
    </div>
  );
}
