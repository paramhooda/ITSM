import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';

export interface AuditEntry {
  entityType: string;
  entityId?: string | null;
  entityLabel?: string | null;
  action: string;
  customerId?: string | null;
  changes?: Record<string, { old: unknown; new: unknown }>;
  metadata?: Record<string, unknown>;
}

export interface AuditActor {
  userId: string | null;
  userName: string | null;
  source: string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export async function writeAudit(tx: Tx, actor: AuditActor, entry: AuditEntry) {
  await tx.insert(schema.auditLog).values({
    userId: actor.userId,
    userName: actor.userName,
    customerId: entry.customerId ?? null,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    entityLabel: entry.entityLabel ?? null,
    action: entry.action,
    changes: entry.changes ?? {},
    source: actor.source,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ? actor.userAgent.slice(0, 500) : null,
    requestId: actor.requestId ?? null,
    metadata: entry.metadata ?? {},
  });
}

/** Computes a {field: {old,new}} diff for audited updates (ignores unchanged + noisy fields). */
export function diffChanges(before: Record<string, unknown>, after: Record<string, unknown>, ignore: string[] = ['updatedAt', 'searchVector', 'lastActivityAt']) {
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (ignore.includes(key)) continue;
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changes[key] = { old: a ?? null, new: b ?? null };
  }
  return changes;
}

export const nowSql = sql`now()`;
