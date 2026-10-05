import type { ReportColumn } from '../registry';
import { DOC } from './tokens';

/** Value formatting shared by the CSV, HTML and Excel renderers (kept apart from render.ts so the document module has no import cycle). */

export const HTML_MAX_ROWS = 2000;
/** Tables with more columns than this print on landscape pages. */
export const WIDE_COLUMNS = 9;

const pad = (n: number) => String(n).padStart(2, '0');

export function formatValue(v: unknown, type?: ReportColumn['type']): string {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'date') {
    const d = v instanceof Date ? v : new Date(String(v).length === 10 ? `${v}T00:00:00Z` : String(v));
    return isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
  }
  if (type === 'datetime') {
    const d = v instanceof Date ? v : new Date(String(v));
    return isNaN(d.getTime()) ? String(v) : `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  }
  if (type === 'pct') return typeof v === 'number' ? `${Math.round(v * 10) / 10}%` : String(v);
  if (type === 'minutes') {
    const m = Math.round(Number(v));
    if (isNaN(m)) return String(v);
    if (Math.abs(m) < 60) return `${m}m`;
    const h = Math.floor(Math.abs(m) / 60);
    const rem = Math.abs(m) % 60;
    return `${m < 0 ? '-' : ''}${h < 24 ? `${h}h${rem ? ` ${rem}m` : ''}` : `${Math.floor(h / 24)}d ${h % 24}h`}`;
  }
  if (type === 'boolean' || typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (type === 'number' && typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** A brand colour from settings, or the Progression navy when the value is not a hex colour. */
export const brandColor = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toLowerCase() : DOC.navy);
/** An accent colour from settings, or the Progression red when the value is not a hex colour. */
export const accentColor = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toLowerCase() : DOC.red);
/** A logo URL from settings: https or an inline image only (the HTML is opened by Chromium and by mail clients). */
export const logoUrl = (v: unknown) => (typeof v === 'string' && /^(https:\/\/[^\s"'<>]{1,2000}|data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]{1,400000})$/.test(v.trim()) ? v.trim() : null);

export const isNumericColumn = (c: ReportColumn) => c.type === 'number' || c.type === 'pct' || c.type === 'minutes';
