import { useQuery } from '@tanstack/react-query';
import { get } from '@/api/client';
import { LoadingBlock } from '@/components/ui';
import { cn } from '@/lib/utils';

export interface PermissionModule {
  module: string;
  permissions: { key: string; description: string }[];
}

export function usePermissionCatalog() {
  return useQuery({ queryKey: ['iam', 'permissions'], queryFn: () => get<{ modules: PermissionModule[] }>('/iam/permissions'), staleTime: 10 * 60_000 });
}

/** Permission checkboxes grouped by module with per-module "all" toggles. */
export function PermissionMatrix({ value, onChange, readOnly, userType, compact }: { value: string[]; onChange?: (v: string[]) => void; readOnly?: boolean; userType?: 'msp' | 'customer'; compact?: boolean }) {
  const { data, isLoading } = usePermissionCatalog();
  if (isLoading || !data) return <LoadingBlock />;
  const allowed = (key: string) => (userType === 'customer' ? key.startsWith('portal:') || key.startsWith('ai:') : true);
  const modules = data.modules.map((m) => ({ ...m, permissions: m.permissions.filter((p) => allowed(p.key)) })).filter((m) => m.permissions.length);
  const set = new Set(value);
  const toggle = (key: string) => {
    if (readOnly || !onChange) return;
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange([...next]);
  };
  const toggleModule = (m: PermissionModule) => {
    if (readOnly || !onChange) return;
    const keys = m.permissions.map((p) => p.key);
    const all = keys.every((k) => set.has(k));
    const next = new Set(set);
    keys.forEach((k) => (all ? next.delete(k) : next.add(k)));
    onChange([...next]);
  };
  return (
    <div className={cn('grid gap-3', compact ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2')}>
      {modules.map((m) => {
        const keys = m.permissions.map((p) => p.key);
        const count = keys.filter((k) => set.has(k)).length;
        return (
          <div key={m.module} className="rounded-lg border border-default">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-default bg-surface-2/60">
              <label className="flex items-center gap-2 text-[12.5px] font-semibold cursor-pointer select-none">
                <input type="checkbox" className="h-3.5 w-3.5 rounded border-default accent-brand-600" checked={count === keys.length} ref={(el) => {
                  if (el) el.indeterminate = count > 0 && count < keys.length;
                }} disabled={readOnly} onChange={() => toggleModule(m)} />
                {m.module}
              </label>
              <span className="text-[11px] text-subtle">
                {count}/{keys.length}
              </span>
            </div>
            <div className="p-1.5">
              {m.permissions.map((p) => (
                <label key={p.key} className={cn('flex items-start gap-2 rounded-md px-1.5 py-1 text-[12.5px]', !readOnly && 'hover:bg-surface-2 cursor-pointer')} title={p.description}>
                  <input type="checkbox" className="mt-0.5 h-3.5 w-3.5 rounded border-default accent-brand-600 shrink-0" checked={set.has(p.key)} disabled={readOnly} onChange={() => toggle(p.key)} />
                  <span className="min-w-0">
                    <span className="font-mono text-[11.5px]">{p.key}</span>
                    {!compact && <span className="block text-[11.5px] text-subtle leading-snug">{p.description}</span>}
                  </span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
