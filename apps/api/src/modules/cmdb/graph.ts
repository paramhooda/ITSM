import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { schema, type Tx } from '@/db/client';

const { cis, ciTypes, ciRelationships, ciRelationshipTypes, tickets, ticketCis, configOptions } = schema;

export interface GraphNode { id: string; name: string; typeKey: string; typeName: string; color: string | null; icon: string | null; status: string; criticality: string; isRoot: boolean; depth: number }
export interface GraphEdge { id: string; source: string; target: string; typeKey: string; typeName: string; inverseName: string }

type RelRow = { id: string; sourceCiId: string; targetCiId: string; typeKey: string; typeName: string; inverseName: string; impactDirection: string };

async function relationshipsTouching(tx: Tx, ids: string[]): Promise<RelRow[]> {
  if (!ids.length) return [];
  return tx
    .select({ id: ciRelationships.id, sourceCiId: ciRelationships.sourceCiId, targetCiId: ciRelationships.targetCiId, typeKey: ciRelationshipTypes.key, typeName: ciRelationshipTypes.name, inverseName: ciRelationshipTypes.inverseName, impactDirection: ciRelationshipTypes.impactDirection })
    .from(ciRelationships)
    .innerJoin(ciRelationshipTypes, eq(ciRelationshipTypes.id, ciRelationships.typeId))
    .where(or(inArray(ciRelationships.sourceCiId, ids), inArray(ciRelationships.targetCiId, ids)));
}

async function loadNodes(tx: Tx, ids: string[]) {
  if (!ids.length) return [];
  return tx
    .select({ id: cis.id, name: cis.name, typeKey: ciTypes.key, typeName: ciTypes.name, color: ciTypes.color, icon: ciTypes.icon, status: cis.status, criticality: cis.criticality })
    .from(cis)
    .innerJoin(ciTypes, eq(ciTypes.id, cis.typeId))
    .where(inArray(cis.id, ids));
}

/** Breadth-first neighbourhood (both directions) around a root CI, bounded by depth and node count. */
export async function buildGraph(tx: Tx, rootId: string, depth = 2, limit = 150): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }> {
  const depthOf = new Map<string, number>([[rootId, 0]]);
  const edges = new Map<string, GraphEdge>();
  let frontier = [rootId];
  let truncated = false;
  for (let d = 1; d <= depth && frontier.length; d++) {
    const rels = await relationshipsTouching(tx, frontier);
    const next: string[] = [];
    for (const r of rels) {
      const other = frontier.includes(r.sourceCiId) ? r.targetCiId : r.sourceCiId;
      if (!depthOf.has(other)) {
        if (depthOf.size >= limit) {
          truncated = true;
          continue;
        }
        depthOf.set(other, d);
        next.push(other);
      }
      edges.set(r.id, { id: r.id, source: r.sourceCiId, target: r.targetCiId, typeKey: r.typeKey, typeName: r.typeName, inverseName: r.inverseName });
    }
    frontier = next;
  }
  const nodeRows = await loadNodes(tx, [...depthOf.keys()]);
  const nodes = nodeRows.map((n) => ({ ...n, isRoot: n.id === rootId, depth: depthOf.get(n.id) ?? 0 }));
  const known = new Set(nodes.map((n) => n.id));
  return { nodes, edges: [...edges.values()].filter((e) => known.has(e.source) && known.has(e.target)), truncated };
}

// ---------------------------------------------------------------- open tickets per CI

const OPEN_STATUS_IDS = sql`(select id from config_options where type = 'ticket_status' and status_category in ('new', 'open', 'pending'))`;

/** Open tickets (status category new/open/pending) per CI, linked via primary_ci_id or ticket_cis. */
export async function openTicketCounts(tx: Tx, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const res = await tx.execute(sql`
    select x.ci_id, count(distinct x.ticket_id)::int as count from (
      select t.primary_ci_id as ci_id, t.id as ticket_id from tickets t where t.primary_ci_id in ${ids} and t.status_id in ${OPEN_STATUS_IDS}
      union all
      select tc.ci_id, tc.ticket_id from ticket_cis tc join tickets t on t.id = tc.ticket_id where tc.ci_id in ${ids} and t.status_id in ${OPEN_STATUS_IDS}
    ) x group by x.ci_id`);
  return new Map((res.rows as { ci_id: string; count: number }[]).map((r) => [r.ci_id, Number(r.count)]));
}

/** Distinct open tickets touching any of the CIs, with the count of "critical" ones (P1/P2 by priority level or major incident). */
export async function openTicketSummary(tx: Tx, ids: string[]): Promise<{ count: number; critical: number }> {
  if (!ids.length) return { count: 0, critical: 0 };
  const res = await tx.execute(sql`
    select count(distinct t.id)::int as count, count(distinct t.id) filter (where t.is_major or pr.level <= 2)::int as critical
    from tickets t left join config_options pr on pr.id = t.priority_id
    where t.status_id in ${OPEN_STATUS_IDS}
      and (t.primary_ci_id in ${ids} or exists (select 1 from ticket_cis tc where tc.ticket_id = t.id and tc.ci_id in ${ids}))`);
  const row = (res.rows as { count: number; critical: number }[])[0];
  return { count: Number(row?.count ?? 0), critical: Number(row?.critical ?? 0) };
}

// ---------------------------------------------------------------- impact (who is affected when this CI fails)

export interface ImpactItem { id: string; name: string; typeKey: string; typeName: string; color: string | null; status: string; criticality: string; depth: number; via: string; path: string[] }

