import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import { SEARCH_TYPES, type SearchProvider, type SearchType } from './provider';
import { postgresSearchProvider } from './postgres';

/** Active provider (PostgreSQL FTS by default; swap here to use an external engine). */
export const searchProvider: SearchProvider = postgresSearchProvider;

const querySchema = z.object({
  q: z.string().min(1).max(200),
  types: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(25).default(8),
});

export function parseTypes(raw: string | undefined): SearchType[] {
  if (!raw) return [...SEARCH_TYPES];
  const wanted = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const valid = wanted.filter((t): t is SearchType => (SEARCH_TYPES as readonly string[]).includes(t));
  return valid.length ? [...new Set(valid)] : [...SEARCH_TYPES];
}

export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/search', { preHandler: app.auth(), schema: { tags: ['search'], querystring: querySchema } }, h(async (ctx, req) => {
    const { q, types, limit } = req.query as z.infer<typeof querySchema>;
    const started = Date.now();
    const items = await searchProvider.search(ctx, q, parseTypes(types), limit);
    return { items, tookMs: Date.now() - started };
  }));
}
