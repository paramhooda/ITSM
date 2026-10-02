import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarClock, FileText, Download, Phone, Mail, Layers } from 'lucide-react';
import { PageHeader, Card, Badge, Tabs, Select, KeyValue, LoadingBlock, ErrorBlock, EmptyState, ProgressBar } from '@/components/ui';
import { download, ApiError } from '@/api/client';
import { fmtDate, fmtDateTime, fmtDuration, fmtBytes, fmtPct, titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ServiceTeamCard } from '@/components/portal/ServiceTeamCard';
import { ScopeTable } from '@/components/portal/ScopeTable';
import { SlaTargetsTable } from '@/components/portal/SlaTargetsTable';
import { EntitlementBars } from '@/components/portal/EntitlementBars';
import { SlaGauge } from '@/components/dashboards/SlaGauge';
import { portalApi, pk, type PortalContract } from '@/components/portal/api';
import { CONTRACT_STATUS_COLORS } from '@/lib/statusColors';

type Tab = 'scope' | 'sla' | 'entitlements' | 'escalation' | 'documents';

const STATUS_COLOR = CONTRACT_STATUS_COLORS;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function countdown(days: number) {
  if (days < 0) return { text: `Ended ${-days} day${days === -1 ? '' : 's'} ago`, tone: 'bad' as const };
  if (days === 0) return { text: 'Ends today', tone: 'warn' as const };
  if (days <= 90) return { text: `Ends in ${days} day${days === 1 ? '' : 's'}`, tone: 'warn' as const };
  return { text: `Ends in ${days} days`, tone: 'good' as const };
}

function SupportHours({ c }: { c: PortalContract }) {
  const h = c.supportHours;
  if (!h) return <span className="text-muted">Not specified</span>;
  if (h.is24x7) return <span>24x7 · {h.timezone}</span>;
  const days = DAYS.filter((d) => (h.hours[d] ?? []).length);
  const slot = days.length ? h.hours[days[0]].map((s) => `${s[0]}–${s[1]}`).join(', ') : '';
  const sameEveryDay = days.every((d) => JSON.stringify(h.hours[d]) === JSON.stringify(h.hours[days[0]]));
  return (
    <span>
      {h.name}
      {days.length > 0 && sameEveryDay ? ` · ${titleCase(days[0])}–${titleCase(days[days.length - 1])} ${slot}` : ''} · {h.timezone}
    </span>
  );
}

function ContractCard({ c, selected, onSelect }: { c: PortalContract; selected: boolean; onSelect: () => void }) {
  const cd = countdown(c.daysToExpiry);
  const total = Math.max(1, (new Date(c.endDate).getTime() - new Date(c.startDate).getTime()) / 86_400_000);
  const elapsed = Math.min(total, Math.max(0, (Date.now() - new Date(c.startDate).getTime()) / 86_400_000));
  return (
    <button onClick={onSelect} className={cn('card text-left px-4 py-3 transition-colors', selected ? 'border-brand-500 ring-2 ring-brand-500/20' : 'hover:border-brand-300')}>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12px] text-muted">{c.number}</span>
        <Badge color={STATUS_COLOR[c.status] ?? 'slate'}>{titleCase(c.status)}</Badge>
        {c.typeLabel && <span className="text-[12px] text-muted">{c.typeLabel}</span>}
      </div>
      <div className="mt-1 font-medium text-[14px]">{c.name}</div>
      <div className="mt-2 text-[12.5px] text-muted flex flex-wrap gap-x-3 gap-y-1">
        <span>
          {fmtDate(c.startDate)} – {fmtDate(c.endDate)}
        </span>
        <span className={{ good: 'text-emerald-600', warn: 'text-amber-600', bad: 'text-red-600' }[cd.tone]}>{cd.text}</span>
        {c.autoRenew && <span>Renews automatically</span>}
      </div>
      <ProgressBar pct={(elapsed / total) * 100} tone="neutral" className="mt-2" />
      <div className="mt-2 text-[12px] text-muted inline-flex items-center gap-1.5">
        <CalendarClock className="h-3.5 w-3.5" /> <SupportHours c={c} />
      </div>
    </button>
  );
}

