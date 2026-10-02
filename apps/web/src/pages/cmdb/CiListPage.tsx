import { PageHeader, EmptyState } from '@/components/ui';

export default function Page() {
  return (
    <div>
      <PageHeader title="CMDB" />
      <EmptyState title="CMDB" description="This area is being built." />
    </div>
  );
}
