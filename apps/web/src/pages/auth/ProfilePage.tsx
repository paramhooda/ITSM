import { PageHeader, EmptyState } from '@/components/ui';

export default function Page() {
  return (
    <div>
      <PageHeader title="Profile" />
      <EmptyState title="Profile" description="This area is being built." />
    </div>
  );
}
