/**
 * Grady on WhatsApp: the webhook intake, the typed and sent linking flows, the
 * chat flag, the job pipeline (identity, gates, the same assistant turn as the
 * web, rendering, sending, recording), yes/no confirmations, STOP/START, the
 * customer fence, switches, caps, revocation and the administrator's reads.
 * The model is a script and Meta's Cloud API is a stubbed fetch.
 * Run with the dev environment sourced: npx vitest run test/whatsapp-assistant.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { eq, and, inArray, desc, sql } from 'drizzle-orm';
import { pool, withSystem, closeDb, schema, type Tx } from '../src/db/client';
import { runAs, type Ctx } from '../src/core/context';
import { loadPrincipal, invalidatePrincipal, type Principal } from '../src/core/principal';
import { can } from '../src/core/authz';
import { encryptSecret } from '../src/lib/crypto';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../src/core/errors';
import { systemText, type AiProvider, type ChatOptions, type ChatResponse } from '../src/lib/ai';
import { createTicket } from '../src/modules/tickets/service';
import * as ai from '../src/modules/ai/service';
import { usage as aiUsage } from '../src/modules/ai/admin';
import { toolByName, toolAvailable } from '../src/modules/ai/tools';
import { resetWhatsAppSettingsCache, loadWhatsAppSettings } from '../src/modules/notifications/channels';
import { startPhoneVerification, confirmPhoneVerification } from '../src/modules/notifications/phone';
import { updatePreferences } from '../src/modules/auth/service';
import * as iam from '../src/modules/iam/service';
import { unlinkPortalUserWhatsApp } from '../src/modules/portal/service';
import { handleWhatsAppWebhook, parseInbound } from '../src/modules/whatsapp/inbound';
import { handleInbound, sweepInbound, CHAT_OFF_REPLY, CLAIM_STALE_MS, MAX_REQUEUES, RECLAIM_MARGIN_MS, REQUEUE_DELAY_MS, fill } from '../src/modules/whatsapp/agent';
import { loadAiSettings } from '../src/modules/ai/guards';
import { markdownToWhatsApp, renderWhatsAppReply, splitWhatsAppText, PART_MAX_CHARS } from '../src/modules/whatsapp/render';
import { setAssistantFlag, revokeNumber, linkStatus } from '../src/modules/whatsapp/link';
import { assistantStatus, listInbound } from '../src/modules/whatsapp/service';
import { DEFAULT_UNLINKED_REPLY } from '../src/modules/whatsapp/schemas';
import { enqueue } from '../src/jobs/queues';
import { buildApp } from '../src/core/app';
import { signAccessToken } from '../src/core/tokens';

// The queue is not part of what is under test: the webhook's enqueue is observed, the job is called directly.
vi.mock('../src/jobs/queues', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/jobs/queues')>();
  return { ...mod, enqueue: vi.fn(async () => ({ id: 'job' })) };
});

const S = Math.random().toString(36).slice(2, 8);
const meta = { requestId: `test-wa-agent-${S}`, ip: '127.0.0.1' };
const APP_URL = 'http://localhost:8080';
const PHONE_NUMBER_ID = '100200300';
const APP_SECRET = 'app-secret';
const PHONES = { portal: '+919876543301', staff: '+919876543302', off: '+919876543303', optin: '+919876543304', fresh: '+919876543305', other: '+919876543309', unknown: '+919876543300' };
const ids = { a: '', b: '', service: '', portal: '', staff: '', off: '', optin: '', fresh: '', fresh2: '', portalAdmin: '', userB: '', ticketA: '', ticketB: '' };
const numbers = { a: '', b: '' };
const names = { a: `WA Agent Alpha ${S}`, b: `WA Agent Beta ${S}` };
let admin: Principal;
let portal: Principal;
let staff: Principal;
let off: Principal;
let fresh: Principal;
let fresh2: Principal;
let portalAdmin: Principal;
const as = (p: Principal) => <T>(fn: (ctx: Ctx) => Promise<T>) => runAs(p, meta, fn);
const emailOf = (who: string) => `wa-agent-${who}-${S}@example.test`;
const digits = (phone: string) => phone.replace(/^\+/, '');

// ---------------------------------------------------------------- the stand-ins

const tool = (name: string, input: Record<string, unknown>, id = `c-${name}`): ChatResponse => ({ text: '', toolCalls: [{ id, name, input }], stopReason: 'tool_use', usage: { inputTokens: 3, outputTokens: 1 } });
const say = (text: string): ChatResponse => ({ text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 3, outputTokens: 2 } });

/** Turn scripts: the i-th response of a turn answers the i-th model call of that turn; the last one repeats. */
class Scripted implements AiProvider {
  name = 'scripted';
  model = 'scripted-1';
  seen: ChatOptions[] = [];
  onChat: (() => Promise<void>) | null = null;
  private turns: ChatResponse[][] = [];
  private turn = -1;
  private call = 0;
  script(...responses: ChatResponse[]) {
    this.turns.push(responses);
    return this;
  }
  async chat(opts: ChatOptions): Promise<ChatResponse> {
    if (this.onChat) await this.onChat();
    this.seen.push({ ...opts, system: systemText(opts.system) });
    const last = opts.messages[opts.messages.length - 1]!;
    if (last.role === 'user') {
      this.turn++;
      this.call = 0;
    }
    const t = this.turns[this.turn] ?? [say('I have nothing to add.')];
    const r = t[Math.min(this.call, t.length - 1)]!;
    this.call++;
    return r;
  }
}
const toolNames = (o: ChatOptions) => (o.tools ?? []).map((t) => t.name);
const useScript = (...responses: ChatResponse[]) => {
  const fake = new Scripted();
  if (responses.length) fake.script(...responses);
  ai.setProviderForTests(fake);
  return fake;
};

/** Every call to the Graph host, in order. */
let graph: { url: string; body: Record<string, unknown> }[] = [];
let replyN = 0;
const texts = () => graph.filter((c) => c.body.type === 'text').map((c) => ({ to: String(c.body.to), text: String((c.body.text as { body: string }).body) }));
const reads = () => graph.filter((c) => c.body.status === 'read');
const resetGraph = () => {
  graph = [];
};
vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
  const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
  graph.push({ url: String(url), body });
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (body.status === 'read') return json({ success: true });
  return json({ messages: [{ id: `wamid.reply.${S}.${++replyN}` }] });
}));

// ---------------------------------------------------------------- helpers

async function setSettings(values: Record<string, unknown>) {
  await withSystem(async (tx) => {
    for (const [key, value] of Object.entries(values)) {
      await tx.insert(schema.systemSettings).values({ key, value: value as never }).onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: value as never, updatedAt: new Date() } });
    }
  });
  resetWhatsAppSettingsCache();
}
/** The connection every case needs (the same values whatsapp.test.ts writes, so the files never race each other to different settings). */
const ensureConnection = () =>
  setSettings({
    'whatsapp.enabled': true,
    'whatsapp.phone_number_id': PHONE_NUMBER_ID,
    'whatsapp.access_token.secret': encryptSecret('test-token'),
    'whatsapp.app.secret': encryptSecret(APP_SECRET),
    'whatsapp.verify_token.secret': encryptSecret('verify-me'),
    'whatsapp.templates': { default: { name: 'progression_update', language: 'en', params: ['subject', 'text', 'link'] } },
  });
const ensureAssistant = () =>
  setSettings({
    'whatsapp.assistant.enabled': true,
    'whatsapp.assistant.audiences': ['staff', 'customers'],
    'whatsapp.assistant.daily_message_cap': 100,
    'whatsapp.assistant.thread_idle_hours': 24,
    'whatsapp.display_number': '+91 11 4000 0000',
    'ai.assistant.enabled': true,
    'ai.disabled_features': [],
  });

let wamidN = 0;
const metaPayload = (from: string, message: Record<string, unknown>, name = 'Test Person', phoneNumberId = PHONE_NUMBER_ID) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '911140000000', phone_number_id: phoneNumberId }, contacts: [{ profile: { name }, wa_id: digits(from) }], messages: [{ from: digits(from), ...message }] } }] }],
});
const textMessage = (id: string, text: string, timestamp = Math.floor(Date.now() / 1000)) => ({ id, timestamp: String(timestamp), type: 'text', text: { body: text } });

