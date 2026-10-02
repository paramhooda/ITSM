import { ShieldCheck, ShieldOff, ShieldQuestion } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ScopeStatus } from './types';

const STYLES: Record<ScopeStatus, { label: string; cls: string; Icon: typeof ShieldCheck }> = {
  in_scope: { label: 'In scope', cls: 'border-emerald-200 text-emerald-700 bg-emerald-50', Icon: ShieldCheck },
  out_of_scope: { label: 'Out of scope', cls: 'border-rose-200 text-rose-700 bg-rose-50', Icon: ShieldOff },
  unknown: { label: 'Scope unknown', cls: 'border-default text-muted bg-surface-2', Icon: ShieldQuestion },
};

/** Subtle outlined chip; scope is informational and never blocks work. */
export function ScopeBadge({ status, detail, className, short, onClick, title }: { status: ScopeStatus; detail?: string | null; className?: string; short?: boolean; onClick?: () => void; title?: string }) {
  const s = STYLES[status] ?? STYLES.unknown;
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag onClick={onClick} title={title ?? detail ?? s.label} className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11.5px] font-medium whitespace-nowrap', s.cls, onClick && 'hover:brightness-95 cursor-pointer', className)}>
      <s.Icon className="h-3 w-3" />
      {short ? { in_scope: 'In', out_of_scope: 'Out', unknown: '?' }[status] : s.label}
      {detail && !short && <span className="font-normal opacity-80">· {detail}</span>}
    </Tag>
  );
}
