import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { eq, and, desc } from 'drizzle-orm';
import type { Permission } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { storage, storageKeyFor, sha256Buffer } from '@/lib/storage';
import { config } from '@/config';
import { isCustomerUser } from '@/core/authz';

/**
 * Attachments are owned by a parent entity. Every operation resolves the
 * parent first (through the tenant-scoped transaction, so RLS already hides
 * other customers' rows) and derives the customer and the permissions from
 * it. This module is the most sensitive one for cross-customer leakage, so
 * the rules are explicit and fail closed.
 */
export const ATTACHMENT_ENTITY_TYPES = ['ticket', 'customer', 'contract', 'asset', 'ci', 'field_visit', 'kb_article', 'pm_occurrence', 'report_run', 'user'] as const;
export type AttachmentEntityType = (typeof ATTACHMENT_ENTITY_TYPES)[number];

export const DOC_TYPES = ['agreement', 'sow', 'report', 'photo', 'signature', 'other'] as const;
export type DocType = (typeof DOC_TYPES)[number];

const DANGEROUS_EXTENSIONS = new Set(['.exe', '.bat', '.cmd', '.ps1', '.sh', '.js', '.vbs', '.msi', '.dll', '.scr', '.jar', '.com', '.pif', '.cpl', '.hta', '.jse', '.wsf', '.wsh', '.msp', '.reg']);

/** Well-known extensions and the content types they may legitimately be declared as. */
const EXTENSION_TYPES: Record<string, string[]> = {
  '.png': ['image/png'],
  '.jpg': ['image/jpeg', 'image/jpg'],
  '.jpeg': ['image/jpeg', 'image/jpg'],
  '.gif': ['image/gif'],
  '.webp': ['image/webp'],
  '.svg': ['image/svg+xml'],
  '.bmp': ['image/bmp'],
  '.pdf': ['application/pdf'],
  '.txt': ['text/plain'],
  '.log': ['text/plain', 'text/x-log'],
  '.csv': ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'],
  '.json': ['application/json', 'text/plain'],
  '.xml': ['application/xml', 'text/xml', 'text/plain'],
  '.md': ['text/markdown', 'text/plain'],
  '.zip': ['application/zip', 'application/x-zip-compressed'],
  '.7z': ['application/x-7z-compressed'],
  '.gz': ['application/gzip', 'application/x-gzip'],
  '.tar': ['application/x-tar'],
  '.doc': ['application/msword'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.xls': ['application/vnd.ms-excel'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.ppt': ['application/vnd.ms-powerpoint'],
  '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  '.eml': ['message/rfc822'],
  '.msg': ['application/vnd.ms-outlook'],
  '.pcap': ['application/vnd.tcpdump.pcap', 'application/octet-stream'],
  '.mp4': ['video/mp4'],
  '.mov': ['video/quicktime'],
  '.mp3': ['audio/mpeg'],
  '.wav': ['audio/wav', 'audio/x-wav'],
};

/** Minimal magic-byte sniffing: enough to refuse executables and obvious mismatches. */
function sniff(buf: Buffer): string | null {
  if (buf.length < 4) return null;
  if (buf[0] === 0x4d && buf[1] === 0x5a) return 'application/x-msdownload'; // MZ (Windows PE)
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return 'application/x-elf';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return 'application/zip';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf[0] === 0x1f && buf[1] === 0x8b) return 'application/gzip';
  return null;
}

const ZIP_CONTAINER_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/java-archive',
]);

