import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, and } from 'drizzle-orm';
import { withSystem, closeDb, schema } from '../src/db/client';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { runAs } from '../src/core/context';
import { hashPassword } from '../src/lib/crypto';
import * as att from '../src/modules/attachments/service';
import * as audit from '../src/modules/audit/service';

const SUFFIX = Date.now().toString(36);
const meta = { requestId: `test-att-${SUFFIX}`, ip: '127.0.0.1', source: 'api' as const };

let admin: Principal;
let userA: Principal;
let userB: Principal;
let customerA: string;
let customerB: string;
let ticketA: string;
let ticketB: string;
const createdUserIds: string[] = [];
const createdCustomerIds: string[] = [];

async function principalFor(email: string) {
  const [u] = await withSystem((tx) => tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1));
  invalidatePrincipal(u.id);
  const p = await loadPrincipal(u.id);
  if (!p) throw new Error(`principal not loaded for ${email}`);
  return p;
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('0000IHDRfake-image-data')]);

beforeAll(async () => {
  admin = await principalFor('admin@msp.local');
  await withSystem(async (tx) => {
    const [a] = await tx.insert(schema.customers).values({ code: `ATT-A-${SUFFIX}`, name: `Attachment Customer A ${SUFFIX}` }).returning({ id: schema.customers.id });
    const [b] = await tx.insert(schema.customers).values({ code: `ATT-B-${SUFFIX}`, name: `Attachment Customer B ${SUFFIX}` }).returning({ id: schema.customers.id });
    customerA = a.id;
    customerB = b.id;
    createdCustomerIds.push(a.id, b.id);
    const [status] = await tx.select({ id: schema.configOptions.id }).from(schema.configOptions).where(and(eq(schema.configOptions.type, 'ticket_status'), eq(schema.configOptions.isDefault, true))).limit(1);
    const [ta] = await tx.insert(schema.tickets).values({ number: `TST-A-${SUFFIX}`, type: 'incident', customerId: customerA, title: `Attachment test ticket A ${SUFFIX}`, statusId: status.id }).returning({ id: schema.tickets.id });
    const [tb] = await tx.insert(schema.tickets).values({ number: `TST-B-${SUFFIX}`, type: 'incident', customerId: customerB, title: `Attachment test ticket B ${SUFFIX}`, statusId: status.id }).returning({ id: schema.tickets.id });
    ticketA = ta.id;
    ticketB = tb.id;
    const [role] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, 'customer_user')).limit(1);
    const hash = await hashPassword('Customer@12345');
    for (const [cid, tag] of [[customerA, 'a'], [customerB, 'b']] as const) {
      const [u] = await tx.insert(schema.users).values({ email: `att-${tag}-${SUFFIX}@test.local`, name: `Customer ${tag.toUpperCase()} User`, userType: 'customer', customerId: cid, passwordHash: hash, status: 'active' }).returning({ id: schema.users.id });
      createdUserIds.push(u.id);
      await tx.insert(schema.userRoles).values({ userId: u.id, roleId: role.id });
    }
  });
  userA = await principalFor(`att-a-${SUFFIX}@test.local`);
  userB = await principalFor(`att-b-${SUFFIX}@test.local`);
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.delete(schema.attachments).where(inArray(schema.attachments.entityId, [ticketA, ticketB]));
    await tx.delete(schema.tickets).where(inArray(schema.tickets.id, [ticketA, ticketB]));
    if (createdUserIds.length) await tx.delete(schema.users).where(inArray(schema.users.id, createdUserIds));
    if (createdCustomerIds.length) await tx.delete(schema.customers).where(inArray(schema.customers.id, createdCustomerIds));
  });
  await closeDb();
});

