import { useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import { Upload, X } from 'lucide-react';
import { fmtBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { fileIcon } from './fileIcon';
import { addFiles } from './upload';

/** Files pasted from the clipboard (a screenshot, a copied file), if any. */
export function pastedFiles(e: ClipboardEvent<HTMLElement>): File[] {
  const list = e.clipboardData?.files;
  return list && list.length ? Array.from(list) : [];
}

/** Chosen-but-not-yet-uploaded files as removable chips. */
export function FileChips({ files, onRemove, disabled, className }: { files: File[]; onRemove?: (index: number) => void; disabled?: boolean; className?: string }) {
  if (!files.length) return null;
  return (
    <ul className={cn('flex flex-wrap gap-1.5', className)}>
      {files.map((f, i) => {
        const Icon = fileIcon(f.type, f.name);
        return (
          <li key={`${f.name}-${f.size}-${i}`} className="inline-flex items-center gap-1.5 rounded-md border border-default bg-surface-2 pl-2 pr-1 py-0.5 text-[12px] max-w-[260px]" title={f.name}>
            <Icon className="h-3.5 w-3.5 text-subtle shrink-0" />
            <span className="truncate">{f.name}</span>
            <span className="text-subtle tnum shrink-0">{fmtBytes(f.size)}</span>
            {onRemove && (
              <button type="button" onClick={() => onRemove(i)} disabled={disabled} aria-label={`Remove ${f.name}`} className="h-5 w-5 rounded flex items-center justify-center text-subtle hover:text-red-600 hover:bg-red-500/10 disabled:opacity-50">
                <X className="h-3 w-3" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Files chosen before the record exists (a new ticket): picked, dropped or pasted now, uploaded
 * once the record is created. The parent owns the list and uploads it.
 */
export function FilePicker({ files, onChange, disabled, hint, className, label = 'Add files' }: { files: File[]; onChange: (files: File[]) => void; disabled?: boolean; hint?: ReactNode; className?: string; label?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const add = (incoming: FileList | File[] | null | undefined) => {
    // Snapshot first: a FileList is live, and the input is cleared right after the change event.
    const picked = incoming ? Array.from(incoming) : [];
    if (picked.length) onChange(addFiles(files, picked));
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (!disabled) add(e.dataTransfer.files);
  };
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        data-testid="file-picker"
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !disabled) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onPaste={(e) => {
          const fs = pastedFiles(e);
          if (fs.length && !disabled) {
            e.preventDefault();
            add(fs);
          }
        }}
        onDragOver={(e) => {
          if (disabled) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn('rounded-lg border border-dashed px-3 py-3 text-center text-[12.5px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30', dragging ? 'border-brand-500 bg-brand-500/5 text-brand-700' : 'border-default text-muted hover:border-brand-400', disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer')}
      >
        <span className="inline-flex items-center gap-1.5">
          <Upload className="h-3.5 w-3.5" /> {label} <span className="text-subtle">· or drop files here</span>
        </span>
        {hint && <div className="text-[11.5px] text-subtle mt-0.5">{hint}</div>}
      </div>
      <input ref={inputRef} type="file" multiple className="hidden" disabled={disabled} onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
      <FileChips files={files} onRemove={disabled ? undefined : (i) => onChange(files.filter((_, j) => j !== i))} />
    </div>
  );
}
