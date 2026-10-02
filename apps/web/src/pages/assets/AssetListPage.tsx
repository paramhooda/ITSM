import { PageHeader, EmptyState } from '@/components/ui';

export default function Page() {
  return (
    <div>
      <PageHeader title="Assets" />
      <EmptyState title="Assets" description="This area is being built." />
    </div>
  );
}
