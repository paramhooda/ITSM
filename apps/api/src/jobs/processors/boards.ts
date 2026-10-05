import { registerProcessor, registerSchedule } from '../workers';
import { purgeDoneNotes } from '@/modules/boards/service';

/**
 * Task boards: every night at 03:40 the sticky notes marked done more than
 * `boards.note_retention_days` ago are removed from the boards.
 */
registerSchedule({ queue: 'maintenance', jobName: 'board-notes-purge', pattern: '40 3 * * *' });
registerProcessor({ queue: 'maintenance', jobName: 'board-notes-purge', concurrency: 1, processor: async () => purgeDoneNotes() });
