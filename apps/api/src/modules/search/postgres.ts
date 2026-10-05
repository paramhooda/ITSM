import { sql } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { isCustomerUser } from '@/core/authz';
import { KNOWN_ERROR_STATUS_LABELS } from '@itsm/shared';
import type { SearchHit, SearchProvider, SearchType } from './provider';

type Row = Record<string, unknown>;

const CONTRACT_STATUS_COLORS: Record<string, string> = { active: 'green', draft: 'slate', pending: 'amber', expired: 'red', terminated: 'red', renewed: 'blue', suspended: 'orange' };
const CI_STATUS_COLORS: Record<string, string> = { active: 'green', planned: 'blue', inactive: 'slate', maintenance: 'amber', retired: 'red' };
const VISIT_STATUS_COLORS: Record<string, string> = { requested: 'slate', scheduled: 'blue', in_progress: 'amber', completed: 'green', cancelled: 'red' };
const KB_VIS_COLORS: Record<string, string> = { internal: 'slate', customer: 'violet', public: 'green' };

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * PostgreSQL implementation: per type, exact-ish matches (numbers, tags,
 * serials, IPs, hostnames) rank first, then full-text matches, then trigram
 * similarity. Queries run sequentially on the request transaction (single
 * connection) and are bounded by `limit` each.
 */
export class PostgresSearchProvider implements SearchProvider {
  async search(ctx: Ctx, rawQ: string, types: SearchType[], limit: number): Promise<SearchHit[]> {
    const q = rawQ.trim();
    if (q.length < 2) return [];
    const customer = isCustomerUser(ctx.user);
    const hits: SearchHit[] = [];
    for (const type of types) {
      const fn = this.queries[type];
      if (!fn) continue;
      if (!this.allowed(ctx, type, customer)) continue;
      const rows = await fn(ctx, q, limit, customer);
      hits.push(...rows);
    }
    return hits;
  }

  private allowed(ctx: Ctx, type: SearchType, customer: boolean) {
    if (customer) {
      if (type === 'ticket') return ctx.can('portal:tickets');
      if (type === 'kb') return ctx.can('portal:access');
      if (type === 'known_error') return ctx.can('portal:kedb');
      return false;
    }
    switch (type) {
      case 'ticket':
        return ctx.can('tickets:read');
      case 'customer':
        return ctx.can('customers:read');
      case 'asset':
        return ctx.can('assets:read');
      case 'ci':
        return ctx.can('cmdb:read');
      case 'contract':
        return ctx.can('contracts:read');
      case 'service':
        return ctx.can('services:read');
      case 'kb':
        return ctx.can('kb:read') || ctx.can('kb:manage');
      case 'visit':
        return ctx.can('field:read') || ctx.can('field:execute');
      case 'known_error':
        return ctx.can('kedb:read');
      default:
        return false;
    }
  }

