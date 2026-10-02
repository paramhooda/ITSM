import { PageHeader, EmptyState } from '@/components/ui';

export default function Page() {
  return (
    <div>
      <PageHeader title="Dashboard" />
      <EmptyState title="Dashboard" description="This area is being built." />
    </div>
  );
}
