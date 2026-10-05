import { ArrowDown, ArrowUp, RotateCcw } from 'lucide-react';
import { Avatar, Button, Dialog, Input, Toggle } from '@/components/ui';
import { cn } from '@/lib/utils';
import { laneDot } from './BoardLane';
import type { BoardLane } from './api';

/**
 * The Lanes dialog: reorder, show or hide, collapse and set a WIP limit per lane. Every
 * change applies at once (the board behind the dialog follows) and is saved with the
 * person's board layout.
 */
export function LanesDialog({ open, onClose, lanes, hidden, collapsed, limits, onReorder, onToggleHidden, onToggleCollapsed, onLimit, onReset }: { open: boolean; onClose: () => void; lanes: BoardLane[]; hidden: Set<string>; collapsed: Set<string>; limits: Record<string, number>; onReorder: (keys: string[]) => void; onToggleHidden: (key: string) => void; onToggleCollapsed: (key: string) => void; onLimit: (key: string, limit: number) => void; onReset: () => void }) {
  const move = (i: number, dir: -1 | 1) => {
    const keys = lanes.map((l) => l.key);
    const j = i + dir;
    if (j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j]!, keys[i]!];
    onReorder(keys);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Lanes"
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={onReset}>
            Reset to default
          </Button>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <p className="text-[12.5px] text-muted mb-3">Order, show, collapse and cap each lane. A WIP limit only marks the lane (amber at the limit, red over it); nothing is blocked. The layout is yours and is remembered.</p>
      {lanes.length === 0 ? (
        <div className="text-[13px] text-subtle py-6 text-center">No lanes on this board yet.</div>
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--border)]" data-testid="lanes-dialog">
          {lanes.map((lane, i) => {
            const isHidden = hidden.has(lane.key);
            return (
              <li key={lane.key} className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 py-2', isHidden && 'opacity-60')} data-lane-row={lane.key}>
                <span className="flex items-center gap-2 min-w-0 flex-1 basis-40">
                  {lane.kind === 'assignee' ? lane.key === 'unassigned' ? <span className="h-5 w-5 rounded-full border border-dashed border-strong shrink-0" aria-hidden /> : <Avatar name={lane.label} size="xs" /> : <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', laneDot(lane))} aria-hidden />}
                  <span className="text-[13px] font-medium text-default truncate">{lane.label}</span>
                  <span className="tnum text-[11.5px] text-subtle">{lane.count}</span>
                </span>
                <span className="flex items-center gap-0.5">
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="h-7 w-7 rounded-md inline-flex items-center justify-center text-muted hover:text-default hover:bg-surface-2 disabled:opacity-30" aria-label={`Move ${lane.label} up`}>
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === lanes.length - 1} className="h-7 w-7 rounded-md inline-flex items-center justify-center text-muted hover:text-default hover:bg-surface-2 disabled:opacity-30" aria-label={`Move ${lane.label} down`}>
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                </span>
                <Toggle checked={!isHidden} onChange={() => onToggleHidden(lane.key)} label={<span className="text-[12.5px] text-muted w-12">{isHidden ? 'Hidden' : 'Shown'}</span>} />
                <Toggle checked={collapsed.has(lane.key)} onChange={() => onToggleCollapsed(lane.key)} label={<span className="text-[12.5px] text-muted w-16">Collapsed</span>} />
                <label className="flex items-center gap-1.5 text-[12.5px] text-muted">
                  WIP
                  <Input type="number" min={0} max={999} value={limits[lane.key] ?? ''} placeholder={lane.limit ? String(lane.limit) : '—'} onChange={(e) => onLimit(lane.key, Math.max(0, Math.round(Number(e.target.value) || 0)))} className="w-16 h-7 py-0 text-[12.5px]" aria-label={`WIP limit for ${lane.label}`} />
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
