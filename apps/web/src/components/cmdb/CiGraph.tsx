import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, type SimulationNodeDatum, type SimulationLinkDatum } from 'd3-force';
import { get } from '@/api/client';
import { Select, LoadingBlock, ErrorBlock, Button } from '@/components/ui';
import { colorHex } from './hooks';
import { CiTypeIcon } from './CiTypeBadge';

export interface GraphNode { id: string; name: string; typeKey: string; typeName: string; color: string | null; icon?: string | null; status: string; criticality: string; isRoot: boolean; depth: number }
export interface GraphEdge { id: string; source: string; target: string; typeKey: string; typeName: string; inverseName: string }
interface SimNode extends SimulationNodeDatum, GraphNode {}
interface SimLink extends SimulationLinkDatum<SimNode> { id: string; typeName: string; typeKey: string }

const W = 900;
const H = 520;

/**
 * SVG force-directed relationship graph around one CI. Nodes are coloured by
 * type, the root is highlighted, nodes can be dragged, the canvas can be
 * panned (drag background) and zoomed (wheel), and clicking a node navigates.
 */
export function CiGraph({ ciId, onNavigate, initialDepth = 2 }: { ciId: string; onNavigate: (id: string) => void; initialDepth?: 1 | 2 | 3 }) {
  const [depth, setDepth] = useState<number>(initialDepth);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['cmdb', ciId, 'graph', depth], queryFn: () => get<{ nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }>(`/cmdb/cis/${ciId}/graph`, { depth }) });
  const [nodes, setNodes] = useState<SimNode[]>([]);
  const [links, setLinks] = useState<SimLink[]>([]);
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: 'pan' | 'node'; node?: SimNode; startX: number; startY: number; origin: { x: number; y: number }; moved: boolean } | null>(null);

  useEffect(() => {
    if (!data) return;
    const ns: SimNode[] = data.nodes.map((n) => ({ ...n, x: W / 2 + (Math.random() - 0.5) * 200, y: H / 2 + (Math.random() - 0.5) * 200 }));
    const root = ns.find((n) => n.isRoot);
    if (root) {
      root.fx = W / 2;
      root.fy = H / 2;
    }
    const byId = new Map(ns.map((n) => [n.id, n]));
    const ls: SimLink[] = data.edges.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e) => ({ id: e.id, source: e.source, target: e.target, typeName: e.typeName, typeKey: e.typeKey }));
    simRef.current?.stop();
    const sim = forceSimulation<SimNode>(ns)
      .force('link', forceLink<SimNode, SimLink>(ls).id((d) => d.id).distance((l) => 90 + 20 * Math.min(3, (byId.get(typeof l.source === 'string' ? l.source : (l.source as SimNode).id)?.depth ?? 0))).strength(0.6))
      .force('charge', forceManyBody().strength(-380))
      .force('center', forceCenter(W / 2, H / 2))
      .force('collide', forceCollide(34))
      .alphaDecay(0.035)
      .on('tick', () => {
        setNodes([...ns]);
        setLinks([...ls]);
      });
    simRef.current = sim;
    setTransform({ x: 0, y: 0, k: 1 });
    return () => {
      sim.stop();
    };
  }, [data]);

  const toLocal = (e: React.MouseEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const sx = (e.clientX - rect.left) * (W / rect.width);
    const sy = (e.clientY - rect.top) * (H / rect.height);
    return { x: (sx - transform.x) / transform.k, y: (sy - transform.y) / transform.k, sx, sy };
  };

  const onMouseDownBg = (e: React.MouseEvent) => {
    const p = toLocal(e);
    drag.current = { kind: 'pan', startX: p.sx, startY: p.sy, origin: { x: transform.x, y: transform.y }, moved: false };
  };
  const onMouseDownNode = (e: React.MouseEvent, n: SimNode) => {
    e.stopPropagation();
    const p = toLocal(e);
    drag.current = { kind: 'node', node: n, startX: p.sx, startY: p.sy, origin: { x: n.x ?? 0, y: n.y ?? 0 }, moved: false };
    n.fx = n.x;
    n.fy = n.y;
    simRef.current?.alphaTarget(0.3).restart();
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toLocal(e);
    const dx = p.sx - d.startX;
    const dy = p.sy - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.kind === 'pan') setTransform((t) => ({ ...t, x: d.origin.x + dx, y: d.origin.y + dy }));
    else if (d.node) {
      d.node.fx = d.origin.x + dx / transform.k;
      d.node.fy = d.origin.y + dy / transform.k;
    }
  };
  const onMouseUp = () => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'node' && d.node) {
      if (!d.node.isRoot) {
        d.node.fx = null;
        d.node.fy = null;
      }
      simRef.current?.alphaTarget(0);
      if (!d.moved) onNavigate(d.node.id);
    }
    drag.current = null;
  };
  const onWheel = (e: React.WheelEvent) => {
    const p = toLocal(e);
    const k = Math.max(0.3, Math.min(3, transform.k * (e.deltaY < 0 ? 1.12 : 0.89)));
    setTransform((t) => ({ k, x: p.sx - ((p.sx - t.x) * k) / t.k, y: p.sy - ((p.sy - t.y) * k) / t.k }));
  };

  const legend = useMemo(() => {
    const m = new Map<string, { name: string; color: string | null; icon?: string | null }>();
    for (const n of data?.nodes ?? []) if (!m.has(n.typeKey)) m.set(n.typeKey, { name: n.typeName, color: n.color, icon: n.icon });
    return [...m.values()];
  }, [data]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-muted">Depth</span>
          <Select className="w-20" value={String(depth)} onChange={(e) => setDepth(Number(e.target.value))} options={[{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }]} />
        </div>
        <Button variant="ghost" size="sm" onClick={() => setTransform({ x: 0, y: 0, k: 1 })}>Reset view</Button>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted ml-auto">
          {legend.map((l) => (
            <span key={l.name} className="inline-flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: colorHex(l.color) }} />
              {l.name}
            </span>
          ))}
        </div>
        {data?.truncated && <span className="text-xs text-amber-600">Graph truncated to 150 nodes</span>}
      </div>
      <div className="card overflow-hidden bg-surface-2/40">
        {isLoading && <LoadingBlock label="Building graph…" />}
        {error && <ErrorBlock error={error} retry={() => refetch()} />}
        {data && (
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full h-[520px] select-none cursor-grab active:cursor-grabbing" onMouseDown={onMouseDownBg} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp} onWheel={onWheel}>
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
              </marker>
            </defs>
            <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
              {links.map((l) => {
                const s = l.source as SimNode;
                const t = l.target as SimNode;
                if (typeof s !== 'object' || typeof t !== 'object') return null;
                const mx = ((s.x ?? 0) + (t.x ?? 0)) / 2;
                const my = ((s.y ?? 0) + (t.y ?? 0)) / 2;
                return (
                  <g key={l.id}>
                    <line x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke="#94a3b8" strokeWidth={1.4} markerEnd="url(#arrow)" />
                    <text x={mx} y={my - 4} fontSize={9} textAnchor="middle" fill="#64748b" className="pointer-events-none">
                      {l.typeName}
                    </text>
                  </g>
                );
              })}
              {nodes.map((n) => (
                <g key={n.id} transform={`translate(${n.x ?? 0},${n.y ?? 0})`} onMouseDown={(e) => onMouseDownNode(e, n)} className="cursor-pointer">
                  {n.isRoot && <circle r={24} fill="none" stroke={colorHex(n.color)} strokeWidth={2} strokeDasharray="4 3" />}
                  <circle r={n.isRoot ? 18 : 14} fill={colorHex(n.color)} fillOpacity={n.status === 'retired' || n.status === 'inactive' ? 0.45 : 0.9} stroke="#fff" strokeWidth={1.5} />
                  <foreignObject x={-8} y={-8} width={16} height={16} className="pointer-events-none">
                    <div className="flex items-center justify-center text-white h-4 w-4">
                      <CiTypeIcon icon={n.icon} className="h-3.5 w-3.5" />
                    </div>
                  </foreignObject>
                  <text y={n.isRoot ? 32 : 27} fontSize={11} fontWeight={n.isRoot ? 600 : 400} textAnchor="middle" fill="currentColor" className="pointer-events-none">
                    {n.name.length > 22 ? n.name.slice(0, 21) + '…' : n.name}
                  </text>
                </g>
              ))}
            </g>
          </svg>
        )}
        {data && data.nodes.length <= 1 && <div className="text-center text-[13px] text-muted pb-4 -mt-10">No relationships yet. Add one to see the graph.</div>}
      </div>
    </div>
  );
}