/** Posts one inbound text through the webhook handler and runs the job on it, as the worker would. */
async function inbound(from: string, text: string, opts: { id?: string; name?: string; run?: boolean } = {}) {
  await ensureConnection();
  const id = opts.id ?? `wamid.${S}.${++wamidN}`;
  const settings = await withSystem((tx) => loadWhatsAppSettings(tx));
  const hook = await handleWhatsAppWebhook(metaPayload(from, textMessage(id, text), opts.name), settings);
  const [row] = await withSystem((tx) => tx.select().from(schema.whatsappInbound).where(eq(schema.whatsappInbound.providerMessageId, id)).limit(1));
  const result = opts.run === false ? null : await handleInbound(row!.id);
  const [after] = await withSystem((tx) => tx.select().from(schema.whatsappInbound).where(eq(schema.whatsappInbound.id, row!.id)).limit(1));
  return { id, hook, rowId: row!.id, result: result!, row: after! };
}
const rowOf = async (id: string) => (await withSystem((tx) => tx.select().from(schema.whatsappInbound).where(eq(schema.whatsappInbound.id, id)).limit(1)))[0]!;
const outboxById = async (id: string) => (await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(eq(schema.notificationOutbox.id, id)).limit(1)))[0]!;
const userRow = async (id: string) => (await withSystem((tx) => tx.select().from(schema.users).where(eq(schema.users.id, id)).limit(1)))[0]!;
const flagOf = async (id: string) => ((await userRow(id)).preferences as { whatsapp?: { assistant?: boolean } }).whatsapp?.assistant;
const audits = (entityId: string, action: string) => withSystem((tx) => tx.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, entityId), eq(schema.auditLog.action, action))).orderBy(desc(schema.auditLog.occurredAt)));
const conversationOf = async (id: string) => (await withSystem((tx) => tx.select().from(schema.aiConversations).where(eq(schema.aiConversations.id, id)).limit(1)))[0]!;
const countComments = async (ticketId: string) => (await withSystem((tx) => tx.select({ id: schema.ticketComments.id }).from(schema.ticketComments).where(eq(schema.ticketComments.ticketId, ticketId)))).length;
const failure = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('expected a failure');
};
const whoOf = (p: Principal) => ({ user: p, can: (perm: Parameters<typeof can>[1], customerId?: string | null) => can(p, perm, customerId) });
async function reload(id: string) {
  invalidatePrincipal(id);
  return (await loadPrincipal(id))!;
}
async function roleId(tx: Tx, key: string) {
  const [row] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
  return row!.id;
}

// ---------------------------------------------------------------- fixtures

beforeAll(async () => {
  await withSystem(async (tx) => {
    const [a] = await tx.insert(schema.customers).values({ code: `WAA${S.toUpperCase()}`, name: names.a }).returning();
    const [b] = await tx.insert(schema.customers).values({ code: `WAB${S.toUpperCase()}`, name: names.b }).returning();
    ids.a = a!.id;
    ids.b = b!.id;
    const [svc] = await tx.insert(schema.services).values({ key: `wa_agent_svc_${S}`, name: `WA Agent Service ${S}`, domain: 'noc' }).returning();
    ids.service = svc!.id;
    // noc_engineer holds tenant:all (sees every customer), ai:use, ai:act and tickets:comment
    const engineer = await roleId(tx, 'noc_engineer');
    const customerUser = await roleId(tx, 'customer_user');
    const customerAdmin = await roleId(tx, 'customer_admin');
    const mk = async (values: Partial<typeof schema.users.$inferInsert> & { email: string; name: string }, role: string, customerId: string | null) => {
      const [u] = await tx.insert(schema.users).values({ userType: 'msp', status: 'active', ...values }).returning();
      await tx.insert(schema.userRoles).values({ userId: u!.id, roleId: role, customerId });
      return u!.id;
    };
    const on = { whatsapp: { assistant: true } };
    ids.portal = await mk({ email: emailOf('portal'), name: 'Portal Person', userType: 'customer', customerId: a!.id, phone: PHONES.portal, whatsappVerifiedAt: new Date(), preferences: on }, customerUser, a!.id);
    ids.portalAdmin = await mk({ email: emailOf('portaladmin'), name: 'Portal Admin', userType: 'customer', customerId: a!.id }, customerAdmin, a!.id);
    ids.userB = await mk({ email: emailOf('userb'), name: 'Beta Person', userType: 'customer', customerId: b!.id }, customerUser, b!.id);
    ids.staff = await mk({ email: emailOf('staff'), name: 'Staff Person', phone: PHONES.staff, whatsappVerifiedAt: new Date(), preferences: on }, engineer, null);
    ids.off = await mk({ email: emailOf('off'), name: 'Chat Off', phone: PHONES.off, whatsappVerifiedAt: new Date() }, engineer, null);
    ids.optin = await mk({ email: emailOf('optin'), name: 'Opted In Only', phone: PHONES.optin, whatsappOptIn: true, whatsappOptedInAt: new Date() }, engineer, null);
    ids.fresh = await mk({ email: emailOf('fresh'), name: 'Fresh Person', phone: '98765 43305' }, engineer, null);
    ids.fresh2 = await mk({ email: emailOf('fresh2'), name: 'Same Number', phone: '+919876543305' }, engineer, null);
    const [adm] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, 'admin@msp.local')).limit(1);
    admin = await reload(adm!.id);
  });
  portal = await reload(ids.portal);
  staff = await reload(ids.staff);
  off = await reload(ids.off);
  fresh = await reload(ids.fresh);
  fresh2 = await reload(ids.fresh2);
  portalAdmin = await reload(ids.portalAdmin);
  await ensureConnection();
  await ensureAssistant();
  useScript();
  await as(admin)(async (ctx) => {
    const ta = await createTicket(ctx, { type: 'incident', customerId: ids.a, title: `Printer offline ${S}`, description: 'The office printer is offline.', serviceId: ids.service });
    const tb = await createTicket(ctx, { type: 'incident', customerId: ids.b, title: `Beta firewall ${S}`, description: 'Beta only.', serviceId: ids.service });
    ids.ticketA = ta.id;
    ids.ticketB = tb.id;
    numbers.a = ta.number;
    numbers.b = tb.number;
  });
});

afterAll(async () => {
  ai.setProviderForTests(null);
  vi.unstubAllGlobals();
  await setSettings({ 'whatsapp.assistant.enabled': false, 'whatsapp.assistant.audiences': ['staff', 'customers'], 'whatsapp.assistant.daily_message_cap': 100, 'whatsapp.assistant.thread_idle_hours': 24, 'whatsapp.display_number': '', 'ai.disabled_features': [], 'ai.assistant.enabled': true });
  await withSystem(async (tx) => {
    const users = [ids.portal, ids.portalAdmin, ids.userB, ids.staff, ids.off, ids.optin, ids.fresh, ids.fresh2].filter(Boolean);
    const phones = [...Object.values(PHONES), '+919876543398', '+919876543397'];
    await tx.delete(schema.whatsappInbound).where(inArray(schema.whatsappInbound.phone, phones));
    await tx.delete(schema.notificationOutbox).where(inArray(schema.notificationOutbox.recipient, phones));
    await tx.delete(schema.aiConversations).where(inArray(schema.aiConversations.userId, users));
    await tx.delete(schema.phoneVerifications).where(inArray(schema.phoneVerifications.userId, users));
    await tx.delete(schema.tickets).where(inArray(schema.tickets.customerId, [ids.a, ids.b]));
    await tx.delete(schema.users).where(inArray(schema.users.id, users));
    await tx.delete(schema.customers).where(inArray(schema.customers.id, [ids.a, ids.b]));
    await tx.delete(schema.services).where(eq(schema.services.id, ids.service));
  });
  await closeDb();
});

// ---------------------------------------------------------------- 1. rendering

describe('rendering', () => {
  it('turns Markdown into WhatsApp text with absolute links, bullets instead of tables and bold headings', () => {
    const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
    const md = `## Open tickets\n\n**7 open tickets**\n\n| Ticket | Title | Status | Owner |\n|---|---|---|---|\n| [INC-000001](/tickets/${id}) | Printer offline | New | nobody |\n| [INC-000002](/tickets/${id}) | VPN down | In progress | Priya |\n\n- first point\n* second point\n> quoted\n\nSee [the docs](https://example.test/docs).`;
    const out = markdownToWhatsApp(md, APP_URL);
    expect(out).toContain('*Open tickets*');
    expect(out).toContain('*7 open tickets*');
    expect(out).toContain(`• INC-000001 (${APP_URL}/tickets/${id}) · Printer offline · New · nobody`);
    expect(out).toContain(' · VPN down · In progress · Priya');
    expect(out).not.toContain('|');
    expect(out).not.toContain('**');
    expect(out).toContain('• first point\n• second point\nquoted');
    expect(out).toContain('the docs (https://example.test/docs)');
    expect(markdownToWhatsApp('a\n\n\n\n\nb', APP_URL)).toBe('a\n\nb');
    // Markdown italics become WhatsApp italics (never bold), strikethrough uses one tilde, bold and arithmetic are left alone
    expect(markdownToWhatsApp('Note *this* and ~~that~~; **bold** stays; 5 * 3 and a*b*c unchanged; `code`', APP_URL)).toBe('Note _this_ and ~that~; *bold* stays; 5 * 3 and a*b*c unchanged; `code`');
  });

  it('appends the YES/NO footer for a held action and a link line for navigation the web would have done, and splits long text', () => {
    const base = { message: { id: 'm', role: 'assistant' as const, content: 'I will add the note. Shall I proceed?', toolCalls: [], inputTokens: 0, outputTokens: 0, feedback: null, createdAt: new Date() } };
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const parts = renderWhatsAppReply({ ...base, pendingAction: { id: 'a', tool: 'add_work_note', tier: 'write_low', preview: 'Add a work note', lines: ['Ticket INC-000001', 'Note: checked'], count: 2, expiresAt }, uiActions: [{ type: 'navigate', to: '/tickets?priority=p1', label: 'P1 tickets' }] }, { appUrl: APP_URL, greeting: 'Hi Staff, this is Grady.' });
    expect(parts).toHaveLength(1);
    expect(parts[0]!.startsWith('Hi Staff, this is Grady.\n\n')).toBe(true);
    expect(parts[0]).toContain('• Ticket INC-000001\n• Note: checked\n(2 records)\nReply *YES* to go ahead or *NO* to drop it (within 30 min).');
    expect(parts[0]!.endsWith(`Open P1 tickets: ${APP_URL}/tickets?priority=p1`)).toBe(true);
    const plain = renderWhatsAppReply({ ...base, pendingAction: null, uiActions: [] }, { appUrl: APP_URL });
    expect(plain).toEqual(['I will add the note. Shall I proceed?']);
    const long = Array.from({ length: 120 }, (_, i) => `Paragraph ${i} ${'x'.repeat(50)}`).join('\n\n');
    const split = splitWhatsAppText(long);
    expect(split.length).toBeGreaterThan(1);
    for (const p of split) expect(p.length).toBeLessThanOrEqual(PART_MAX_CHARS + 8);
    expect(split[0]!.startsWith(`(1/${split.length}) `)).toBe(true);
    expect(splitWhatsAppText('short')).toEqual(['short']);
    const huge = splitWhatsAppText('y'.repeat(PART_MAX_CHARS * 6));
    expect(huge).toHaveLength(4);
    expect(huge[3]).toContain('(ask for less at a time)');
  });
});

