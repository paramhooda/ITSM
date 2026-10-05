import { z } from 'zod';
import { TICKET_TYPES } from '@itsm/shared';
import { boolQ } from '@/modules/tickets/schemas';
import { BOARD_NOTE_COLORS } from '@/db/schema/boards';

const uuid = z.string().uuid();

export const boardKind = z.enum(['tickets', 'tasks']);
export const boardScope = z.enum(['mine', 'team', 'assignee', 'all']);
export const boardLanes = z.enum(['status', 'assignee']);
export const taskStatus = z.enum(['open', 'in_progress', 'done', 'cancelled']);
export const taskDue = z.enum(['overdue', 'today', 'week', 'any']);

export const ticketBoardQuery = z.object({
  scope: boardScope.default('mine'),
  teamId: uuid.optional(),
  assigneeId: uuid.optional(),
  lanes: boardLanes.default('status'),
  type: z.enum(TICKET_TYPES).optional(),
  customerId: uuid.optional(),
  priorityId: uuid.optional(),
  q: z.string().max(200).optional(),
  includeClosed: boolQ,
});
export type TicketBoardQuery = z.infer<typeof ticketBoardQuery>;

export const taskBoardQuery = z.object({
  scope: boardScope.default('mine'),
  teamId: uuid.optional(),
  assigneeId: uuid.optional(),
  lanes: boardLanes.default('status'),
  customerId: uuid.optional(),
  due: taskDue.default('any'),
  q: z.string().max(200).optional(),
  includeDone: boolQ,
});
export type TaskBoardQuery = z.infer<typeof taskBoardQuery>;

export const reorderBody = z.object({
  items: z.array(z.object({
    taskId: uuid,
    ticketId: uuid,
    status: taskStatus.optional(),
    sortOrder: z.number().int().min(0).max(100000),
  })).min(1).max(200),
});
export type ReorderItem = z.infer<typeof reorderBody>['items'][number];

export const handoverQuery = z.object({ teamId: uuid });

export const noteColor = z.enum(BOARD_NOTE_COLORS);
export const noteListQuery = z.object({ board: boardKind.default('tickets'), teamId: uuid.optional(), includeDone: boolQ });
export type NoteListQuery = z.infer<typeof noteListQuery>;
export const noteInput = z.object({
  board: boardKind.default('tickets'),
  teamId: uuid.nullable().optional(),
  body: z.string().trim().min(1).max(2000),
  color: noteColor.default('amber'),
  pinned: z.boolean().default(false),
});
export type NoteInput = z.infer<typeof noteInput>;
export const notePatch = z.object({
  body: z.string().trim().min(1).max(2000).optional(),
  color: noteColor.optional(),
  pinned: z.boolean().optional(),
  done: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
});
export type NotePatch = z.infer<typeof notePatch>;
