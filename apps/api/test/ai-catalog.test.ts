import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ALL_TOOLS, ACTION_TOOLS, READ_TOOLS, toolJsonSchema, toolDefinitions, tierOf, toolAvailable, availableTools, availableToolsets, TOOLSET_KEYS, type Who } from '../src/modules/ai/tools';
import { TOOLSETS, SKILL_TOOLSETS, resolveToolsets, enableToolset, keywordToolsets, pageToolsets, BASE_SETS, MAX_EXTRA_SETS } from '../src/modules/ai/toolsets';
import { buildSystemPrompt, PROMPT_VERSION, SKILL_DEFS } from '../src/modules/ai/prompt';
import { SKILLS } from '../src/modules/ai/schemas';
import type { Principal } from '../src/core/principal';

/**
 * The tool catalogue, the toolset router and the prompt builder, checked
 * without a database: every tool is well formed, the router is deterministic,
 * and the stable prompt block carries nothing date- or user-specific.
 */

const principal = (over: Partial<Principal> & { perms: string[] }): Principal =>
  ({ id: '00000000-0000-0000-0000-000000000001', email: 'x@example.test', name: 'Test Person', userType: 'msp', customerId: null, customerScope: 'all', timezone: 'UTC', roles: [{ key: 'r', name: 'Role', customerId: null }], teams: [], permissions: over.perms, isSystem: false, apiKeyId: null, ...over }) as unknown as Principal;
const whoOf = (p: Principal): Who => ({ user: p, can: (perm) => (p as unknown as { permissions: string[] }).permissions.includes(perm) });
const staffPerms = ['ai:use', 'ai:act', 'tickets:read', 'tickets:create', 'tickets:update', 'tickets:assign', 'tickets:comment', 'tickets:work_notes', 'tickets:major', 'customers:read', 'contracts:read', 'cmdb:read', 'assets:read', 'field:read', 'pm:read', 'kb:read', 'reports:run', 'admin:config', 'admin:system', 'admin:users', 'admin:audit', 'dashboards:management', 'services:read'];
const admin = whoOf(principal({ perms: staffPerms }));
const portal = whoOf(principal({ userType: 'customer', customerId: '00000000-0000-0000-0000-0000000000aa', customerScope: ['00000000-0000-0000-0000-0000000000aa'], perms: ['ai:use', 'ai:act', 'portal:access', 'portal:tickets', 'portal:approve', 'portal:contracts', 'portal:assets', 'portal:reports'] } as never));

