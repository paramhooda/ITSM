import { useEffect, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Settings2, Sparkles } from 'lucide-react';
import { Badge, Button, Drawer, EmptyState, ErrorBlock, LoadingBlock, StatTile } from '@/components/ui';
import { RowList, type RowItem } from '@/components/dashboards/Panel';
import { GradyAvatar } from '@/components/grady/GradyAvatar';
import { Markdown } from '@/components/handover/Markdown';
import { cn } from '@/lib/utils';
import { fmtDate, fmtDateTime, relativeTime } from '@/lib/format';
import { BREACH_RISK_COLORS, SENTIMENT_COLORS } from '@/lib/statusColors';
import type { Briefing, BriefingDoor, BriefingItem, BriefingSection, BriefingToday, BriefingUsage } from './api';

/** Why the refresh button is off, in words: the daily cap or the cooldown. */
export function refreshHint(usage: BriefingUsage | undefined): string | null {
  if (!usage) return null;
  if (usage.exhausted) return `You have used today's ${usage.maxPerDay} brief${usage.maxPerDay === 1 ? '' : 's'}; the next one comes tomorrow.`;
  if (usage.cooling && usage.nextAllowedAt) return `Refresh again from ${fmtDateTime(usage.nextAllowedAt)}${usage.remaining !== null ? ` (${usage.remaining} left today)` : ''}.`;
  return usage.remaining !== null ? `${usage.remaining} refresh${usage.remaining === 1 ? '' : 'es'} left today.` : null;
}

/** "NOC manager" stays, "Engineer" becomes "engineer": the first letter drops its case unless the label opens with an acronym. */
const roleWords = (label: string) => label.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());

/** A count as a chip: a door opens the list it was counted on; a figure is the same chip without a link. */
function DoorChip({ door }: { door: BriefingDoor }) {
  const body = (
    <>
      <span className="tnum font-semibold text-default">{door.value}</span>
      <span className="text-muted">{door.label}</span>
    </>
  );
  const cls = 'inline-flex items-center gap-1.5 h-6 rounded-md border px-2 text-[12px] whitespace-nowrap';
  if (door.href) {
    return (
      <Link to={door.href} className={cn(cls, 'border-default bg-white hover:border-strong hover:bg-surface-2 transition-colors')} data-testid="briefing-door" title={`Open the ${door.value} ${door.label.toLowerCase()}`}>
        {body}
      </Link>
    );
  }
  return (
    <span className={cn(cls, 'border-transparent bg-surface-2')} data-testid="briefing-figure">
      {body}
    </span>
  );
}

/** The typed fields of an item as quiet badges; the email line when the item carries none. */
function itemDetails(item: BriefingItem, staff: boolean): ReactNode {
  const parts: ReactNode[] = [];
  if (item.priority?.label) parts.push(<Badge key="p" color={item.priority.color ?? 'slate'}>{item.priority.label}</Badge>);
  if (item.customer) parts.push(<span key="c" className="text-muted">{item.customer}</span>);
  if (staff && item.kind === 'ticket') parts.push(<span key="a" className={item.assignee ? 'text-muted' : 'text-subtle italic'}>{item.assignee ?? 'unassigned'}</span>);
  if (item.dueAt) parts.push(<span key="d" className="text-muted tnum">due {relativeTime(item.dueAt)}</span>);
  if (item.breachRisk === 'high' || item.breachRisk === 'medium') parts.push(<Badge key="r" color={BREACH_RISK_COLORS[item.breachRisk]}>{item.breachRisk === 'high' ? 'likely to breach' : 'at risk'}</Badge>);
  if (item.sentiment && item.sentiment !== 'neutral' && item.sentiment !== 'positive') parts.push(<Badge key="s" color={SENTIMENT_COLORS[item.sentiment] ?? 'slate'}>{item.sentiment}</Badge>);
  if (item.when) parts.push(<span key="w" className="text-muted tnum">{item.when.length === 10 ? fmtDate(item.when) : fmtDateTime(item.when)}</span>);
  if (item.status && item.kind !== 'ticket') parts.push(<span key="st" className="text-muted">{item.status}</span>);
  if (!parts.length) return item.meta || null;
  return <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">{parts}</span>;
}

