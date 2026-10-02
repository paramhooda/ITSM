import { useState } from 'react';
import { ChevronRight, ChevronDown, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';

/** Compact collapsible JSON tree for event payloads (no external dependency). */
function Node({ name, value, depth, defaultOpen }: { name?: string; value: unknown; depth: number; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const isObj = value !== null && typeof value === 'object';
  const entries = isObj ? (Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>)) : [];
  const label = name !== undefined && <span className="text-purple-700">{name}</span>;
  if (!isObj) {
    const cls = typeof value === 'string' ? 'text-emerald-700' : typeof value === 'number' ? 'text-blue-700' : 'text-amber-700';
    const text = typeof value === 'string' ? JSON.stringify(value) : String(value);
    return (
      <div className="whitespace-pre-wrap break-all" style={{ paddingLeft: depth * 14 }}>
        {label}
        {name !== undefined && <span className="text-subtle">: </span>}
        <span className={cls}>{text}</span>
      </div>
    );
  }
  const bracket = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return (
    <div>
      <button type="button" className="flex items-center gap-0.5 hover:bg-surface-2 rounded px-0.5 -mx-0.5" style={{ paddingLeft: depth * 14 }} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown className="h-3 w-3 text-subtle" /> : <ChevronRight className="h-3 w-3 text-subtle" />}
        {label}
        {name !== undefined && <span className="text-subtle">: </span>}
        <span className="text-subtle">
          {bracket[0]}
          {!open && ` ${entries.length} ${entries.length === 1 ? 'item' : 'items'} `}
          {!open && bracket[1]}
        </span>
      </button>
      {open && entries.map(([k, v]) => <Node key={k} name={k} value={v} depth={depth + 1} defaultOpen={depth < 1} />)}
      {open && (
        <div className="text-subtle" style={{ paddingLeft: depth * 14 + 14 }}>
          {bracket[1]}
        </div>
      )}
    </div>
  );
}

export function JsonView({ value, className, maxHeight = 'max-h-96' }: { value: unknown; className?: string; maxHeight?: string }) {
  const [raw, setRaw] = useState(false);
  const text = (() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  })();
  return (
    <div className={cn('rounded-lg border border-default bg-surface-2/60', className)}>
      <div className="flex items-center justify-end gap-1 px-2 py-1 border-b border-default">
        <Button variant="ghost" size="sm" onClick={() => setRaw((r) => !r)}>
          {raw ? 'Tree' : 'Raw'}
        </Button>
        <Button variant="ghost" size="sm" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => { void navigator.clipboard?.writeText(text); toast.success('Copied'); }}>
          Copy
        </Button>
      </div>
      <div className={cn('overflow-auto p-2 font-mono text-[12px] leading-5', maxHeight)}>{raw ? <pre className="whitespace-pre-wrap break-all">{text}</pre> : <Node value={value} depth={0} defaultOpen />}</div>
    </div>
  );
}
