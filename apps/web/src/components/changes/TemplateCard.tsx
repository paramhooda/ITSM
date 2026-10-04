import { useNavigate } from 'react-router-dom';
import { ShieldCheck, ShieldQuestion, Clock, Layers, Info, Rocket } from 'lucide-react';
import { Badge, Button, Card } from '@/components/ui';
import { relativeTime } from '@/lib/format';
import type { ChangeTemplate } from './api';

/** Where "Raise this change" goes: the new-change form prefilled from the template (and the customer filter, when set). */
export const raiseUrl = (t: ChangeTemplate, customerId?: string) => `/tickets/new?type=change&templateId=${t.id}${customerId ? `&customerId=${customerId}` : ''}`;

export const TYPE_COLOR: Record<string, string> = { standard: 'green', normal: 'blue', emergency: 'red' };

/** "Used 14 times · last 3 d ago", "Used once · last 2 h ago" or "Never used". */
export function usageLine(t: Pick<ChangeTemplate, 'usageCount' | 'lastUsedAt'>) {
  if (!t.usageCount) return 'Never used';
  return `Used ${t.usageCount === 1 ? 'once' : `${t.usageCount} times`}${t.lastUsedAt ? ` · last ${relativeTime(t.lastUsedAt)}` : ''}`;
}

/** One standard change in the catalog: what it is, how it is approved, how often it is raised, and the two ways in. */
export function TemplateCard({ t, canRaise, customerId, onDetails }: { t: ChangeTemplate; canRaise: boolean; customerId?: string; onDetails: () => void }) {
  const navigate = useNavigate();
  return (
    <Card className="h-full" padded={false} data-testid="template-card" data-template-key={t.key}>
      <div className="flex flex-col gap-3 p-4 h-full">
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0">
          <div className="font-medium text-[14px] leading-snug truncate" title={t.name}>{t.name}</div>
          <div className="font-mono text-[11px] text-subtle truncate">{t.key}</div>
        </div>
        {t.skipApproval ? (
          <Badge color="green" className="shrink-0"><ShieldCheck className="h-3 w-3" /> Pre-approved</Badge>
        ) : (
          <Badge color="amber" className="shrink-0"><ShieldQuestion className="h-3 w-3" /> Needs approval</Badge>
        )}
      </div>
      <p className={t.description ? 'text-[12.5px] text-muted line-clamp-3 min-h-[3.75em]' : 'text-[12.5px] text-subtle italic min-h-[3.75em]'}>{t.description || 'No description'}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge color={TYPE_COLOR[t.changeType] ?? 'slate'} className="capitalize">{t.changeType}</Badge>
        {t.riskLabel && <Badge color="slate">Risk: {t.riskLabel}</Badge>}
        {t.downtimeExpectedMinutes != null && <Badge color="slate"><Clock className="h-3 w-3" /> {t.downtimeExpectedMinutes ? `${t.downtimeExpectedMinutes} min downtime` : 'No downtime'}</Badge>}
      </div>
      <div className="text-[12px] text-muted inline-flex items-center gap-1.5 min-w-0">
        <Layers className="h-3.5 w-3.5 text-subtle shrink-0" />
        <span className="truncate">{[t.categoryLabel, t.serviceName].filter(Boolean).join(' · ') || 'Any category or service'}</span>
      </div>
      <div className="mt-auto text-[11.5px] text-subtle tabular-nums truncate" title={t.customerIds.length ? `Offered to ${t.customerIds.length} customer${t.customerIds.length === 1 ? '' : 's'}` : 'Offered to every customer'}>
        {usageLine(t)} · {t.customerIds.length ? `${t.customerIds.length} customer${t.customerIds.length === 1 ? '' : 's'}` : 'every customer'}
      </div>
      <div className="flex items-center justify-end gap-2 pt-2 border-t border-default">
        <div className="flex items-center gap-1.5 shrink-0">
          <Button size="sm" variant="ghost" icon={<Info className="h-3.5 w-3.5" />} onClick={onDetails}>Details</Button>
          {canRaise && (
            <Button size="sm" icon={<Rocket className="h-3.5 w-3.5" />} onClick={() => navigate(raiseUrl(t, customerId))} data-testid="raise-template">Raise this change</Button>
          )}
        </div>
      </div>
      </div>
    </Card>
  );
}
