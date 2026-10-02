import { Component, lazy, Suspense, type ReactNode, type ComponentType } from 'react';
import { LoadingBlock } from '@/components/ui';

/**
 * Components owned by other modules (attachments, audit) are loaded lazily so a
 * broken or missing chunk degrades to the supplied fallback instead of taking
 * the whole page down.
 */
class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export interface AttachmentListProps {
  entityType: string;
  entityId: string;
  customerId?: string | null;
  canUpload?: boolean;
  canDelete?: boolean;
  showVisibility?: boolean;
  compact?: boolean;
  docTypes?: { value: string; label: string }[];
}

const AttachmentListLazy = lazy(() => import('@/components/attachments/AttachmentList').then((m) => ({ default: (m.AttachmentList ?? m.default) as ComponentType<AttachmentListProps> })));
const AuditTrailLazy = lazy(() => import('@/components/audit/AuditTrail').then((m) => ({ default: (m.AuditTrail ?? m.default) as ComponentType<{ entityType: string; entityId: string; compact?: boolean; limit?: number }> })));

export function OptionalAttachmentList({ fallback, ...props }: AttachmentListProps & { fallback: ReactNode }) {
  return (
    <Boundary fallback={fallback}>
      <Suspense fallback={<LoadingBlock />}>
        <AttachmentListLazy {...props} />
      </Suspense>
    </Boundary>
  );
}

export function OptionalAuditTrail({ fallback, ...props }: { entityType: string; entityId: string; compact?: boolean; limit?: number; fallback: ReactNode }) {
  return (
    <Boundary fallback={fallback}>
      <Suspense fallback={<LoadingBlock />}>
        <AuditTrailLazy {...props} />
      </Suspense>
    </Boundary>
  );
}