/** Validates filename, size, extension and content-type consistency. Returns the normalized content type. */
export function validateUpload(filename: string, declaredType: string | undefined, buffer: Buffer): string {
  const name = (filename ?? '').trim();
  if (!name) throw new ValidationError('A file name is required');
  if (name.length > 255) throw new ValidationError('File name is too long');
  if (buffer.length === 0) throw new ValidationError('The file is empty');
  const maxBytes = config.MAX_UPLOAD_MB * 1024 * 1024;
  if (buffer.length > maxBytes) throw new ValidationError(`File exceeds the maximum size of ${config.MAX_UPLOAD_MB} MB`);

  // Reject any dangerous extension anywhere in the name (report.pdf.exe, script.js).
  const lower = name.toLowerCase();
  const ext = path.extname(lower);
  if (DANGEROUS_EXTENSIONS.has(ext)) throw new ValidationError(`Files of type ${ext} are not allowed`);
  const parts = lower.split('.');
  for (const p of parts.slice(1)) if (DANGEROUS_EXTENSIONS.has(`.${p}`)) throw new ValidationError(`Files of type .${p} are not allowed`);

  const sniffed = sniff(buffer);
  if (sniffed === 'application/x-msdownload' || sniffed === 'application/x-elf') throw new ValidationError('Executable files are not allowed');

  const declared = (declaredType ?? '').split(';')[0].trim().toLowerCase();
  const expected = EXTENSION_TYPES[ext];
  let contentType = declared && declared !== 'application/octet-stream' ? declared : expected?.[0] ?? 'application/octet-stream';

  if (expected && declared && declared !== 'application/octet-stream' && !expected.includes(declared)) {
    throw new ValidationError(`Content type ${declared} does not match the file extension ${ext}`);
  }
  // Formats with unambiguous signatures must carry them: a "PNG" that does not start with the PNG header is not a PNG.
  const STRICT_SIGNATURES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
  if (STRICT_SIGNATURES.has(contentType) && sniffed !== contentType) {
    throw new ValidationError(`File content does not match the declared type ${contentType}`);
  }
  if (sniffed && sniffed !== 'application/zip' && sniffed !== 'application/gzip') {
    // Image/PDF signatures are unambiguous: declared type must agree.
    if (contentType !== sniffed && (contentType.startsWith('image/') || contentType === 'application/pdf' || sniffed === 'application/pdf' || sniffed.startsWith('image/'))) {
      throw new ValidationError(`File content (${sniffed}) does not match the declared type ${contentType}`);
    }
  }
  if (sniffed === 'application/zip' && (contentType.startsWith('image/') || contentType === 'application/pdf')) {
    throw new ValidationError(`File content does not match the declared type ${contentType}`);
  }
  if (sniffed === 'application/zip' && !ZIP_CONTAINER_TYPES.has(contentType) && contentType !== 'application/octet-stream' && !contentType.startsWith('application/vnd.')) {
    contentType = 'application/zip';
  }
  if (contentType === 'application/java-archive' || contentType === 'application/x-msdownload' || contentType === 'application/x-msdos-program') {
    throw new ValidationError('Executable files are not allowed');
  }
  return contentType;
}

// ---------------------------------------------------------------- access resolution

export interface EntityAccess {
  entityType: AttachmentEntityType;
  entityId: string;
  customerId: string | null;
  label: string;
  /** Caller may add attachments to this entity. */
  canUpload: boolean;
  /** Caller may manage (edit/delete) any attachment on this entity. */
  canManage: boolean;
  /** Caller is a customer (portal) user: only customer-visible attachments. */
  customerOnly: boolean;
}

interface Rule {
  read: Permission[];
  upload: Permission[];
  manage: Permission[];
  /** Permission that lets a portal user read customer-visible attachments of their own customer. */
  portalRead?: Permission;
  /** Portal users may upload (only tickets). */
  portalUpload?: boolean;
}

const RULES: Record<Exclude<AttachmentEntityType, 'user'>, Rule> = {
  ticket: { read: ['tickets:read'], upload: ['tickets:read'], manage: ['tickets:update'], portalRead: 'portal:tickets', portalUpload: true },
  customer: { read: ['customers:read'], upload: ['customers:manage'], manage: ['customers:manage'], portalRead: 'portal:contracts' },
  contract: { read: ['contracts:read'], upload: ['contracts:manage'], manage: ['contracts:manage'], portalRead: 'portal:contracts' },
  asset: { read: ['assets:read'], upload: ['assets:manage'], manage: ['assets:manage'], portalRead: 'portal:assets' },
  ci: { read: ['cmdb:read'], upload: ['cmdb:manage'], manage: ['cmdb:manage'], portalRead: 'portal:assets' },
  field_visit: { read: ['field:read', 'field:execute'], upload: ['field:execute', 'field:manage'], manage: ['field:manage'], portalRead: 'portal:access' },
  kb_article: { read: ['kb:read'], upload: ['kb:manage'], manage: ['kb:manage'], portalRead: 'portal:access' },
  pm_occurrence: { read: ['pm:read'], upload: ['pm:manage', 'field:execute'], manage: ['pm:manage'], portalRead: 'portal:access' },
  report_run: { read: ['reports:run'], upload: ['reports:run'], manage: ['reports:manage'], portalRead: 'portal:reports' },
};

