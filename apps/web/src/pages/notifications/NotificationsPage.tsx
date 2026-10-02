import { PageHeader, EmptyState } from '@/components/ui';

export default function Page() {
  return (
    <div>
      <PageHeader title="Notifications" />
      <EmptyState title="Notifications" description="This area is being built." />
    </div>
  );
}