describe('tool catalogue', () => {
  it('every tool is well formed: unique snake_case name, known toolset and tier, declared permissions, a preview for actions, a JSON schema', () => {
    const names = new Set<string>();
    for (const t of ALL_TOOLS) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]{2,40}$/);
      expect(names.has(t.name), `duplicate ${t.name}`).toBe(false);
      names.add(t.name);
      expect(TOOLSET_KEYS).toContain(t.toolset);
      expect(['read', 'write_low', 'write', 'outbound', 'admin', 'destructive']).toContain(tierOf(t));
      if (!t.action) expect(tierOf(t)).toBe('read');
      if (t.action) expect(typeof t.preview, `${t.name} has no preview`).toBe('function');
      expect(Array.isArray(t.requires)).toBe(true);
      if (t.portal) for (const p of t.portal) expect(p, `${t.name} offers ${p} to the portal`).toMatch(/^(portal:|ai:)/);
      const js = toolJsonSchema(t.inputSchema);
      expect(js.type).toBe('object');
      expect(js.$schema).toBeUndefined();
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.description.length).toBeLessThan(700);
    }
    expect(READ_TOOLS.length + ACTION_TOOLS.length).toBe(ALL_TOOLS.length);
    expect(ALL_TOOLS.length).toBeGreaterThanOrEqual(100);
    expect(ACTION_TOOLS.length).toBeGreaterThanOrEqual(40);
  });

  it('definitions are emitted in registry order, so the same set always serialises to the same bytes', () => {
    const a = JSON.stringify(toolDefinitions(availableTools(admin)));
    const b = JSON.stringify(toolDefinitions(availableTools(admin)));
    expect(a).toBe(b);
    const subset = availableTools(admin, ['core', 'ui', 'tickets']);
    expect(subset.map((t) => t.name)).toEqual(ALL_TOOLS.filter((t) => !t.hidden && ['core', 'ui', 'tickets'].includes(t.toolset) && toolAvailable(admin, t)).map((t) => t.name));
  });

  it('portal users only get portal tools; staff never get portal-only tools; actions need ai:act', () => {
    const portalNames = availableTools(portal).map((t) => t.name);
    for (const n of portalNames) expect(ALL_TOOLS.find((t) => t.name === n)!.portal).not.toBeNull();
    expect(portalNames).toContain('confirm_resolution');
    expect(portalNames).toContain('acknowledge_visit');
    expect(portalNames).not.toContain('list_customers');
    expect(portalNames).not.toContain('update_setting');
    const adminNames = availableTools(admin).map((t) => t.name);
    expect(adminNames).not.toContain('confirm_resolution');
    expect(adminNames).not.toContain('acknowledge_visit');
    expect(adminNames).toContain('update_setting');
    const noAct = whoOf(principal({ perms: staffPerms.filter((p) => p !== 'ai:act') }));
    expect(availableTools(noAct).some((t) => t.action)).toBe(false);
    const noUse = whoOf(principal({ perms: staffPerms.filter((p) => p !== 'ai:use') }));
    expect(availableTools(noUse)).toEqual([]);
  });

  it('anyOf permissions open a tool to either role', () => {
    const settings = ALL_TOOLS.find((t) => t.name === 'get_settings')!;
    expect(toolAvailable(whoOf(principal({ perms: ['ai:use', 'admin:config'] })), settings)).toBe(true);
    expect(toolAvailable(whoOf(principal({ perms: ['ai:use', 'admin:system'] })), settings)).toBe(true);
    expect(toolAvailable(whoOf(principal({ perms: ['ai:use', 'tickets:read'] })), settings)).toBe(false);
  });

  it('UI tools never touch the database for navigation and the guide', async () => {
    const trap = new Proxy({}, { get: (_t, prop) => { throw new Error(`database access through ctx.${String(prop)}`); } });
    const ctx = { ...admin, tx: trap, requestId: 't', require: () => undefined, requireCustomer: () => undefined } as never;
    const navigate = ALL_TOOLS.find((t) => t.name === 'navigate')!;
    const res = (await navigate.run(ctx, { to: '/tickets?priority=p1&bogus=1' })) as { uiAction: { to: string }; ignoredFilters?: string[] };
    expect(res.uiAction.to).toBe('/tickets?priority=p1');
    expect(res.ignoredFilters).toEqual(['bogus']);
    const engineer = whoOf(principal({ perms: ['ai:use', 'tickets:read'] }));
    await expect(navigate.run({ ...engineer, tx: trap, requestId: 't' } as never, { to: '/admin/users' })).rejects.toThrow();
    await expect(navigate.run({ ...portal, tx: trap, requestId: 't' } as never, { to: '/tickets' })).rejects.toThrow();
    const guide = ALL_TOOLS.find((t) => t.name === 'app_guide')!;
    const g = (await guide.run(ctx, { question: 'where do I see major incidents' })) as { pages: { route: string | null }[] };
    expect(g.pages.some((p) => p.route === '/operations/major-incidents')).toBe(true);
  });
});

describe('toolset router', () => {
  it('always enables the base sets, adds the skill, page and keyword sets in that priority, and caps the extras', () => {
    const offered = availableToolsets(admin);
    expect(offered).toContain('core');
    expect(offered).toContain('admin');
    const s = resolveToolsets({ who: admin, message: 'declare a major incident for the outage and approve the change', page: '/customers/accounts', sticky: ['knowledge', 'assets', 'reports'], skill: 'triage' });
    expect(s.active.slice(0, 2)).toEqual(BASE_SETS);
    expect(s.active.length - BASE_SETS.length).toBeLessThanOrEqual(MAX_EXTRA_SETS);
    expect(s.active).toContain('tickets');
    expect(s.active).toContain('triage');
    expect(s.active).toContain('customers');
    expect(s.reasons.triage).toBe('skill triage');
    expect(s.reasons.customers).toBe('current page');
    const again = resolveToolsets({ who: admin, message: 'declare a major incident for the outage and approve the change', page: '/customers/accounts', sticky: ['knowledge', 'assets', 'reports'], skill: 'triage' });
    expect(again.active).toEqual(s.active);
  });

  it('routes keywords and pages deterministically and never offers a set the principal has no tools for', () => {
    expect(keywordToolsets('which contracts expire next month')).toContain('contracts');
    expect(keywordToolsets('is the core switch down')).toContain('cmdb');
    expect(pageToolsets('/tickets/123')).toEqual(['tickets', 'triage']);
    expect(pageToolsets('/nowhere')).toEqual([]);
    const p = resolveToolsets({ who: portal, message: 'change the assignment rule and list users', page: '/admin/users', sticky: ['admin'], skill: 'admin' });
    expect(p.active).not.toContain('admin');
    expect(p.active).not.toContain('iam');
    expect(availableToolsets(portal)).not.toContain('admin');
  });

  it('enable_toolset puts the requested set first so the cap never drops it', () => {
    let s = resolveToolsets({ who: admin, message: 'tickets customers contracts assets', page: null, sticky: null, skill: null });
    expect(s.active.length - BASE_SETS.length).toBe(MAX_EXTRA_SETS);
    s = enableToolset(s, 'field');
    expect(s.active[BASE_SETS.length]).toBe('field');
    expect(s.active.length - BASE_SETS.length).toBe(MAX_EXTRA_SETS);
    expect(enableToolset(s, 'core').active).toEqual(s.active);
    for (const k of Object.keys(SKILL_TOOLSETS)) expect(SKILLS).toContain(k);
    for (const k of TOOLSET_KEYS) expect(TOOLSETS[k].key).toBe(k);
  });
});

