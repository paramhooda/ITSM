import { Mail, Phone, Headset, UserRound } from 'lucide-react';
import { Card, Avatar } from '@/components/ui';
import type { PortalMe } from './api';

/** "Your service team": account manager and service desk contacts from /portal/me. */
export function ServiceTeamCard({ me, className }: { me: PortalMe | undefined; className?: string }) {
  const am = me?.serviceTeam.accountManager ?? null;
  const desk = me?.serviceTeam.serviceDesk ?? null;
  return (
    <Card title="Your service team" className={className}>
      {!me ? (
        <div className="text-[12.5px] text-muted">Loading…</div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <div className="h-9 w-9 rounded-full bg-brand-600/10 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
              <Headset className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{desk?.name ?? 'Service desk'}</div>
              <div className="text-[12px] text-muted">Raise and track requests here, or reach the desk by e-mail.</div>
              {desk?.email && (
                <a href={`mailto:${desk.email}`} className="mt-1 inline-flex items-center gap-1 text-[12.5px] text-brand-700 dark:text-brand-300 hover:underline">
                  <Mail className="h-3.5 w-3.5" /> {desk.email}
                </a>
              )}
            </div>
          </div>
          <div className="flex items-start gap-3">
            {am ? <Avatar name={am.name} size="md" /> : (
              <div className="h-9 w-9 rounded-full bg-surface-2 text-subtle flex items-center justify-center shrink-0">
                <UserRound className="h-4 w-4" />
              </div>
            )}
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{am?.name ?? 'Account manager'}</div>
              <div className="text-[12px] text-muted">{am ? am.title || 'Your account manager for escalations and contract matters' : 'Not assigned yet'}</div>
              {am?.email && (
                <a href={`mailto:${am.email}`} className="mt-1 inline-flex items-center gap-1 text-[12.5px] text-brand-700 dark:text-brand-300 hover:underline">
                  <Mail className="h-3.5 w-3.5" /> {am.email}
                </a>
              )}
              {am?.phone && (
                <a href={`tel:${am.phone}`} className="ml-3 inline-flex items-center gap-1 text-[12.5px] text-brand-700 dark:text-brand-300 hover:underline">
                  <Phone className="h-3.5 w-3.5" /> {am.phone}
                </a>
              )}
            </div>
          </div>
          {me.serviceTeam.teams.length > 0 && <div className="text-[12px] text-muted">Teams serving you: {me.serviceTeam.teams.map((t) => t.name).join(', ')}</div>}
        </div>
      )}
    </Card>
  );
}
