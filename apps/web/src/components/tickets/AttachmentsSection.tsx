import { Component, Suspense, lazy, type ReactNode } from 'react';
import { LoadingBlock } from '@/components/ui';

interface AttachmentListProps {
  entityType: string;
  entityId: string;
  customerId?: string | null;
  canUpload?: boolean;
  canDelete?: boolean;
  showVisibility?: boolean;
}

// The attachments module is built separately; load it lazily so this page still renders if it is missing.
const LazyAttachmentList = lazy(() =>
  import('@/components/attachments/AttachmentList')
    .then((m) => ({ default: (m.AttachmentList ?? m.default) as React.ComponentType<AttachmentListProps> }))
    .catch(() => ({ default: () => <div className="text-[12.5px] text-muted">Attachments are not available.</div> })),
);

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <div className="text-[12.5px] text-muted">Attachments could not be loaded.</div> : this.props.children;
  }
}

export function AttachmentsSection(props: AttachmentListProps) {
  return (
    <Boundary>
      <Suspense fallback={<LoadingBlock label="Loading attachments…" />}>
        <LazyAttachmentList {...props} />
      </Suspense>
    </Boundary>
  );
}
