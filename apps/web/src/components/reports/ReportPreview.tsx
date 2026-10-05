import { Fragment, useState, type ReactNode } from 'react';
import { Card, StatTile } from '@/components/ui';
import { TrendChart } from '@/components/dashboards/TrendChart';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { SlaGauge } from '@/components/dashboards/SlaGauge';
import { InsightsCard } from './InsightsCard';
import { formatCell, fmtDelta, fmtTileValue, type Insight, type ReportColumn, type ReportChart, type ReportSection, type RunPreview, type SummaryTile } from './types';

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

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const short = (v: string) => (typeof v === 'string' && v.length > 18 ? `${v.slice(0, 17)}…` : String(v));
const unitFormatter = (unit?: ReportChart['unit']) => (v: number) => fmtTileValue({ value: v, unit });

/** The compact weekday-by-hour grid of a heatmap chart: opacity on the brand colour scales with the value. */
function Heatmap({ chart }: { chart: ReportChart }) {
  const key = Array.isArray(chart.y) ? chart.y[0]! : chart.y;
  const cells = chart.data.map((d) => ({ row: String(d.row ?? ''), col: String(d.col ?? ''), value: Math.max(0, num(d[key]) || 0) }));
  const rows = chart.rows ?? [...new Set(cells.map((c) => c.row))];
  const cols = chart.cols ?? [...new Set(cells.map((c) => c.col))];
  const max = Math.max(1, ...cells.map((c) => c.value));
  const lookup = new Map(cells.map((c) => [`${c.row}\u0000${c.col}`, c.value]));
  return (
    <div className="overflow-x-auto">
      <div className="grid gap-px text-[10px] text-subtle min-w-[520px]" style={{ gridTemplateColumns: `auto repeat(${cols.length}, minmax(0, 1fr))` }}>
        <div />
        {cols.map((c) => <div key={c} className="text-center">{c}</div>)}
        {rows.map((r) => (
          <Fragment key={r}>
            <div className="pr-1.5 text-right leading-4">{r}</div>
            {cols.map((c) => {
              const v = lookup.get(`${r}\u0000${c}`) ?? 0;
              return <div key={c} className="h-4 rounded-[2px] bg-brand-600" style={{ opacity: v ? 0.15 + (v / max) * 0.85 : 0.04 }} title={`${r} ${c}:00 · ${v}`} />;
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function Chart({ chart }: { chart: ReportChart }) {
  const keys = Array.isArray(chart.y) ? chart.y : [chart.y];
  const series = keys.map((k) => ({ key: k, label: chart.labels?.[k] ?? k }));
  const fmt = unitFormatter(chart.unit);
  let body: ReactNode;
  if (!chart.data.length) body = <div className="text-[13px] text-subtle py-8 text-center">No data</div>;
  else if (chart.type === 'donut') body = <BreakdownBar items={chart.data.map((d) => ({ label: String(d[chart.x] ?? ''), value: num(d[keys[0]!]) || 0 }))} />;
  else if (chart.type === 'gauge') body = <SlaGauge pct={num(chart.data[0]?.[keys[0]!])} target={chart.target ?? 95} label={chart.title} />;
  else if (chart.type === 'heatmap') body = <Heatmap chart={chart} />;
  else if (chart.type === 'stacked_bar') body = <TrendChart data={chart.data} x={chart.x} kind="bar" stacked series={series} height={200} valueFormatter={fmt} xFormatter={short} />;
  else body = <TrendChart data={chart.data} x={chart.x} kind={chart.type === 'line' ? 'line' : 'bar'} series={series} height={200} valueFormatter={fmt} xFormatter={short} />;
  return (
    <Card title={chart.title} className={chart.width === 'full' ? 'lg:col-span-2' : undefined}>
      {chart.subtitle && <div className="text-[12px] text-muted -mt-1 mb-2">{chart.subtitle}</div>}
      {body}
    </Card>
  );
}

const KIND_RAIL: Record<Insight['kind'], string> = { good: 'border-emerald-500', attention: 'border-amber-500', info: 'border-brand-500' };

function Callouts({ items }: { items: Insight[] }) {
  return (
    <ul className="flex flex-col gap-1.5 px-4 pt-3">
      {items.map((i, idx) => (
        <li key={idx} className={`border-l-2 ${KIND_RAIL[i.kind]} pl-3 text-[13px] text-default`}>
          {i.text}
          {i.evidence && <span className="text-muted"> · {i.evidence}</span>}
        </li>
      ))}
    </ul>
  );
}

function Tile({ tile, comparison }: { tile: SummaryTile; comparison?: string }) {
  const d = tile.delta;
  const improved = d && typeof d.change === 'number' && d.change !== 0 ? (d.lowerIsBetter ? d.change < 0 : d.change > 0) : null;
  const tone = tile.tone ?? (improved === null || d?.neutral ? undefined : improved ? 'good' : 'bad');
  const hint = d && typeof d.previous === 'number' ? `${fmtDelta({ ...d, unit: d.unit ?? tile.unit })} vs ${comparison ?? 'previous period'}${tile.target !== undefined ? ` · target ${fmtTileValue({ value: tile.target, unit: tile.unit })}` : ''}` : tile.target !== undefined ? `${tile.hint ? `${tile.hint} · ` : ''}target ${fmtTileValue({ value: tile.target, unit: tile.unit })}` : tile.hint;
  return <StatTile label={tile.label} value={fmtTileValue({ value: tile.value, unit: tile.unit, label: tile.label })} hint={hint} tone={tone} />;
}

function Section({ section }: { section: ReportSection }) {
  return (
    <Card title={`${section.title} · ${section.rows.length}`} padded={false}>
      {section.intro && <div className="text-[12.5px] text-muted px-4 pt-3">{section.intro}</div>}
      {section.callouts && section.callouts.length > 0 && <Callouts items={section.callouts} />}
      {section.charts && section.charts.length > 0 && <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 p-4">{section.charts.map((c, i) => <Chart key={i} chart={c} />)}</div>}
      <Table columns={section.columns} rows={section.rows} />
    </Card>
  );
}

/** Summary tiles with their deltas, the insights, charts of every kind and the result tables of a report preview. */
export function ReportPreview({ preview }: { preview: RunPreview }) {
  const r = preview.result;
  const comparison = r.comparison?.label;
  const chapters: { group: string | null; sections: ReportSection[] }[] = [];
  for (const s of r.sections ?? []) {
    const last = chapters[chapters.length - 1];
    if (s.group && last && last.group === s.group) last.sections.push(s);
    else chapters.push({ group: s.group ?? null, sections: [s] });
  }
  return (
    <div className="flex flex-col gap-4">
      {r.summary && r.summary.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
          {r.summary.map((s, i) => <Tile key={i} tile={s} comparison={comparison} />)}
        </div>
      )}
      {(r.narrative || (r.insights && r.insights.length > 0)) && <InsightsCard narrative={r.narrative} insights={r.insights} />}
      {r.charts && r.charts.length > 0 && <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">{r.charts.map((c, i) => <Chart key={i} chart={c} />)}</div>}
      <Card title={`${preview.report.kind === 'pack' ? 'Scorecard' : 'Detail'} · ${r.rowCount} rows${r.truncated ? ' (preview truncated)' : ''}`} padded={false}>
        <Table columns={r.columns} rows={r.rows} />
      </Card>
      {chapters.map((c, i) => (
        <div key={i} className="flex flex-col gap-3">
          {c.group && <div className="text-[13px] font-semibold text-default border-l-[3px] border-brand-500 pl-2.5 mt-1">{c.group}</div>}
          {c.sections.map((s, j) => <Section key={j} section={s} />)}
        </div>
      ))}
    </div>
  );
}
