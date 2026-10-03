import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Dialog, Button, Field, Select, Textarea } from '@/components/ui';
import { errorMessage } from '@/components/admin/api';
import { oncallApi, oncallKeys, STEP_TARGET_LABELS } from './api';

/** Page someone for a ticket: pick the policy (the assigned team's default is preselected) and say why. */
export function PageDialog({ open, onClose, ticketId, ticketNumber, teamId, onPaged }: { open: boolean; onClose: () => void; ticketId: string; ticketNumber: string; teamId?: string | null; onPaged?: () => void }) {
  const qc = useQueryClient();
  const policies = useQuery({ queryKey: oncallKeys.policies, queryFn: oncallApi.policies, enabled: open, staleTime: 60_000 });
  const team = useQuery({ queryKey: oncallKeys.now(teamId ?? null), queryFn: () => oncallApi.now(teamId ?? null), enabled: open && !!teamId, staleTime: 60_000 });
  const teamPolicyId = team.data?.teams[0]?.escalationPolicyId ?? null;
  const onCall = team.data?.teams[0]?.rotas.find((r) => r.user)?.user ?? null;
  const [policyId, setPolicyId] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) {
      setPolicyId('');
      setReason('');
    }
  }, [open]);
  const active = (policies.data ?? []).filter((p) => p.isActive);
  const chosen = active.find((p) => p.id === (policyId || teamPolicyId));
  const first = chosen?.steps[0];
  const send = useMutation({
    mutationFn: () => oncallApi.page({ ticketId, policyId: policyId || null, reason: reason.trim() || null }),
    onSuccess: (page) => {
      void qc.invalidateQueries({ queryKey: oncallKeys.all });
      void qc.invalidateQueries({ queryKey: ['tickets', ticketId] });
      toast.success(page.status === 'pending' ? `Paged ${page.targetName ?? page.targetTeamName ?? 'the team'}` : 'Nobody could be paged; the managers were told');
      onPaged?.();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={open} onClose={onClose} title={`Page on-call for ${ticketNumber}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => send.mutate()} disabled={!policyId && !teamPolicyId} loading={send.isPending}>Page now</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Escalation policy" required hint={active.length ? (teamId && !teamPolicyId ? 'The assigned team has no default policy; pick one.' : undefined) : 'No active policy exists yet; create one under Operations → On-call → Escalation policies.'}>
          <Select value={policyId} onChange={(e) => setPolicyId(e.target.value)} placeholder={teamPolicyId ? `Team's default: ${active.find((p) => p.id === teamPolicyId)?.name ?? 'policy'}` : 'Pick a policy'} options={active.map((p) => ({ value: p.id, label: p.name }))} />
        </Field>
        {first && (
          <p className="text-[12.5px] text-muted">
            Step 1 reaches <strong className="text-default">{first.target === 'user' ? (first.userName ?? 'a named person') : first.target === 'oncall' && onCall ? `${onCall.name} (on call now)` : STEP_TARGET_LABELS[first.target].toLowerCase()}</strong> by {first.channels.join(', ').replace('in_app', 'in-app')}; without an acknowledgement in {first.timeoutMinutes} min the page moves to the next step{chosen && chosen.steps.length > 1 ? ` (${chosen.steps.length} steps in total)` : ''}.
          </p>
        )}
        <Field label="What should they know first?">
          <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-[80px]" placeholder="Core switch down at the Pune site, customer on the phone" />
        </Field>
      </div>
    </Dialog>
  );
}
