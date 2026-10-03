import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import * as svc from './service';
import * as paging from './paging';
import * as S from './schemas';

const idParam = z.object({ id: z.string().uuid() });
const tokenParam = z.object({ token: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/) });
const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A small, dependency-free page for the acknowledgement link (opened from WhatsApp or email, no sign-in). */
function ackPage(opts: { title: string; lead: string; ticket?: { number: string; title: string; link: string } | null; button?: { label: string; action: string } | null; tone: 'ask' | 'ok' | 'info' | 'bad' }) {
  const color = { ask: '#111827', ok: '#047857', info: '#1d4ed8', bad: '#b91c1c' }[opts.tone];
  const ticket = opts.ticket ? `<p class="t"><strong>${esc(opts.ticket.number)}</strong> ${esc(opts.ticket.title)}</p>` : '';
  const button = opts.button ? `<form method="post" action="${esc(opts.button.action)}"><button type="submit">${esc(opts.button.label)}</button></form>` : '';
  const open = opts.ticket ? `<p class="s"><a href="${esc(opts.ticket.link)}">Open the ticket in Progression</a></p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(opts.title)}</title>
<style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f5f5f5;color:#111827}main{max-width:460px;margin:12vh auto;padding:28px 24px;background:#fff;border:1px solid #e5e7eb;border-radius:12px}h1{font-size:20px;margin:0 0 8px;color:${color}}p{margin:8px 0;line-height:1.5}.t{padding:10px 12px;background:#f9fafb;border-radius:8px}.s{font-size:13px;color:#6b7280}button{margin-top:12px;width:100%;padding:12px;font-size:16px;font-weight:600;color:#fff;background:#111827;border:0;border-radius:8px;cursor:pointer}a{color:#1d4ed8}</style></head>
<body><main><h1>${esc(opts.title)}</h1><p>${esc(opts.lead)}</p>${ticket}${button}${open}</main></body></html>`;
}

/**
 * On-call: rotas, overrides and escalation policies (staff), who is on call,
 * the schedule for a range, and paging with its public acknowledgement link.
 */
