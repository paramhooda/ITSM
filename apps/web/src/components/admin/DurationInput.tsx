import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

/** Parses "4h", "2d", "30m", "1d 4h 30m", "90" (minutes) into minutes. Returns null when empty, NaN when invalid. */
export function parseDuration(text: string): number | null {
  const s = text.trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const re = /(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|w|week|weeks)\b/g;
  let total = 0;
  let matched = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    const u = m[2][0];
    total += u === 'w' ? n * 7 * 1440 : u === 'd' ? n * 1440 : u === 'h' ? n * 60 : n;
    matched += m[0];
  }
  if (!matched || matched.replace(/\s/g, '') !== s.replace(/\s/g, '')) return NaN;
  return Math.round(total);
}

/** Formats minutes compactly: 30m, 4h, 1d 4h, 2d. */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || isNaN(minutes)) return '';
  const m = Math.max(0, Math.round(minutes));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (mm || !parts.length) parts.push(`${mm}m`);
  return parts.join(' ');
}

/** Text input for durations in minutes; accepts 4h / 2d / 30m / 1d 4h / plain minutes. */
export function DurationInput({ value, onChange, placeholder = 'e.g. 4h', className, disabled, size = 'md', title }: { value: number | null; onChange: (minutes: number | null) => void; placeholder?: string; className?: string; disabled?: boolean; size?: 'sm' | 'md'; title?: string }) {
  const [text, setText] = useState(formatDuration(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(formatDuration(value));
    setInvalid(false);
  }, [value]);
  const commit = () => {
    const parsed = parseDuration(text);
    if (parsed !== null && isNaN(parsed)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (parsed !== value) onChange(parsed);
    setText(formatDuration(parsed));
  };
  return (
    <input
      type="text"
      title={title ?? (invalid ? 'Enter a duration like 4h, 2d or 30m' : undefined)}
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
      className={cn('input', size === 'sm' && 'py-1 px-2 text-[12.5px] h-7', invalid && 'border-red-500 focus:border-red-500', className)}
    />
  );
}
