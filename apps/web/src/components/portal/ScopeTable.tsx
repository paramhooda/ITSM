import { ShieldCheck, ShieldOff } from 'lucide-react';
import { EmptyState } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { ScopeGroup } from './api';

function ScopeBadge({ classification }: { classification: string }) {
  const inScope = classification === 'in_scope';
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11.5px] font-medium whitespace-nowrap', inScope ? 'border-emerald-200 text-emerald-700 bg-emerald-50' : 'border-rose-200 text-rose-700 bg-rose-50')}>
      {inScope ? <ShieldCheck className="h-3 w-3" /> : <ShieldOff className="h-3 w-3" />}
      {inScope ? 'Included' : 'Not included'}
    </span>
  );
}

/** Scope items grouped by header with in/out badges, in plain language. */
export function ScopeTable({ groups }: { groups: ScopeGroup[] }) {
  if (!groups.length) return <EmptyState title="No scope definition yet" description="Your contract has no itemised scope. Ask your account manager if you need one." />;
  return (
    <div className="overflow-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Item</th>
            <th className="w-[130px]">Coverage</th>
            <th className="hidden md:table-cell">Applies to</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <GroupRows key={g.headerId ?? 'general'} group={g} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupRows({ group }: { group: ScopeGroup }) {
  return (
    <>
      <tr className="bg-surface-2/60">
        <td colSpan={3} className="text-[11.5px] uppercase tracking-wide text-subtle font-semibold py-1.5">
          {group.headerLabel}
        </td>
      </tr>
      {group.items.map((i) => {
        const applies = [i.serviceName, i.siteName, i.ciTypeName, i.ticketCategoryLabel].filter(Boolean).join(' · ');
        return (
          <tr key={i.id}>
            <td>
              <div className="text-[13px] font-medium">{i.name}</div>
              {i.description && <div className="text-[12px] text-muted">{i.description}</div>}
              {applies && <div className="md:hidden text-[11.5px] text-subtle mt-0.5">{applies}</div>}
            </td>
            <td>
              <ScopeBadge classification={i.classification} />
            </td>
            <td className="hidden md:table-cell text-[12.5px] text-muted">{applies || 'Everything under this contract'}</td>
          </tr>
        );
      })}
    </>
  );
}