/**
 * Downstream impact: every CI that (transitively) relies on the given CI,
 * following the impact metadata of each relationship type:
 * - 'downstream' edges inbound to the failing CI (X depends_on / runs_on / hosted_on ... ROOT → X is impacted)
 * - 'upstream' edges outbound from the failing CI (ROOT supports / manages X → X is impacted)
 */
export async function buildImpact(tx: Tx, rootId: string, maxDepth = 6, limit = 300) {
  const [root] = await loadNodes(tx, [rootId]);
  if (!root) return null;
  const visited = new Map<string, { depth: number; via: string; path: string[] }>([[rootId, { depth: 0, via: '', path: [root.name] }]]);
  let frontier = [rootId];
  for (let d = 1; d <= maxDepth && frontier.length && visited.size < limit; d++) {
    const rels = await relationshipsTouching(tx, frontier);
    const inFrontier = new Set(frontier);
    const next: string[] = [];
    for (const r of rels) {
      let dependent: string | null = null;
      if (r.impactDirection === 'downstream' && inFrontier.has(r.targetCiId)) dependent = r.sourceCiId; // source relies on the (failing) target
      else if (r.impactDirection === 'upstream' && inFrontier.has(r.sourceCiId)) dependent = r.targetCiId; // the (failing) source supports target
      if (!dependent || visited.has(dependent)) continue;
      const parent = dependent === r.sourceCiId ? r.targetCiId : r.sourceCiId;
      const parentInfo = visited.get(parent)!;
      visited.set(dependent, { depth: d, via: r.typeKey, path: [...parentInfo.path, dependent] });
      next.push(dependent);
      if (visited.size >= limit) break;
    }
    frontier = next;
  }
  const ids = [...visited.keys()].filter((id) => id !== rootId);
  const nodes = await loadNodes(tx, ids);
  const nameOf = new Map(nodes.map((n) => [n.id, n.name]));
  nameOf.set(rootId, root.name);
  const dependents: ImpactItem[] = nodes
    .map((n) => {
      const v = visited.get(n.id)!;
      return { ...n, depth: v.depth, via: v.via, path: v.path.map((p) => nameOf.get(p) ?? p) };
    })
    .sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
  const businessServices = dependents.filter((d) => d.typeKey === 'business_service');

  const affectedIds = [rootId, ...ids];
  const ticketStatus = alias(configOptions, 'ticket_status');
  const openTickets = affectedIds.length
    ? await tx
        .select({ id: tickets.id, number: tickets.number, title: tickets.title, type: tickets.type, status: ticketStatus.label, statusColor: ticketStatus.color, ciId: tickets.primaryCiId, createdAt: tickets.createdAt })
        .from(tickets)
        .innerJoin(ticketStatus, eq(ticketStatus.id, tickets.statusId))
        .where(and(or(inArray(tickets.primaryCiId, affectedIds), inArray(tickets.id, tx.select({ id: ticketCis.ticketId }).from(ticketCis).where(inArray(ticketCis.ciId, affectedIds)))), inArray(ticketStatus.statusCategory, ['new', 'open', 'pending'])))
        .limit(100)
    : [];
  return { root, dependents, businessServices, openTickets, truncated: visited.size >= limit };
}

// ---------------------------------------------------------------- dependency map (what this CI relies on)

export interface MapNode { id: string; name: string; typeKey: string; typeName: string; color: string | null; icon: string | null; status: string; criticality: string; layer: number; openTickets: number }
export interface MapEdge { id: string; source: string; target: string; typeKey: string; typeName: string }

/**
 * Layered dependency map of everything a root CI relies on (the inverse of
 * `buildImpact`): outbound 'downstream' edges (root depends_on X → X in layer 1)
 * and inbound 'upstream' edges (X supports root → X in layer 1), breadth-first
 * up to `depth` and at most `limit` nodes. The root is layer 0 and part of `nodes`.
 */
export async function buildDependencyMap(tx: Tx, rootId: string, depth = 6, limit = 200) {
  const [root] = await loadNodes(tx, [rootId]);
  if (!root) return null;
  const layerOf = new Map<string, number>([[rootId, 0]]);
  const edges = new Map<string, MapEdge>();
  let frontier = [rootId];
  let truncated = false;
  for (let d = 1; d <= depth && frontier.length; d++) {
    const rels = await relationshipsTouching(tx, frontier);
    const inFrontier = new Set(frontier);
    const next: string[] = [];
    for (const r of rels) {
      let dependency: string | null = null;
      if (r.impactDirection === 'downstream' && inFrontier.has(r.sourceCiId)) dependency = r.targetCiId; // frontier depends on target
      else if (r.impactDirection === 'upstream' && inFrontier.has(r.targetCiId)) dependency = r.sourceCiId; // source supports frontier
      if (!dependency) continue;
      if (!layerOf.has(dependency)) {
        if (layerOf.size >= limit) {
          truncated = true;
          continue;
        }
        layerOf.set(dependency, d);
        next.push(dependency);
      }
      edges.set(r.id, { id: r.id, source: r.sourceCiId, target: r.targetCiId, typeKey: r.typeKey, typeName: r.typeName });
    }
    frontier = next;
  }
  const ids = [...layerOf.keys()];
  const [rows, open] = await Promise.all([loadNodes(tx, ids), openTicketCounts(tx, ids)]);
  const nodes: MapNode[] = rows
    .map((n) => ({ ...n, layer: layerOf.get(n.id) ?? 0, openTickets: open.get(n.id) ?? 0 }))
    .sort((a, b) => a.layer - b.layer || a.name.localeCompare(b.name));
  const known = new Set(nodes.map((n) => n.id));
  return { root, nodes, edges: [...edges.values()].filter((e) => known.has(e.source) && known.has(e.target)), truncated };
}
