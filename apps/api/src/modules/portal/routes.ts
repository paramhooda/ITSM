import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import * as svc from './service';
import * as S from './schemas';
import * as kedb from '@/modules/known-errors/service';
import * as KE from '@/modules/known-errors/schemas';
import * as surveysPortal from '@/modules/surveys/portal';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Customer portal API (`/portal/*`).
 *
 * Every handler goes through `svc.resolvePortalCustomer`, which binds the call
 * to the principal's own customer (customer users) or, for GET endpoints only,
 * lets an MSP user holding `tenant:all` preview a customer's portal with
 * `?customerId=`. Mutations are always customer-user only. Row-level security
 * narrows every query a second time.
 */
export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['portal'];
  /** Read endpoints: portal users, or MSP users with MSP-wide visibility (preview). */
  const read = app.auth('portal:access', 'tenant:all');
  /** Mutations: portal users only (the service refuses MSP principals). */
  const act = app.auth('portal:access');
  const q = <T extends { customerId?: string }>(req: { query: unknown }) => req.query as T;

  r.get('/portal/me', { preHandler: read, schema: { tags, querystring: S.previewQuery } }, h((ctx, req) => svc.me(ctx, q(req).customerId)));
  r.get('/portal/banners', { preHandler: read, schema: { tags, querystring: S.previewQuery } }, h((ctx, req) => svc.portalBanners(ctx, q(req).customerId)));
  r.get('/portal/catalog', { preHandler: read, schema: { tags, querystring: S.previewQuery } }, h((ctx, req) => svc.portalCatalog(ctx, q(req).customerId)));

  // ---- tickets
  r.get('/portal/tickets', { preHandler: read, schema: { tags, querystring: S.ticketListQuery } }, h((ctx, req) => svc.listPortalTickets(ctx, req.query as S.TicketListQuery)));
  r.post('/portal/tickets', { preHandler: act, schema: { tags, body: S.createTicketBody } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return svc.createPortalTicket(ctx, req.body as S.CreateTicketBody);
  }));
  r.get('/portal/tickets/:id', { preHandler: read, schema: { tags, params: idParam, querystring: S.previewQuery } }, h((ctx, req) => svc.getPortalTicket(ctx, (req.params as { id: string }).id, q(req).customerId)));
  r.get('/portal/tickets/:id/attachments', { preHandler: read, schema: { tags, params: idParam, querystring: S.previewQuery } }, h((ctx, req) => svc.portalTicketAttachments(ctx, (req.params as { id: string }).id, q(req).customerId)));
  r.post('/portal/tickets/:id/comments', { preHandler: act, schema: { tags, params: idParam, body: S.commentBody } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return svc.commentOnTicket(ctx, (req.params as { id: string }).id, (req.body as { body: string }).body);
  }));
  r.post('/portal/tickets/:id/reopen', { preHandler: act, schema: { tags, params: idParam, body: S.reopenBody } }, h((ctx, req) => svc.reopenPortalTicket(ctx, (req.params as { id: string }).id, (req.body as { reason: string }).reason)));
  r.post('/portal/tickets/:id/close-confirm', { preHandler: act, schema: { tags, params: idParam, body: S.closeConfirmBody } }, h((ctx, req) => svc.confirmResolution(ctx, (req.params as { id: string }).id, (req.body as { comment?: string | null } | undefined)?.comment)));
  // ---- satisfaction surveys: rate a resolved or closed ticket; the organisation's tickets still to rate
  r.post('/portal/tickets/:id/survey', { preHandler: act, schema: { tags, params: idParam, body: S.surveyAnswerBody } }, h((ctx, req) => surveysPortal.answerPortalSurvey(ctx, (req.params as { id: string }).id, req.body as S.SurveyAnswerBody)));
  r.get('/portal/surveys', { preHandler: read, schema: { tags, querystring: S.previewQuery } }, h((ctx, req) => surveysPortal.pendingForPortal(ctx, q(req).customerId)));

  // ---- approvals
  r.get('/portal/approvals', { preHandler: read, schema: { tags, querystring: S.previewQuery } }, h((ctx, req) => svc.listPortalApprovals(ctx, q(req).customerId)));
  r.post('/portal/approvals/:ticketId/:approvalId', { preHandler: act, schema: { tags, params: z.object({ ticketId: z.string().uuid(), approvalId: z.string().uuid() }), body: S.decideBody } }, h((ctx, req) => {
    const p = req.params as { ticketId: string; approvalId: string };
    const b = req.body as { decision: 'approved' | 'rejected'; comment?: string | null };
    return svc.decidePortalApproval(ctx, p.ticketId, p.approvalId, b.decision, b.comment);
  }));

  // ---- services, contracts, SLA
  r.get('/portal/services', { preHandler: read, schema: { tags, querystring: S.previewQuery } }, h((ctx, req) => svc.portalServices(ctx, q(req).customerId)));
  r.get('/portal/sla', { preHandler: read, schema: { tags, querystring: S.slaQuery } }, h((ctx, req) => svc.portalSla(ctx, req.query as { customerId?: string; days: number })));

  // ---- assets & CIs (static /portal/assets/overview first, ahead of any future /portal/assets/:id)
  r.get('/portal/assets/overview', { preHandler: read, schema: { tags, querystring: S.previewQuery } }, h((ctx, req) => svc.portalAssetsOverview(ctx, q(req).customerId)));
  r.get('/portal/assets', { preHandler: read, schema: { tags, querystring: S.assetListQuery } }, h((ctx, req) => svc.portalAssets(ctx, req.query as S.AssetListQuery)));
  r.get('/portal/cis', { preHandler: read, schema: { tags, querystring: S.ciListQuery } }, h((ctx, req) => svc.portalCis(ctx, req.query as S.CiListQuery)));

  // ---- software (customer administrators: titles and their licence position, licences without commercial terms, installations)
  r.get('/portal/software', { preHandler: read, schema: { tags, querystring: S.previewQuery } }, h((ctx, req) => svc.portalSoftware(ctx, q(req).customerId)));
  r.get('/portal/software/licences', { preHandler: read, schema: { tags, querystring: S.portalLicenceQuery } }, h((ctx, req) => svc.portalSoftwareLicences(ctx, req.query as S.PortalLicenceQuery)));
  r.get('/portal/software/installations', { preHandler: read, schema: { tags, querystring: S.portalInstallationQuery } }, h((ctx, req) => svc.portalSoftwareInstallations(ctx, req.query as S.PortalInstallationQuery)));

  // ---- planned changes (the organisation's own; plans, risk, CAB and conflicts never leave the MSP side)
  r.get('/portal/changes', { preHandler: read, schema: { tags, querystring: S.plannedChangesQuery } }, h((ctx, req) => svc.portalPlannedChanges(ctx, req.query as S.PlannedChangesQuery)));

  // ---- maintenance & visits
  r.get('/portal/maintenance', { preHandler: read, schema: { tags, querystring: S.maintenanceQuery } }, h((ctx, req) => svc.portalMaintenance(ctx, req.query as { customerId?: string; pastDays: number; futureDays: number })));
  r.post('/portal/visits/:id/acknowledge', { preHandler: act, schema: { tags, params: idParam, body: S.acknowledgeBody } }, h((ctx, req) => svc.acknowledgePortalVisit(ctx, (req.params as { id: string }).id, req.body as S.AcknowledgeBody)));

  // ---- reports
  r.get('/portal/reports', { preHandler: read, schema: { tags, querystring: S.previewQuery } }, h((ctx, req) => svc.portalReports(ctx, q(req).customerId)));

  // ---- known errors (the organisation's published entries, customer wording only; literal /suggest before /:id)
  r.get('/portal/known-errors', { preHandler: read, schema: { tags, querystring: KE.portalListQuerySchema } }, h((ctx, req) => kedb.listPortalKnownErrors(ctx, req.query as KE.PortalListQuery)));
  r.get('/portal/known-errors/suggest', { preHandler: read, schema: { tags, querystring: KE.portalSuggestQuerySchema } }, h((ctx, req) => kedb.suggestPortalKnownErrors(ctx, req.query as KE.PortalSuggestQuery)));
  r.get('/portal/known-errors/:id', { preHandler: read, schema: { tags, params: idParam, querystring: S.previewQuery } }, h((ctx, req) => kedb.getPortalKnownError(ctx, (req.params as { id: string }).id, q(req).customerId)));

  // ---- users (customer administrators)
  r.get('/portal/users', { preHandler: read, schema: { tags, querystring: S.userListQuery } }, h((ctx, req) => svc.listPortalUsers(ctx, req.query as S.UserListQuery)));
  r.post('/portal/users', { preHandler: act, schema: { tags, body: S.createUserBody } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return svc.createPortalUser(ctx, req.body as S.CreateUserBody);
  }));
  r.patch('/portal/users/:id', { preHandler: act, schema: { tags, params: idParam, body: S.updateUserBody } }, h((ctx, req) => svc.updatePortalUser(ctx, (req.params as { id: string }).id, req.body as S.UpdateUserBody)));
  r.post('/portal/users/:id/reset-password', { preHandler: act, schema: { tags, params: idParam } }, h((ctx, req) => svc.resetPortalUserPassword(ctx, (req.params as { id: string }).id)));
}