describe('prompt builder', () => {
  const build = (who: Who, over: Partial<Parameters<typeof buildSystemPrompt>[0]> = {}) => {
    const sets = resolveToolsets({ who, message: 'hello', page: null, sticky: null, skill: null });
    return buildSystemPrompt({ ctx: who, tools: availableTools(who, sets.active), toolsets: { active: sets.active, offered: sets.offered }, customerScopeSummary: 'all customers (MSP-wide)', today: new Date('2026-10-03T00:00:00Z'), ...over });
  };
  it('splits a stable block (identity, rules, style, playbooks) from a volatile one (context, capabilities), in a fixed order', () => {
    const p = build(admin);
    expect(p.version).toBe(PROMPT_VERSION);
    const order = ['You are Grady', '## Applications', '## Rules', '### Grounding', '### Authorisation', '### Confirmation tiers', '### Privacy and tenant', '### Untrusted content', '### Refusals and limits', '## How you answer', '## Skills (playbooks)'];
    let last = -1;
    for (const marker of order) {
      const i = p.stable.indexOf(marker);
      expect(i, marker).toBeGreaterThan(last);
      last = i;
    }
    expect(p.volatile.indexOf('## Operating context')).toBeLessThan(p.volatile.indexOf('## Capabilities this turn'));
    expect(p.stable).toMatch(/«data»/);
    expect(p.stable).not.toMatch(/api[_-]?key|secret/i);
    expect(p.volatile).not.toMatch(/api[_-]?key|secret/i);
  });

  it('keeps everything date-, user- and tool-specific out of the stable block', () => {
    const a = build(admin);
    const b = build(whoOf(principal({ name: 'Someone Else', timezone: 'Asia/Kolkata', perms: staffPerms })), { today: new Date('2030-01-01T00:00:00Z') });
    expect(a.stable).toBe(b.stable);
    expect(a.stable).not.toContain('2026-10-03');
    expect(a.stable).not.toContain('Test Person');
    expect(a.volatile).toContain('Today is 2026-10-03');
    expect(a.volatile).toContain('Test Person');
    expect(a.volatile).toContain('query_tickets');
    expect(a.stable).not.toContain('Capabilities this turn');
  });

  it('gives portal users the self-service playbook and the tenant rule, staff the triage, act, incident and admin playbooks', () => {
    const p = build(portal, { organisation: { name: 'Sample Org', code: 'SO' }, customerScopeSummary: "only Sample Org's own tickets" });
    expect(p.stable).toContain('### Self-service');
    expect(p.stable).not.toContain('### Triage');
    expect(p.stable).not.toContain('### Administer');
    expect(p.stable).toContain('Every answer is about that organisation only');
    expect(p.volatile).toContain('Sample Org (SO)');
    expect(p.volatile).toContain('Every answer is about Sample Org only');
    const s = build(admin);
    for (const title of ['### Triage', '### Act on tickets', '### Major incidents', '### Administer']) expect(s.stable).toContain(title);
    expect(s.stable).not.toContain('### Self-service');
    expect(SKILL_DEFS.map((d) => d.key).sort()).toEqual([...SKILLS].sort());
  });

  it('states autonomy, the active skill, the screen and the enablable groups in the volatile block', () => {
    const p = build(admin, { autonomy: 'auto_low', skill: 'triage', contextDescription: 'User is viewing ticket INC-000001', notes: ['The earlier proposal was not confirmed and is now cancelled.'] });
    expect(p.volatile).toContain('Autonomy: low-risk internal writes');
    expect(p.volatile).toContain('Active skill: Triage');
    expect(p.volatile).toContain('## Current screen');
    expect(p.volatile).toContain('INC-000001');
    expect(p.volatile).toContain('not confirmed and is now cancelled');
    expect(p.volatile).toMatch(/More groups you can enable with enable_toolset/);
    const noAct = build(whoOf(principal({ perms: staffPerms.filter((x) => x !== 'ai:act') })));
    expect(noAct.volatile).toContain('Actions: NOT enabled');
  });

  it('puts the WhatsApp channel note in the volatile block only, so the stable block is the same on both channels', () => {
    const web = build(admin);
    const wa = build(admin, { channel: 'whatsapp' });
    expect(wa.stable).toBe(web.stable);
    expect(wa.volatile).toContain('## Channel');
    expect(wa.volatile).toContain('Reply YES to go ahead or NO to drop it');
    expect(wa.volatile).toContain('never call navigate, open_record or prefill_form');
    expect(web.volatile).not.toContain('## Channel');
    expect(web.stable).toContain('When the Operating context says the channel is WhatsApp');
  });
});
