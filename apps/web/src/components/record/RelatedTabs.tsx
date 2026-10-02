import type { ReactNode } from 'react';
import { Tabs } from '@/components/ui';
import { useListState } from '@/hooks/useListState';
import { cn } from '@/lib/utils';

export interface RelatedTab {
  key: string;
  label: ReactNode;
  count?: number | null;
  content: ReactNode;
  hidden?: boolean;
}

/**
 * Related lists under the form, ServiceNow style: one tab strip, the active list below,
 * the choice kept in the URL (`?tab=`) so links and refreshes land on the same list.
 */
export function RelatedTabs({ tabs, param = 'tab', defaultTab, className }: { tabs: RelatedTab[]; param?: string; defaultTab?: string; className?: string }) {
  const visible = tabs.filter((t) => !t.hidden);
  const { state, set } = useListState({ [param]: defaultTab ?? visible[0]?.key ?? '' });
  if (!visible.length) return null;
  const current = visible.find((t) => t.key === state[param]) ?? visible[0]!;
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <Tabs tabs={visible.map((t) => ({ key: t.key, label: t.label, count: t.count ?? undefined }))} value={current.key} onChange={(k) => set({ [param]: k, page: undefined }, false)} />
      <div className="min-w-0">{current.content}</div>
    </div>
  );
}
