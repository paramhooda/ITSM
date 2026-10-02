import { PageHeader, EmptyState } from '@/components/ui';

export default function Page() {
  return (
    <div>
      <PageHeader title="Knowledge" />
      <EmptyState title="Knowledge" description="This area is being built." />
    </div>
  );
}