type Resolved = { customerId: string | null; label: string; extra?: Record<string, unknown> } | null;

async function resolveEntity(ctx: Ctx, entityType: AttachmentEntityType, entityId: string): Promise<Resolved> {
  const tx = ctx.tx;
  switch (entityType) {
    case 'ticket': {
      const [r] = await tx.select({ id: schema.tickets.id, customerId: schema.tickets.customerId, number: schema.tickets.number, domain: schema.tickets.domain }).from(schema.tickets).where(eq(schema.tickets.id, entityId)).limit(1);
      return r ? { customerId: r.customerId, label: r.number, extra: { domain: r.domain } } : null;
    }
    case 'customer': {
      const [r] = await tx.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, entityId)).limit(1);
      return r ? { customerId: r.id, label: r.name } : null;
    }
    case 'contract': {
      const [r] = await tx.select({ id: schema.contracts.id, customerId: schema.contracts.customerId, number: schema.contracts.number }).from(schema.contracts).where(eq(schema.contracts.id, entityId)).limit(1);
      return r ? { customerId: r.customerId, label: r.number } : null;
    }
    case 'asset': {
      const [r] = await tx.select({ id: schema.assets.id, customerId: schema.assets.customerId, tag: schema.assets.tag }).from(schema.assets).where(eq(schema.assets.id, entityId)).limit(1);
      return r ? { customerId: r.customerId, label: r.tag } : null;
    }
    case 'ci': {
      const [r] = await tx.select({ id: schema.cis.id, customerId: schema.cis.customerId, name: schema.cis.name }).from(schema.cis).where(eq(schema.cis.id, entityId)).limit(1);
      return r ? { customerId: r.customerId, label: r.name } : null;
    }
    case 'field_visit': {
      const [r] = await tx.select({ id: schema.fieldVisits.id, customerId: schema.fieldVisits.customerId, number: schema.fieldVisits.number }).from(schema.fieldVisits).where(eq(schema.fieldVisits.id, entityId)).limit(1);
      return r ? { customerId: r.customerId, label: r.number } : null;
    }
    case 'kb_article': {
      const [r] = await tx.select({ id: schema.kbArticles.id, customerId: schema.kbArticles.customerId, number: schema.kbArticles.number, status: schema.kbArticles.status, visibility: schema.kbArticles.visibility }).from(schema.kbArticles).where(eq(schema.kbArticles.id, entityId)).limit(1);
      return r ? { customerId: r.customerId, label: r.number, extra: { status: r.status, visibility: r.visibility } } : null;
    }
    case 'pm_occurrence': {
      const [r] = await tx.select({ id: schema.pmOccurrences.id, customerId: schema.pmOccurrences.customerId, plannedDate: schema.pmOccurrences.plannedDate }).from(schema.pmOccurrences).where(eq(schema.pmOccurrences.id, entityId)).limit(1);
      return r ? { customerId: r.customerId, label: `PM ${r.plannedDate}` } : null;
    }
    case 'report_run': {
      const [r] = await tx.select({ id: schema.reportRuns.id, customerId: schema.reportRuns.customerId, name: schema.reportRuns.name, portalVisible: schema.reportRuns.portalVisible }).from(schema.reportRuns).where(eq(schema.reportRuns.id, entityId)).limit(1);
      return r ? { customerId: r.customerId, label: r.name, extra: { portalVisible: r.portalVisible } } : null;
    }
    case 'user': {
      const [r] = await tx.select({ id: schema.users.id, customerId: schema.users.customerId, name: schema.users.name }).from(schema.users).where(eq(schema.users.id, entityId)).limit(1);
      return r ? { customerId: r.customerId, label: r.name } : null;
    }
    default:
      return null;
  }
}

