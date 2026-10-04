import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql, and } from 'drizzle-orm';
import { withSystem, closeDb, schema } from '../src/db/client';
import { runAs } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal } from '../src/core/principal';
import { listTickets } from '../src/modules/tickets/list';
import { listQuerySchema } from '../src/modules/tickets/schemas';
import { loadDemoData } from '../src/seed/demo-data';

/**
 * Loads the demonstration dataset into the test database when it is empty
 * (dev-env.sh applies migrations + defaults + admin) and checks that the result
 * is internally consistent. The full load takes about a minute.
 */
const count = async (table: string, where = '') => withSystem(async (tx) => Number(((await tx.execute(sql.raw(`select count(*)::int as n from ${table} ${where}`))).rows[0] as { n: number }).n));

let seeded = false;

beforeAll(async () => {
  const customers = await count('customers');
  if (customers === 0) {
    await loadDemoData();
    seeded = true;
  }
}, 240_000);

afterAll(async () => {
  await closeDb();
});

describe('demo dataset', () => {
  it('loads the expected volumes', async () => {
    expect(await count('customers')).toBeGreaterThanOrEqual(10);
    expect(await count('sites')).toBeGreaterThanOrEqual(30);
    expect(await count('contracts')).toBeGreaterThanOrEqual(18);
    expect(await count('tickets')).toBeGreaterThanOrEqual(400);
    expect(await count('cis')).toBeGreaterThanOrEqual(200);
    expect(await count('ci_relationships')).toBeGreaterThanOrEqual(250);
    expect(await count('assets')).toBeGreaterThanOrEqual(150);
    expect(await count('kb_articles', "where status = 'published'")).toBeGreaterThanOrEqual(25);
    expect(await count('field_visits')).toBeGreaterThanOrEqual(40);
    expect(await count('pm_programs')).toBeGreaterThanOrEqual(5);
    expect(await count('integration_events')).toBeGreaterThanOrEqual(50);
    expect(await count('metric_rollups_daily')).toBeGreaterThan(0);
    expect(await count('users', "where user_type = 'customer'")).toBeGreaterThanOrEqual(10);
    // Change management: blackouts, scored risk, standard changes from the catalog, CAB meetings with agendas.
    expect(await count('change_blackout_windows')).toBeGreaterThanOrEqual(3);
    expect(await count('cab_meetings')).toBeGreaterThanOrEqual(2);
    expect(await count('cab_meeting_items')).toBeGreaterThanOrEqual(5);
    expect(await count('change_details', 'where risk_score is not null')).toBeGreaterThanOrEqual(10);
    expect(await count('change_details', 'where template_id is not null')).toBeGreaterThanOrEqual(3);
    expect(await count('change_risk_questions')).toBeGreaterThanOrEqual(6);
    expect(await count('change_templates')).toBeGreaterThanOrEqual(4);
  });

  it('keeps every customer-scoped row inside its parent customer', async () => {
    const mismatches = await withSystem(async (tx) => {
      const q = async (s: string) => Number(((await tx.execute(sql.raw(s))).rows[0] as { n: number }).n);
      return {
        sites: await q('select count(*)::int as n from tickets t join sites s on s.id = t.site_id where s.customer_id <> t.customer_id'),
        cis: await q('select count(*)::int as n from tickets t join cis c on c.id = t.primary_ci_id where c.customer_id <> t.customer_id'),
        contracts: await q('select count(*)::int as n from tickets t join contracts c on c.id = t.contract_id where c.customer_id <> t.customer_id'),
        rels: await q('select count(*)::int as n from ci_relationships r join cis a on a.id = r.source_ci_id join cis b on b.id = r.target_ci_id where a.customer_id <> r.customer_id or b.customer_id <> r.customer_id'),
        assets: await q('select count(*)::int as n from cis c join assets a on a.id = c.asset_id where a.customer_id <> c.customer_id'),
        slas: await q('select count(*)::int as n from ticket_slas s join tickets t on t.id = s.ticket_id where s.customer_id <> t.customer_id'),
        visits: await q('select count(*)::int as n from field_visits v join tickets t on t.id = v.ticket_id where v.customer_id <> t.customer_id'),
        contractDates: await q('select count(*)::int as n from contracts where end_date < start_date'),
      };
    });
    expect(mismatches).toEqual({ sites: 0, cis: 0, contracts: 0, rels: 0, assets: 0, slas: 0, visits: 0, contractDates: 0 });
  });

  it('has coherent SLA rows', async () => {
    expect(await count('ticket_slas', "where state = 'met' and completed_at > due_at")).toBe(0);
    expect(await count('ticket_slas', "where state = 'breached' and completed_at is not null and completed_at <= due_at")).toBe(0);
    expect(await count('ticket_slas', "where state in ('met','breached','cancelled') and completed_at is not null and completed_at < started_at")).toBe(0);
    // The generator decides running/breached against the load's start time; a clock due minutes later is swept by the SLA job in a running system, so allow that latency here.
    expect(await count('ticket_slas', "where state = 'running' and due_at < now() - interval '15 minutes'")).toBe(0);
    expect(await count('ticket_slas', "where state = 'paused' and paused_at is null")).toBe(0);
    // every incident / request carries SLA clocks; changes and problems may not
    expect(await count('tickets', "t where t.type in ('incident','request') and not exists (select 1 from ticket_slas s where s.ticket_id = t.id)")).toBe(0);
    expect(await count('tickets', 'where created_at > now()')).toBe(0);
    expect(await count('tickets', 'where resolved_at is not null and resolved_at < created_at')).toBe(0);
    const compliance = await withSystem(async (tx) => {
      const rows = (await tx.execute(sql`select metric, count(*) filter (where state = 'met')::float / nullif(count(*) filter (where state in ('met','breached')), 0) as pct from ticket_slas where metric in ('response','resolution') group by metric`)).rows as { metric: string; pct: number }[];
      return Object.fromEntries(rows.map((r) => [r.metric, Number(r.pct)]));
    });
    expect(compliance.response).toBeGreaterThan(0.75);
    expect(compliance.resolution).toBeGreaterThan(0.8);
    expect(await count('ticket_slas', "where state = 'breached'")).toBeGreaterThan(10);
  });

  it('has a realistic status and scope mix', async () => {
    const open = await count('tickets', "t join config_options s on s.id = t.status_id where s.status_category in ('new','open','pending')");
    const total = await count('tickets');
    expect(open / total).toBeGreaterThan(0.06);
    expect(open / total).toBeLessThan(0.25);
    expect(await count('tickets', "where scope_status = 'out_of_scope'")).toBeGreaterThan(10);
    expect(await count('tickets', "where scope_status = 'in_scope'")).toBeGreaterThan(total * 0.6);
    expect(await count('tickets', "where type = 'problem'")).toBeGreaterThanOrEqual(10);
    expect(await count('tickets', "where type = 'change'")).toBeGreaterThanOrEqual(10);
    expect(await count('ticket_links', "where link_type = 'problem_of'")).toBeGreaterThan(5);
    expect(await count('approvals')).toBeGreaterThan(10);
    expect(await count('entitlement_consumptions')).toBeGreaterThan(20);
    expect(await count('tickets', "where created_at > now() - interval '7 days'")).toBeGreaterThan(15);
  });

  it('lets an ABC Manufacturing portal user see only ABC tickets', async () => {
    const abc = await withSystem(async (tx) => (await tx.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.code, 'ABC')))[0]!);
    const portalUser = await withSystem(async (tx) => (await tx.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.email, 'manish.agarwal@abc-manufacturing.example'), eq(schema.users.userType, 'customer'))))[0]!);
    invalidatePrincipal(portalUser.id);
    const principal = await loadPrincipal(portalUser.id);
    expect(principal?.customerScope).toEqual([abc.id]);
    const page = await runAs(principal!, { requestId: 'demo-seed-test', source: 'ui' }, (ctx) => listTickets(ctx, listQuerySchema.parse({ page: 1, pageSize: 500 })));
    const abcTotal = await count('tickets', `where customer_id = '${abc.id}'`);
    expect(page.total).toBe(abcTotal);
    expect(page.items.length).toBeGreaterThan(30);
    expect(page.items.every((t) => t.customerId === abc.id)).toBe(true);
  });

  it('gives a field engineer visibility limited to granted customers', async () => {
    const eng = await withSystem(async (tx) => (await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'suresh.reddy@msp.local')))[0]!);
    invalidatePrincipal(eng.id);
    const principal = await loadPrincipal(eng.id);
    expect(principal?.customerScope).not.toBe('all');
    expect((principal?.customerScope as string[]).length).toBeGreaterThanOrEqual(4);
    const page = await runAs(principal!, { requestId: 'demo-seed-test', source: 'ui' }, (ctx) => listTickets(ctx, listQuerySchema.parse({ page: 1, pageSize: 500 })));
    expect(page.items.every((t) => (principal!.customerScope as string[]).includes(t.customerId))).toBe(true);
  });

  it('reports whether this run performed the load', () => {
    expect(typeof seeded).toBe('boolean');
  });
});
