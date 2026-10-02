import { PageHeader, EmptyState } from '@/components/ui';

export default function Page() {
  return (
    <div>
      <PageHeader title="My tickets" />
      <EmptyState title="My tickets" description="This area is being built." />
    </div>
  );
}
