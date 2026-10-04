#!/usr/bin/env node
/**
 * Rasterises the Progression mark (apps/web/public/mark.svg) into the favicon set:
 *   favicon-16.png, favicon-32.png (transparent), favicon.ico (16 + 32, PNG-compressed entries),
 *   apple-touch-icon.png (180, mark on white, no transparency), icon-192.png, icon-512.png (transparent).
 * Needs a Chromium through Playwright: `npx playwright install chromium`, or point PLAYWRIGHT_MODULE at an
 * installed copy and PLAYWRIGHT_CHROMIUM at a Chromium binary. Run from the repository root:
 *   node apps/web/scripts/make-icons.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const pub = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const svg = readFileSync(resolve(pub, 'mark.svg'), 'utf8');
const data = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');

/** Windows ICO container with PNG-compressed entries (accepted by every current browser and by Windows Vista+). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const entries = []; const blobs = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, png } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size === 256 ? 0 : size; e[1] = size === 256 ? 0 : size; e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12);
    entries.push(e); blobs.push(png); offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined, args: ['--no-sandbox'] });
async function render(size, { background, scale = 1 } = {}) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const inner = Math.round(size * scale);
  await page.setContent(`<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;background:${background ?? 'transparent'};display:flex;align-items:center;justify-content:center"><img src="${data}" width="${inner}" height="${inner}" style="display:block"></body></html>`);
  const png = await page.screenshot({ omitBackground: !background, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  return png;
}
const out = {};
out['favicon-16.png'] = await render(16);
out['favicon-32.png'] = await render(32);
out['icon-192.png'] = await render(192);
out['icon-512.png'] = await render(512);
out['apple-touch-icon.png'] = await render(180, { background: '#ffffff', scale: 0.7 }); // iOS rounds the corners itself; no transparency allowed
out['favicon.ico'] = ico([{ size: 16, png: out['favicon-16.png'] }, { size: 32, png: out['favicon-32.png'] }]);
await browser.close();
const target = process.env.ICONS_OUT ?? pub;
for (const [name, buf] of Object.entries(out)) { writeFileSync(resolve(target, name), buf); console.log(`${name}\t${buf.length} bytes`); }
