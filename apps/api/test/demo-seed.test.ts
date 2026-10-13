import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql, and } from 'drizzle-orm';
import { withSystem, closeDb, schema } from '../src/db/client';
import { runAs } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal } from '../src/core/principal';
import { listTickets } from '../src/modules/tickets/list';
import { listQuerySchema } from '../src/modules/tickets/schemas';
import { loadDemoData } from '../src/seed/demo-data';
import { listResponses } from '../src/modules/surveys/service';
import { responsesQuery } from '../src/modules/surveys/schemas';
import { resolutionCompliance } from '../src/modules/sla/compliance';
import { toDay, addDays } from '../src/modules/reports/dates';
import { noticeDays } from '../src/jobs/processors/contracts';
import { INDIA_MOVABLE, INDIA_HOLIDAY_CALENDAR, UK_HOLIDAY_CALENDAR } from '../src/seed/holidays';
import { CUSTOMER_SEEDS } from '../src/seed/demo/customers';
import { CAL_UK } from '../src/seed/demo/state';

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
    // Known error database: flagged problems carry a status and customer wording; some are published to the portal.
    expect(await count('problem_details', 'where is_known_error')).toBeGreaterThanOrEqual(10);
    expect(await count('problem_details', 'where portal_visible')).toBeGreaterThanOrEqual(5);
    expect(await count('problem_details', "where is_known_error and ke_status is not null and customer_workaround is not null")).toBeGreaterThanOrEqual(10);
    // Customer satisfaction: a survey per resolved incident or request of the last ninety days, about half answered, three policy overrides.
    expect(await count('ticket_surveys')).toBeGreaterThanOrEqual(150);
    expect(await count('ticket_surveys', "where status = 'answered' and rating between 1 and 5")).toBeGreaterThanOrEqual(60);
    expect(await count('ticket_surveys', 'where status = \'answered\' and rating <= 2 and low_rating_alerted_at is not null')).toBeGreaterThan(0);
    expect(await count('tickets', 'where csat_rating is not null')).toBeGreaterThanOrEqual(60);
    expect(await count('survey_configs')).toBeGreaterThanOrEqual(3);
    // Task boards: the shift handovers the board panel shows (one acknowledged), personal sticky notes, open tasks for the NOC engineers.
    expect(await count('shift_handovers', "where status in ('final', 'acknowledged')")).toBeGreaterThanOrEqual(2);
    expect(await count('shift_handovers', "where status = 'acknowledged'")).toBeGreaterThanOrEqual(1);
    // the seed also writes one done note, which the retention purge (exercised by boards.test.ts in the same run) may remove at any time
    expect(await count('board_notes', 'where not done')).toBeGreaterThanOrEqual(8);
    expect(await count('board_notes', 'where pinned')).toBeGreaterThanOrEqual(2);
    expect(await count('ticket_tasks', "where status in ('open', 'in_progress') and due_at < now()")).toBeGreaterThanOrEqual(2);
    expect(await count('ticket_tasks', "where status = 'in_progress'")).toBeGreaterThanOrEqual(3);
    // Software asset management: a shared catalogue, installations on the committed CIs and imported hosts, licences in every position, one renewed.
    expect(await count('software_products')).toBeGreaterThanOrEqual(10);
    expect(await count('software_installations')).toBeGreaterThanOrEqual(300);
    expect(await count('software_licences')).toBeGreaterThanOrEqual(15);
    expect(await count('software_licences', 'where successor_id is not null')).toBeGreaterThanOrEqual(1);
    expect(await count('software_licences', 'where end_date < current_date and successor_id is null')).toBeGreaterThanOrEqual(1);
    expect(await count('assets', "a join config_options o on o.id = a.category_id where o.key = 'software_license'")).toBe(0);
    // Custom reports: the four built in the report builder (one shared with roles, one with a team, one published to a portal, one private).
    expect(await count('report_definitions')).toBeGreaterThanOrEqual(4);
    expect(await count('report_definitions', 'where portal_visible and scope_customer_id is not null')).toBeGreaterThanOrEqual(1);
    expect(await count('report_definitions', "where visibility = 'shared' and cardinality(shared_team_ids) > 0")).toBeGreaterThanOrEqual(1);
    // Notification preferences: the fifteen seeded categories; six demo people opted in to WhatsApp with a verified number and a few categories switched off.
    expect(await count('notification_categories')).toBeGreaterThanOrEqual(15);
    expect(await count('users', 'where whatsapp_opt_in and whatsapp_verified_at is not null')).toBeGreaterThanOrEqual(6);
    expect(await count('users', "where whatsapp_verified_at is not null and preferences -> 'notifications' <> '{}'::jsonb")).toBeGreaterThanOrEqual(6);
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
        surveys: await q('select count(*)::int as n from ticket_surveys s join tickets t on t.id = s.ticket_id where s.customer_id <> t.customer_id'),
        surveyTimes: await q('select count(*)::int as n from ticket_surveys where (answered_at is not null and answered_at < requested_at) or expires_at <= requested_at'),
        installs: await q('select count(*)::int as n from software_installations i join cis c on c.id = i.ci_id where c.customer_id <> i.customer_id'),
        licences: await q('select count(*)::int as n from software_licences l join contracts c on c.id = l.contract_id where c.customer_id <> l.customer_id'),
      };
    });
    expect(mismatches).toEqual({ sites: 0, cis: 0, contracts: 0, rels: 0, assets: 0, slas: 0, visits: 0, contractDates: 0, surveys: 0, surveyTimes: 0, installs: 0, licences: 0 });
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

  it('keeps its dates current', async () => {
    // Every assertion is relative to the load date and scoped to the demo rows (CTR- numbers, the demo customer codes, the demo
    // licence names): the database is shared with other test files that create their own contracts and licences.
    const demoCodes = CUSTOMER_SEEDS.map((c) => `'${c.code}'`).join(', ');
    const demoCustomers = `(select id from customers where code in (${demoCodes}))`;
    const year = new Date().getUTCFullYear(); // the seeds take their year from the load instant in UTC
    // Contracts: active and expiring ones cover today; none sits inside the window the daily job uses, so the two expiring ones stay the only two.
    expect(await count('contracts', "where number like 'CTR-%' and status in ('active','expiring') and (start_date > current_date or end_date < current_date)")).toBe(0);
    const maxNotice = Math.max(0, ...(await withSystem(noticeDays)));
    expect(await count('contracts', `where number like 'CTR-%' and status = 'active' and end_date <= current_date + greatest(coalesce(notice_period_days, 0), ${maxNotice})`)).toBe(0);
    expect(await count('contracts', "where number like 'CTR-%' and status = 'expiring'")).toBe(2);
    // Numbers carry the start year; the draft proposal starts next January; the predecessors end before their successors start.
    expect(await count('contracts', "where number like 'CTR-%' and number not like 'CTR-' || to_char(start_date, 'YYYY') || '-%'")).toBe(0);
    expect(await count('contracts', `where number like 'CTR-%' and status = 'draft' and start_date = '${year + 1}-01-01'`)).toBe(1);
    expect(await count('contracts', "p join contracts c on c.parent_contract_id = p.id where c.number like 'CTR-%' and p.end_date >= c.start_date")).toBe(0);
    expect(await count('contracts', "p join contracts c on c.parent_contract_id = p.id where c.number like 'CTR-%' and c.custom_fields->>'renewedFrom' is distinct from p.number")).toBe(0);
    expect(await count('contracts', "where number like 'CTR-%' and name like 'Managed Infrastructure Services %' and name <> 'Managed Infrastructure Services ' || to_char(start_date, 'YYYY')")).toBe(0);
    expect(await count('contracts', "where number like 'CTR-%' and name like 'Managed Infrastructure Services %'")).toBe(2);
    expect(await count('contracts', `where number like 'CTR-%' and name like 'SOC Services %-%' and name <> 'SOC Services ' || to_char(start_date, 'YYYY') || '-' || to_char(end_date, 'YY')`)).toBe(0);
    expect(await count('contracts', `where number like 'CTR-%' and name ~ '^SOC Services [0-9]{4}$' and name <> 'SOC Services ' || to_char(start_date, 'YYYY')`)).toBe(0);
    expect(await count('contracts', `where number like 'CTR-%' and name ~ '^SOC Services [0-9]{4}'`)).toBe(2);
    expect(await count('contracts', `where number like 'CTR-%' and status = 'draft' and name <> 'Managed Services ${year + 1} (proposal)'`)).toBe(0);
    // Customers were onboarded before their first signed contract.
    expect(await count('customers', `where code in (${demoCodes}) and (custom_fields->>'onboardedOn')::date > (select min(c.start_date) from contracts c where c.customer_id = customers.id and c.status <> 'draft')`)).toBe(0);
    // Request form dates and the CVE year follow the ticket's own creation date.
    for (const field of ['startDate', 'expiry', 'preferredDate']) {
      expect(await count('tickets', `where customer_id in ${demoCustomers} and type = 'request' and form_data ? '${field}' and (form_data->>'${field}')::date < created_at::date`)).toBe(0);
      expect(await count('tickets', `where customer_id in ${demoCustomers} and type = 'request' and form_data ? '${field}'`)).toBeGreaterThan(0);
    }
    expect(await count('tickets', `where customer_id in ${demoCustomers} and title like 'Critical CVE-%' and title not like 'Critical CVE-' || to_char(created_at, 'YYYY') || '-%'`)).toBe(0);
    // Holidays for the load year and the next: India from the fixed dates plus the movable table, the UK by rule, the UK business calendar wired to it.
    const india = (y: number) => count('holidays h join holiday_calendars c on c.id = h.calendar_id', `where c.name = '${INDIA_HOLIDAY_CALENDAR}' and extract(year from h.date) = ${y}`);
    const uk = (y: number) => count('holidays h join holiday_calendars c on c.id = h.calendar_id', `where c.name = '${UK_HOLIDAY_CALENDAR}' and extract(year from h.date) = ${y}`);
    for (const y of [year, year + 1]) {
      expect(await india(y)).toBe(4 + (INDIA_MOVABLE[y]?.length ?? 0));
      expect(await uk(y)).toBe(8);
    }
    expect(await count('business_calendars b join holiday_calendars h on h.id = b.holiday_calendar_id', `where b.name = '${CAL_UK}' and h.name = '${UK_HOLIDAY_CALENDAR}'`)).toBe(1);
    expect(await count('contracts c join holiday_calendars h on h.id = c.holiday_calendar_id', `where c.number like 'CTR-%' and c.name = 'Managed IT Services (UK)' and h.name = '${UK_HOLIDAY_CALENDAR}'`)).toBe(1);
    expect(await count('contracts c join holiday_calendars h on h.id = c.holiday_calendar_id', `where c.number like 'CTR-%' and c.name <> 'Managed IT Services (UK)' and h.name <> '${INDIA_HOLIDAY_CALENDAR}'`)).toBe(0);
    // Software: the renewed Microsoft 365 licence carries the year it started.
    expect(await count('software_licences', "where name like 'Microsoft 365 E3 annual%' and successor_id is not null and name = 'Microsoft 365 E3 annual (200) ' || to_char(start_date, 'YYYY')")).toBe(1);
    expect(await count('software_licences', `where name like 'AutoCAD % seats' and name <> 'AutoCAD ${year} seats'`)).toBe(0);
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
    // The survey responses are fenced the same way, without engineer or team names.
    const responses = await runAs(principal!, { requestId: 'demo-seed-test', source: 'ui' }, (ctx) => listResponses(ctx, responsesQuery.parse({ page: 1, pageSize: 500, days: 365 })));
    expect(responses.total).toBe(await count('ticket_surveys', `where customer_id = '${abc.id}' and status = 'answered' and answered_at >= now() - interval '365 days'`));
    expect(responses.items.length).toBeGreaterThan(5);
    expect(responses.items.every((r) => r.customerId === abc.id && !('assigneeName' in r) && !('teamName' in r) && !('recipientEmail' in r))).toBe(true);
  });

  it('gives ABC Manufacturing four active sites and the portal home a live customer-audience announcement', async () => {
    const abc = await withSystem(async (tx) => (await tx.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.code, 'ABC')))[0]!);
    expect(await count('sites', `where customer_id = '${abc.id}' and is_active`)).toBe(4);
    // Pinned for every customer and inside its window, so the Announcements panel of the demo portal home is never empty.
    expect(await count('announcements', "where audience = 'customers' and is_active and cardinality(customer_ids) = 0 and starts_at <= now() and (ends_at is null or ends_at > now())")).toBeGreaterThanOrEqual(1);
  });

  it('gives ABC Manufacturing a resolution compliance donut that is never empty and equals a direct count of the seeded clocks', async () => {
    const abc = await withSystem(async (tx) => (await tx.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.code, 'ABC')))[0]!);
    const adminUser = await withSystem(async (tx) => (await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')))[0]!);
    invalidatePrincipal(adminUser.id);
    const principal = await loadPrincipal(adminUser.id);
    const today = toDay(new Date());
    const w = { from: addDays(today, -29), to: today };
    const r = await runAs(principal!, { requestId: 'demo-seed-test', source: 'ui' }, (ctx) => resolutionCompliance(ctx, { ...w, fence: sql`AND t.customer_id = ${abc.id}::uuid` }));
    // Closed tickets are spread over 120 days and drift with the reset date: no fixed minimum, only "something ended" and the direct count.
    expect(r.met + r.breached).toBeGreaterThanOrEqual(1);
    const win = (col: string) => `${col} >= ('${w.from}'::date)::timestamp at time zone 'UTC' and ${col} < ('${w.to}'::date + interval '1 day')::timestamp at time zone 'UTC'`;
    expect(r.met).toBe(await count('ticket_slas s join tickets t on t.id = s.ticket_id', `where t.customer_id = '${abc.id}' and s.metric = 'resolution' and s.state = 'met' and ${win('s.completed_at')}`));
    expect(r.breached).toBe(await count('ticket_slas s join tickets t on t.id = s.ticket_id', `where t.customer_id = '${abc.id}' and s.metric = 'resolution' and s.state = 'breached' and ${win('s.breached_at')}`));
    expect(r.compliancePct).toBe(Math.round((r.met / (r.met + r.breached)) * 1000) / 10);
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
