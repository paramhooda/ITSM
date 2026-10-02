/**
 * Small, dependency-free CSV reader for imports (RFC 4180-ish): handles quoted
 * fields, escaped quotes (""), embedded newlines, CRLF, a UTF-8 BOM and both
 * comma and semicolon delimiters (auto-detected from the header line).
 */
export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseCsv(input: string | Buffer, opts: { maxRows?: number } = {}): CsvTable {
  let text = Buffer.isBuffer(input) ? input.toString('utf8') : input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';

  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      records.push(row);
      row = [];
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    records.push(row);
  }
  const nonEmpty = records.filter((r) => r.some((v) => v.trim() !== ''));
  if (!nonEmpty.length) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map((h) => h.trim());
  const max = opts.maxRows ?? 20_000;
  const rows: Record<string, string>[] = [];
  for (const rec of nonEmpty.slice(1, max + 1)) {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => (obj[h] = (rec[idx] ?? '').trim()));
    rows.push(obj);
  }
  return { headers, rows };
}

/** Case/space-insensitive header lookup: "Serial Number" == "serialNumber" == "serial_number". */
export function headerIndex(headers: string[]) {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_\-]/g, '');
  const map = new Map<string, string>();
  for (const h of headers) map.set(norm(h), h);
  return (name: string) => map.get(norm(name));
}

export function rowValue(row: Record<string, string>, idx: (n: string) => string | undefined, name: string): string | undefined {
  const h = idx(name);
  if (!h) return undefined;
  const v = row[h];
  return v === undefined || v === '' ? undefined : v;
}

export const CSV_LIMITS = { maxBytes: 10 * 1024 * 1024, maxRows: 20_000 };
