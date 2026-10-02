import { useRef, useState, type DragEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Paperclip, Upload, Trash2, Download, Image as ImageIcon, FileText, FileArchive, FileSpreadsheet, File as FileIcon, Eye, EyeOff, Loader2, FileCode, Film, Music } from 'lucide-react';
import { get, patch, del, upload, download, ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { Button, Badge, ConfirmDialog, Select } from '@/components/ui';
import { fmtBytes, relativeTime, fmtDateTime, titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface Attachment {
  id: string;
  customerId: string | null;
  entityType: string;
  entityId: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string | null;
  docType: string;
  title: string | null;
  customerVisible: boolean;
  expiresAt: string | null;
  uploadedBy: string | null;
  uploadedByName: string | null;
  createdAt: string;
  canDelete: boolean;
  canEdit: boolean;
}

export interface AttachmentListProps {
  entityType: string;
  entityId: string;
  customerId?: string | null;
  canUpload?: boolean;
  canDelete?: boolean;
  showVisibility?: boolean;
  compact?: boolean;
  docTypes?: { value: string; label: string }[];
}

interface ListResponse {
  items: Attachment[];
  access: { canUpload: boolean; canManage: boolean };
}

export function fileIcon(contentType: string, filename: string) {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (contentType.startsWith('image/')) return ImageIcon;
  if (contentType.startsWith('video/')) return Film;
  if (contentType.startsWith('audio/')) return Music;
  if (contentType === 'application/pdf' || contentType.startsWith('text/') || ['doc', 'docx', 'md'].includes(ext)) return FileText;
  if (['zip', 'gz', 'tar', '7z', 'rar'].includes(ext) || contentType.includes('zip') || contentType.includes('compressed')) return FileArchive;
  if (['xls', 'xlsx', 'csv'].includes(ext)) return FileSpreadsheet;
  if (['json', 'xml', 'yaml', 'yml', 'log'].includes(ext)) return FileCode;
  return FileIcon;
}

export const attachmentsKey = (entityType: string, entityId: string) => ['attachments', entityType, entityId] as const;

/**
 * Reusable attachment panel for any entity (tickets, contracts, assets, CIs,
 * visits, KB articles...). Lists files, uploads via drag-and-drop or button,
 * toggles customer visibility and deletes with confirmation. The API decides
 * what the caller may do; the props only hide controls.
 */
export function AttachmentList({ entityType, entityId, customerId, canUpload = true, canDelete = false, showVisibility = false, compact = false, docTypes }: AttachmentListProps) {
  const qc = useQueryClient();
  const isCustomer = useAuthStore((s) => s.user?.userType === 'customer');
  const key = attachmentsKey(entityType, entityId);
  const list = useQuery({ queryKey: key, queryFn: () => get<ListResponse>('/attachments', { entityType, entityId }), enabled: !!entityId });
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; name: string } | null>(null);
  const [docType, setDocType] = useState<string>(docTypes?.[0]?.value ?? 'other');
  const [visibleDefault, setVisibleDefault] = useState(isCustomer);
  const [confirm, setConfirm] = useState<Attachment | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = list.data?.items ?? [];
  const uploadAllowed = canUpload && (list.data?.access.canUpload ?? true);
  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  async function uploadFiles(files: FileList | File[]) {
    const arr = Array.from(files);
    if (!arr.length) return;
    let ok = 0;
    for (let i = 0; i < arr.length; i++) {
      const file = arr[i];
      setProgress({ done: i, total: arr.length, name: file.name });
      try {
        await upload('/attachments', file, {
          entityType,
          entityId,
          ...(customerId ? { customerId } : {}),
          customerVisible: String(visibleDefault),
          docType,
        });
        ok++;
      } catch (err) {
        toast.error(`${file.name}: ${err instanceof ApiError ? err.message : 'upload failed'}`);
      }
    }
    setProgress(null);
    if (ok) toast.success(ok === 1 ? `${arr[0].name} uploaded` : `${ok} files uploaded`);
    invalidate();
  }

  const toggleVisible = useMutation({
    mutationFn: (a: Attachment) => patch<Attachment>(`/attachments/${a.id}`, { customerVisible: !a.customerVisible }),
    onSuccess: (a) => {
      toast.success(a.customerVisible ? 'Visible to customer' : 'Hidden from customer');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not update'),
  });

  const remove = useMutation({
    mutationFn: (a: Attachment) => del(`/attachments/${a.id}`),
    onSuccess: () => {
      toast.success('Attachment deleted');
      setConfirm(null);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not delete'),
  });

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (!uploadAllowed) return;
    if (e.dataTransfer.files?.length) void uploadFiles(e.dataTransfer.files);
  }

  async function doDownload(a: Attachment) {
    try {
      await download(`/attachments/${a.id}/download`, a.filename);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Download failed');
    }
  }

  return (
    <div
      className={cn('relative', dragging && 'ring-2 ring-brand-500/40 rounded-lg')}
      onDragOver={(e) => {
        if (!uploadAllowed) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {!compact && (
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Paperclip className="h-4 w-4 text-subtle" /> Attachments
            {items.length > 0 && <span className="text-muted font-normal">({items.length})</span>}
          </div>
          {uploadAllowed && (
            <div className="flex items-center gap-2">
              {docTypes && docTypes.length > 0 && <Select className="h-8 w-auto py-1 text-xs" value={docType} onChange={(e) => setDocType(e.target.value)} options={docTypes} />}
              {showVisibility && !isCustomer && (
                <label className="inline-flex items-center gap-1.5 text-xs text-muted cursor-pointer select-none">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-brand-600" checked={visibleDefault} onChange={(e) => setVisibleDefault(e.target.checked)} /> Customer visible
                </label>
              )}
              <Button size="sm" variant="outline" icon={<Upload className="h-3.5 w-3.5" />} onClick={() => inputRef.current?.click()} disabled={!!progress}>
                Upload
              </Button>
            </div>
          )}
        </div>
      )}
      {uploadAllowed && <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => e.target.files && void uploadFiles(e.target.files).then(() => (e.target.value = ''))} />}

      {progress && (
        <div className="flex items-center gap-2 text-xs text-muted mb-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading {progress.done + 1}/{progress.total}: <span className="truncate">{progress.name}</span>
        </div>
      )}

      {list.isLoading && <div className="text-xs text-muted py-2">Loading attachments…</div>}
      {list.isError && <div className="text-xs text-red-600 py-2">{(list.error as Error).message}</div>}

      {!list.isLoading && items.length === 0 && (
        <div
          className={cn('rounded-lg border border-dashed border-default text-center text-xs text-muted', compact ? 'py-3' : 'py-6', uploadAllowed && 'cursor-pointer hover:border-brand-400')}
          onClick={() => uploadAllowed && inputRef.current?.click()}
        >
          {uploadAllowed ? 'Drop files here or click to upload' : 'No attachments'}
        </div>
      )}

      {items.length > 0 && (
        <ul className={cn('divide-y divide-[var(--border)] rounded-lg border border-default', compact && 'text-[12.5px]')}>
          {items.map((a) => {
            const Icon = fileIcon(a.contentType, a.filename);
            const deletable = (canDelete || a.canDelete) && !remove.isPending;
            return (
              <li key={a.id} className={cn('flex items-center gap-3 px-3', compact ? 'py-1.5' : 'py-2')}>
                <Icon className="h-4 w-4 text-subtle shrink-0" />
                <div className="min-w-0 flex-1">
                  <button className="text-[13px] font-medium hover:underline text-left truncate max-w-full block" onClick={() => doDownload(a)} title={a.title ? `${a.title} (${a.filename})` : a.filename}>
                    {a.title || a.filename}
                  </button>
                  <div className="text-[11.5px] text-muted flex flex-wrap items-center gap-x-2">
                    {a.title && <span className="truncate">{a.filename}</span>}
                    <span>{fmtBytes(a.size)}</span>
                    {a.uploadedByName && <span>· {a.uploadedByName}</span>}
                    <span title={fmtDateTime(a.createdAt)}>· {relativeTime(a.createdAt)}</span>
                    {a.docType && a.docType !== 'other' && <Badge className="py-0 text-[10.5px]">{titleCase(a.docType)}</Badge>}
                  </div>
                </div>
                {showVisibility && !isCustomer && (
                  <button
                    className={cn('h-7 w-7 rounded-md flex items-center justify-center', a.customerVisible ? 'text-emerald-600 hover:bg-emerald-500/10' : 'text-subtle hover:bg-surface-2')}
                    title={a.customerVisible ? 'Visible to customer (click to hide)' : 'Hidden from customer (click to share)'}
                    disabled={!a.canEdit || toggleVisible.isPending}
                    onClick={() => toggleVisible.mutate(a)}
                  >
                    {a.customerVisible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  </button>
                )}
                <button className="h-7 w-7 rounded-md flex items-center justify-center text-subtle hover:bg-surface-2 hover:text-default" title="Download" onClick={() => doDownload(a)}>
                  <Download className="h-4 w-4" />
                </button>
                {deletable && (
                  <button className="h-7 w-7 rounded-md flex items-center justify-center text-subtle hover:bg-red-500/10 hover:text-red-600" title="Delete" onClick={() => setConfirm(a)}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {compact && uploadAllowed && items.length > 0 && (
        <button className="mt-1.5 text-xs text-brand-600 hover:underline inline-flex items-center gap-1" onClick={() => inputRef.current?.click()} disabled={!!progress}>
          <Upload className="h-3 w-3" /> Add files
        </button>
      )}

      {dragging && uploadAllowed && <div className="absolute inset-0 rounded-lg bg-brand-500/5 flex items-center justify-center text-[13px] text-brand-700 pointer-events-none">Drop to upload</div>}

      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} onConfirm={() => confirm && remove.mutate(confirm)} title="Delete attachment?" description={confirm ? `${confirm.filename} will be permanently removed.` : ''} confirmLabel="Delete" danger loading={remove.isPending} />
    </div>
  );
}

export default AttachmentList;
