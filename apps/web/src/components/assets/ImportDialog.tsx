import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { upload, download } from '@/api/client';
import { Button, Dialog, Field, Select, Badge } from '@/components/ui';
import { useCustomersLookup } from '@/hooks/useLookups';
import { errorMessage } from '@/components/cmdb/hooks';

export interface ImportResult { created: number; updated: number; skipped: number; errors: { row: number; message: string }[] }

/** CSV import dialog shared by assets and CIs: customer, file, template download and a result summary. */
export function ImportDialog({ open, onClose, title, endpoint, templatePath, templateName, columns, customerId: initialCustomer, onDone }: { open: boolean; onClose: () => void; title: string; endpoint: string; templatePath: string; templateName: string; columns: string[]; customerId?: string; onDone?: () => void }) {
  const customers = useCustomersLookup();
  const [customerId, setCustomerId] = useState(initialCustomer ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const run = useMutation({
    mutationFn: () => upload<ImportResult>(endpoint, file!, { customerId }),
    onSuccess: (r) => {
      setResult(r);
      toast.success(`Import finished: ${r.created} created, ${r.updated} updated${r.errors.length ? `, ${r.errors.length} error(s)` : ''}`);
      onDone?.();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const close = () => {
    setResult(null);
    setFile(null);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={close}>Close</Button>
          <Button icon={<Upload className="h-4 w-4" />} onClick={() => run.mutate()} disabled={!file || !customerId} loading={run.isPending}>Import</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="text-[13px] text-muted">
          Upload a CSV with a header row. Rows are matched to existing records and updated; unknown rows are created. Expected columns:
          <div className="mt-1 flex flex-wrap gap-1">{columns.map((c) => <Badge key={c} color="slate">{c}</Badge>)}</div>
        </div>
        <Button variant="outline" size="sm" icon={<Download className="h-4 w-4" />} className="self-start" onClick={() => download(templatePath, templateName).catch((e) => toast.error(errorMessage(e)))}>
          Download template
        </Button>
        <Field label="Customer" required>
          <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="Select customer…" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))} />
        </Field>
        <Field label="CSV file" required>
          <input type="file" accept=".csv,text/csv" className="text-[13px]" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        {result && (
          <div className="card p-3 text-[13px]">
            <div className="flex gap-4">
              <span className="text-emerald-600">{result.created} created</span>
              <span className="text-blue-600">{result.updated} updated</span>
              <span className="text-muted">{result.skipped} skipped</span>
              <span className={result.errors.length ? 'text-red-600' : 'text-muted'}>{result.errors.length} errors</span>
            </div>
            {result.errors.length > 0 && (
              <ul className="mt-2 max-h-40 overflow-y-auto text-xs text-red-700 dark:text-red-300 list-disc pl-4">
                {result.errors.map((e, i) => (
                  <li key={i}>Row {e.row}: {e.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