export default function PortalServicesPage() {
  const me = useQuery({ queryKey: pk.me, queryFn: portalApi.me, staleTime: 5 * 60_000 });
  const view = useQuery({ queryKey: pk.services, queryFn: portalApi.services, staleTime: 60_000 });
  const [days, setDays] = useState(30);
  const sla = useQuery({ queryKey: pk.sla(days), queryFn: () => portalApi.sla(days), staleTime: 60_000 });
  const [tab, setTab] = useState<Tab>('scope');
  const [contractId, setContractId] = useState<string | null>(null);
  const contracts = view.data?.contracts ?? [];
  const contract = useMemo(() => contracts.find((c) => c.id === contractId) ?? contracts[0] ?? null, [contracts, contractId]);

  async function openDoc(id: string, filename: string) {
    try {
      await download(`/attachments/${id}/download`, filename);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Download failed');
    }
  }

  if (view.isLoading) return <LoadingBlock label="Loading your services…" />;
  if (view.isError) return <ErrorBlock error={view.error} retry={() => view.refetch()} />;

  const docsCount = contract?.documents.length ?? 0;
  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'scope', label: 'What is covered' },
    { key: 'sla', label: 'Service levels' },
    { key: 'entitlements', label: 'Entitlements', count: view.data?.entitlements.length },
    { key: 'escalation', label: 'Escalation' },
    { key: 'documents', label: 'Documents', count: docsCount },
  ];

  return (
    <div className="max-w-6xl">
      <PageHeader title="Services & contracts" subtitle="Your agreements with us, in plain language: what is covered, how fast we respond and what you are entitled to." />
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
        <div className="flex flex-col gap-4 min-w-0">
          {contracts.length === 0 ? (
            <Card>
              <EmptyState icon={<FileText className="h-5 w-5" />} title="No active contract on record" description="Contact your account manager if you believe this is wrong." />
            </Card>
          ) : (
            <div className={cn('grid gap-3', contracts.length > 1 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1')}>
              {contracts.map((c) => (
                <ContractCard key={c.id} c={c} selected={contract?.id === c.id} onSelect={() => setContractId(c.id)} />
              ))}
            </div>
          )}

          {(view.data?.services.length ?? 0) > 0 && (
            <Card title="Covered services" padded={false}>
              <ul className="divide-y divide-[var(--border)]">
                {view.data!.services.map((s) => (
                  <li key={s.id} className="px-4 py-2.5 flex items-start gap-3">
                    <span className="h-7 w-7 rounded-md bg-brand-600/10 text-brand-700 flex items-center justify-center shrink-0">
                      <Layers className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium">{s.name}</div>
                      {s.description && <div className="text-[12px] text-muted">{s.description}</div>}
                      <div className="text-[11.5px] text-subtle mt-0.5 flex flex-wrap gap-x-3">
                        {s.teamName && <span>Delivered by {s.teamName}</span>}
                        {s.slaPolicyName && <span>Service levels: {s.slaPolicyName}</span>}
                        {s.contractNumbers.length > 0 && <span>{s.contractNumbers.join(', ')}</span>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {contract && (
            <Card padded={false}>
              <Tabs tabs={tabs} value={tab} onChange={setTab} className="px-2" />
              <div className="p-4">
                {tab === 'scope' && (
                  <div className="flex flex-col gap-4">
                    <KeyValue
                      columns={2}
                      items={[
                        { label: 'Sites covered', value: contract.allSites ? 'All your sites' : contract.sites.map((s) => s.name).join(', ') || '—' },
                        { label: 'Services', value: contract.services.map((s) => s.name).join(', ') || '—' },
                        ...(contract.description ? [{ label: 'About this contract', value: contract.description, span: 2 as const }] : []),
                        ...(contract.exclusions ? [{ label: 'Not included', value: contract.exclusions, span: 2 as const }] : []),
                      ]}
                    />
                    <ScopeTable groups={contract.scopeGroups} />
                  </div>
                )}
                {tab === 'sla' && (
                  <div className="flex flex-col gap-5">
                    {(contract.responseCommitment || contract.resolutionCommitment) && (
                      <KeyValue columns={2} items={[...(contract.responseCommitment ? [{ label: 'Response commitment', value: contract.responseCommitment }] : []), ...(contract.resolutionCommitment ? [{ label: 'Resolution commitment', value: contract.resolutionCommitment }] : [])]} />
                    )}
                    <div>
                      <div className="text-[13px] font-semibold mb-2">
                        Targets {contract.slaPolicy ? <span className="text-muted font-normal">· {contract.slaPolicy.name}</span> : null}
                      </div>
                      <SlaTargetsTable targets={contract.slaPolicy?.targets ?? []} calendarName={contract.slaPolicy?.calendarName ?? contract.supportHours?.name} />
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-[13px] font-semibold">How we did</div>
                        <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} options={[{ value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }]} className="w-auto h-8 py-0 text-[12.5px]" />
                      </div>
                      {sla.isLoading ? (
                        <LoadingBlock />
                      ) : sla.data ? (
                        <div className="flex flex-col gap-3">
                          <div className="grid grid-cols-1 md:grid-cols-[auto_minmax(0,1fr)] gap-x-8 gap-y-4 items-start">
                            <div className="flex flex-col gap-3">
                              <SlaGauge pct={sla.data.totals.compliancePct} met={sla.data.totals.met} breached={sla.data.totals.breached} label={`Targets met · ${days} days`} breachedLabel="missed" />
                              <div className="text-[12px] text-muted tabular-nums">
                                {sla.data.totals.completed} completed · {sla.data.totals.running} in progress
                                {sla.data.totals.overdueRunning ? <span className="text-red-600"> · {sla.data.totals.overdueRunning} overdue</span> : null}
                              </div>
                            </div>
                            {sla.data.byPriority.length > 0 ? (
                              <div className="overflow-auto">
                                <table className="table">
                                  <thead>
                                    <tr>
                                      <th>Priority</th>
                                      <th>Met</th>
                                      <th>Missed</th>
                                      <th>In progress</th>
                                      <th>Targets met</th>
                                      <th className="hidden sm:table-cell">Avg. time</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {sla.data.byPriority.map((g) => (
                                      <tr key={g.key}>
                                        <td>{g.label}</td>
                                        <td className="tabular-nums">{g.met}</td>
                                        <td className="tabular-nums">{g.breached}</td>
                                        <td className="tabular-nums">{g.running}</td>
                                        <td className="tabular-nums">{g.compliancePct === null ? '—' : fmtPct(g.compliancePct)}</td>
                                        <td className="tabular-nums hidden sm:table-cell">{g.avgElapsedMinutes === null ? '—' : fmtDuration(g.avgElapsedMinutes)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            ) : (
                              <div className="text-[12.5px] text-muted self-center">No targets were completed in this period yet.</div>
                            )}
                          </div>
                          {sla.data.byMetric.length > 0 && (
                            <div className="text-[12px] text-muted flex flex-wrap gap-x-4 gap-y-1">
                              {sla.data.byMetric.map((g) => (
                                <span key={g.key}>
                                  {titleCase(g.label)}: {g.compliancePct === null ? 'no data' : fmtPct(g.compliancePct)}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
                {tab === 'entitlements' && <EntitlementBars entitlements={(view.data?.entitlements ?? []).filter((e) => contracts.length <= 1 || e.contractNumber === contract.number)} />}
                {tab === 'escalation' && (
                  contract.escalationMatrix.length === 0 ? (
                    <div className="text-[12.5px] text-muted">No escalation matrix is defined for this contract. Reach your account manager for escalations.</div>
                  ) : (
                    <div className="overflow-auto">
                      <table className="table">
                        <thead>
                          <tr>
                            <th className="w-[70px]">Level</th>
                            <th>Escalation point</th>
                            <th className="hidden sm:table-cell">After</th>
                            <th>Contact</th>
                          </tr>
                        </thead>
                        <tbody>
                          {contract.escalationMatrix.map((m, i) => (
                            <tr key={i}>
                              <td>
                                <Badge color={['green', 'amber', 'orange', 'red'][Math.min(3, (m.level ?? 1) - 1)]}>L{m.level ?? i + 1}</Badge>
                              </td>
                              <td>
                                <div className="text-[13px] font-medium">{m.name ?? m.mspContactName ?? m.contact?.name ?? '—'}</div>
                                {m.mspContactName && m.name && <div className="text-[12px] text-muted">{m.mspContactName}</div>}
                              </td>
                              <td className="hidden sm:table-cell text-[12.5px] text-muted">{m.afterMinutes ? fmtDuration(m.afterMinutes) : '—'}</td>
                              <td className="text-[12.5px]">
                                {m.contact ? (
                                  <div className="flex flex-col">
                                    <span>{m.contact.name}{m.contact.title ? ` · ${m.contact.title}` : ''}</span>
                                    <span className="flex flex-wrap gap-x-3 text-muted">
                                      {m.contact.email && <a className="inline-flex items-center gap-1 hover:underline" href={`mailto:${m.contact.email}`}><Mail className="h-3 w-3" />{m.contact.email}</a>}
                                      {m.contact.phone && <a className="inline-flex items-center gap-1 hover:underline" href={`tel:${m.contact.phone}`}><Phone className="h-3 w-3" />{m.contact.phone}</a>}
                                    </span>
                                  </div>
                                ) : (
                                  <span className="text-muted">Via the service desk</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                )}
                {tab === 'documents' && (
                  contract.documents.length === 0 ? (
                    <div className="text-[12.5px] text-muted">No documents have been shared for this contract yet.</div>
                  ) : (
                    <ul className="divide-y divide-[var(--border)] rounded-lg border border-default">
                      {contract.documents.map((d) => (
                        <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                          <FileText className="h-4 w-4 text-subtle shrink-0" />
                          <div className="min-w-0 flex-1">
                            <button className="text-[13px] font-medium hover:underline truncate max-w-full block text-left" onClick={() => openDoc(d.id, d.filename)}>
                              {d.title || d.filename}
                            </button>
                            <div className="text-[11.5px] text-muted">
                              {titleCase(d.docType)} · {fmtBytes(d.size)} · {fmtDateTime(d.createdAt)}
                            </div>
                          </div>
                          <button className="h-7 w-7 rounded-md flex items-center justify-center text-subtle hover:bg-surface-2 hover:text-default" title="Download" onClick={() => openDoc(d.id, d.filename)}>
                            <Download className="h-4 w-4" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
                )}
              </div>
            </Card>
          )}
        </div>
        <ServiceTeamCard me={me.data} />
      </div>
    </div>
  );
}
