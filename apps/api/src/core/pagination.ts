import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

export type Pagination = z.infer<typeof paginationSchema>;

export function paginate<T>(items: T[], total: number, p: Pagination) {
  return { items, total, page: p.page, pageSize: p.pageSize };
}

export const offsetOf = (p: Pagination) => (p.page - 1) * p.pageSize;

export const sortSchema = z.object({
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const listQuerySchema = paginationSchema.merge(sortSchema).extend({
  q: z.string().optional(),
});
