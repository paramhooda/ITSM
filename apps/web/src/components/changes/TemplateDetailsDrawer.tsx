import { useNavigate } from 'react-router-dom';
import { Rocket, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { Badge, Button, Drawer, KeyValue } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import type { ChangeTemplate } from './api';
import { raiseUrl, usageLine, TYPE_COLOR } from './TemplateCard';

const PLANS: { key: keyof ChangeTemplate; label: string }[] = [
  { key: 'descriptionTemplate', label: 'Description' },
  { key: 'justification', label: 'Justification' },
  { key: 'implementationPlan', label: 'Implementation plan' },
  { key: 'testPlan', label: 'Test plan' },
  { key: 'backoutPlan', label: 'Backout plan' },
  { key: 'communicationPlan', label: 'Communication plan' },
];

/** The prefilled text of a standard change, read-only: what an engineer gets when raising it. */
export function TemplateDetailsDrawer({ template, onClose, canRaise, customerId }: { template: ChangeTemplate | null; onClose: () => void; canRaise: boolean; customerId?: string }) {
  const navigate = useNavigate();
  const t = template;
  return (
    <Drawer
      open={!!t}
      onClose={onClose}
      title={t ? t.name : ''}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Close</Button>
          {t && canRaise && <Button icon={<Rocket className="h-4 w-4" />} onClick={() => navigate(raiseUrl(t, customerId))}>Raise this change</Button>}
        </>
      }
    >
      {t && (
        <div className="flex flex-col gap-5" data-testid="template-details">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge color={TYPE_COLOR[t.changeType] ?? 'slate'} className="capitalize">{t.changeType}</Badge>
            {t.skipApproval ? <Badge color="green"><ShieldCheck className="h-3 w-3" /> Pre-approved: no approval workflow</Badge> : <Badge color="amber"><ShieldQuestion className="h-3 w-3" /> Needs approval</Badge>}
            {t.riskLabel && <Badge color="slate">Risk: {t.riskLabel}</Badge>}
            {!t.isActive && <Badge color="gray">Inactive</Badge>}
          </div>
          {t.description && <p className="text-[13px] text-muted">{t.description}</p>}
          <KeyValue
            columns={2}
            items={[
              { label: 'Key', value: <span className="font-mono text-[12px]">{t.key}</span> },
              { label: 'Default title', value: t.titleTemplate ?? <span className="text-subtle">The template name</span> },
              { label: 'Category', value: t.categoryLabel ?? <span className="text-subtle">Any</span> },
              { label: 'Service', value: t.serviceName ?? <span className="text-subtle">Any</span> },
              { label: 'Expected downtime', value: t.downtimeExpectedMinutes != null ? (t.downtimeExpectedMinutes ? `${t.downtimeExpectedMinutes} min` : 'None') : <span className="text-subtle">Not stated</span> },
              { label: 'Offered to', value: t.customerIds.length ? `${t.customerIds.length} customer${t.customerIds.length === 1 ? '' : 's'}` : 'Every customer' },
              { label: 'Usage', value: usageLine(t) },
              { label: 'Last 90 days', value: `${t.usage90d} raised` },
              { label: 'Updated', value: fmtDateTime(t.updatedAt) },
            ]}
          />
          <div className="flex flex-col gap-3">
            {PLANS.map((p) => {
              const text = t[p.key] as string | null;
              return (
                <div key={p.key}>
                  <div className="text-[11.5px] font-semibold uppercase tracking-wide text-subtle mb-1">{p.label}</div>
                  <div className={text ? 'text-[13px] whitespace-pre-wrap rounded-md border border-default bg-surface-2 px-3 py-2' : 'text-[12.5px] text-subtle italic'}>{text || 'Not prefilled'}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Drawer>
  );
}
