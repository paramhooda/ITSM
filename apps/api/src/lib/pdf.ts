import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '@/config';
import { logger } from '@/core/logger';

/**
 * HTML → PDF through the Chromium binary that ships in the container (the
 * Playwright build), without a browser automation library: one process per
 * document, `--headless=new --print-to-pdf`, a 60-second limit, and one
 * render at a time in this process so a burst of downloads cannot exhaust
 * memory. `PDF_CHROMIUM_PATH` overrides the lookup; `pdfAvailable()` tells
 * the UI whether PDF output is on.
 */

const CANDIDATES = [
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
];
const TIMEOUT_MS = 60_000;

let resolved: string | null | undefined;

/** The first usable binary: the configured path, then the known locations. */
export async function chromiumPath(): Promise<string | null> {
  if (resolved !== undefined) return resolved;
  const candidates = [config.PDF_CHROMIUM_PATH, ...CANDIDATES].filter((p): p is string => !!p);
  for (const p of candidates) {
    try {
      await access(p);
      resolved = p;
      return p;
    } catch {
      /* next */
    }
  }
  resolved = null;
  return null;
}

export const pdfAvailable = async () => (await chromiumPath()) !== null;

/** Serialises renders: the previous one must finish before the next starts. */
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
};

export interface PdfOptions {
  /** Paper size; A4 by default. */
  paper?: 'A4' | 'Letter';
  landscape?: boolean;
}

/** Renders a self-contained HTML document to a PDF buffer. Throws when no Chromium is installed or the render fails. */
export function htmlToPdf(html: string, opts: PdfOptions = {}): Promise<Buffer> {
  return serial(async () => {
    const bin = await chromiumPath();
    if (!bin) throw new Error('PDF output needs Chromium (set PDF_CHROMIUM_PATH); see docs/OPERATIONS.md');
    const dir = await mkdtemp(join(tmpdir(), 'itsm-pdf-'));
    const input = join(dir, 'document.html');
    const output = join(dir, 'document.pdf');
    try {
      await writeFile(input, html, 'utf8');
      const args = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-pdf-header-footer', '--run-all-compositor-stages-before-draw', '--virtual-time-budget=5000', `--print-to-pdf=${output}`, `file://${input}`];
      if (opts.landscape) args.splice(1, 0, '--landscape');
      await new Promise<void>((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr?.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('PDF render timed out after 60 s'));
        }, TIMEOUT_MS);
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`Chromium exited with code ${code}: ${stderr.slice(-400)}`));
        });
      });
      return await readFile(output);
    } catch (err) {
      logger.warn({ err }, 'pdf render failed');
      throw err;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}
