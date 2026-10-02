/**
 * Approval workflows run their steps in order (DB-backed). Run with the dev environment sourced:
 *   npx vitest run test/approvals.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { withSystem, closeDb, schema } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { createTicket } from '../src/modules/tickets/service';
import * as approvals from '../src/modules/tickets/approvals';

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-approvals-${S}`, ip: '127.0.0.1' };
let admin: Principal;
const ids = { customer: '', cab: '' };
const ticketIds: string[] = [];
const asAdmin = <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(admin, meta, fn);

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [c] = await tx.insert(schema.customers).values({ code: `APR${S.toUpperCase()}`, name: `Approvals Customer ${S}` }).returning();
    ids.customer = c!.id;
    const [cab] = await tx.select({ id: schema.approvalWorkflows.id }).from(schema.approvalWorkflows).where(eq(schema.approvalWorkflows.name, 'CAB approval')).limit(1);
    if (!cab) throw new Error('"CAB approval" workflow missing (seed not applied?)');
    ids.cab = cab.id;
    const [u] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    invalidatePrincipal(u!.id);
    admin = (await loadPrincipal(u!.id))!;
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    if (ticketIds.length) await tx.delete(schema.tickets).where(inArray(schema.tickets.id, ticketIds));
    await tx.delete(schema.customers).where(eq(schema.customers.id, ids.customer));
  });
  await closeDb();
});

const statusesOf = (items: { step: number; status: string }[]) => [...items].sort((a, b) => a.step - b.step).map((a) => a.status);

describe('approval steps run in order', () => {
  it('opens only the first step, releases the next on approval, and completes when the last is approved', async () => {
    const t = await asAdmin((ctx) => createTicket(ctx, { type: 'change', customerId: ids.customer, title: `Two-step change ${S}`, description: 'Needs CAB' }));
    ticketIds.push(t.id);
    const started = await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, ids.cab));
    expect(statusesOf(started.items)).toEqual(['pending', 'waiting']);
    const [step1, step2] = [...started.items].sort((a, b) => a.step - b.step);

    // Nobody sees step 2 in their inbox yet, and it cannot be decided before step 1.
    const inbox = await asAdmin((ctx) => approvals.listMine(ctx));
    expect(inbox.items.some((a) => a.id === step2!.id)).toBe(false);
    await expect(asAdmin((ctx) => approvals.decide(ctx, t.id, step2!.id, 'approved'))).rejects.toThrow(/Step 1 must be decided/);

    const afterFirst = await asAdmin((ctx) => approvals.decide(ctx, t.id, step1!.id, 'approved', 'CAB ok'));
    expect(statusesOf(afterFirst.items)).toEqual(['approved', 'pending']);
    expect(afterFirst.approvalStatus).toBe('pending');

    const done = await asAdmin((ctx) => approvals.decide(ctx, t.id, step2!.id, 'approved'));
    expect(statusesOf(done.items)).toEqual(['approved', 'approved']);
    expect(done.approvalStatus).toBe('approved');
    const [row] = await withSystem((tx) => tx.select({ statusId: schema.tickets.statusId }).from(schema.tickets).where(eq(schema.tickets.id, t.id)));
    const [status] = await withSystem((tx) => tx.select({ key: schema.configOptions.key }).from(schema.configOptions).where(eq(schema.configOptions.id, row!.statusId)));
    expect(status!.key).toBe('approved');
  });

  it('a rejection at the first step skips the rest and rejects the ticket', async () => {
    const t = await asAdmin((ctx) => createTicket(ctx, { type: 'change', customerId: ids.customer, title: `Rejected change ${S}`, description: 'Will be rejected' }));
    ticketIds.push(t.id);
    const started = await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, ids.cab));
    const [step1] = [...started.items].sort((a, b) => a.step - b.step);
    const res = await asAdmin((ctx) => approvals.decide(ctx, t.id, step1!.id, 'rejected', 'Not this week'));
    expect(statusesOf(res.items)).toEqual(['rejected', 'skipped']);
    expect(res.approvalStatus).toBe('rejected');
    // Re-requesting supersedes the old steps and starts again at step 1.
    const again = await asAdmin((ctx) => approvals.requestApproval(ctx, t.id, ids.cab));
    expect(statusesOf(again.items.filter((a) => a.status !== 'superseded' && a.status !== 'rejected' && a.status !== 'skipped'))).toEqual(['pending', 'waiting']);
  });
});
