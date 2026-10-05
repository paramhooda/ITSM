import { Checkbox } from '@/components/ui';
import { Segmented } from '@/components/dashboards/Panel';
import { aggregateAlias, AGGREGATE_LABELS, type CatalogField, type ReportAggregate, type ReportSpec } from '../types';

type Chart = ReportSpec['chart'];

/** None, bar or line over the first group field; the series are the aggregates. Only a grouped report can chart. */
export function ChartEditor({ grouped, aggregates, fields, chart, onChange }: { grouped: boolean; aggregates: ReportAggregate[]; fields: CatalogField[]; chart: Chart; onChange: (c: Chart) => void }) {
  const aliases = aggregates.map((a) => ({ alias: aggregateAlias(a), label: a.label?.trim() || (a.fn === 'count' ? 'Count' : `${AGGREGATE_LABELS[a.fn]} ${fields.find((f) => f.key === a.field)?.label.toLowerCase() ?? a.field ?? ''}`) }));
  if (!grouped) return <div className="text-[12px] text-subtle">Switch on grouping to chart the totals.</div>;
  const type = chart?.type ?? 'none';
  const setType = (t: 'none' | 'bar' | 'line') => onChange(t === 'none' ? null : { type: t, y: chart?.y.length ? chart.y : aliases.slice(0, 4).map((a) => a.alias) });
  return (
    <div className="flex flex-col gap-2.5">
      <Segmented size="sm" value={type} onChange={setType} options={[{ value: 'none', label: 'None' }, { value: 'bar', label: 'Bar' }, { value: 'line', label: 'Line' }]} />
      {chart && (
        <div className="flex flex-col gap-1">
          <div className="text-[12px] text-muted">Series (up to four)</div>
          {aliases.map((a) => {
            const on = chart.y.includes(a.alias);
            return <Checkbox key={a.alias} checked={on} disabled={!on && chart.y.length >= 4} onChange={() => onChange({ ...chart, y: on ? chart.y.filter((k) => k !== a.alias) : [...chart.y, a.alias] })} label={a.label} />;
          })}
          {chart.y.length === 0 && <div className="text-[11.5px] text-red-600">Pick at least one series</div>}
        </div>
      )}
    </div>
  );
}
