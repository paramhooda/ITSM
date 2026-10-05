import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';
import type { ReportSpec } from '@/db/schema/report-definitions';
import { customer, user, type DemoState } from './state';
import { addDays } from './rng';

/**
 * Four custom reports built in the report builder by the people who would build
 * them: a shared breakdown for management, a team's working list, a customer's
 * warranty register published to the portal, and one private time analysis.
 * Loaded once (the table is left alone when it already has rows).
 */
export async function seedCustomReports(state: DemoState, tx: Tx) {
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.reportDefinitions);
  if (n > 0) {
    state.counts.customReports = n;
    return;
  }
  const { now, refs } = state;
  const abc = customer(state, 'abc');
  const ananya = user(state, 'ananya');
  const rajesh = user(state, 'rajesh');
  const lakshmi = user(state, 'lakshmi');
  const sarah = user(state, 'sarah');
  const noc = refs.team('noc');
  const spec = (s: Partial<ReportSpec>): ReportSpec => ({ columns: [], filters: [], match: 'all', groupBy: [], aggregates: [], sort: null, dateField: null, rowLimit: null, chart: null, ...s });

  const rows: (typeof schema.reportDefinitions.$inferInsert)[] = [
    {
      name: 'P1 and P2 incidents by customer',
      description: 'How many high-priority incidents each customer raised in the period.',
      category: 'custom',
      entity: 'tickets',
      spec: spec({ groupBy: ['customer'], aggregates: [{ fn: 'count', label: 'Incidents' }], filters: [{ field: 'type', op: 'in', value: ['incident'] }, { field: 'priority_level', op: 'lte', value: 2 }], dateField: 'created_at', sort: { key: 'count', order: 'desc' }, chart: { type: 'bar', y: ['count'] } }),
      defaultDateRange: 'last_30_days',
      scopeCustomerId: null,
      ownerId: ananya.id,
      visibility: 'shared',
      sharedRoleKeys: ['service_manager', 'management', 'account_manager'],
      sharedTeamIds: [],
      portalVisible: false,
      cover: false,
      runCount: 12,
      lastRunAt: addDays(now, -2),
      createdAt: addDays(now, -40),
      updatedAt: addDays(now, -40),
    },
    {
      name: 'Open changes with windows',
      description: 'Every change still in flight with its risk and planned window, for the NOC.',
      category: 'custom',
      entity: 'changes',
      spec: spec({ columns: ['number', 'title', 'customer', 'change_type', 'risk_level', 'status', 'scheduled_start', 'scheduled_end', 'assignee'], filters: [{ field: 'status_category', op: 'in', value: ['new', 'open', 'pending'] }], sort: { key: 'scheduled_start', order: 'asc' } }),
      defaultDateRange: 'last_30_days',
      scopeCustomerId: null,
      ownerId: rajesh.id,
      visibility: 'shared',
      sharedRoleKeys: [],
      sharedTeamIds: [noc],
      portalVisible: false,
      cover: false,
      runCount: 7,
      lastRunAt: addDays(now, -1),
      createdAt: addDays(now, -25),
      updatedAt: addDays(now, -25),
    },
    {
      name: 'Warranty register for ABC',
      description: 'The assets in service at ABC Manufacturing with their warranty and AMC end dates, published to their portal.',
      category: 'custom',
      entity: 'assets',
      spec: spec({ columns: ['tag', 'name', 'category', 'site', 'manufacturer', 'model', 'warranty_end', 'amc_end', 'lifecycle_stage'], filters: [{ field: 'lifecycle_stage', op: 'not_in', value: ['retired', 'disposed'] }], sort: { key: 'warranty_end', order: 'asc' } }),
      defaultDateRange: 'last_30_days',
      scopeCustomerId: abc.id,
      ownerId: lakshmi.id,
      visibility: 'shared',
      sharedRoleKeys: ['contract_admin', 'account_manager'],
      sharedTeamIds: [],
      portalVisible: true,
      cover: true,
      runCount: 4,
      lastRunAt: addDays(now, -6),
      createdAt: addDays(now, -18),
      updatedAt: addDays(now, -18),
    },
    {
      name: 'Engineering time by person and work type',
      description: null,
      category: 'custom',
      entity: 'time_entries',
      spec: spec({ groupBy: ['user', 'work_type'], aggregates: [{ fn: 'sum', field: 'minutes', label: 'Minutes' }, { fn: 'count', label: 'Entries' }], dateField: 'started_at', sort: { key: 'sum_minutes', order: 'desc' }, chart: { type: 'bar', y: ['sum_minutes'] } }),
      defaultDateRange: 'last_month',
      scopeCustomerId: null,
      ownerId: sarah.id,
      visibility: 'private',
      sharedRoleKeys: [],
      sharedTeamIds: [],
      portalVisible: false,
      cover: false,
      runCount: 2,
      lastRunAt: addDays(now, -3),
      createdAt: addDays(now, -9),
      updatedAt: addDays(now, -9),
    },
  ];
  await tx.insert(schema.reportDefinitions).values(rows);
  state.counts.customReports = rows.length;
}
