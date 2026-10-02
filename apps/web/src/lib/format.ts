const dtf = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const df = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function fmtDateTime(v?: string | Date | null) {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  return isNaN(d.getTime()) ? '—' : dtf.format(d);
}

export function fmtDate(v?: string | Date | null) {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v.length === 10 ? v + 'T00:00:00' : v) : v;
  return isNaN(d.getTime()) ? '—' : df.format(d);
}

export function relativeTime(v?: string | Date | null) {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  const diff = (d.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return fmtDate(d);
}

export function fmtDuration(minutes?: number | null) {
  if (minutes === null || minutes === undefined || isNaN(minutes)) return '—';
  const m = Math.round(Math.abs(minutes));
  const sign = minutes < 0 ? '-' : '';
  if (m < 60) return `${sign}${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return `${sign}${h}h${rem ? ` ${rem}m` : ''}`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return `${sign}${d}d${rh ? ` ${rh}h` : ''}`;
}

export function fmtNumber(n?: number | null, digits = 0) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(n);
}

export function fmtPct(n?: number | null, digits = 0) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(n)}%`;
}

export function fmtMoney(n?: number | string | null, currency = 'INR') {
  if (n === null || n === undefined || n === '') return '—';
  const v = typeof n === 'string' ? Number(n) : n;
  if (isNaN(v)) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);
}

export function fmtBytes(b?: number | null) {
  if (!b && b !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export const titleCase = (s?: string | null) => (s ? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '');
