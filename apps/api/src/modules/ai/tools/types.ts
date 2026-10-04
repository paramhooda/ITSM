import type { z } from 'zod';
import type { Permission } from '@itsm/shared';
import type { Ctx } from '@/core/context';

/** What a tool's availability check needs: the principal and its permission check (no database). */
export type Who = Pick<Ctx, 'user' | 'can'>;

/**
 * How much a tool can change, and therefore when it may run:
 * read: freely · write_low: internal, low-risk (auto-applied only under autonomy auto_low) ·
 * write: needs confirmation · outbound: reaches people outside the platform, always confirmed ·
 * admin: configuration, always confirmed · destructive: removes or cancels, always confirmed and the preview states the count.
 */
export type ToolTier = 'read' | 'write_low' | 'write' | 'outbound' | 'admin' | 'destructive';

/** Toolsets group tools by module; the model sees the core set plus the sets that fit the page, the message and the skill. */
export const TOOLSET_KEYS = ['core', 'ui', 'tickets', 'triage', 'incident', 'approvals', 'customers', 'contracts', 'cmdb', 'assets', 'field', 'knowledge', 'reports', 'config', 'admin', 'iam'] as const;
export type ToolsetKey = (typeof TOOLSET_KEYS)[number];

/** What the user is shown before confirming: one sentence, optionally the exact changes and a count for bulk or destructive actions. */
export interface PreviewDetail {
  text: string;
  lines?: string[];
  count?: number;
}

export interface AiTool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  toolset: ToolsetKey;
  inputSchema: S;
  /** Defaults to 'write' for action tools and 'read' otherwise. */
  tier?: ToolTier;
  /** MSP users: every listed permission is required. */
  requires: Permission[];
  /** MSP users: additionally, at least one of these (for pages that open with "any of" permissions). */
  anyOf?: Permission[];
  /** Customer (portal) users: permissions required, or `null` when the tool is not offered in the portal. */
  portal: Permission[] | null;
  /** Never offered to MSP staff (self-service actions such as acknowledging a visit as the customer). */
  portalOnly?: boolean;
  /** Mutates data: requires `ai:act`; never runs until the user has confirmed the preview (propose-then-commit). */
  action: boolean;
  /** Kept for compatibility but no longer offered to the model (superseded by a better tool). */
  hidden?: boolean;
  /** Web query caches to refresh after this action ran. */
  invalidates?: ('tickets' | 'approvals' | 'visits' | 'knowledge' | 'config' | 'cmdb' | 'assets' | 'contracts' | 'announcements' | 'changes')[];
  run(ctx: Ctx, input: z.infer<S>): Promise<unknown>;
  /** One-line description shown in the conversation ("Listed 5 open tickets for Sample Customer"). */
  summary(input: z.infer<S>, result: unknown): string;
  /** Action tools: what exactly will happen, resolved against real records, shown to the user before they confirm. */
  preview?(ctx: Ctx, input: z.infer<S>): Promise<string | PreviewDetail>;
}

export const define = <S extends z.ZodTypeAny>(t: AiTool<S>): AiTool => t as unknown as AiTool;
export const tierOf = (t: AiTool): ToolTier => t.tier ?? (t.action ? 'write' : 'read');
export const previewText = (p: string | PreviewDetail): string => (typeof p === 'string' ? p : p.text);
export const previewDetail = (p: string | PreviewDetail): PreviewDetail => (typeof p === 'string' ? { text: p } : p);