/**
 * Resolves the parent entity and the caller's rights on its attachments.
 * Throws NotFound when the entity does not exist or is not visible to the
 * caller (never reveals existence of other customers' records).
 */
export async function attachmentAccess(ctx: Ctx, entityType: string, entityId: string): Promise<EntityAccess> {
  if (!(ATTACHMENT_ENTITY_TYPES as readonly string[]).includes(entityType)) throw new ValidationError(`Unsupported entity type: ${entityType}`);
  const type = entityType as AttachmentEntityType;
  const p = ctx.user;
  const customer = isCustomerUser(p);
  const resolved = await resolveEntity(ctx, type, entityId);
  if (!resolved) throw new NotFoundError('Record');
  const { customerId, label, extra } = resolved;
  if (customerId && !ctx.canSeeCustomer(customerId)) throw new NotFoundError('Record');

  if (type === 'user') {
    const self = entityId === p.id;
    const admin = !customer && ctx.can('admin:users');
    if (!self && !admin) throw new NotFoundError('Record');
    return { entityType: type, entityId, customerId, label, canUpload: self || admin, canManage: self || admin, customerOnly: customer && !self };
  }

  const rule = RULES[type];

  if (customer) {
    // Portal users: only their own customer, only with the matching portal permission, and only customer-visible files.
    if (!rule.portalRead || !ctx.can(rule.portalRead, p.customerId)) throw new ForbiddenError();
    if (type === 'kb_article') {
      // Published public articles (shared rows) or published articles written for this customer.
      const ex = extra as { status: string; visibility: string };
      const own = ex.visibility === 'customer' && !!customerId && customerId === p.customerId;
      const pub = ex.visibility === 'public' && !customerId;
      if (ex.status !== 'published' || !(own || pub)) throw new NotFoundError('Record');
    } else if (!customerId || customerId !== p.customerId) {
      throw new NotFoundError('Record');
    }
    if (type === 'report_run' && !(extra as { portalVisible: boolean }).portalVisible) throw new NotFoundError('Record');
    return { entityType: type, entityId, customerId, label, canUpload: !!rule.portalUpload, canManage: false, customerOnly: true };
  }

  // MSP users
  if (type === 'ticket' && (extra as { domain: string }).domain === 'soc' && !ctx.can('soc:read', customerId)) throw new NotFoundError('Record');
  if (type === 'kb_article') {
    // Public/customer articles can be seen by any MSP KB reader; internal ones too (MSP side).
    const ex = extra as { status: string; visibility: string };
    const canRead = rule.read.some((perm) => ctx.can(perm, customerId));
    const canManage = rule.manage.some((perm) => ctx.can(perm, customerId));
    if (!canRead && !canManage) throw new ForbiddenError();
    if (ex.status === 'draft' && !canManage) throw new NotFoundError('Record');
  } else if (!rule.read.some((perm) => ctx.can(perm, customerId)) && !rule.manage.some((perm) => ctx.can(perm, customerId))) {
    throw new ForbiddenError();
  }
  const canManage = ctx.can('admin:system') || rule.manage.some((perm) => ctx.can(perm, customerId));
  const canUpload = canManage || rule.upload.some((perm) => ctx.can(perm, customerId));
  return { entityType: type, entityId, customerId, label, canUpload, canManage, customerOnly: false };
}

// ---------------------------------------------------------------- queries

const attachmentColumns = {
  id: schema.attachments.id,
  customerId: schema.attachments.customerId,
  entityType: schema.attachments.entityType,
  entityId: schema.attachments.entityId,
  filename: schema.attachments.filename,
  contentType: schema.attachments.contentType,
  size: schema.attachments.size,
  sha256: schema.attachments.sha256,
  docType: schema.attachments.docType,
  title: schema.attachments.title,
  customerVisible: schema.attachments.customerVisible,
  expiresAt: schema.attachments.expiresAt,
  uploadedBy: schema.attachments.uploadedBy,
  uploadedByName: schema.users.name,
  createdAt: schema.attachments.createdAt,
};

const UPLOADER_WINDOW_MS = 24 * 60 * 60 * 1000;