export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['oncall'];
  const read = app.auth('oncall:read');
  const manage = app.auth('oncall:manage');

  // ---- who is on call and the schedule
  r.get('/oncall/now', { preHandler: read, schema: { tags, querystring: S.nowQuerySchema } }, h((ctx, req) => svc.onCallNow(ctx, req.query as { teamId?: string; at?: Date })));
  r.get('/oncall/schedule', { preHandler: read, schema: { tags, querystring: S.scheduleQuerySchema } }, h((ctx, req) => svc.schedule(ctx, req.query as { teamId: string; from: Date; to: Date })));

  // ---- rotas
  r.get('/oncall/rotas', { preHandler: read, schema: { tags, querystring: S.rotasQuerySchema } }, h((ctx, req) => svc.listRotas(ctx, (req.query as { teamId?: string }).teamId)));
  r.post('/oncall/rotas', { preHandler: manage, schema: { tags, body: S.rotaBodySchema } }, h((ctx, req) => svc.createRota(ctx, req.body as S.RotaBody)));
  r.patch('/oncall/rotas/:id', { preHandler: manage, schema: { tags, params: idParam, body: S.rotaPatchSchema } }, h((ctx, req) => svc.updateRota(ctx, idOf(req), req.body as S.RotaPatch)));
  r.delete('/oncall/rotas/:id', { preHandler: manage, schema: { tags, params: idParam } }, h(async (ctx, req) => {
    await svc.deleteRota(ctx, idOf(req));
    return { ok: true };
  }));

  // ---- overrides (cover)
  r.get('/oncall/overrides', { preHandler: read, schema: { tags, querystring: S.overridesQuerySchema } }, h((ctx, req) => svc.listOverrides(ctx, req.query as { teamId?: string; rotaId?: string; from?: Date; to?: Date })));
  r.post('/oncall/overrides', { preHandler: read, schema: { tags, body: S.overrideBodySchema } }, h((ctx, req) => svc.createOverride(ctx, req.body as S.OverrideBody)));
  r.delete('/oncall/overrides/:id', { preHandler: read, schema: { tags, params: idParam } }, h(async (ctx, req) => {
    await svc.deleteOverride(ctx, idOf(req));
    return { ok: true };
  }));

  // ---- escalation policies
  r.get('/oncall/policies', { preHandler: read, schema: { tags } }, h((ctx) => svc.listPolicies(ctx)));
  r.post('/oncall/policies', { preHandler: manage, schema: { tags, body: S.policyBodySchema } }, h((ctx, req) => svc.createPolicy(ctx, req.body as S.PolicyBody)));
  r.patch('/oncall/policies/:id', { preHandler: manage, schema: { tags, params: idParam, body: S.policyPatchSchema } }, h((ctx, req) => svc.updatePolicy(ctx, idOf(req), req.body as S.PolicyPatch)));
  r.delete('/oncall/policies/:id', { preHandler: manage, schema: { tags, params: idParam } }, h(async (ctx, req) => {
    await svc.deletePolicy(ctx, idOf(req));
    return { ok: true };
  }));
  r.put('/oncall/teams/:id/policy', { preHandler: manage, schema: { tags, params: idParam, body: S.teamPolicySchema } }, h((ctx, req) => svc.setTeamPolicy(ctx, idOf(req), (req.body as { policyId: string | null }).policyId)));

  // ---- pages
  r.get('/oncall/pages', { preHandler: app.auth('tickets:read'), schema: { tags, querystring: S.pagesQuerySchema } }, h((ctx, req) => paging.listPages(ctx, req.query as { ticketId?: string; status?: paging.PageStatus | 'open'; limit?: number })));
  r.post('/oncall/pages', { preHandler: app.auth('tickets:escalate', 'tickets:major', 'oncall:manage'), schema: { tags, body: S.pageBodySchema } }, h((ctx, req) => {
    const b = req.body as { ticketId: string; policyId?: string | null; reason?: string | null };
    return paging.pageTicket(ctx, b.ticketId, { policyId: b.policyId ?? null, reason: b.reason ?? null, source: 'manual' });
  }));
  r.post('/oncall/pages/:id/ack', { preHandler: app.auth('tickets:read'), schema: { tags, params: idParam, body: S.pageAckSchema } }, h((ctx, req) => paging.acknowledgePage(ctx, idOf(req), (req.body as { note?: string | null }).note ?? null)));
  r.post('/oncall/pages/:id/cancel', { preHandler: app.auth('tickets:escalate', 'tickets:major', 'oncall:manage'), schema: { tags, params: idParam, body: S.pageCancelSchema } }, h((ctx, req) => paging.cancelPage(ctx, idOf(req), (req.body as { reason?: string | null }).reason ?? null)));

  // ---- acknowledgement link (public). GET only shows the button: messaging apps prefetch links.
  await app.register(async (pub) => {
    // The button is a plain HTML form; its body carries nothing the handler needs.
    pub.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, _body, done) => done(null, {}));
    pub.get('/oncall/ack/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } }, schema: { tags, params: tokenParam, hide: true } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const info = await paging.pageByToken(token);
    reply.type('text/html; charset=utf-8');
    if (!info) return reply.code(404).send(ackPage({ title: 'Link not recognised', lead: 'This acknowledgement link is not valid. Open the ticket in Progression instead.', tone: 'bad' }));
    if (info.status === 'pending') return reply.send(ackPage({ title: 'You are being paged', lead: `${info.target ? `${info.target}, ` : ''}press the button to confirm you are on it.`, ticket: info.ticket, button: { label: 'Acknowledge the page', action: `/api/oncall/ack/${token}` }, tone: 'ask' }));
    if (info.status === 'acked') return reply.send(ackPage({ title: 'Already acknowledged', lead: `${info.ackedBy ?? 'Someone'} already acknowledged this page.`, ticket: info.ticket, tone: 'info' }));
    return reply.send(ackPage({ title: 'This page is closed', lead: 'The page was cancelled or expired. Nothing more to do here.', ticket: info.ticket, tone: 'info' }));
    });
    pub.post('/oncall/ack/:token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { tags, params: tokenParam, hide: true } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    reply.type('text/html; charset=utf-8');
    try {
      const res = await paging.acknowledgeByToken(token);
      if (res.status === 'acked' && res.ackedBy) return reply.send(ackPage({ title: 'Acknowledged', lead: `Thanks ${res.ackedBy}. The team knows you are on it${'assigned' in res && res.assigned ? ' and the ticket is now assigned to you' : ''}.`, ticket: res.ticket, tone: 'ok' }));
      return reply.send(ackPage({ title: 'This page is closed', lead: 'The page was already handled. Nothing more to do here.', ticket: res.ticket, tone: 'info' }));
    } catch {
      return reply.code(404).send(ackPage({ title: 'Link not recognised', lead: 'This acknowledgement link is not valid. Open the ticket in Progression instead.', tone: 'bad' }));
    }
    });
  });
}
