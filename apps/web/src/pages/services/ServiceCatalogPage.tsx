import { PageHeader, EmptyState } from '@/components/ui';

export default function Page() {
  return (
    <div>
      <PageHeader title="Service catalog" />
      <EmptyState title="Service catalog" description="This area is being built." />
    </div>
  );
}