function decorate<T extends { uploadedBy: string | null; createdAt: Date }>(row: T, access: EntityAccess, userId: string) {
  const isUploader = !!row.uploadedBy && row.uploadedBy === userId;
  const recent = Date.now() - row.createdAt.getTime() < UPLOADER_WINDOW_MS;
  return { ...row, canDelete: access.canManage || (isUploader && recent), canEdit: access.canManage || isUploader };
}

/** Lists attachments of an entity after the parent access check. Customer users only see customer-visible files. */
export async function listAttachments(ctx: Ctx, entityType: string, entityId: string) {
  const access = await attachmentAccess(ctx, entityType, entityId);
  const conds = [eq(schema.attachments.entityType, access.entityType), eq(schema.attachments.entityId, entityId)];
  if (access.customerOnly) conds.push(eq(schema.attachments.customerVisible, true));
  const rows = await ctx.tx
    .select(attachmentColumns)
    .from(schema.attachments)
    .leftJoin(schema.users, eq(schema.users.id, schema.attachments.uploadedBy))
    .where(and(...conds))
    .orderBy(desc(schema.attachments.createdAt));
  return { items: rows.map((r) => decorate(r, access, ctx.user.id)), access: { canUpload: access.canUpload, canManage: access.canManage } };
}

async function loadWithAccess(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select(attachmentColumns).from(schema.attachments).leftJoin(schema.users, eq(schema.users.id, schema.attachments.uploadedBy)).where(eq(schema.attachments.id, id)).limit(1);
  if (!row) throw new NotFoundError('Attachment');
  const access = await attachmentAccess(ctx, row.entityType, row.entityId);
  if (access.customerOnly && !row.customerVisible) throw new NotFoundError('Attachment');
  // Defence in depth: the attachment row must agree with its parent on the customer.
  if (row.customerId && access.customerId && row.customerId !== access.customerId) throw new NotFoundError('Attachment');
  return { row, access };
}

export async function getAttachment(ctx: Ctx, id: string) {
  const { row, access } = await loadWithAccess(ctx, id);
  return decorate(row, access, ctx.user.id);
}

/** Returns the metadata plus a readable stream of the file content (after the access check). */
export async function openAttachment(ctx: Ctx, id: string) {
  const { row, access } = await loadWithAccess(ctx, id);
  const [full] = await ctx.tx.select({ storageKey: schema.attachments.storageKey }).from(schema.attachments).where(eq(schema.attachments.id, id)).limit(1);
  if (!full || !(await storage.exists(full.storageKey))) throw new NotFoundError('Attachment', 'Attachment file is missing from storage');
  await ctx.audit({ entityType: 'attachment', entityId: id, entityLabel: row.filename, action: 'download', customerId: access.customerId, metadata: { parentType: access.entityType, parentId: access.entityId } });
  return { meta: decorate(row, access, ctx.user.id), stream: storage.stream(full.storageKey) };
}

// ---------------------------------------------------------------- mutations

export interface CreateAttachmentInput {
  entityType: string;
  entityId: string;
  filename: string;
  contentType?: string;
  buffer: Buffer;
  customerId?: string | null;
  customerVisible?: boolean;
  docType?: DocType;
  title?: string | null;
  expiresAt?: Date | null;
}

