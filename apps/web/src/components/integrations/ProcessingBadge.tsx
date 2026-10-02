import { Badge } from '@/components/ui';
import type { ProcessingStatus } from './types';

export const PROCESSING_COLORS: Record<string, string> = { received: 'blue', correlated: 'teal', ticket_created: 'green', deduplicated: 'purple', ignored: 'gray', error: 'red' };
export const PROCESSING_LABELS: Record<string, string> = { received: 'Queued', correlated: 'Correlated', ticket_created: 'Ticket created', deduplicated: 'Deduplicated', ignored: 'Ignored', error: 'Needs attention' };

export function ProcessingBadge({ status, title }: { status: ProcessingStatus | string; title?: string | null }) {
  return (
    <Badge color={PROCESSING_COLORS[status] ?? 'slate'} title={title ?? undefined} dot={status === 'received'}>
      {PROCESSING_LABELS[status] ?? status}
    </Badge>
  );
}
