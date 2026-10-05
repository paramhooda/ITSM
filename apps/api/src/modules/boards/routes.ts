import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { h } from '@/core/context';
import * as svc from './service';
import * as S from './schemas';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Task boards (staff only, tickets:read): the ticket board, the task board,
 * the task reorder, the shift handover panel and the person's own sticky
 * notes. Moving a card uses the ticket routes the record page uses
 * (status, assign, resolve, close, cancel, tasks), so the permission each
 * move needs is the one those routes already check.
 */
export default async function routes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['boards'];
  const read = app.auth('tickets:read');
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  r.get('/boards/tickets', { preHandler: read, schema: { tags, querystring: S.ticketBoardQuery } }, h((ctx, req) => svc.ticketBoard(ctx, req.query as S.TicketBoardQuery)));
  r.get('/boards/tasks', { preHandler: read, schema: { tags, querystring: S.taskBoardQuery } }, h((ctx, req) => svc.taskBoard(ctx, req.query as S.TaskBoardQuery)));
  r.post('/boards/tasks/reorder', { preHandler: app.auth('tickets:update'), schema: { tags, body: S.reorderBody } }, h((ctx, req) => svc.reorderTasks(ctx, (req.body as z.infer<typeof S.reorderBody>).items)));
  r.get('/boards/handover', { preHandler: read, schema: { tags, querystring: S.handoverQuery } }, h((ctx, req) => svc.handoverPanel(ctx, (req.query as z.infer<typeof S.handoverQuery>).teamId)));

  r.get('/boards/notes', { preHandler: read, schema: { tags, querystring: S.noteListQuery } }, h((ctx, req) => svc.listNotes(ctx, req.query as S.NoteListQuery)));
  r.post('/boards/notes', { preHandler: read, schema: { tags, body: S.noteInput } }, h(async (ctx, req, reply) => {
    reply.status(201);
    return svc.createNote(ctx, req.body as S.NoteInput);
  }));
  r.patch('/boards/notes/:id', { preHandler: read, schema: { tags, params: idParam, body: S.notePatch } }, h((ctx, req) => svc.updateNote(ctx, id(req), req.body as S.NotePatch)));
  r.delete('/boards/notes/:id', { preHandler: read, schema: { tags, params: idParam } }, h((ctx, req) => svc.deleteNote(ctx, id(req))));
}
