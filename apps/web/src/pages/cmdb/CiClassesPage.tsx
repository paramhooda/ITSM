import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Settings2, ChevronRight, Layers, Share2 } from 'lucide-react';
import { PageHeader, Button, Badge, SearchInput, ErrorBlock, LoadingBlock, EmptyState } from '@/components/ui';
import { Panel } from '@/components/dashboards/Panel';
import { useAuthStore } from '@/stores/auth';
import { fmtNumber, titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CmdbNav } from '@/components/cmdb/CmdbNav';
import { CiTypeIcon } from '@/components/cmdb/CiTypeBadge';
import { colorHex } from '@/components/cmdb/hooks';
import { cmdbApi, cmdbKeys, type CiTypeDef } from '@/components/cmdb/api';

/** CI class manager (read view): the class hierarchy, counts per class, attributes each class carries, and the relationship vocabulary. */
export default function CiClassesPage() {
  const navigate = useNavigate();
  const can = useAuthStore((s) => s.can);
  const types = useQuery({ queryKey: cmdbKeys.types, queryFn: () => cmdbApi.types(), staleTime: 300_000 });
  const overview = useQuery({ queryKey: cmdbKeys.overview(), queryFn: () => cmdbApi.overview(), staleTime: 60_000 });
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const counts = useMemo(() => new Map((overview.data?.byType ?? []).map((t) => [t.key, t.count])), [overview.data]);
  const classes = useMemo(() => {
    const all = (types.data?.types ?? []).filter((t) => t.isActive !== false);
    const needle = q.trim().toLowerCase();
    const byParent = new Map<string | null, CiTypeDef[]>();
    for (const t of all) byParent.set(t.parentKey ?? null, [...(byParent.get(t.parentKey ?? null) ?? []), t]);
    const rows: { type: CiTypeDef; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const t of (byParent.get(parent) ?? []).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name))) {
        rows.push({ type: t, depth });
        walk(t.key, depth + 1);
      }
    };
    walk(null, 0);
    // Types whose parent is inactive/unknown still show at the root.
    const seen = new Set(rows.map((r) => r.type.key));
    for (const t of all) if (!seen.has(t.key)) rows.push({ type: t, depth: 0 });
    return needle ? rows.filter((r) => r.type.name.toLowerCase().includes(needle) || r.type.key.includes(needle)) : rows;
  }, [types.data, q]);
  const current = classes.find((c) => c.type.key === selected)?.type ?? classes[0]?.type ?? null;
  const rels = types.data?.relationshipTypes ?? [];
  const total = [...counts.values()].reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="CI classes" subtitle="The classes a configuration item can belong to, what each one records, and how items relate" actions={can('admin:config') ? <Button size="sm" variant="outline" icon={<Settings2 className="h-4 w-4" />} onClick={() => navigate('/admin/ci-types')}>Manage classes</Button> : undefined} />
      <CmdbNav />
      {types.isError && <ErrorBlock error={types.error} retry={() => types.refetch()} />}
      {types.isLoading && <LoadingBlock />}
      {types.data && (
        <div className="grid grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)] gap-4 items-start">
          <div className="card overflow-hidden">
            <div className="p-2.5 border-b border-default">
              <SearchInput value={q} onChange={setQ} placeholder="Filter classes…" />
            </div>
            <ul className="max-h-[70vh] overflow-y-auto py-1">
              {classes.map(({ type: t, depth }) => {
                const n = counts.get(t.key) ?? 0;
                return (
                  <li key={t.key}>
                    <button onClick={() => setSelected(t.key)} className={cn('w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-2', current?.key === t.key && 'bg-brand-50/60')} style={{ paddingLeft: 12 + depth * 16 }}>
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-md shrink-0" style={{ background: `${colorHex(t.color)}1a`, color: colorHex(t.color) }}><CiTypeIcon icon={t.icon} className="h-3.5 w-3.5" /></span>
                      <span className={cn('truncate flex-1', n === 0 && 'text-muted')}>{t.name}</span>
                      <span className="tnum text-[12px] text-subtle">{n}</span>
                      <ChevronRight className="h-3.5 w-3.5 text-subtle" />
                    </button>
                  </li>
                );
              })}
              {classes.length === 0 && <li className="px-3 py-3 text-[12.5px] text-subtle">No classes match.</li>}
            </ul>
            <div className="px-3 py-2 border-t border-default text-[12px] text-muted">{fmtNumber(types.data.types.length)} classes · {fmtNumber(total)} items</div>
          </div>
          <div className="flex flex-col gap-4 min-w-0">
            {current ? (
              <>
                <div className="card px-5 py-4 flex flex-wrap items-start gap-3">
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl shrink-0" style={{ background: `${colorHex(current.color)}1a`, color: colorHex(current.color) }}><CiTypeIcon icon={current.icon} className="h-5 w-5" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap"><h2 className="text-[17px] font-semibold">{current.name}</h2><Badge color="slate" className="font-mono">{current.key}</Badge>{current.isSystem && <Badge color="indigo">system</Badge>}{current.parentKey && <span className="text-[12.5px] text-muted">extends <Link to="#" onClick={(e) => { e.preventDefault(); setSelected(current.parentKey!); }} className="hover:underline font-medium text-default">{types.data.types.find((t) => t.key === current.parentKey)?.name ?? current.parentKey}</Link></span>}</div>
                    {current.description && <div className="text-[13px] text-muted mt-0.5">{current.description}</div>}
                  </div>
                  <Button size="sm" variant="outline" icon={<Layers className="h-3.5 w-3.5" />} onClick={() => navigate(`/cmdb/cis?typeKey=${current.key}`)}>{fmtNumber(counts.get(current.key) ?? 0)} items</Button>
                </div>
                <Panel title="Attributes" subtitle="Fields recorded on items of this class, beyond the common identity and platform fields" padded={false}>
                  {current.attributeSchema?.length ? (
                    <table className="table [&_td]:py-1.5 [&_th]:py-1.5">
                      <thead><tr><th>Attribute</th><th>Key</th><th>Type</th><th>Required</th></tr></thead>
                      <tbody>
                        {current.attributeSchema.map((a) => (
                          <tr key={a.key}><td className="font-medium">{a.label}</td><td className="font-mono text-xs text-muted">{a.key}</td><td className="text-muted">{titleCase(a.type)}</td><td>{a.required ? <Badge color="amber">required</Badge> : <span className="text-subtle">optional</span>}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <EmptyState title="No class-specific attributes" description="Items of this class use the common fields only." />
                  )}
                </Panel>
                <Panel title={<><Share2 className="inline h-3.5 w-3.5 mr-1 text-subtle" />Relationship types</>} subtitle="How items relate, and which direction an outage travels" padded={false} action={can('admin:config') ? <Button size="sm" variant="ghost" onClick={() => navigate('/admin/relationship-types')}>Manage</Button> : undefined}>
                  <table className="table [&_td]:py-1.5 [&_th]:py-1.5">
                    <thead><tr><th>Relationship</th><th>Inverse</th><th>Impact</th></tr></thead>
                    <tbody>
                      {rels.filter((r) => r.isActive !== false).map((r) => (
                        <tr key={r.key}>
                          <td><span className="font-medium">{r.name}</span> <span className="font-mono text-[11px] text-subtle ml-1">{r.key}</span></td>
                          <td className="text-muted">{r.inverseName}</td>
                          <td>{r.impactDirection === 'downstream' ? <Badge color="amber">source impacted when target fails</Badge> : r.impactDirection === 'upstream' ? <Badge color="orange">target impacted when source fails</Badge> : <Badge color="slate">no propagation</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Panel>
              </>
            ) : (
              <div className="card"><EmptyState title="No classes" /></div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