export async function createAttachment(ctx: Ctx, input: CreateAttachmentInput) {
  const access = await attachmentAccess(ctx, input.entityType, input.entityId);
  if (!access.canUpload) throw new ForbiddenError('You cannot add attachments to this record');
  if (input.customerId && access.customerId && input.customerId !== access.customerId) throw new ValidationError('customerId does not match the owning record');
  const customerId = access.customerId ?? (input.customerId && ctx.canSeeCustomer(input.customerId) ? input.customerId : null);
  const contentType = validateUpload(input.filename, input.contentType, input.buffer);
  const filename = path.basename(input.filename.trim()).replace(/[\u0000-\u001f]/g, '').slice(0, 255);
  const docType: DocType = input.docType && (DOC_TYPES as readonly string[]).includes(input.docType) ? input.docType : 'other';
  // Portal uploads are always visible to the customer who uploaded them.
  const customerVisible = access.customerOnly ? true : input.customerVisible ?? false;

  const id = randomUUID();
  const storageKey = storageKeyFor(customerId, id, filename);
  await storage.put(storageKey, input.buffer);
  let row: typeof schema.attachments.$inferSelect;
  try {
    [row] = await ctx.tx
      .insert(schema.attachments)
      .values({
        id,
        customerId,
        entityType: access.entityType,
        entityId: access.entityId,
        filename,
        contentType,
        size: input.buffer.length,
        storageKey,
        sha256: sha256Buffer(input.buffer),
        docType,
        title: input.title?.trim() || null,
        customerVisible,
        expiresAt: input.expiresAt ?? null,
        uploadedBy: ctx.user.apiKeyId ? null : ctx.user.id,
      })
      .returning();
  } catch (err) {
    await storage.delete(storageKey);
    throw err;
  }
  await ctx.audit({
    entityType: 'attachment',
    entityId: id,
    entityLabel: filename,
    action: 'upload',
    customerId,
    metadata: { parentType: access.entityType, parentId: access.entityId, parentLabel: access.label, size: row.size, contentType, customerVisible, docType },
  });
  await ctx.audit({ entityType: access.entityType, entityId: access.entityId, entityLabel: access.label, action: 'attachment.added', customerId, metadata: { attachmentId: id, filename, size: row.size } });
  return getAttachment(ctx, id);
}

export interface UpdateAttachmentInput {
  customerVisible?: boolean;
  title?: string | null;
  docType?: DocType;
  expiresAt?: Date | null;
}

export async function updateAttachment(ctx: Ctx, id: string, patch: UpdateAttachmentInput) {
  const { row, access } = await loadWithAccess(ctx, id);
  if (access.customerOnly) throw new ForbiddenError();
  const isUploader = !!row.uploadedBy && row.uploadedBy === ctx.user.id;
  if (!access.canManage && !isUploader) throw new ForbiddenError('Only the uploader or a manager can edit this attachment');
  const values: Partial<typeof schema.attachments.$inferInsert> = {};
  if (patch.customerVisible !== undefined) values.customerVisible = patch.customerVisible;
  if (patch.title !== undefined) values.title = patch.title?.trim() || null;
  if (patch.docType !== undefined) values.docType = patch.docType;
  if (patch.expiresAt !== undefined) values.expiresAt = patch.expiresAt;
  if (Object.keys(values).length) await ctx.tx.update(schema.attachments).set(values).where(eq(schema.attachments.id, id));
  await ctx.audit({
    entityType: 'attachment',
    entityId: id,
    entityLabel: row.filename,
    action: 'update',
    customerId: access.customerId,
    changes: diffChanges(row as Record<string, unknown>, values as Record<string, unknown>),
    metadata: { parentType: access.entityType, parentId: access.entityId },
  });
  return getAttachment(ctx, id);
}

export async function deleteAttachment(ctx: Ctx, id: string) {
  const { row, access } = await loadWithAccess(ctx, id);
  const isUploader = !!row.uploadedBy && row.uploadedBy === ctx.user.id;
  const recent = Date.now() - row.createdAt.getTime() < UPLOADER_WINDOW_MS;
  if (!access.canManage && !(isUploader && recent)) throw new ForbiddenError('Only the uploader (within 24 hours) or a manager can delete this attachment');
  const [full] = await ctx.tx.select({ storageKey: schema.attachments.storageKey }).from(schema.attachments).where(eq(schema.attachments.id, id)).limit(1);
  await ctx.tx.delete(schema.attachments).where(eq(schema.attachments.id, id));
  if (full) await storage.delete(full.storageKey);
  await ctx.audit({ entityType: 'attachment', entityId: id, entityLabel: row.filename, action: 'delete', customerId: access.customerId, metadata: { parentType: access.entityType, parentId: access.entityId, size: row.size } });
  await ctx.audit({ entityType: access.entityType, entityId: access.entityId, entityLabel: access.label, action: 'attachment.removed', customerId: access.customerId, metadata: { attachmentId: id, filename: row.filename } });
  return { deleted: true };
}

/** Content-Disposition helper: inline for images/PDF (browser preview), attachment otherwise. */
export function contentDisposition(filename: string, contentType: string) {
  const inline = contentType.startsWith('image/') || contentType === 'application/pdf';
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
