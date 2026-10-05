import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sparkles } from 'lucide-react';
import { Dialog, Button, Field, Textarea, Checkbox } from '@/components/ui';
import { aiApi } from '@/components/ai/api';
import { kedbApi } from './api';

export interface PublishTarget {
  id: string;
  number: string;
  title: string;
  customerName: string | null;
  customerSummary: string | null;
  customerWorkaround: string | null;
  portalVisible: boolean;
}

/**
 * Customer-facing wording of a known error: what the customer may notice and what to do in the meantime,
 * drafted by Grady on request (or assembled without a provider), published to the organisation's portal.
 * The first publication notifies the organisation's portal users; updating the wording does not.
 */
export function PublishDialog({ open, onClose, target, canDraft, onPublished }: { open: boolean; onClose: () => void; target: PublishTarget; /** The kedb_draft feature is on and the person may use the assistant. */ canDraft?: boolean; onPublished?: () => void }) {
  const qc = useQueryClient();
  const [summary, setSummary] = useState('');
  const [workaround, setWorkaround] = useState('');
  const [notify, setNotify] = useState(true);
  const [drafting, setDrafting] = useState(false);
  const [drafted, setDrafted] = useState<boolean | null>(null);
  useEffect(() => {
    if (open) {
      setSummary(target.customerSummary ?? '');
      setWorkaround(target.customerWorkaround ?? '');
      setNotify(true);
      setDrafted(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target.id]);
  const draft = async () => {
    if (drafting) return;
    setDrafting(true);
    try {
      const r = await aiApi.draftKnownError(target.id);
      setSummary(r.summary);
      setWorkaround(r.workaround);
      setDrafted(r.aiGenerated);
    } catch (err) {
      toast.error((err as Error).message || 'Could not draft the wording');
    } finally {
      setDrafting(false);
    }
  };
  const publish = useMutation({
    mutationFn: () => kedbApi.publish(target.id, { customerSummary: summary.trim(), customerWorkaround: workaround.trim(), notify: target.portalVisible ? false : notify }),
    onSuccess: (res) => {
      toast.success(res.first ? (res.notified > 0 ? `Published to the portal; ${res.notified} portal user${res.notified === 1 ? '' : 's'} notified` : 'Published to the portal') : 'Portal wording updated');
      qc.invalidateQueries({ queryKey: ['known-errors'] });
      qc.invalidateQueries({ queryKey: ['tickets', target.id] });
      qc.invalidateQueries({ queryKey: ['knowledge'] });
      qc.invalidateQueries({ queryKey: ['portal'] });
      qc.invalidateQueries({ queryKey: ['dashboards'] });
      qc.invalidateQueries({ queryKey: ['audit'] });
      onPublished?.();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const valid = summary.trim().length >= 10 && workaround.trim().length >= 10;
  const verb = target.portalVisible ? 'Update wording' : 'Publish';
  const draftHint = drafted === null ? null : drafted ? 'Drafted by Grady from the problem record. Check it before publishing.' : 'Assembled from the problem record without the model (switched off or no usable answer). Check it before publishing.';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${target.portalVisible ? 'Update the portal wording of' : 'Publish'} ${target.number}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => publish.mutate()} disabled={!valid} loading={publish.isPending}>{verb}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[12.5px] text-muted">
          {target.customerName ? <>Portal users of <span className="font-medium text-default">{target.customerName}</span> read this wording. </> : null}
          Describe what they may notice and what to do in the meantime; never internal notes, hostnames or vendor references.
        </p>
        <Field
          label={
            <span className="inline-flex items-center gap-2">
              Customer summary
              {canDraft && (
                <Button size="sm" variant="ghost" className="h-6 px-1.5" icon={<Sparkles className="h-3 w-3" />} loading={drafting} onClick={() => void draft()}>
                  Write with Grady
                </Button>
              )}
            </span>
          }
          required
          hint={draftHint ?? 'What the customer may notice, in one or two plain sentences.'}
        >
          <Textarea autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} className="min-h-[80px]" placeholder="The site's wireless network drops for a few seconds at a time…" />
        </Field>
        <Field label="Customer workaround" required hint="What the customer can do in the meantime, or that no action is needed on their side.">
          <Textarea value={workaround} onChange={(e) => setWorkaround(e.target.value)} className="min-h-[110px]" placeholder="Reconnect to the network; our team restarts the access point automatically…" />
        </Field>
        {target.portalVisible ? (
          <p className="text-[12px] text-subtle">The entry is already published: the new wording replaces the old one and nobody is notified.</p>
        ) : (
          <div>
            <Checkbox checked={notify} onChange={(e) => setNotify(e.target.checked)} label="Notify the organisation's portal users" />
            <p className="text-[12px] text-subtle mt-1 ml-6">{target.customerName ? `Portal users of ${target.customerName}` : 'The organisation’s portal users'} receive an email and an in-app notice when the entry is first published; nothing is sent when the wording is only updated.</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