  private queries: Record<SearchType, (ctx: Ctx, q: string, limit: number, customer: boolean) => Promise<SearchHit[]>> = {
    ticket: async (ctx, q, limit, customer) => {
      const prefix = `${escapeLike(q)}%`;
      const socFilter = !customer && !ctx.can('soc:read') ? sql`and t.domain <> 'soc'` : sql``;
      // Portal users: RLS already limits rows to their organisation; the explicit predicate keeps that true even if the tenant context were ever wrong.
      const tenantFilter = customer ? sql`and t.customer_id = ${ctx.user.customerId ?? '00000000-0000-0000-0000-000000000000'}::uuid` : sql``;
      const res = await ctx.tx.execute(sql`
        select t.id, t.number, t.title, t.type, t.domain, c.name as customer_name, s.label as status_label, s.color as status_color,
          (case when t.number ilike ${prefix} then 3 else 0 end)
          + (case when t.external_ref ilike ${prefix} then 2 else 0 end)
          + ts_rank_cd(t.search_vector, websearch_to_tsquery('simple', ${q}))
          + similarity(t.title, ${q}) as score
        from tickets t
        left join customers c on c.id = t.customer_id
        left join config_options s on s.id = t.status_id
        where (t.number ilike ${prefix} or t.external_ref ilike ${prefix} or t.search_vector @@ websearch_to_tsquery('simple', ${q}) or similarity(t.title, ${q}) > 0.3)
        ${socFilter}
        ${tenantFilter}
        order by score desc, t.created_at desc
        limit ${limit}`);
      return (res.rows as Row[]).map((r) => ({
        type: 'ticket',
        id: String(r.id),
        title: `${r.number} · ${r.title}`,
        subtitle: [r.customer_name, titleCase(String(r.type))].filter(Boolean).join(' · '),
        badge: (r.status_label as string | null) ?? undefined,
        badgeColor: (r.status_color as string | null) ?? undefined,
        link: customer ? `/portal/tickets/${r.id}` : `/tickets/${r.id}`,
        score: Number(r.score),
      }));
    },

    customer: async (ctx, q, limit) => {
      const prefix = `${escapeLike(q)}%`;
      const res = await ctx.tx.execute(sql`
        select c.id, c.code, c.name, c.legal_name, c.is_active, st.label as status_label, st.color as status_color,
          (case when c.code ilike ${prefix} then 3 when c.name ilike ${prefix} then 2 else 0 end)
          + ts_rank_cd(c.search_vector, websearch_to_tsquery('simple', ${q}))
          + similarity(c.name, ${q}) as score
        from customers c
        left join config_options st on st.id = c.status_id
        where (c.code ilike ${prefix} or c.name ilike ${prefix} or c.search_vector @@ websearch_to_tsquery('simple', ${q}) or similarity(c.name, ${q}) > 0.3)
        order by score desc, c.name asc
        limit ${limit}`);
      return (res.rows as Row[]).map((r) => ({
        type: 'customer',
        id: String(r.id),
        title: String(r.name),
        subtitle: [r.code, r.legal_name].filter(Boolean).join(' · '),
        badge: (r.status_label as string | null) ?? (r.is_active ? undefined : 'Inactive'),
        badgeColor: (r.status_color as string | null) ?? (r.is_active ? undefined : 'slate'),
        link: `/customers/${r.id}`,
        score: Number(r.score),
      }));
    },

    asset: async (ctx, q, limit) => {
      const prefix = `${escapeLike(q)}%`;
      const res = await ctx.tx.execute(sql`
        select a.id, a.tag, a.name, a.serial_number, a.model, a.lifecycle_stage, c.name as customer_name, st.label as status_label, st.color as status_color,
          (case when a.tag ilike ${prefix} then 3 when a.serial_number ilike ${prefix} then 3 else 0 end)
          + ts_rank_cd(a.search_vector, websearch_to_tsquery('simple', ${q}))
          + similarity(a.name, ${q}) as score
        from assets a
        left join customers c on c.id = a.customer_id
        left join config_options st on st.id = a.status_id
        where (a.tag ilike ${prefix} or a.serial_number ilike ${prefix} or a.search_vector @@ websearch_to_tsquery('simple', ${q}) or similarity(a.name, ${q}) > 0.3)
        order by score desc, a.name asc
        limit ${limit}`);
      return (res.rows as Row[]).map((r) => ({
        type: 'asset',
        id: String(r.id),
        title: `${r.tag} · ${r.name}`,
        subtitle: [r.customer_name, r.model, r.serial_number ? `S/N ${r.serial_number}` : null].filter(Boolean).join(' · '),
        badge: (r.status_label as string | null) ?? titleCase(String(r.lifecycle_stage ?? '')),
        badgeColor: (r.status_color as string | null) ?? 'slate',
        link: `/assets/${r.id}`,
        score: Number(r.score),
      }));
    },

    ci: async (ctx, q, limit) => {
      const prefix = `${escapeLike(q)}%`;
      const res = await ctx.tx.execute(sql`
        select ci.id, ci.name, ci.hostname, ci.ip_address, ci.status, ci.environment, c.name as customer_name, t.name as type_name, t.color as type_color,
          (case when ci.ip_address ilike ${prefix} then 3 when ci.hostname ilike ${prefix} then 3 when ci.name ilike ${prefix} then 2 when ci.serial_number ilike ${prefix} then 2 else 0 end)
          + ts_rank_cd(ci.search_vector, websearch_to_tsquery('simple', ${q}))
          + greatest(similarity(ci.name, ${q}), similarity(coalesce(ci.hostname, ''), ${q})) as score
        from cis ci
        left join customers c on c.id = ci.customer_id
        left join ci_types t on t.id = ci.type_id
        where (ci.ip_address ilike ${prefix} or ci.hostname ilike ${prefix} or ci.name ilike ${prefix} or ci.serial_number ilike ${prefix}
          or ci.search_vector @@ websearch_to_tsquery('simple', ${q}) or similarity(ci.name, ${q}) > 0.3 or similarity(coalesce(ci.hostname, ''), ${q}) > 0.3)
        order by score desc, ci.name asc
        limit ${limit}`);
      return (res.rows as Row[]).map((r) => ({
        type: 'ci',
        id: String(r.id),
        title: String(r.name),
        subtitle: [r.customer_name, r.hostname, r.ip_address, r.status !== 'active' ? titleCase(String(r.status)) : null].filter(Boolean).join(' · '),
        badge: (r.type_name as string | null) ?? undefined,
        badgeColor: (r.type_color as string | null) ?? CI_STATUS_COLORS[String(r.status)] ?? 'slate',
        link: `/cmdb/${r.id}`,
        score: Number(r.score),
      }));
    },

    contract: async (ctx, q, limit) => {
      const prefix = `${escapeLike(q)}%`;
      const contains = `%${escapeLike(q)}%`;
      const res = await ctx.tx.execute(sql`
        select k.id, k.number, k.name, k.status, k.end_date, c.name as customer_name, t.label as type_label,
          (case when k.number ilike ${prefix} then 3 when k.name ilike ${prefix} then 1.5 else 0 end)
          + similarity(k.name, ${q}) as score
        from contracts k
        left join customers c on c.id = k.customer_id
        left join config_options t on t.id = k.type_id
        where (k.number ilike ${prefix} or k.name ilike ${contains} or similarity(k.name, ${q}) > 0.3)
        order by score desc, k.end_date desc
        limit ${limit}`);
      return (res.rows as Row[]).map((r) => ({
        type: 'contract',
        id: String(r.id),
        title: `${r.number} · ${r.name}`,
        subtitle: [r.customer_name, r.type_label, r.end_date ? `ends ${String(r.end_date).slice(0, 10)}` : null].filter(Boolean).join(' · '),
        badge: titleCase(String(r.status)),
        badgeColor: CONTRACT_STATUS_COLORS[String(r.status)] ?? 'slate',
        link: `/contracts/${r.id}`,
        score: Number(r.score),
      }));
    },

    service: async (ctx, q, limit) => {
      const prefix = `${escapeLike(q)}%`;
      const contains = `%${escapeLike(q)}%`;
      const res = await ctx.tx.execute(sql`
        select s.id, s.key, s.name, s.domain, s.is_active, cat.label as category_label,
          (case when s.key ilike ${prefix} then 3 when s.name ilike ${prefix} then 2 else 0 end) + similarity(s.name, ${q}) as score
        from services s
        left join config_options cat on cat.id = s.category_id
        where (s.key ilike ${prefix} or s.name ilike ${contains} or similarity(s.name, ${q}) > 0.3 or s.description ilike ${contains})
        order by score desc, s.name asc
        limit ${limit}`);
      return (res.rows as Row[]).map((r) => ({
        type: 'service',
        id: String(r.id),
        title: String(r.name),
        subtitle: [r.key, r.category_label, r.domain !== 'general' ? String(r.domain).toUpperCase() : null].filter(Boolean).join(' · '),
        badge: r.is_active ? undefined : 'Inactive',
        badgeColor: r.is_active ? undefined : 'slate',
        link: `/services?focus=${r.id}`,
        score: Number(r.score),
      }));
    },

    kb: async (ctx, q, limit, customer) => {
      const prefix = `${escapeLike(q)}%`;
      const cid = ctx.user.customerId ?? '00000000-0000-0000-0000-000000000000';
      const visibility = customer ? sql`and k.status = 'published' and (k.visibility = 'public' or (k.visibility = 'customer' and k.customer_id = ${cid}::uuid))` : sql`and k.status <> 'archived'`;
      const res = await ctx.tx.execute(sql`
        select k.id, k.number, k.title, k.article_type, k.visibility, k.status, c.name as customer_name, cat.name as category_name,
          (case when k.number ilike ${prefix} then 3 when k.title ilike ${prefix} then 1 else 0 end)
          + ts_rank_cd(k.search_vector, websearch_to_tsquery('simple', ${q}))
          + similarity(k.title, ${q}) as score
        from kb_articles k
        left join customers c on c.id = k.customer_id
        left join kb_categories cat on cat.id = k.category_id
        where (k.number ilike ${prefix} or k.search_vector @@ websearch_to_tsquery('simple', ${q}) or similarity(k.title, ${q}) > 0.3)
        ${visibility}
        order by score desc, k.view_count desc
        limit ${limit}`);
      return (res.rows as Row[]).map((r) => ({
        type: 'kb',
        id: String(r.id),
        title: `${r.number} · ${r.title}`,
        subtitle: [r.category_name, titleCase(String(r.article_type)), r.customer_name, r.status !== 'published' ? titleCase(String(r.status)) : null].filter(Boolean).join(' · '),
        badge: titleCase(String(r.visibility)),
        badgeColor: KB_VIS_COLORS[String(r.visibility)] ?? 'slate',
        link: `/knowledge/${r.id}`,
        score: Number(r.score),
      }));
    },

    visit: async (ctx, q, limit) => {
      const prefix = `${escapeLike(q)}%`;
      const contains = `%${escapeLike(q)}%`;
      const res = await ctx.tx.execute(sql`
        select v.id, v.number, v.title, v.status, v.scheduled_start, c.name as customer_name, u.name as engineer_name,
          (case when v.number ilike ${prefix} then 3 when v.title ilike ${prefix} then 1.5 else 0 end) + similarity(v.title, ${q}) as score
        from field_visits v
        left join customers c on c.id = v.customer_id
        left join users u on u.id = v.engineer_id
        where (v.number ilike ${prefix} or v.title ilike ${contains} or similarity(v.title, ${q}) > 0.3)
        order by score desc, v.scheduled_start desc nulls last
        limit ${limit}`);
      return (res.rows as Row[]).map((r) => ({
        type: 'visit',
        id: String(r.id),
        title: `${r.number} · ${r.title}`,
        subtitle: [r.customer_name, r.engineer_name, r.scheduled_start ? new Date(String(r.scheduled_start)).toISOString().slice(0, 10) : null].filter(Boolean).join(' · '),
        badge: titleCase(String(r.status)),
        badgeColor: VISIT_STATUS_COLORS[String(r.status)] ?? 'slate',
        link: `/field/${r.id}`,
        score: Number(r.score),
      }));
    },

    known_error: async (ctx, q, limit, customer) => {
      const prefix = `${escapeLike(q)}%`;
      const cid = ctx.user.customerId ?? '00000000-0000-0000-0000-000000000000';
      // Customers match the title and the customer wording of their organisation's published entries only; staff match the whole problem text.
      const text = customer ? sql`to_tsvector('simple', coalesce(t.title, '') || ' ' || coalesce(pd.customer_summary, '') || ' ' || coalesce(pd.customer_workaround, ''))` : sql`(t.search_vector || pd.ke_search_vector)`;
      const visibility = customer ? sql`and pd.portal_visible and t.customer_id = ${cid}::uuid and coalesce(pd.ke_status, 'open') <> 'retired'` : !ctx.can('soc:read') ? sql`and t.domain <> 'soc'` : sql``;
      const res = await ctx.tx.execute(sql`
        select t.id, t.number, t.title, coalesce(pd.ke_status, 'open') as ke_status, pd.portal_visible, c.name as customer_name, s.name as service_name,
          (case when t.number ilike ${prefix} then 3 else 0 end)
          + ts_rank_cd(${text}, websearch_to_tsquery('simple', ${q}))
          + similarity(t.title, ${q}) as score
        from tickets t
        join problem_details pd on pd.ticket_id = t.id
        left join customers c on c.id = t.customer_id
        left join services s on s.id = t.service_id
        where t.type = 'problem' and pd.is_known_error
          and (t.number ilike ${prefix} or ${text} @@ websearch_to_tsquery('simple', ${q}) or similarity(t.title, ${q}) > 0.3)
        ${visibility}
        order by score desc, pd.updated_at desc
        limit ${limit}`);
      return (res.rows as Row[]).map((r) => {
        const status = KNOWN_ERROR_STATUS_LABELS[String(r.ke_status) as keyof typeof KNOWN_ERROR_STATUS_LABELS] ?? titleCase(String(r.ke_status));
        return {
          type: 'known_error',
          id: String(r.id),
          title: customer ? String(r.title) : `${r.number} · ${r.title}`,
          subtitle: (customer ? [r.service_name, status] : [r.customer_name, r.service_name, status, r.portal_visible ? 'Published' : null]).filter(Boolean).join(' · '),
          badge: 'Known error',
          badgeColor: 'orange',
          link: `/knowledge/known-errors/${r.id}`,
          score: Number(r.score),
        };
      });
    },
  };
}

function escapeLike(s: string) {
  return s.replace(/[%_\\]/g, (m) => `\\${m}`);
}

export const postgresSearchProvider = new PostgresSearchProvider();