const FirstMarker = () => (
  <span className="inline-flex h-5 items-center rounded-md bg-brand-50 px-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-brand-700" data-testid="briefing-pick" title="Start here">
    first
  </span>
);

/** One block per section: the title with its doors, the lead sentence, then the items (the model's picks first). */
function SectionBlock({ section, lead, picks, staff }: { section: BriefingSection; lead: string | null; picks: string[]; staff: boolean }) {
  const picked = picks.map((ref) => section.items.find((i) => i.ref === ref)).filter((i): i is BriefingItem => !!i);
  const rest = section.items.filter((i) => !picks.includes(i.ref));
  const rows: RowItem[] = [...picked, ...rest].map((item, idx) => ({
    key: `${section.key}:${item.ref}:${idx}`,
    primary: (
      <>
        <span className="font-mono text-[12px] text-muted mr-2">{item.ref}</span>
        {item.title}
      </>
    ),
    secondary: itemDetails(item, staff),
    right: item.doors?.length ? <span className="inline-flex flex-wrap justify-end gap-1">{item.doors.map((d) => <DoorChip key={d.label} door={d} />)}</span> : undefined,
    href: item.link ?? undefined,
    leading: picks.includes(item.ref) ? <FirstMarker /> : undefined,
  }));
  return (
    <section className="border-t border-default pt-4" data-testid="briefing-section" data-section={section.key}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <h3 className="text-[13px] font-semibold text-default tracking-[-0.01em]">{section.title}</h3>
        {section.doors.length > 0 && <div className="flex flex-wrap items-center gap-1.5">{section.doors.map((d) => <DoorChip key={d.label} door={d} />)}</div>}
      </div>
      {lead && <p className="text-[13px] text-muted leading-relaxed mt-1">{lead}</p>}
      {rows.length > 0 && (
        <div className="mt-2">
          <RowList items={rows} dense />
        </div>
      )}
    </section>
  );
}

function BriefBody({ briefing, staff }: { briefing: Briefing; staff: boolean }) {
  const facts = briefing.facts;
  const narrative = briefing.narrative;
  const kpis = facts?.kpis ?? [];
  const sections = facts?.sections ?? [];
  const leadOf = (s: BriefingSection) => narrative?.sections.find((n) => n.key === s.key)?.lead ?? s.summary ?? null;
  const picksOf = (s: BriefingSection) => narrative?.sections.find((n) => n.key === s.key)?.picks ?? [];
  return (
    <div className="flex flex-col gap-5">
      {narrative && (
        <div>
          <p className="text-[15px] font-semibold text-default tracking-[-0.01em]" data-testid="briefing-greeting">{narrative.greeting}</p>
          <p className="text-[13.5px] leading-relaxed text-secondary mt-1" data-testid="briefing-summary">{narrative.summary}</p>
        </div>
      )}
      {kpis.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" data-testid="briefing-kpis">
          {kpis.map((k) => (
            <StatTile key={k.key} label={k.label} value={k.value} tone={k.tone ?? 'default'} to={k.href ?? undefined} hint={k.hint ?? undefined} className="p-3.5 gap-1" />
          ))}
        </div>
      )}
      {sections.map((s) => (
        <SectionBlock key={s.key} section={s} lead={leadOf(s)} picks={picksOf(s)} staff={staff} />
      ))}
      {!facts && <Markdown body={briefing.text} />}
    </div>
  );
}

export interface BriefingPanelProps {
  open: boolean;
  onClose: () => void;
  /** The `today` payload; undefined while it loads. */
  data: BriefingToday | undefined;
  error?: unknown;
  retry?: () => void;
  /** Generates (or refreshes) the brief on request. */
  onGenerate: () => void;
  generating: boolean;
  /** The organisation's name for a customer's title; staff leave it out. */
  organisation?: string | null;
  /** Called once the panel has shown a brief, so the top-bar dot can clear. */
  onSeen?: (id: string) => void;
}

