import { sql, type SQL, type AnyColumn, asc, desc, ilike, or } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { Pagination } from './pagination';

/** Counts rows for a built query (`select ... from ... where`). */
export async function countRows(tx: Tx, from: SQL, where?: SQL): Promise<number> {
  const res = await tx.execute(sql`select count(*)::int as count from ${from} ${where ? sql`where ${where}` : sql``}`);
  const rows = res.rows as { count: number }[];
  return rows[0]?.count ?? 0;
}

/** Resolves a sort field into an ORDER BY clause from an allow-list. */
export function orderBy(sortable: Record<string, AnyColumn | SQL>, sort: string | undefined, order: 'asc' | 'desc', fallback: AnyColumn | SQL) {
  const col = sort && sortable[sort] ? sortable[sort] : fallback;
  return order === 'asc' ? asc(col as AnyColumn) : desc(col as AnyColumn);
}

export const limitOffset = (p: Pagination) => ({ limit: p.pageSize, offset: (p.page - 1) * p.pageSize });

/** Case-insensitive contains across several columns. */
export function searchLike(q: string | undefined, ...cols: AnyColumn[]) {
  if (!q || !q.trim()) return undefined;
  const pattern = `%${q.trim().replace(/[%_]/g, (m) => `\\${m}`)}%`;
  return or(...cols.map((c) => ilike(c, pattern)));
}

/** Full-text + trigram search condition for a tsvector column. */
export function searchFts(q: string | undefined, vectorCol: AnyColumn, ...fuzzyCols: AnyColumn[]) {
  if (!q || !q.trim()) return undefined;
  const term = q.trim();
  const tsq = sql`websearch_to_tsquery('simple', ${term})`;
  const parts: SQL[] = [sql`${vectorCol} @@ ${tsq}`];
  for (const c of fuzzyCols) parts.push(ilike(c, `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`) as unknown as SQL);
  return or(...parts);
}
