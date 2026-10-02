import { PageHeader, EmptyState } from '@/components/ui';

export default function Page() {
  return (
    <div>
      <PageHeader title="New ticket" />
      <EmptyState title="New ticket" description="This area is being built." />
    </div>
  );
}