// ---------------------------------------------------------------- 2. webhook

describe('webhook intake', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const headers = async (p: Principal) => ({ authorization: `Bearer ${await signAccessToken(p.id, `test-${S}`)}` });
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('refuses a bad signature, parses and deduplicates messages, queues one job per message and ignores other numbers, reactions and stale messages', async () => {
    await ensureConnection();
    vi.mocked(enqueue).mockClear();
    const id = `wamid.${S}.hook1`;
    const payload = metaPayload(PHONES.unknown, textMessage(id, 'hello there', 1_700_000_000), 'Hook Person');
    const raw = JSON.stringify(payload);
    const bad = await app.inject({ method: 'POST', url: '/api/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, payload: raw });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: 'POST', url: '/api/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}` }, payload: raw });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ ok: true, updated: 0, queued: 1 });
    const [row] = await withSystem((tx) => tx.select().from(schema.whatsappInbound).where(eq(schema.whatsappInbound.providerMessageId, id)));
    expect(row).toMatchObject({ status: 'received', kind: 'text', text: 'hello there', displayName: 'Hook Person', phone: PHONES.unknown, outcome: null });
    expect(row!.receivedAt.toISOString()).toBe(new Date(1_700_000_000 * 1000).toISOString());
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('ai', 'whatsapp-chat', { inboundId: row!.id }, expect.objectContaining({ jobId: `whatsapp-${id}`, attempts: 1 }));

    // the same wamid again (Meta retries): nothing new
    const settings = await withSystem((tx) => loadWhatsAppSettings(tx));
    expect(await handleWhatsAppWebhook(payload, settings)).toEqual({ ok: true, updated: 0, queued: 0 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((await withSystem((tx) => tx.select().from(schema.whatsappInbound).where(eq(schema.whatsappInbound.providerMessageId, id)))).length).toBe(1);

    // a redelivery of a message still waiting after a minute (its job never ran): the job is asked for again under the same id, no second row
    await withSystem((tx) => tx.update(schema.whatsappInbound).set({ createdAt: new Date(Date.now() - 2 * 60_000) }).where(eq(schema.whatsappInbound.providerMessageId, id)));
    expect(await handleWhatsAppWebhook(payload, settings)).toEqual({ ok: true, updated: 0, queued: 1 });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenLastCalledWith('ai', 'whatsapp-chat', { inboundId: row!.id }, expect.objectContaining({ jobId: `whatsapp-${id}`, attempts: 1 }));
    expect((await withSystem((tx) => tx.select().from(schema.whatsappInbound).where(eq(schema.whatsappInbound.providerMessageId, id)))).length).toBe(1);

    // a message addressed to another business number is ignored
    expect(await handleWhatsAppWebhook(metaPayload(PHONES.unknown, textMessage(`wamid.${S}.other`, 'x'), 'X', '999'), settings)).toEqual({ ok: true, updated: 0, queued: 0 });
    expect((await withSystem((tx) => tx.select().from(schema.whatsappInbound).where(eq(schema.whatsappInbound.providerMessageId, `wamid.${S}.other`)))).length).toBe(0);

    // a button carries its text, an image is unsupported, a reaction is stored as ignored and never queued
    const button = parseInbound({ id: 'b', from: digits(PHONES.unknown), timestamp: '1700000000', type: 'button', button: { text: 'Yes', payload: 'YES' } }, [], '91');
    expect(button).toMatchObject({ kind: 'button', text: 'Yes', phone: PHONES.unknown });
    const image = parseInbound({ id: 'i', from: digits(PHONES.unknown), timestamp: 'nope', type: 'image' }, [{ wa_id: digits(PHONES.unknown), profile: { name: 'Pic' } }], '91');
    expect(image).toMatchObject({ kind: 'unsupported', text: null, displayName: 'Pic' });
    expect(parseInbound({ id: 'n', from: '12', type: 'text', text: { body: 'x' } }, [], '91')).toBeNull();
    vi.mocked(enqueue).mockClear();
    await handleWhatsAppWebhook(metaPayload(PHONES.unknown, { id: `wamid.${S}.react`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'reaction', reaction: { message_id: 'wamid.x', emoji: '👍' } }), settings);
    const [reaction] = await withSystem((tx) => tx.select().from(schema.whatsappInbound).where(eq(schema.whatsappInbound.providerMessageId, `wamid.${S}.react`)));
    expect(reaction).toMatchObject({ kind: 'reaction', status: 'ignored', outcome: 'ignored' });
    expect(enqueue).not.toHaveBeenCalled();

    // the job: the stale message (25 hours old) is ignored without a send; a second run on the same row is a duplicate
    resetGraph();
    const stale = await handleInbound(row!.id);
    expect(stale.outcome).toBe('ignored');
    expect(await rowOf(row!.id)).toMatchObject({ status: 'ignored', outcome: 'ignored', error: 'stale: outside the 24-hour window' });
    expect(graph).toHaveLength(0);
    expect(await handleInbound(row!.id)).toEqual({ outcome: 'duplicate', replied: false, parts: 0 });
    expect(await handleInbound('')).toEqual({ outcome: 'duplicate', replied: false, parts: 0 });
    expect(graph).toHaveLength(0);
  });

  it('applies delivery statuses but refuses to queue messages while the app secret is empty', async () => {
    await ensureConnection();
    await setSettings({ 'whatsapp.app.secret': '' });
    try {
      const [out] = await withSystem((tx) => tx.insert(schema.notificationOutbox).values({ channel: 'whatsapp', event: 'test.message', recipient: PHONES.unknown, body: 'x', status: 'sent', providerMessageId: `wamid.${S}.status1`, deliveryStatus: 'accepted' }).returning({ id: schema.notificationOutbox.id }));
      vi.mocked(enqueue).mockClear();
      const settings = await withSystem((tx) => loadWhatsAppSettings(tx));
      expect(settings.appSecret).toBe('');
      const payload = metaPayload(PHONES.unknown, textMessage(`wamid.${S}.nosecret`, 'hi'));
      (payload.entry[0]!.changes[0]!.value as Record<string, unknown>).statuses = [{ id: `wamid.${S}.status1`, status: 'delivered' }];
      expect(await handleWhatsAppWebhook(payload, settings)).toEqual({ ok: true, updated: 1, queued: 0 });
      expect((await outboxById(out!.id)).deliveryStatus).toBe('delivered');
      expect((await withSystem((tx) => tx.select().from(schema.whatsappInbound).where(eq(schema.whatsappInbound.providerMessageId, `wamid.${S}.nosecret`)))).length).toBe(0);
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await ensureConnection();
    }
  });

  it('closes the administrator reads to portal users', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/whatsapp/inbound', headers: await headers(portal) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/whatsapp/assistant/status', headers: await headers(portal) })).statusCode).toBe(403);
    const mine = await app.inject({ method: 'GET', url: '/api/whatsapp/link', headers: await headers(portal) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({ phone: '+91••••3301', assistant: { on: true, enabled: true, allowed: true, reason: null }, businessNumber: '+91 11 4000 0000', waLink: 'https://wa.me/911140000000' });
    expect((await app.inject({ method: 'GET', url: '/api/whatsapp/inbound?limit=5', headers: await headers(admin) })).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------- 3 and 4. linking

describe('linking a number', () => {
  const latestCode = async (phone: string) => {
    const [row] = await withSystem((tx) => tx.select().from(schema.notificationOutbox).where(and(eq(schema.notificationOutbox.channel, 'whatsapp'), eq(schema.notificationOutbox.recipient, phone), eq(schema.notificationOutbox.event, 'user.phone_verification'))).orderBy(desc(schema.notificationOutbox.createdAt)).limit(1));
    const params = (row!.payload as { template: { params: string[] } }).template.params;
    const code = /\b(\d{6})\b/.exec(params[1]!)?.[1];
    expect(code, 'the six-digit code is in the WhatsApp text').toBeTruthy();
    return code!;
  };

  it('verifies by a sent code (five wrong tries void it), then the person switches the chat on and off; the flag needs a verified number and never an API key', async () => {
    await ensureConnection();
    const started = await as(fresh)((ctx) => startPhoneVerification(ctx, { method: 'sent' }));
    expect(started).toMatchObject({ method: 'sent', sentTo: '+91••••3305' });
    expect(started).not.toHaveProperty('code');
    const code = await latestCode(PHONES.fresh);
    const wrong = code === '000000' ? '000001' : '000000';
    for (const left of [4, 3, 2, 1]) expect((await failure(as(fresh)((ctx) => confirmPhoneVerification(ctx, wrong)))).message).toBe(`That code is not right, ${left} attempts left`);
    expect((await failure(as(fresh)((ctx) => confirmPhoneVerification(ctx, wrong)))).message).toBe('Too many attempts; request a new code');
    expect((await failure(as(fresh)((ctx) => confirmPhoneVerification(ctx, code)))).message).toBe('No code is waiting; request a new one');
    await as(fresh)((ctx) => startPhoneVerification(ctx, { method: 'sent' }));
    const second = await latestCode(PHONES.fresh);
    await as(fresh)((ctx) => confirmPhoneVerification(ctx, second));
    const verified = await userRow(ids.fresh);
    expect(verified.whatsappVerifiedAt).toBeTruthy();
    expect(verified.phone).toBe(PHONES.fresh);
    expect(verified.whatsappOptIn).toBe(false);
    expect((verified.preferences as Record<string, unknown>).whatsapp).toBeUndefined();
    expect((await audits(ids.fresh, 'phone.verified'))[0]!.metadata).toMatchObject({ method: 'sent', phone: '+91••••3305' });
    fresh = await reload(ids.fresh);
    expect(fresh.whatsappVerifiedAt).toBeTruthy();

    expect(await as(fresh)((ctx) => setAssistantFlag(ctx, true))).toEqual({ on: true });
    expect(await flagOf(ids.fresh)).toBe(true);
    expect((await audits(ids.fresh, 'whatsapp.assistant.on'))[0]!.metadata).toMatchObject({ by: 'self' });
    const status = await as(fresh)((ctx) => linkStatus(ctx));
    expect(status).toMatchObject({ phone: '+91••••3305', assistant: { on: true }, pending: null });
    expect(status.verifiedAt).toBeTruthy();
    expect(await as(fresh)((ctx) => setAssistantFlag(ctx, false))).toEqual({ on: false });
    expect(await flagOf(ids.fresh)).toBe(false);
    expect((await audits(ids.fresh, 'whatsapp.assistant.off'))[0]!.metadata).toMatchObject({ by: 'self' });
    expect((await userRow(ids.fresh)).whatsappVerifiedAt).toBeTruthy();
    // the other keys of the preferences object are left alone
    await withSystem((tx) => tx.update(schema.users).set({ preferences: { briefing: { enabled: true }, whatsapp: { assistant: false } } }).where(eq(schema.users.id, ids.fresh)));
    await as(fresh)((ctx) => setAssistantFlag(ctx, true));
    expect((await userRow(ids.fresh)).preferences).toEqual({ briefing: { enabled: true }, whatsapp: { assistant: true } });
    await as(fresh)((ctx) => setAssistantFlag(ctx, false));

    const unverified = await reload(ids.optin);
    expect((await failure(as(unverified)((ctx) => setAssistantFlag(ctx, true)))).message).toBe('Verify your mobile number first');
    expect(await failure(as(fresh2)((ctx) => startPhoneVerification(ctx, { method: 'sent' })))).toBeInstanceOf(ConflictError);
    expect(await failure(as({ ...fresh, apiKeyId: 'k1' })((ctx) => setAssistantFlag(ctx, true)))).toBeInstanceOf(ForbiddenError);
    expect(await failure(as({ ...fresh, apiKeyId: 'k1' })((ctx) => linkStatus(ctx)))).toBeInstanceOf(ForbiddenError);
  });

  it('links by a code typed from the phone: shown once, bound to the profile number, refused from another number, consumed after use', async () => {
    await ensureConnection();
    await ensureAssistant();
    const typed = await as(fresh)((ctx) => startPhoneVerification(ctx, { method: 'typed' }));
    expect(typed.method).toBe('typed');
    if (typed.method !== 'typed') throw new Error('typed expected');
    expect(typed.code).toMatch(/^\d{6}$/);
    expect(typed.phone).toBe(PHONES.fresh);
    expect(typed.businessNumber).toBe('+91 11 4000 0000');
    expect(typed.waLink).toBe(`https://wa.me/911140000000?text=${typed.code}`);
    expect((await audits(ids.fresh, 'phone.verification_shown')).length).toBe(1);
    expect((await as(fresh)((ctx) => linkStatus(ctx))).pending).toMatchObject({ method: 'typed' });
    expect((await texts()).filter((t) => t.to === digits(PHONES.fresh)).length).toBe(0);

    // from a different number: the code does not match a row for that number, and the stranger gets the unlinked reply
    resetGraph();
    const wrongPhone = await inbound(PHONES.other, typed.code);
    expect(wrongPhone.result.outcome).toBe('unverified');
    expect(texts().map((t) => t.to)).toEqual([digits(PHONES.other)]);
    expect(texts()[0]!.text).toBe(fill(DEFAULT_UNLINKED_REPLY, { platform: 'Progression' }));
    expect(await flagOf(ids.fresh)).toBe(false);

    // other accounts asked for codes on the same number afterwards: their rows never push the owner's out of reach
    const decoys = await withSystem((tx) => tx.insert(schema.phoneVerifications).values([ids.off, ids.optin, ids.staff].map((userId) => ({ userId, phone: PHONES.fresh, method: 'typed' as const, codeHash: 'decoy', expiresAt: new Date(Date.now() + 600_000) }))).returning({ id: schema.phoneVerifications.id }));

    // from the right number: verified, chat on, "Linked." plus the greeting, no model call
    resetGraph();
    const fake = useScript();
    const linked = await inbound(PHONES.fresh, ` ${typed.code} `);
    expect(linked.result.outcome).toBe('linked');
    expect(linked.row).toMatchObject({ status: 'handled', outcome: 'linked', userId: ids.fresh });
    expect(linked.row.replyOutboxId).toBeTruthy();
    const sent = texts();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text.startsWith('Linked. You can now chat with Grady here.\n\nHi Fresh, this is Grady from Progression.')).toBe(true);
    expect(fake.seen).toHaveLength(0);
    expect(await flagOf(ids.fresh)).toBe(true);
    expect((await audits(ids.fresh, 'whatsapp.assistant.on'))[0]!.metadata).toMatchObject({ by: 'typed_code' });
    expect((await audits(ids.fresh, 'phone.verified'))[0]!.metadata).toMatchObject({ method: 'typed', phone: '+91••••3305' });
    expect((await audits(linked.rowId, 'whatsapp.chat'))[0]!.metadata).toMatchObject({ outcome: 'linked', userId: ids.fresh });
    const open = await withSystem((tx) => tx.select().from(schema.phoneVerifications).where(and(eq(schema.phoneVerifications.userId, ids.fresh), sql`${schema.phoneVerifications.consumedAt} is null`)));
    expect(open).toHaveLength(0);
    await withSystem((tx) => tx.delete(schema.phoneVerifications).where(inArray(schema.phoneVerifications.id, decoys.map((d) => d.id))));

    // the same code again is an ordinary message for a linked person (the row is consumed), so the model answers it
    resetGraph();
    useScript(say('That looks like a code, but you are already linked.'));
    const again = await inbound(PHONES.fresh, typed.code);
    expect(again.result.outcome).toBe('replied');
    expect(texts()[0]!.text).toContain('already linked');
    fresh = await reload(ids.fresh);
  });
});

