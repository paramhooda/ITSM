import { PageHeader, EmptyState } from '@/components/ui';

export default function Page() {
  return (
    <div>
      <PageHeader title="Field visit" />
      <EmptyState title="Field visit" description="This area is being built." />
    </div>
  );
}
