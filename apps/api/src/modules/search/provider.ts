import type { Ctx } from '@/core/context';

/** Result types the global search can return. */
export const SEARCH_TYPES = ['ticket', 'customer', 'asset', 'ci', 'contract', 'service', 'kb', 'visit', 'known_error'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchHit {
  type: SearchType;
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  badgeColor?: string | null;
  link: string;
  /** Relative relevance (higher is better); informational. */
  score?: number;
}

/**
 * Search backend abstraction. The default implementation uses PostgreSQL
 * full-text search + trigram similarity; an OpenSearch/Meilisearch provider
 * can be plugged in later without touching the route or the UI.
 */
export interface SearchProvider {
  search(ctx: Ctx, q: string, types: SearchType[], limit: number): Promise<SearchHit[]>;
}
