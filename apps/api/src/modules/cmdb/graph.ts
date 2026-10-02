import { and, eq, inArray, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { schema, type Tx } from '@/db/client';

const { cis, ciTypes, ciRelationships, ciRelationshipTypes, tickets, ticketCis, configOptions } = schema;

export interface GraphNode { id: string; name: string; typeKey: string; typeName: string; color: string | null; icon: string | null; status: string; criticality: string; isRoot: boolean; depth: number }
export interface GraphEdge { id: string; source: string; target: string; typeKey: string; typeName: string; inverseName: string }

type RelRow = { id: string; sourceCiId: string; targetCiId: string; typeKey: string; typeName: string; inverseName: string };

async function relationshipsTouching(tx: Tx, ids: string[]): Promise<RelRow[]> {
  if (!ids.length) return [];
  return tx
    .select({ id: ciRelationships.id, sourceCiId: ciRelationships.sourceCiId, targetCiId: ciRelationships.targetCiId, typeKey: ciRelationshipTypes.key, typeName: ciRelationshipTypes.name, inverseName: ciRelationshipTypes.inverseName })
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

/** Relationship types that express "source depends on target" (dependency flows source → target). */
export const DEPENDENCY_TYPES = ['depends_on', 'runs_on', 'hosted_on', 'uses', 'member_of'];
/** Relationship types that express "source supports target" (dependency flows target → source). */
export const SUPPORT_TYPES = ['supports', 'protected_by_inverse'];

export interface ImpactItem { id: string; name: string; typeKey: string; typeName: string; color: string | null; status: string; criticality: string; depth: number; via: string; path: string[] }

/**
 * Downstream impact: every CI that (transitively) depends on the given CI,
 * i.e. inbound depends_on/runs_on/hosted_on/uses and outbound supports.
 */
export async function buildImpact(tx: Tx, rootId: string, maxDepth = 6, limit = 300) {
  const [root] = await loadNodes(tx, [rootId]);
  if (!root) return null;
  const visited = new Map<string, { depth: number; via: string; path: string[] }>([[rootId, { depth: 0, via: '', path: [root.name] }]]);
  let frontier = [rootId];
  for (let d = 1; d <= maxDepth && frontier.length && visited.size < limit; d++) {
    const rels = await relationshipsTouching(tx, frontier);
    const next: string[] = [];
    for (const r of rels) {
      let dependent: string | null = null;
      if (DEPENDENCY_TYPES.includes(r.typeKey) && frontier.includes(r.targetCiId)) dependent = r.sourceCiId; // source depends on (frontier) target
      else if (r.typeKey === 'supports' && frontier.includes(r.sourceCiId)) dependent = r.targetCiId; // (frontier) source supports target
      if (!dependent || visited.has(dependent)) continue;
      const parent = frontier.includes(r.sourceCiId) ? r.sourceCiId : r.targetCiId;
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