/**
 * The daily brief as a designed panel on the existing Drawer: the greeting and
 * summary, the KPI tiles (doors open their list), one block per section with
 * the lead sentence, the doors as chips, the items with their typed badges and
 * a "first" marker on the model's picks, and a footer with the cap and
 * cooldown hint, the delivery settings (staff) and Refresh. Nothing on the page
 * scrolls; following a link closes the panel.
 */
export function BriefingPanel({ open, onClose, data, error, retry, onGenerate, generating, organisation, onSeen }: BriefingPanelProps) {
  const briefing = data?.briefing ?? null;
  const staff = briefing ? briefing.role !== 'customer' : data ? data.role !== 'customer' : !organisation;
  useEffect(() => {
    if (open && briefing && onSeen) onSeen(briefing.id);
  }, [open, briefing?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const usage = data?.usage;
  const hint = refreshHint(usage);
  const title = briefing ? (staff ? `Your ${roleWords(briefing.roleLabel)} brief` : organisation ? `Your brief for ${organisation}` : "Your organisation's brief") : 'Your daily brief';
  const closeOnLink = (e: MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest('a[href]')) onClose();
  };
  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="max-w-2xl"
      title={
        <span className="flex items-center gap-2.5 min-w-0">
          <GradyAvatar size={32} decorative />
          <span className="min-w-0 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate" data-testid="briefing-title">{title}</span>
            {briefing && (
              <>
                <span className="text-[12px] font-normal text-subtle whitespace-nowrap">
                  {fmtDate(briefing.day)} · generated {relativeTime(briefing.generatedAt)}
                </span>
                <Badge color={briefing.ai ? 'violet' : 'slate'}>{briefing.ai ? 'Grady' : 'from the facts'}</Badge>
              </>
            )}
          </span>
        </span>
      }
      footer={
        <div className="flex flex-wrap items-center gap-2 w-full">
          <span className="text-[12px] text-subtle">{hint}</span>
          <div className="ml-auto flex items-center gap-2">
            {staff && data && (
              <Link to="/profile" className="text-[12.5px] text-brand-700 hover:underline inline-flex items-center gap-1" onClick={onClose}>
                <Settings2 className="h-3.5 w-3.5" /> {data.prefs.enabled ? `Daily at ${data.prefs.time}` : 'Daily delivery'}
              </Link>
            )}
            {briefing && (
              <Button size="sm" variant="outline" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={generating} disabled={!!usage && (usage.exhausted || usage.cooling)} title={hint ?? undefined} onClick={onGenerate}>
                Refresh
              </Button>
            )}
            <Button size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      }
    >
      <div data-testid="briefing-panel" onClickCapture={closeOnLink}>
        {error ? (
          <ErrorBlock error={error} retry={retry} />
        ) : !data ? (
          <LoadingBlock label="Loading your brief…" />
        ) : briefing ? (
          <BriefBody briefing={briefing} staff={staff} />
        ) : (
          <EmptyState
            icon={<GradyAvatar size={30} decorative />}
            title={`No brief yet for ${fmtDate(data.day)}`}
            description={
              staff
                ? data.prefs.enabled
                  ? `It arrives at ${data.prefs.time} in your timezone; you can also have it now.`
                  : 'What matters for your role, in one read: open and due tickets, breaches and the things to look at first. Read one now, or turn on the daily delivery on your profile.'
                : 'What matters for your organisation, in one read: open tickets, what waits on you, service levels and what is scheduled.'
            }
            action={
              <Button icon={<Sparkles className="h-4 w-4" />} loading={generating} disabled={!!usage?.exhausted} title={hint ?? undefined} onClick={onGenerate}>
                Brief me now
              </Button>
            }
          />
        )}
      </div>
    </Drawer>
  );
}