// ---------------------------------------------------------------- 5 and 6. the turn

describe('a turn from WhatsApp', () => {
  it('answers a staff message with the same assistant turn as the web, rendered as WhatsApp text, recorded in the outbox, the conversation and the audit log', async () => {
    await ensureConnection();
    await ensureAssistant();
    resetGraph();
    const fake = useScript(tool('query_tickets', { mode: 'list', customer: names.a }), say(`**1 open ticket**\n\n| Ticket | Title | Status | Owner |\n|---|---|---|---|\n| [${numbers.a}](/tickets/${ids.ticketA}) | Printer offline | New | nobody |`));
    const first = await inbound(PHONES.staff, 'what is open for Alpha?');
    expect(first.result).toMatchObject({ outcome: 'replied', replied: true, parts: 1 });
    const sent = texts();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(digits(PHONES.staff));
    expect(sent[0]!.text).toContain('Hi Staff, this is Grady from Progression.');
    expect(sent[0]!.text).toContain('*1 open ticket*');
    expect(sent[0]!.text).toContain(`${APP_URL}/tickets/${ids.ticketA}`);
    expect(sent[0]!.text).not.toContain('|');
    expect(reads().map((r) => r.body.message_id)).toEqual([first.id]);
    // the outbox row carries the provider id so delivery states land on it
    const outbox = await outboxById(first.row.replyOutboxId!);
    expect(outbox).toMatchObject({ channel: 'whatsapp', event: 'assistant.reply', recipient: PHONES.staff, status: 'sent', deliveryStatus: 'accepted', entityType: 'ai_conversation', entityId: first.row.conversationId });
    expect(outbox.providerMessageId).toMatch(/^wamid\.reply\./);
    expect((outbox.payload as { kind: string; part: number; parts: number }).kind).toBe('text');
    // the conversation is the person's own, keyed by the channel
    const conv = await conversationOf(first.row.conversationId!);
    expect(conv.userId).toBe(ids.staff);
    expect((conv.context as { channel?: string }).channel).toBe('whatsapp');
    expect(first.row).toMatchObject({ status: 'handled', outcome: 'replied', userId: ids.staff });
    // audit: the turn as the person (source ai, user agent whatsapp, request id from the wamid) and one whatsapp.chat entry
    const chat = (await withSystem((tx) => tx.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, conv.id), eq(schema.auditLog.action, 'ai.chat')))))[0]!;
    expect(chat).toMatchObject({ userId: ids.staff, source: 'ai', userAgent: 'whatsapp', requestId: `whatsapp:${first.id}` });
    expect((await audits(first.rowId, 'whatsapp.chat'))[0]).toMatchObject({ userId: ids.staff, source: 'ai' });
    expect((await audits(first.rowId, 'whatsapp.chat'))[0]!.metadata).toMatchObject({ outcome: 'replied', parts: 1, failedParts: 0, pendingAction: false });
    // the prompt carries the channel note and no navigation tools
    expect(fake.seen[0]!.system).toContain('## Channel');
    expect(fake.seen[0]!.system).toContain('Reply YES to go ahead or NO to drop it');
    expect(toolNames(fake.seen[0]!)).not.toContain('navigate');
    expect(toolNames(fake.seen[0]!)).not.toContain('open_record');
    expect(toolNames(fake.seen[0]!)).toContain('query_tickets');
    // a delivery callback for the reply updates the outbox row
    const settings = await withSystem((tx) => loadWhatsAppSettings(tx));
    const callback = await handleWhatsAppWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{ id: outbox.providerMessageId, status: 'read' }] } }] }] }, settings);
    expect(callback).toEqual({ ok: true, updated: 1, queued: 0 });
    expect((await outboxById(outbox.id)).deliveryStatus).toBe('read');

    // a second message continues the same thread, with no second greeting
    resetGraph();
    fake.script(say('Still one open ticket.'));
    const second = await inbound(PHONES.staff, 'and now?');
    expect(second.row.conversationId).toBe(first.row.conversationId);
    expect(texts()[0]!.text).toBe('Still one open ticket.');
    expect(fake.seen[fake.seen.length - 1]!.messages.filter((m) => m.role === 'user').length).toBeGreaterThanOrEqual(2);
    // after the idle window a fresh thread starts
    await setSettings({ 'whatsapp.assistant.thread_idle_hours': 0 });
    fake.script(say('A fresh thread.'));
    const third = await inbound(PHONES.staff, 'hello again');
    expect(third.row.conversationId).not.toBe(first.row.conversationId);
    await setSettings({ 'whatsapp.assistant.thread_idle_hours': 24 });
  });

  it('proposes an action with the YES/NO footer and decides it on yes or no without a model call', async () => {
    await ensureConnection();
    await ensureAssistant();
    resetGraph();
    const before = await countComments(ids.ticketA);
    const fake = useScript(tool('add_comment', { ticket: numbers.a, body: `Checked by phone ${S}` }), say('I will add that comment. Shall I proceed?'));
    const proposal = await inbound(PHONES.staff, `add a comment to ${numbers.a} saying checked by phone`);
    expect(proposal.result.outcome).toBe('replied');
    expect(texts()[0]!.text).toMatch(/Reply \*YES\* to go ahead or \*NO\* to drop it \(within \d+ min\)\.$/);
    expect((await audits(proposal.rowId, 'whatsapp.chat'))[0]!.metadata).toMatchObject({ pendingAction: true });
    const calls = fake.seen.length;
    resetGraph();
    const yes = await inbound(PHONES.staff, 'yes');
    expect(yes.result.outcome).toBe('replied');
    expect(fake.seen.length).toBe(calls);
    expect(await countComments(ids.ticketA)).toBe(before + 1);
    expect(texts()[0]!.text.startsWith('Done:')).toBe(true);
    expect(texts()[0]!.text).toContain(`${APP_URL}/tickets/${ids.ticketA}`);
    expect(yes.row.conversationId).toBe(proposal.row.conversationId);

    fake.script(tool('add_comment', { ticket: numbers.a, body: `Second thought ${S}` }), say('I will add that. Shall I proceed?'));
    await inbound(PHONES.staff, 'add another comment');
    resetGraph();
    const no = await inbound(PHONES.staff, 'no');
    expect(no.result.outcome).toBe('replied');
    expect(texts()[0]!.text).toBe('OK, I have not done that.');
    expect(await countComments(ids.ticketA)).toBe(before + 1);

    // after a thread reset there is nothing held, so "yes" is an ordinary message
    await setSettings({ 'whatsapp.assistant.thread_idle_hours': 0 });
    fake.script(say('Yes to what? Ask me something.'));
    resetGraph();
    const stray = await inbound(PHONES.staff, 'yes');
    expect(stray.result.outcome).toBe('replied');
    expect(texts()[0]!.text).toBe('Yes to what? Ask me something.');
    expect(await countComments(ids.ticketA)).toBe(before + 1);
    await setSettings({ 'whatsapp.assistant.thread_idle_hours': 24 });
  });
});

