import { PageHeader, EmptyState } from '@/components/ui';

export default function Page() {
  return (
    <div>
      <PageHeader title="Field service" />
      <EmptyState title="Field service" description="This area is being built." />
    </div>
  );
}
