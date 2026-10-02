import { PageHeader, EmptyState } from '@/components/ui';

export default function Page() {
  return (
    <div>
      <PageHeader title="Tickets" />
      <EmptyState title="Tickets" description="This area is being built." />
    </div>
  );
}
