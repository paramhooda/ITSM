import { PageHeader, EmptyState } from '@/components/ui';

export default function Page() {
  return (
    <div>
      <PageHeader title="Users" />
      <EmptyState title="Users" description="This area is being built." />
    </div>
  );
}
