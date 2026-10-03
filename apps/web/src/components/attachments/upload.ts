import { toast } from 'sonner';
import { upload, ApiError } from '@/api/client';

/** Query key of an entity's attachment list (the same shape AttachmentList uses). */
export const attachmentsQueryKey = (entityType: string, entityId: string) => ['attachments', entityType, entityId] as const;

/** Shown next to pickers; the API enforces its own MAX_UPLOAD_MB (50 MB by default). */
export const UPLOAD_HINT = 'Screenshots, logs, mails or documents · up to 50 MB each';

export interface UploadTarget {
  entityType: string;
  entityId: string;
  customerId?: string | null;
  /** Staff only: the API forces `true` for portal users. */
  customerVisible?: boolean;
  docType?: string;
}

export interface UploadOutcome {
  ok: string[];
  failed: { name: string; error: string }[];
}

/** Adds files to a selection, skipping duplicates (same name and size). */
export function addFiles(current: File[], incoming: Iterable<File>): File[] {
  const next = [...current];
  for (const f of incoming) if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
  return next;
}

/** Uploads files one per request (the API takes a single `file` field) and reports per-file outcomes. */
export async function uploadAttachments(files: File[], target: UploadTarget, onProgress?: (done: number, total: number, name: string) => void): Promise<UploadOutcome> {
  const out: UploadOutcome = { ok: [], failed: [] };
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    onProgress?.(i, files.length, file.name);
    try {
      await upload('/attachments', file, {
        entityType: target.entityType,
        entityId: target.entityId,
        ...(target.customerId ? { customerId: target.customerId } : {}),
        ...(target.customerVisible !== undefined ? { customerVisible: String(target.customerVisible) } : {}),
        ...(target.docType ? { docType: target.docType } : {}),
      });
      out.ok.push(file.name);
    } catch (err) {
      out.failed.push({ name: file.name, error: err instanceof ApiError ? err.message : 'upload failed' });
    }
  }
  onProgress?.(files.length, files.length, '');
  return out;
}

/** One toast per failed file, so a bad file never hides the ones that went through. */
export function reportUploadFailures(outcome: UploadOutcome) {
  for (const f of outcome.failed) toast.error(`${f.name}: ${f.error}`);
}

/**
 * Names the uploaded files in the note itself: attachments are not linked to a comment, and the
 * e-mail copy of the note should mention them too.
 */
export function withAttachmentNote(text: string, names: string[]) {
  const t = text.trim();
  if (!names.length) return t;
  const line = `${names.length === 1 ? 'Attachment' : 'Attachments'}: ${names.join(', ')}`;
  return t ? `${t}\n\n${line}` : line;
}

/**
 * A reply with files: the files go up first (so a note never names a file that failed), then the
 * note is posted naming what arrived. Throws when there is nothing left to post.
 */
export async function commentWithAttachments(opts: { text: string; files: File[]; target: UploadTarget; post: (body: string) => Promise<unknown> }): Promise<UploadOutcome> {
  let outcome: UploadOutcome = { ok: [], failed: [] };
  if (opts.files.length) {
    outcome = await uploadAttachments(opts.files, opts.target);
    reportUploadFailures(outcome);
  }
  const body = withAttachmentNote(opts.text, outcome.ok);
  if (!body) throw new Error(outcome.failed.length ? 'Nothing was posted: no file could be uploaded' : 'Write a note or attach a file');
  await opts.post(body);
  return outcome;
}
