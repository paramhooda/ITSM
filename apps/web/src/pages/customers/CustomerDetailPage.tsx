import { PageHeader, EmptyState } from '@/components/ui';

export default function Page() {
  return (
    <div>
      <PageHeader title="Customer" />
      <EmptyState title="Customer" description="This area is being built." />
    </div>
  );
}
