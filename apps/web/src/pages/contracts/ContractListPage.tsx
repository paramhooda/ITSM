import { PageHeader, EmptyState } from '@/components/ui';

export default function Page() {
  return (
    <div>
      <PageHeader title="Contracts" />
      <EmptyState title="Contracts" description="This area is being built." />
    </div>
  );
}
