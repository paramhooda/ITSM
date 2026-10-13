import Handlebars from 'handlebars';

const hb = Handlebars.create();
hb.registerHelper('date', (v: unknown) => (v ? new Date(v as string).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) + ' UTC' : ''));
hb.registerHelper('upper', (v: unknown) => String(v ?? '').toUpperCase());
hb.registerHelper('default', (v: unknown, d: unknown) => (v === undefined || v === null || v === '' ? d : v));
hb.registerHelper('eq', (a: unknown, b: unknown) => a === b);

const cache = new Map<string, HandlebarsTemplateDelegate>();
const textCache = new Map<string, HandlebarsTemplateDelegate>();

function compiled(store: Map<string, HandlebarsTemplateDelegate>, template: string, noEscape: boolean) {
  let fn = store.get(template);
  if (!fn) {
    fn = hb.compile(template, { noEscape });
    if (store.size > 500) store.clear();
    store.set(template, fn);
  }
  return fn;
}

/** Renders an HTML template: every value is escaped (the email body). */
export function render(template: string, data: Record<string, unknown>): string {
  return compiled(cache, template, false)(data);
}

/** Renders a plain-text template: nothing is escaped (an email subject, a WhatsApp message), so an apostrophe stays an apostrophe. */
export function renderText(template: string, data: Record<string, unknown>): string {
  return compiled(textCache, template, true)(data);
}

export const escapeHtml = (s: string) => Handlebars.Utils.escapeExpression(s);

/** Minimal HTML email wrapper used by all notifications. */
export function emailLayout(title: string, bodyHtml: string, footer = 'This message was sent by Progression Service Management.') {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1f2933">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e4e7eb;overflow:hidden">
<div style="padding:16px 24px;background:#0a1f3d;color:#fff;font-weight:600;font-size:16px">${escapeHtml(title)}</div>
<div style="padding:24px;font-size:14px;line-height:1.55">${bodyHtml}</div>
<div style="padding:12px 24px;background:#f8fafc;color:#64748b;font-size:12px">${escapeHtml(footer)}</div>
</div></body></html>`;
}
