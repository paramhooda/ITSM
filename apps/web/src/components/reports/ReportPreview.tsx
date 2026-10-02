import { useState } from 'react';
import { Card, StatTile } from '@/components/ui';
import { TrendChart } from '@/components/dashboards/TrendChart';
import { formatCell, type ReportColumn, type ReportChart, type RunPreview } from './types';

const PAGE = 100;

function Table({ columns, rows }: { columns: ReportColumn[]; rows: Record<string, unknown>[] }) {
  const [limit, setLimit] = useState(PAGE);
  if (!rows.length) return <div className="text-[13px] text-subtle py-6 text-center">No rows for these parameters</div>;
  const numeric = (c: ReportColumn) => c.type === 'number' || c.type === 'pct' || c.type === 'minutes';
  return (
    <div className="overflow-auto max-h-[60vh]">
      <table className="table [&_td]:py-1.5 [&_th]:py-1.5 [&_th]:sticky [&_th]:top-0">
        <thead><tr>{columns.map((c) => <th key={c.key} className={numeric(c) ? 'text-right' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.slice(0, limit).map((r, i) => (
            <tr key={String(r.id ?? i)}>{columns.map((c) => <td key={c.key} className={`${numeric(c) ? 'text-right tabular-nums' : ''} max-w-[320px] truncate`} title={formatCell(r[c.key], c.type)}>{formatCell(r[c.key], c.type)}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit && (
        <button className="w-full text-[12.5px] text-brand-700 hover:underline py-2" onClick={() => setLimit(limit + PAGE * 5)}>
          Show more ({rows.length - limit} remaining)
        </button>
      )}
    </div>
  );
}

function Chart({ chart }: { chart: ReportChart }) {
  const keys = Array.isArray(chart.y) ? chart.y : [chart.y];
  return (
    <Card title={chart.title}>
      <TrendChart data={chart.data} x={chart.x} kind={chart.type} series={keys.map((k) => ({ key: k, label: chart.labels?.[k] ?? k }))} height={200} xFormatter={(v) => (typeof v === 'string' && v.length > 18 ? `${v.slice(0, 17)}…` : String(v))} />
    </Card>
  );
}

/** Summary tiles, charts and the result table of a report preview. */
export function ReportPreview({ preview }: { preview: RunPreview }) {
  const r = preview.result;
  return (
    <div className="flex flex-col gap-4">
      {r.summary && r.summary.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
          {r.summary.map((s, i) => <StatTile key={i} label={s.label} value={typeof s.value === 'number' ? formatCell(s.value, 'number') : s.value ?? '—'} hint={s.hint} />)}
        </div>
      )}
      {r.charts && r.charts.length > 0 && <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">{r.charts.map((c, i) => <Chart key={i} chart={c} />)}</div>}
      <Card title={`Detail · ${r.rowCount} rows${r.truncated ? ' (preview truncated)' : ''}`} padded={false}>
        <Table columns={r.columns} rows={r.rows} />
      </Card>
      {r.sections?.map((s, i) => (
        <Card key={i} title={`${s.title} · ${s.rows.length}`} padded={false}>
          <Table columns={s.columns} rows={s.rows} />
        </Card>
      ))}
    </div>
  );
}
