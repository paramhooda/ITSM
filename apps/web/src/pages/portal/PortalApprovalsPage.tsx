import { PageHeader, EmptyState } from '@/components/ui';

export default function Page() {
  return (
    <div>
      <PageHeader title="Approvals" />
      <EmptyState title="Approvals" description="This area is being built." />
    </div>
  );
}