describe('attachments', () => {
  let internalId: string;
  let visibleId: string;
  let portalUploadId: string;

  it('uploads via the service with a buffer (admin, hidden from customer)', async () => {
    const res = await runAs(admin, meta, (ctx) => att.createAttachment(ctx, { entityType: 'ticket', entityId: ticketA, filename: 'diag.log', contentType: 'text/plain', buffer: Buffer.from('line 1\nline 2\n'), customerVisible: false, title: 'Diagnostics' }));
    internalId = res.id;
    expect(res.customerId).toBe(customerA);
    expect(res.size).toBe(14);
    expect(res.sha256).toHaveLength(64);
    expect(res.customerVisible).toBe(false);
    expect(res.uploadedByName).toBe(admin.name);
    expect(res.canDelete).toBe(true);
  });

  it('uploads a customer-visible image (admin)', async () => {
    const res = await runAs(admin, meta, (ctx) => att.createAttachment(ctx, { entityType: 'ticket', entityId: ticketA, filename: 'screen.png', contentType: 'image/png', buffer: PNG, customerVisible: true, docType: 'photo' }));
    visibleId = res.id;
    expect(res.contentType).toBe('image/png');
    expect(res.docType).toBe('photo');
  });

  it('portal uploads are forced customer-visible and limited to own tickets', async () => {
    const res = await runAs(userA, meta, (ctx) => att.createAttachment(ctx, { entityType: 'ticket', entityId: ticketA, filename: 'proof.txt', contentType: 'text/plain', buffer: Buffer.from('proof'), customerVisible: false }));
    portalUploadId = res.id;
    expect(res.customerVisible).toBe(true);
    await expect(runAs(userB, meta, (ctx) => att.createAttachment(ctx, { entityType: 'ticket', entityId: ticketA, filename: 'x.txt', contentType: 'text/plain', buffer: Buffer.from('x') }))).rejects.toThrow(/not found/i);
    await expect(runAs(userA, meta, (ctx) => att.createAttachment(ctx, { entityType: 'customer', entityId: customerA, filename: 'x.txt', contentType: 'text/plain', buffer: Buffer.from('x') }))).rejects.toThrow();
  });

  it('customer user lists only customer-visible attachments of their own ticket', async () => {
    const mine = await runAs(userA, meta, (ctx) => att.listAttachments(ctx, 'ticket', ticketA));
    const names = mine.items.map((i) => i.filename).sort();
    expect(names).toEqual(['proof.txt', 'screen.png']);
    expect(mine.items.every((i) => i.customerVisible)).toBe(true);
    expect(mine.access.canManage).toBe(false);
    const all = await runAs(admin, meta, (ctx) => att.listAttachments(ctx, 'ticket', ticketA));
    expect(all.items).toHaveLength(3);
    await expect(runAs(userB, meta, (ctx) => att.listAttachments(ctx, 'ticket', ticketA))).rejects.toThrow(/not found/i);
  });

  it('download access is denied for hidden files and other customers', async () => {
    await expect(runAs(userA, meta, (ctx) => att.openAttachment(ctx, internalId))).rejects.toThrow(/not found/i);
    await expect(runAs(userB, meta, (ctx) => att.openAttachment(ctx, visibleId))).rejects.toThrow(/not found/i);
    await expect(runAs(userB, meta, (ctx) => att.getAttachment(ctx, visibleId))).rejects.toThrow(/not found/i);
    const ok = await runAs(userA, meta, (ctx) => att.openAttachment(ctx, visibleId));
    const chunks: Buffer[] = [];
    for await (const c of ok.stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).equals(PNG)).toBe(true);
    expect(att.contentDisposition('screen.png', 'image/png')).toMatch(/^inline/);
    expect(att.contentDisposition('diag.log', 'text/plain')).toMatch(/^attachment/);
  });

  it('rejects dangerous extensions, executables and mismatched content types', async () => {
    const up = (filename: string, contentType: string, buffer: Buffer) => runAs(admin, meta, (ctx) => att.createAttachment(ctx, { entityType: 'ticket', entityId: ticketA, filename, contentType, buffer }));
    await expect(up('run.exe', 'application/octet-stream', Buffer.from('MZ....'))).rejects.toThrow(/not allowed/);
    await expect(up('report.pdf.exe', 'application/pdf', Buffer.from('%PDF-1.4'))).rejects.toThrow(/not allowed/);
    await expect(up('script.ps1', 'text/plain', Buffer.from('Get-Process'))).rejects.toThrow(/not allowed/);
    await expect(up('lib.jar', 'application/java-archive', Buffer.from('PK\x03\x04'))).rejects.toThrow(/not allowed/);
    await expect(up('notes.txt', 'image/png', Buffer.from('plain text'))).rejects.toThrow(/does not match/);
    await expect(up('fake.png', 'image/png', Buffer.from('not a png'))).rejects.toThrow(/does not match/);
    await expect(up('binary.bin', 'application/octet-stream', Buffer.from('MZ\x90\x00\x03'))).rejects.toThrow(/Executable/);
    await expect(up('empty.txt', 'text/plain', Buffer.alloc(0))).rejects.toThrow(/empty/);
    const rows = await withSystem((tx) => tx.select({ filename: schema.attachments.filename }).from(schema.attachments).where(eq(schema.attachments.entityId, ticketA)));
    expect(rows.map((r) => r.filename).sort()).toEqual(['diag.log', 'proof.txt', 'screen.png']);
  });

  it('customer cannot edit or delete MSP files; can delete own recent upload', async () => {
    await expect(runAs(userA, meta, (ctx) => att.updateAttachment(ctx, visibleId, { title: 'x' }))).rejects.toThrow();
    await expect(runAs(userA, meta, (ctx) => att.deleteAttachment(ctx, visibleId))).rejects.toThrow();
    const res = await runAs(userA, meta, (ctx) => att.deleteAttachment(ctx, portalUploadId));
    expect(res.deleted).toBe(true);
  });

  it('manager toggles visibility and deletes; everything is audited', async () => {
    const upd = await runAs(admin, meta, (ctx) => att.updateAttachment(ctx, internalId, { customerVisible: true, docType: 'report' }));
    expect(upd.customerVisible).toBe(true);
    const nowVisible = await runAs(userA, meta, (ctx) => att.listAttachments(ctx, 'ticket', ticketA));
    expect(nowVisible.items.map((i) => i.id)).toContain(internalId);
    await runAs(admin, meta, (ctx) => att.deleteAttachment(ctx, internalId));
    await expect(runAs(admin, meta, (ctx) => att.getAttachment(ctx, internalId))).rejects.toThrow(/not found/i);
    const history = await runAs(admin, meta, (ctx) => audit.entityHistory(ctx, 'attachment', internalId));
    expect(history.items.map((h) => h.action)).toEqual(expect.arrayContaining(['upload', 'update', 'delete']));
    // Portal users only see the action timeline of their own tickets.
    const portal = await runAs(userA, meta, (ctx) => audit.entityHistory(ctx, 'ticket', ticketA));
    expect(portal.restricted).toBe(true);
    expect(portal.items.map((h) => h.action)).toContain('attachment.added');
    expect(portal.items.every((h) => Object.keys(h.changes).length === 0)).toBe(true);
    await expect(runAs(userA, meta, (ctx) => audit.entityHistory(ctx, 'ticket', ticketB))).rejects.toThrow(/not found/i);
    await expect(runAs(userA, meta, (ctx) => audit.listAudit(ctx, {}))).rejects.toThrow();
  });
});
