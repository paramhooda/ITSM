import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Maximize2 } from 'lucide-react';
import { Button, Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import { colorHex } from './hooks';
import { CiTypeIcon } from './CiTypeBadge';
import type { MapNode, MapEdge } from './api';

const NODE_W = 184;
const NODE_H = 52;
const COL_GAP = 28;
const ROW_GAP = 72;

/**
 * Layered, top-down service map: the business service on top, then what it depends on,
 * layer by layer. Open incidents colour a node; hovering highlights its dependencies.
 */
export function ServiceMap({ nodes, edges, truncated, onSelect, height = 560 }: { nodes: MapNode[]; edges: MapEdge[]; truncated?: boolean; onSelect?: (id: string) => void; height?: number }) {
  const [hover, setHover] = useState<string | null>(null);
  const [t, setT] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);

  const layout = useMemo(() => {
    const layers = new Map<number, MapNode[]>();
    for (const n of nodes) layers.set(n.layer, [...(layers.get(n.layer) ?? []), n]);
    const widest = Math.max(1, ...[...layers.values()].map((l) => l.length));
    const width = widest * (NODE_W + COL_GAP) + COL_GAP;
    const pos = new Map<string, { x: number; y: number }>();
    for (const [layer, list] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
      const sorted = [...list].sort((a, b) => b.openTickets - a.openTickets || a.name.localeCompare(b.name));
      const rowW = sorted.length * (NODE_W + COL_GAP) - COL_GAP;
      const x0 = (width - rowW) / 2;
      sorted.forEach((n, i) => pos.set(n.id, { x: x0 + i * (NODE_W + COL_GAP), y: 24 + layer * (NODE_H + ROW_GAP) }));
    }
    const h = 24 + layers.size * (NODE_H + ROW_GAP);
    return { pos, width, height: h, layers: layers.size };
  }, [nodes]);

  const related = useMemo(() => {
    if (!hover) return null;
    const ids = new Set<string>([hover]);
    for (const e of edges) if (e.source === hover || e.target === hover) ids.add(e.source), ids.add(e.target);
    return ids;
  }, [hover, edges]);

  const fit = () => {
    const el = wrap.current;
    if (!el) return;
    const k = Math.min(1, (el.clientWidth - 24) / layout.width, (height - 24) / layout.height);
    setT({ x: (el.clientWidth - layout.width * k) / 2, y: 12, k });
  };
  const wrap = useRef<HTMLDivElement>(null);
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const k = Math.max(0.3, Math.min(2.5, t.k * (e.deltaY < 0 ? 1.1 : 0.9)));
    setT((p) => ({ ...p, k }));
  };
  const onDown = (e: React.MouseEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, ox: t.x, oy: t.y, moved: false };
  };
  const onMove = (e: React.MouseEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true;
    setT((p) => ({ ...p, x: drag.current!.ox + dx, y: drag.current!.oy + dy }));
  };
  const onUp = () => {
    drag.current = null;
  };
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const tone = (n: MapNode) => (n.status === 'retired' || n.status === 'inactive' ? 'retired' : n.openTickets > 0 && (n.criticality === 'critical' || n.criticality === 'high') ? 'critical' : n.openTickets > 0 ? 'warning' : 'ok');

  return (
    <div ref={wrap} className="relative rounded-xl border border-default bg-dots overflow-hidden select-none" style={{ height }} onWheel={onWheel} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}>
      <svg width="100%" height="100%" className="cursor-grab active:cursor-grabbing">
        <defs>
          <marker id="map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#a1a1aa" />
          </marker>
        </defs>
        <g transform={`translate(${t.x},${t.y}) scale(${t.k})`}>
          {edges.map((e) => {
            const a = layout.pos.get(e.source);
            const b = layout.pos.get(e.target);
            if (!a || !b) return null;
            const from = { x: a.x + NODE_W / 2, y: a.y + NODE_H };
            const to = { x: b.x + NODE_W / 2, y: b.y };
            const dim = related && !(related.has(e.source) && related.has(e.target));
            const mid = (from.y + to.y) / 2;
            return <path key={e.id} d={`M ${from.x} ${from.y} C ${from.x} ${mid}, ${to.x} ${mid}, ${to.x} ${to.y}`} fill="none" stroke={dim ? '#e4e4e7' : '#a1a1aa'} strokeWidth={dim ? 1 : 1.5} markerEnd="url(#map-arrow)" />;
          })}
          {nodes.map((n) => {
            const p = layout.pos.get(n.id);
            if (!p) return null;
            const dim = related && !related.has(n.id);
            const tn = tone(n);
            const stroke = tn === 'critical' ? '#dc2626' : tn === 'warning' ? '#f59e0b' : n.layer === 0 ? '#2563eb' : '#e4e4e7';
            return (
              <g key={n.id} transform={`translate(${p.x},${p.y})`} opacity={dim ? 0.35 : 1} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} onClick={() => !drag.current?.moved && onSelect?.(n.id)} className="cursor-pointer">
                <rect width={NODE_W} height={NODE_H} rx={10} fill="#fff" stroke={stroke} strokeWidth={n.layer === 0 || tn !== 'ok' ? 2 : 1} />
                <rect x={0} y={0} width={4} height={NODE_H} rx={2} fill={colorHex(n.color) ?? '#a1a1aa'} />
                <foreignObject x={10} y={6} width={NODE_W - 16} height={NODE_H - 12}>
                  <div className="flex items-center gap-2 h-full min-w-0">
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-surface-2 text-muted shrink-0"><CiTypeIcon icon={n.icon} className="h-3.5 w-3.5" /></span>
                    <div className="min-w-0">
                      <div className="text-[12.5px] font-medium text-default truncate leading-tight">{n.name}</div>
                      <div className="text-[11px] text-muted truncate leading-tight">{n.typeName}{n.status !== 'active' ? ` · ${n.status}` : ''}</div>
                    </div>
                    {n.openTickets > 0 && <span className={cn('ml-auto shrink-0 rounded-full px-1.5 text-[10.5px] font-semibold text-white tnum', tn === 'critical' ? 'bg-red-600' : 'bg-amber-500')}>{n.openTickets}</span>}
                  </div>
                </foreignObject>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="absolute top-2 right-2 flex items-center gap-1">
        <Button size="sm" variant="outline" icon={<Maximize2 className="h-3.5 w-3.5" />} onClick={fit}>Fit</Button>
      </div>
      <div className="absolute bottom-2 left-2 flex items-center gap-2 text-[11px] text-muted bg-white/90 rounded-md px-2 py-1 border border-default">
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border-2 border-brand-600" /> service</span>
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border-2 border-amber-500" /> open ticket</span>
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border-2 border-red-600" /> critical with ticket</span>
        <span>· {nodes.length} CIs · {layout.layers} layers{truncated ? ' · truncated' : ''}</span>
      </div>
      {hover && byId.get(hover) && (
        <div className="absolute top-2 left-2 card px-3 py-2 text-[12px] max-w-[260px] pointer-events-none">
          <div className="font-medium">{byId.get(hover)!.name}</div>
          <div className="text-muted">{byId.get(hover)!.typeName} · {byId.get(hover)!.criticality}</div>
          {byId.get(hover)!.openTickets > 0 && <Badge color="amber" className="mt-1">{byId.get(hover)!.openTickets} open ticket{byId.get(hover)!.openTickets === 1 ? '' : 's'}</Badge>}
          <div className="text-subtle mt-1">Click to open · <Link to={`/cmdb/cis/${hover}`} className="pointer-events-auto hover:underline">record</Link></div>
        </div>
      )}
    </div>
  );
}