// ---------------------------------------------------------------- one turn per phone, and recovery

describe('one turn per phone, in order, and recovery after a dead run', () => {
  const processingRow = (providerMessageId: string, opts: { receivedAt: Date; claimedAt: Date }) =>
    withSystem((tx) => tx.insert(schema.whatsappInbound).values({ providerMessageId, phone: PHONES.staff, userId: ids.staff, kind: 'text', text: 'x', status: 'processing', receivedAt: opts.receivedAt, claimedAt: opts.claimedAt }).returning({ id: schema.whatsappInbound.id }).then((r) => r[0]!.id));
  const setRow = (id: string, values: Partial<typeof schema.whatsappInbound.$inferInsert>) => withSystem((tx) => tx.update(schema.whatsappInbound).set(values).where(eq(schema.whatsappInbound.id, id)));

  it('a newer message waits for the older one being answered (and gives way once the requeues are used up); the older never waits for the newer, nor for a sibling claimed longer ago than the stale window', async () => {
    await ensureConnection();
    await ensureAssistant();
    const fake = useScript(say('In order.'));
    const older = await processingRow(`wamid.${S}.older`, { receivedAt: new Date(Date.now() - 5_000), claimedAt: new Date() });
    let future: string | null = null;
    try {
      vi.mocked(enqueue).mockClear();
      resetGraph();
      const newer = await inbound(PHONES.staff, 'second');
      expect(newer.result.outcome).toBe('requeued');
      expect(newer.row).toMatchObject({ status: 'received', claimedAt: null });
      // the webhook's enqueue, then the requeue
      expect(enqueue).toHaveBeenCalledTimes(2);
      expect(enqueue).toHaveBeenLastCalledWith('ai', 'whatsapp-chat', { inboundId: newer.rowId, n: 1 }, expect.objectContaining({ jobId: `whatsapp-${newer.id}-1`, delay: REQUEUE_DELAY_MS, attempts: 1 }));
      expect(graph).toHaveLength(0);
      expect(fake.seen).toHaveLength(0);
      // the requeued run finds the older one still being answered: it waits again, numbered
      expect((await handleInbound(newer.rowId, 1)).outcome).toBe('requeued');
      expect(enqueue).toHaveBeenLastCalledWith('ai', 'whatsapp-chat', { inboundId: newer.rowId, n: 2 }, expect.objectContaining({ jobId: `whatsapp-${newer.id}-2` }));
      // with the requeues used up it proceeds rather than never answering
      expect((await handleInbound(newer.rowId, MAX_REQUEUES)).outcome).toBe('replied');
      expect(texts()[0]!.text).toBe('In order.');
      await setRow(older, { status: 'handled', outcome: 'replied', handledAt: new Date() });
      // a newer sibling being answered never holds an older message back
      future = await processingRow(`wamid.${S}.future`, { receivedAt: new Date(Date.now() + 60_000), claimedAt: new Date() });
      fake.script(say('Older first.'));
      resetGraph();
      expect((await inbound(PHONES.staff, 'third')).result.outcome).toBe('replied');
      expect(texts()[0]!.text).toBe('Older first.');
      // an older sibling whose claim is past the stale window does not block either
      await setRow(future, { receivedAt: new Date(Date.now() - 120_000), claimedAt: new Date(Date.now() - CLAIM_STALE_MS - 1_000) });
      fake.script(say('Stale sibling.'));
      resetGraph();
      expect((await inbound(PHONES.staff, 'fourth')).result.outcome).toBe('replied');
      expect(texts()[0]!.text).toBe('Stale sibling.');
    } finally {
      await setRow(older, { status: 'handled', outcome: 'replied', handledAt: new Date() });
      if (future) await setRow(future, { status: 'handled', outcome: 'replied', handledAt: new Date() });
    }
  });

  it('takes over a row a dead run left in processing once its claim is older than the turn timeout, and comes back later while it is not', async () => {
    await ensureConnection();
    await ensureAssistant();
    const fake = useScript(say('Taken over.'));
    const ai_ = await withSystem((tx) => loadAiSettings(tx));
    const reclaimAfter = ai_.turnTimeoutSeconds * 1000 + RECLAIM_MARGIN_MS;
    const held = await inbound(PHONES.staff, 'are you there?', { run: false });
    await setRow(held.rowId, { status: 'processing', claimedAt: new Date(Date.now() - 10_000) });
    vi.mocked(enqueue).mockClear();
    resetGraph();
    expect(await handleInbound(held.rowId)).toEqual({ outcome: 'requeued', replied: false, parts: 0 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [, , data, opts] = vi.mocked(enqueue).mock.calls[0]! as unknown as [string, string, Record<string, unknown>, { jobId: string; delay: number; attempts: number }];
    expect(data).toEqual({ inboundId: held.rowId, n: 1 });
    expect(opts).toMatchObject({ jobId: `whatsapp-${held.id}-1`, attempts: 1 });
    expect(opts.delay).toBeGreaterThan(reclaimAfter - 20_000);
    expect(opts.delay).toBeLessThanOrEqual(reclaimAfter);
    expect((await rowOf(held.rowId)).status).toBe('processing');
    expect(graph).toHaveLength(0);
    expect(fake.seen).toHaveLength(0);
    // the claim is older than the turn timeout: the next run takes the row over and answers
    await setRow(held.rowId, { claimedAt: new Date(Date.now() - reclaimAfter - 1_000) });
    resetGraph();
    expect((await handleInbound(held.rowId, 1)).outcome).toBe('replied');
    expect(texts()[0]!.text).toBe('Taken over.');
    expect((await rowOf(held.rowId)).status).toBe('handled');
    expect((await handleInbound(held.rowId, 2)).outcome).toBe('duplicate');
    // with the requeues used up a held row is left to its holder
    const held2 = await inbound(PHONES.staff, 'still there?', { run: false });
    await setRow(held2.rowId, { status: 'processing', claimedAt: new Date() });
    vi.mocked(enqueue).mockClear();
    expect((await handleInbound(held2.rowId, MAX_REQUEUES)).outcome).toBe('duplicate');
    expect(enqueue).not.toHaveBeenCalled();
    await setRow(held2.rowId, { status: 'handled', outcome: 'replied', handledAt: new Date() });
  });

  it('the sweep asks for the job of a message still waiting after two minutes and records a claim older than an hour as failed', async () => {
    await ensureConnection();
    await ensureAssistant();
    const waiting = await inbound(PHONES.staff, 'lost', { run: false });
    await setRow(waiting.rowId, { createdAt: new Date(Date.now() - 3 * 60_000) });
    const dead = await processingRow(`wamid.${S}.dead`, { receivedAt: new Date(Date.now() - 2 * 3_600_000), claimedAt: new Date(Date.now() - 2 * 3_600_000) });
    const justNow = await inbound(PHONES.staff, 'just now', { run: false });
    vi.mocked(enqueue).mockClear();
    const swept = await sweepInbound();
    expect(swept.requeued).toBeGreaterThanOrEqual(1);
    expect(swept.abandoned).toBeGreaterThanOrEqual(1);
    const call = vi.mocked(enqueue).mock.calls.find((c) => (c[2] as { inboundId: string }).inboundId === waiting.rowId);
    expect(call).toBeTruthy();
    expect((call![3] as { jobId: string }).jobId.startsWith(`whatsapp-${waiting.id}-sweep-`)).toBe(true);
    expect(vi.mocked(enqueue).mock.calls.some((c) => (c[2] as { inboundId: string }).inboundId === justNow.rowId)).toBe(false);
    expect(await rowOf(dead)).toMatchObject({ status: 'failed', outcome: 'failed', error: 'worker stopped mid-turn' });
    expect((await audits(dead, 'whatsapp.chat'))[0]!.metadata).toMatchObject({ outcome: 'failed', userId: ids.staff });
    expect((await rowOf(justNow.rowId)).status).toBe('received');
    // the requeued message is answered by its job
    useScript(say('Found it.'));
    resetGraph();
    expect((await handleInbound(waiting.rowId)).outcome).toBe('replied');
    expect(texts()[0]!.text).toBe('Found it.');
    expect((await handleInbound(justNow.rowId)).outcome).toBe('replied');
  });
});

// ---------------------------------------------------------------- 7. who gets what

describe('numbers that are not linked, and STOP/START', () => {
  it('tells an unknown or unverified number how to link once an hour, and a verified number with the chat off once an hour, without any model call', async () => {
    await ensureConnection();
    await ensureAssistant();
    const fake = useScript();
    resetGraph();
    const unknown = await inbound(PHONES.unknown, 'hello?');
    expect(unknown.result.outcome).toBe('unverified');
    expect(texts()).toEqual([{ to: digits(PHONES.unknown), text: fill(DEFAULT_UNLINKED_REPLY, { platform: 'Progression' }) }]);
    expect(unknown.row.replyOutboxId).toBeTruthy();
    expect((await outboxById(unknown.row.replyOutboxId!)).payload).toMatchObject({ kind: 'notice', inboundId: unknown.rowId });
    expect((await audits(unknown.rowId, 'whatsapp.chat'))[0]!.metadata).toMatchObject({ outcome: 'unverified' });
    resetGraph();
    const again = await inbound(PHONES.unknown, 'anyone there?');
    expect(again.result.outcome).toBe('unverified');
    expect(again.row.replyOutboxId).toBeNull();
    expect(graph).toHaveLength(0);
    // consent to notifications is not proof of ownership
    resetGraph();
    const optin = await inbound(PHONES.optin, 'hi');
    expect(optin.result.outcome).toBe('unverified');
    expect(texts()).toHaveLength(1);
    // verified but the chat is off: the chat-off notice, once, then silence
    resetGraph();
    const chatOff = await inbound(PHONES.off, 'hi grady');
    expect(chatOff.result.outcome).toBe('chat_off');
    expect(chatOff.row.userId).toBe(ids.off);
    expect(texts()).toEqual([{ to: digits(PHONES.off), text: CHAT_OFF_REPLY }]);
    resetGraph();
    const chatOffAgain = await inbound(PHONES.off, 'hello?');
    expect(chatOffAgain.result.outcome).toBe('chat_off');
    expect(texts()).toHaveLength(0);
    expect(fake.seen).toHaveLength(0);
    // the inbound log shows the person for a verified number and nothing for a stranger
    const log = await as(admin)((ctx) => listInbound(ctx, { limit: 50, phone: PHONES.unknown }));
    expect(log.items.length).toBeGreaterThanOrEqual(2);
    for (const item of log.items) expect(item.user).toBeNull();
    const offLog = await as(admin)((ctx) => listInbound(ctx, { limit: 50, phone: PHONES.off, outcome: 'chat_off' }));
    expect(offLog.items.length).toBe(2);
    for (const item of offLog.items) expect(item.user).toMatchObject({ id: ids.off, name: 'Chat Off' });
    // newest first: the throttled one has no reply, the first one does
    expect(offLog.items[0]!.reply).toBeNull();
    expect(offLog.items[1]!.reply).toMatchObject({ status: 'sent', deliveryStatus: 'accepted' });
  });

  it('STOP switches the chat off from the phone with a confirming reply, START switches it back on, each audited as done by phone', async () => {
    await ensureConnection();
    await ensureAssistant();
    const fake = useScript();
    resetGraph();
    const stop = await inbound(PHONES.staff, 'STOP');
    expect(stop.result.outcome).toBe('stopped');
    expect(await flagOf(ids.staff)).toBe(false);
    expect(texts()[0]!.text).toContain('Chat with Grady is now off for this number. Text START');
    expect((await audits(ids.staff, 'whatsapp.assistant.off'))[0]!.metadata).toMatchObject({ by: 'phone' });
    expect((await userRow(ids.staff)).whatsappVerifiedAt).toBeTruthy();
    resetGraph();
    const silent = await inbound(PHONES.staff, 'are you there?');
    expect(silent.result.outcome).toBe('chat_off');
    expect(texts()[0]!.text).toBe(CHAT_OFF_REPLY);
    resetGraph();
    const stopAgain = await inbound(PHONES.staff, 'stop.');
    expect(stopAgain.result.outcome).toBe('stopped');
    expect(texts()[0]!.text).toContain('already off');
    resetGraph();
    const start = await inbound(PHONES.staff, 'Start');
    expect(start.result.outcome).toBe('started');
    expect(await flagOf(ids.staff)).toBe(true);
    expect(texts()[0]!.text).toContain('Chat with Grady is on for this number.');
    expect((await audits(ids.staff, 'whatsapp.assistant.on'))[0]!.metadata).toMatchObject({ by: 'phone' });
    expect(fake.seen).toHaveLength(0);
    resetGraph();
    fake.script(say('Back with you.'));
    const back = await inbound(PHONES.staff, 'hello');
    expect(back.result.outcome).toBe('replied');
    expect(texts()[0]!.text).toBe('Back with you.');
    // START for a number that cannot be linked is just an unverified message
    resetGraph();
    expect((await inbound(PHONES.optin, 'START')).result.outcome).toBe('unverified');
  });
});

// ---------------------------------------------------------------- 8 and 11. the portal user

describe('a portal user on WhatsApp', () => {
  it('is fenced to their organisation exactly as in the portal, in their own conversation', async () => {
    await ensureConnection();
    await ensureAssistant();
    resetGraph();
    // the model guesses another organisation's ticket number: the tool refuses it and the answer fence scrubs the number
    const fake = useScript(tool('get_ticket', { ticket: numbers.b }), say(`Ticket ${numbers.b} is open.`));
    const res = await inbound(PHONES.portal, 'what is open at Beta?');
    expect(res.result.outcome).toBe('replied');
    const text = texts()[0]!.text;
    expect(text).not.toContain(numbers.b);
    expect(text).not.toContain(names.b);
    expect(text).toContain('a ticket');
    const conv = await conversationOf(res.row.conversationId!);
    expect(conv.customerId).toBe(ids.a);
    expect(conv.userId).toBe(ids.portal);
    expect(fake.seen[0]!.system).toContain(`Every answer is about ${names.a} only`);
    expect(fake.seen[0]!.system).toContain('## Channel');
    const staffConversations = await withSystem((tx) => tx.select({ id: schema.aiConversations.id }).from(schema.aiConversations).where(eq(schema.aiConversations.userId, ids.staff)));
    expect(staffConversations.map((c) => c.id)).not.toContain(conv.id);
    const outbox = await outboxById(res.row.replyOutboxId!);
    expect(outbox.customerId).toBe(ids.a);
  });

  it('holds no database connection and no open transaction while the model is working', async () => {
    await ensureConnection();
    await ensureAssistant();
    resetGraph();
    const snapshots: { busy: number; idleInTransaction: number }[] = [];
    const fake = useScript(say('Nothing is open for you right now.'));
    fake.onChat = async () => {
      const busy = pool.totalCount - pool.idleCount;
      const res = await withSystem((tx) => tx.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()`));
      snapshots.push({ busy, idleInTransaction: Number((res.rows[0] as { n: number }).n) });
    };
    const res = await inbound(PHONES.portal, 'anything open?');
    expect(res.result.outcome).toBe('replied');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({ busy: 0, idleInTransaction: 0 });
  });
});

// ---------------------------------------------------------------- 9. switches and limits

describe('switches, audiences and limits', () => {
  it('answers nobody while the feature or the assistant switch is off, honours the audiences, the daily cap and the burst limit', async () => {
    await ensureConnection();
    await ensureAssistant();
    const fake = useScript();
    try {
      await setSettings({ 'ai.disabled_features': ['whatsapp_assistant'] });
      resetGraph();
      const off = await inbound(PHONES.staff, 'hello');
      expect(off.result.outcome).toBe('feature_off');
      expect(texts()).toEqual([{ to: digits(PHONES.staff), text: `The WhatsApp assistant is switched off. Use the web application: ${APP_URL}` }]);
      resetGraph();
      expect((await inbound(PHONES.staff, 'hello?')).result.outcome).toBe('feature_off');
      expect(texts()).toHaveLength(0);
      await setSettings({ 'ai.disabled_features': [], 'whatsapp.assistant.enabled': false });
      resetGraph();
      const switched = await inbound(PHONES.portal, 'hello');
      expect(switched.result.outcome).toBe('feature_off');
      expect(texts()).toHaveLength(1);
      expect(fake.seen).toHaveLength(0);
      expect((await as(portal)((ctx) => linkStatus(ctx))).assistant).toMatchObject({ enabled: false, reason: 'The administrator has not enabled WhatsApp chat yet' });

      await setSettings({ 'whatsapp.assistant.enabled': true, 'whatsapp.assistant.audiences': ['staff'] });
      resetGraph();
      const audience = await inbound(PHONES.portal, 'hello');
      expect(audience.result.outcome).toBe('audience');
      expect(texts()).toEqual([{ to: digits(PHONES.portal), text: 'WhatsApp chat is not available for your account' }]);
      expect((await as(portal)((ctx) => linkStatus(ctx))).assistant).toMatchObject({ enabled: true, allowed: false, reason: 'WhatsApp chat is not available for your account' });
      fake.script(say('Staff still get answers.'));
      resetGraph();
      expect((await inbound(PHONES.staff, 'hello')).result.outcome).toBe('replied');
      expect(texts()[0]!.text).toBe('Staff still get answers.');

      await setSettings({ 'whatsapp.assistant.audiences': ['staff', 'customers'], 'whatsapp.assistant.daily_message_cap': 1 });
      resetGraph();
      const capped = await inbound(PHONES.staff, 'one more');
      expect(capped.result.outcome).toBe('cap');
      expect(texts()).toEqual([{ to: digits(PHONES.staff), text: "You have reached today's WhatsApp limit of 1 messages; it resets at midnight UTC." }]);
      // a turn whose reply Meta refused counts toward the cap as well (the model ran)
      const [turns] = await withSystem((tx) => tx.select({ n: sql<number>`count(*)::int` }).from(schema.whatsappInbound).where(and(eq(schema.whatsappInbound.userId, ids.staff), inArray(schema.whatsappInbound.outcome, ['replied', 'failed']), sql`${schema.whatsappInbound.handledAt} >= date_trunc('day', now())`)));
      await setSettings({ 'whatsapp.assistant.daily_message_cap': Number(turns!.n) + 1 });
      await withSystem((tx) => tx.insert(schema.whatsappInbound).values({ providerMessageId: `wamid.${S}.failedturn`, phone: PHONES.staff, userId: ids.staff, kind: 'text', text: 'x', status: 'failed', outcome: 'failed', error: 'the reply could not be sent', receivedAt: new Date(), handledAt: new Date() }));
      resetGraph();
      const seenBefore = fake.seen.length;
      expect((await inbound(PHONES.staff, 'and again')).result.outcome).toBe('cap');
      expect(fake.seen.length).toBe(seenBefore);

      await setSettings({ 'whatsapp.assistant.daily_message_cap': 100 });
      const burst = Array.from({ length: 31 }, (_, i) => ({ providerMessageId: `wamid.${S}.burst.${i}`, phone: PHONES.staff, userId: ids.staff, kind: 'text' as const, text: 'x', status: 'handled' as const, outcome: 'replied', receivedAt: new Date(), handledAt: new Date() }));
      await withSystem((tx) => tx.insert(schema.whatsappInbound).values(burst));
      resetGraph();
      const calls = fake.seen.length;
      const throttled = await inbound(PHONES.staff, 'again');
      expect(throttled.result.outcome).toBe('throttled');
      expect(graph.filter((c) => c.body.type === 'text')).toHaveLength(0);
      expect(fake.seen.length).toBe(calls);
      await withSystem((tx) => tx.delete(schema.whatsappInbound).where(sql`${schema.whatsappInbound.providerMessageId} like ${`wamid.${S}.burst.%`}`));
    } finally {
      await ensureAssistant();
    }
  });
});

// ---------------------------------------------------------------- 13 and 14. the administrator

describe('administrator reads, the tool and settings validation', () => {
  it('reports readiness and counts, serves the inbound log, counts WhatsApp replies in the usage report and answers whatsapp_chat_status for administrators only', async () => {
    await ensureConnection();
    await ensureAssistant();
    const status = await as(admin)((ctx) => assistantStatus(ctx));
    expect(status.enabled).toBe(true);
    expect(status.linkedUsers).toBeGreaterThanOrEqual(2);
    expect(status.verifiedUsers).toBeGreaterThanOrEqual(status.linkedUsers);
    expect(status.inboundToday).toBeGreaterThan(0);
    expect(status.repliedToday).toBeGreaterThan(0);
    const texts_ = status.checks.map((c) => `${c.level}: ${c.text}`);
    expect(texts_.some((t) => t.startsWith('ok: WhatsApp is enabled'))).toBe(true);
    expect(texts_.some((t) => t.startsWith('ok: The app secret is set'))).toBe(true);
    expect(texts_.some((t) => t.includes('"Chat on WhatsApp" feature and the AI provider are on'))).toBe(true);
    expect(texts_.some((t) => t.includes('webhook URL is local'))).toBe(true);
    await setSettings({ 'whatsapp.app.secret': '' });
    const noSecret = await as(admin)((ctx) => assistantStatus(ctx));
    expect(noSecret.ready).toBe(false);
    expect(noSecret.checks.some((c) => c.level === 'error' && c.text.includes('Inbound messages are ignored until the app secret is set'))).toBe(true);
    await ensureConnection();

    const log = await as(admin)((ctx) => listInbound(ctx, { limit: 200 }));
    expect(log.items.length).toBeGreaterThan(0);
    expect((await as(admin)((ctx) => listInbound(ctx, { limit: 2 }))).items.length).toBe(2);
    expect(log.items.some((i) => i.user === null)).toBe(true);
    expect(log.items.some((i) => i.outcome === 'replied' && i.reply?.status === 'sent')).toBe(true);
    const u = await as(admin)((ctx) => aiUsage(ctx, { days: 1 }));
    expect(u.totals.whatsappTurns).toBeGreaterThanOrEqual(1);
    expect(u.series.some((d) => d.whatsappTurns >= 1)).toBe(true);

    const t = toolByName('whatsapp_chat_status')!;
    expect(t.portal).toBeNull();
    expect(toolAvailable(whoOf(admin), t)).toBe(true);
    expect(toolAvailable(whoOf(portal), t)).toBe(false);
    const result = (await as(admin)((ctx) => t.run(ctx, { hours: 6 }))) as { enabled: boolean; linkedUsers: number; inbound: number; replied: number; unverified: number; facts: string[]; link: string };
    expect(result.enabled).toBe(true);
    expect(result.inbound).toBeGreaterThan(0);
    expect(result.replied).toBeGreaterThan(0);
    expect(result.unverified).toBeGreaterThan(0);
    expect(result.facts[0]).toMatch(/^WhatsApp chat: on, .*linked people, \d+ messages in the last 6 h, \d+ answered, \d+ failed, \d+ from unlinked numbers$/);
    expect(result.link).toBe('/admin/whatsapp');
    // the users list carries the chat flag without anybody's preferences
    const listed = await as(admin)((ctx) => iam.listUsers(ctx, { page: 1, pageSize: 5, q: emailOf('staff'), sort: 'name', order: 'asc' }));
    expect(listed.items[0]).toMatchObject({ id: ids.staff, assistantOn: true });
    expect(listed.items[0]).not.toHaveProperty('preferences');
    const one = await as(admin)((ctx) => iam.getUser(ctx, ids.off));
    expect(one.assistantOn).toBe(false);
    expect(one.whatsappVerifiedAt).toBeTruthy();
    // a malformed flag (anything but true) reads as off and never breaks the users pages or the readiness counts
    await withSystem((tx) => tx.update(schema.users).set({ preferences: { whatsapp: { assistant: 'maybe' } } }).where(eq(schema.users.id, ids.optin)));
    expect((await as(admin)((ctx) => iam.getUser(ctx, ids.optin))).assistantOn).toBe(false);
    expect((await as(admin)((ctx) => iam.listUsers(ctx, { page: 1, pageSize: 5, q: emailOf('optin'), sort: 'name', order: 'asc' }))).items[0]).toMatchObject({ id: ids.optin, assistantOn: false });
    expect((await as(admin)((ctx) => assistantStatus(ctx))).linkedUsers).toBeGreaterThanOrEqual(1);
    await withSystem((tx) => tx.update(schema.users).set({ preferences: {} }).where(eq(schema.users.id, ids.optin)));
  });

  it('lets Grady change the assistant settings with validation, never the display number or a secret', async () => {
    const t = toolByName('update_setting')!;
    expect(await as(admin)((ctx) => t.preview!(ctx, { key: 'whatsapp.assistant.daily_message_cap', value: 50 }))).toContain('whatsapp.assistant.daily_message_cap');
    expect(await as(admin)((ctx) => t.preview!(ctx, { key: 'whatsapp.assistant.audiences', value: ['customers'] }))).toContain('whatsapp.assistant.audiences');
    expect((await failure(as(admin)((ctx) => t.preview!(ctx, { key: 'whatsapp.assistant.audiences', value: ['everyone'] }))))).toBeInstanceOf(ValidationError);
    expect((await failure(as(admin)((ctx) => t.preview!(ctx, { key: 'whatsapp.assistant.thread_idle_hours', value: 0 }))))).toBeInstanceOf(ValidationError);
    expect((await failure(as(admin)((ctx) => t.preview!(ctx, { key: 'whatsapp.assistant.greeting', value: 'Hi' }))))).toBeInstanceOf(ValidationError);
    expect((await failure(as(admin)((ctx) => t.preview!(ctx, { key: 'whatsapp.access_token.secret', value: 'x' })))).message).toMatch(/cannot be changed|protected/);
    expect((await failure(as(admin)((ctx) => t.preview!(ctx, { key: 'whatsapp.display_number', value: '+91 11 4000 0001' })))).message).toMatch(/cannot be changed/);
    expect((await failure(as(admin)((ctx) => t.preview!(ctx, { key: 'whatsapp.app.secret', value: 'x' })))).message).toMatch(/cannot be changed|protected/);
  });
});

// ---------------------------------------------------------------- 10 and 12. clearing

describe('clearing a number', () => {
  it('a changed number clears the verification (the notifications module audits it); the same number in another format keeps it; the old number is a stranger afterwards', async () => {
    await ensureConnection();
    await ensureAssistant();
    await as(admin)((ctx) => iam.updateUser(ctx, ids.off, { phone: '+91 98765 43303' }));
    expect((await userRow(ids.off)).whatsappVerifiedAt).toBeTruthy();
    await as(admin)((ctx) => iam.updateUser(ctx, ids.off, { phone: '98765 43397' }));
    expect((await userRow(ids.off)).whatsappVerifiedAt).toBeNull();
    expect((await audits(ids.off, 'phone.verification_cleared'))[0]!.metadata).toMatchObject({ reason: 'phone_changed' });
    await updatePreferences(ids.staff, { phone: '98765 43398' }, { requestId: meta.requestId });
    expect((await userRow(ids.staff)).whatsappVerifiedAt).toBeNull();
    expect((await audits(ids.staff, 'phone.verification_cleared'))[0]!.metadata).toMatchObject({ reason: 'phone_changed' });
    resetGraph();
    const stranger = await inbound(PHONES.staff, 'hello');
    expect(stranger.result.outcome).toBe('unverified');
    expect(stranger.row.userId).toBeNull();
  });

  it('administrators revoke a number (chat off, verification cleared, open codes consumed, both audited); a customer administrator only within their organisation', async () => {
    await withSystem((tx) => tx.update(schema.users).set({ phone: PHONES.off, whatsappVerifiedAt: new Date(), preferences: { whatsapp: { assistant: true } } }).where(eq(schema.users.id, ids.off)));
    await withSystem((tx) => tx.insert(schema.phoneVerifications).values({ userId: ids.off, phone: PHONES.off, method: 'typed', codeHash: 'x', expiresAt: new Date(Date.now() + 600_000) }));
    expect(await as(admin)((ctx) => revokeNumber(ctx, ids.off, { by: 'admin' }))).toEqual({ ok: true });
    const revoked = await userRow(ids.off);
    expect(revoked.whatsappVerifiedAt).toBeNull();
    expect(await flagOf(ids.off)).toBe(false);
    expect((await audits(ids.off, 'whatsapp.assistant.off'))[0]!.metadata).toMatchObject({ by: 'admin' });
    expect((await audits(ids.off, 'phone.verification_cleared'))[0]!.metadata).toMatchObject({ reason: 'admin', phone: '+91••••3303' });
    const open = await withSystem((tx) => tx.select().from(schema.phoneVerifications).where(and(eq(schema.phoneVerifications.userId, ids.off), sql`${schema.phoneVerifications.consumedAt} is null`)));
    expect(open).toHaveLength(0);
    expect(await failure(as(admin)((ctx) => revokeNumber(ctx, '00000000-0000-4000-8000-000000000000', { by: 'admin' })))).toBeInstanceOf(NotFoundError);

    expect(await failure(as(portalAdmin)((ctx) => unlinkPortalUserWhatsApp(ctx, ids.userB)))).toBeInstanceOf(NotFoundError);
    expect(await failure(as(portalAdmin)((ctx) => unlinkPortalUserWhatsApp(ctx, ids.staff)))).toBeInstanceOf(NotFoundError);
    expect(await as(portalAdmin)((ctx) => unlinkPortalUserWhatsApp(ctx, ids.portal))).toEqual({ ok: true });
    expect((await userRow(ids.portal)).whatsappVerifiedAt).toBeNull();
    expect(await flagOf(ids.portal)).toBe(false);
    expect((await audits(ids.portal, 'whatsapp.assistant.off'))[0]!.metadata).toMatchObject({ by: 'portal_admin' });
    expect((await audits(ids.portal, 'phone.verification_cleared'))[0]!.metadata).toMatchObject({ reason: 'portal_admin' });
    // an MSP principal cannot use the portal path
    expect(await failure(as(admin)((ctx) => unlinkPortalUserWhatsApp(ctx, ids.portal)))).toBeInstanceOf(ForbiddenError);
    resetGraph();
    expect((await inbound(PHONES.portal, 'hello')).result.outcome).toBe('unverified');
  });
});
