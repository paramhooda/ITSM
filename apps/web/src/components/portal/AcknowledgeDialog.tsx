import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { Dialog, Button, Field, Input, Textarea } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { cn } from '@/lib/utils';
import type { PortalVisit } from './api';

export interface AcknowledgeInput {
  name: string;
  title: string | null;
  notes: string | null;
  rating: number | null;
}

function StarRating({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  return (
    <div className="flex items-center gap-1" onMouseLeave={() => setHover(null)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" aria-label={`${n} star${n > 1 ? 's' : ''}`} onMouseEnter={() => setHover(n)} onClick={() => onChange(value === n ? null : n)} className="p-0.5">
          <Star className={cn('h-6 w-6 transition-colors', n <= shown ? 'fill-amber-400 text-amber-400' : 'text-subtle')} />
        </button>
      ))}
      <span className="ml-2 text-[12px] text-muted">{value ? ['', 'Poor', 'Fair', 'Good', 'Very good', 'Excellent'][value] : 'Optional'}</span>
    </div>
  );
}

/** Customer sign-off for a completed visit: name, title, notes and a star rating. */
export function AcknowledgeDialog({ visit, onClose, onSubmit, busy }: { visit: PortalVisit | null; onClose: () => void; onSubmit: (input: AcknowledgeInput) => Promise<unknown>; busy?: boolean }) {
  const user = useAuthStore((s) => s.user);
  const [name, setName] = useState(user?.name ?? '');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  useEffect(() => {
    if (visit) {
      setName(user?.name ?? '');
      setTitle('');
      setNotes('');
      setRating(null);
    }
  }, [visit, user?.name]);
  const open = !!visit;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={visit ? `Acknowledge visit ${visit.number}` : ''}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!name.trim()} onClick={() => void onSubmit({ name: name.trim(), title: title.trim() || null, notes: notes.trim() || null, rating })}>
            Confirm visit
          </Button>
        </>
      }
    >
      {visit && (
        <div className="flex flex-col gap-3">
          <div className="text-[13px] text-muted">
            Confirm that <span className="font-medium text-default">{visit.title}</span>
            {visit.engineerName ? ` by ${visit.engineerName}` : ''} took place as reported. Your name is recorded on the visit report.
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Your name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            <Field label="Job title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. IT Manager" />
            </Field>
          </div>
          <Field label="How did it go?">
            <StarRating value={rating} onChange={setRating} />
          </Field>
          <Field label="Notes for the engineer or your account manager">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything we should know?" />
          </Field>
        </div>
      )}
    </Dialog>
  );
}
