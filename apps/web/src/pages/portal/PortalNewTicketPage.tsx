import { PageHeader, EmptyState } from '@/components/ui';

export default function Page() {
  return (
    <div>
      <PageHeader title="Raise a ticket" />
      <EmptyState title="Raise a ticket" description="This area is being built." />
    </div>
  );
}
