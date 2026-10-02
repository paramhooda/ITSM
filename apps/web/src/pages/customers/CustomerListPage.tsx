import { PageHeader, EmptyState } from '@/components/ui';

export default function Page() {
  return (
    <div>
      <PageHeader title="Customers" />
      <EmptyState title="Customers" description="This area is being built." />
    </div>
  );
}
