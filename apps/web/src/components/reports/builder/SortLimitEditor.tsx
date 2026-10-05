import { Field, Input, Select } from '@/components/ui';
import { Segmented } from '@/components/dashboards/Panel';

/** The sort key (a column, or a group field or aggregate when grouped), its direction and the row limit. */
export function SortLimitEditor({ keys, sort, rowLimit, maxRows, onSort, onLimit }: { keys: { value: string; label: string }[]; sort: { key: string; order: 'asc' | 'desc' } | null; rowLimit: number | null; maxRows: number; onSort: (s: { key: string; order: 'asc' | 'desc' } | null) => void; onLimit: (n: number | null) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-end">
        <Field label="Sort by">
          <Select value={sort?.key ?? ''} onChange={(e) => onSort(e.target.value ? { key: e.target.value, order: sort?.order ?? 'desc' } : null)} placeholder="Default order" options={keys} aria-label="Sort key" />
        </Field>
        {sort && <Segmented size="sm" value={sort.order} onChange={(order) => onSort({ ...sort, order })} options={[{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }]} />}
      </div>
      <Field label="Row limit" hint={`Leave empty for the platform cap of ${maxRows.toLocaleString('en-GB')} rows`}>
        <Input type="number" min={1} max={maxRows} value={rowLimit ?? ''} onChange={(e) => onLimit(e.target.value === '' ? null : Math.max(1, Math.min(maxRows, Math.round(Number(e.target.value) || 1))))} placeholder={String(maxRows)} aria-label="Row limit" />
      </Field>
    </div>
  );
}
