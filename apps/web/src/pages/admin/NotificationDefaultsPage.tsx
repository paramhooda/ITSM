import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { NOTIFICATION_CATEGORIES, type NotificationCategoryDef } from '@itsm/shared';
import { Badge, Card, Toggle, EmptyState, LoadingBlock, ErrorBlock, Pagination } from '@/components/ui';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { useAdminMutation } from '@/components/admin/api';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { useConfigFilter } from '@/hooks/useConfigFilter';
import { useAuthStore } from '@/stores/auth';
import { notificationPrefsApi, notificationPrefsKeys, type CategoryRow, type CategoryPatch } from '@/components/notifications/api';

const AUDIENCE: Record<NotificationCategoryDef['audience'], { label: string; color: string }> = {
  staff: { label: 'Staff', color: 'blue' },
  customer: { label: 'Customers', color: 'violet' },
  both: { label: 'Both', color: 'gray' },
};

const GRID = 'md:grid-cols-[minmax(0,1fr)_repeat(4,104px)]';

/** One toggle cell: its own small label under md (the header row is hidden there), disabled with a reason when the lock makes no sense or the user may not write. */
function Cell({ label, checked, onChange, disabled, reason }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; reason?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 md:justify-start">
      <span className="text-[11px] text-subtle md:hidden">{label}</span>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} title={disabled ? reason : undefined} />
    </div>
  );
}

const Dash = ({ label }: { label: string }) => (
  <div className="flex items-center justify-between gap-2 md:justify-start">
    <span className="text-[11px] text-subtle md:hidden">{label}</span>
    <span className="text-subtle">—</span>
  </div>
);

/** Administration → Notifications → Notification defaults: the default and the lock per category and channel, with the search and audience filters in the URL (`q`, `audience`). */
export default function NotificationDefaultsPage() {
  const can = useAuthStore((s) => s.can);
  const canWrite = can('admin:config');
  const q = useQuery({ queryKey: notificationPrefsKeys.categories, queryFn: () => notificationPrefsApi.categories() });
  const update = useAdminMutation(({ id, ...body }: CategoryPatch & { id: string }) => notificationPrefsApi.updateCategory(id, body), { invalidate: [notificationPrefsKeys.categories], success: 'Defaults saved' });
  const rows = useMemo(() => {
    const byKey = new Map((q.data ?? []).map((r) => [r.key, r]));
    return NOTIFICATION_CATEGORIES.map((def) => ({ def, row: byKey.get(def.key) })).filter((x): x is { def: NotificationCategoryDef; row: CategoryRow } => !!x.row);
  }, [q.data]);
  // The matrix is a configuration list like the others: search and audience in the URL (`q`, `audience`).
  const f = useConfigFilter(rows, {
    search: [({ def }) => def.label, ({ def }) => def.description, ({ def }) => def.key, ({ def }) => AUDIENCE[def.audience].label],
    selects: [{ key: 'audience', label: 'Audience', options: (Object.keys(AUDIENCE) as NotificationCategoryDef['audience'][]).map((a) => ({ value: a, label: AUDIENCE[a].label })), predicate: ({ def }, v) => def.audience === v }],
    noun: ['category', 'categories'],
    searchPlaceholder: 'Search categories',
  });
  const readOnly = 'Requires the admin:config permission';
  const save = (row: CategoryRow, patch: CategoryPatch) => update.mutate({ id: row.id, ...patch });

  return (
    <div>
      <SectionHeader title="Notification defaults" description="Per category and channel: on or off unless a person chooses otherwise, and locked when nobody of that audience may switch it off. Categories are defined by the platform." />
      {!canWrite && <div className="mb-3 text-[12.5px] text-amber-700">Read-only: changing a default requires the admin:config permission.</div>}
      <p className="mb-3 text-[12.5px] text-muted">
        Rules decide which channels an event may use; these defaults and each person&apos;s own choice only ever remove a channel. Account messages (welcome, password reset, verification codes) are always sent. Which channels an event may use at all is set under{' '}
        <Link to="/admin/notifications/rules" className="text-brand-700 hover:underline">Notification rules</Link>.
      </p>
      <ConfigToolbar {...f.toolbar} />
      {q.isLoading ? (
        <LoadingBlock />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No notification categories yet" description="They are seeded when the API starts." />
      ) : f.rows.length === 0 ? (
        <Card><EmptyState title="No categories match" description="Try another search, or clear the conditions in the breadcrumb above." /></Card>
      ) : (
        <Card padded={false}>
          <div className={`hidden md:grid ${GRID} gap-3 border-b border-default px-4 py-2 text-[11px] uppercase tracking-wide text-subtle`}>
            <div>Category</div>
            <div>Email default</div>
            <div>Email locked</div>
            <div>WhatsApp default</div>
            <div>WhatsApp locked</div>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {f.rows.map(({ def, row }) => {
              const audience = AUDIENCE[def.audience];
              const busy = update.isPending && update.variables?.id === row.id;
              return (
                <div key={def.key} data-row={def.key} className={`grid grid-cols-1 ${GRID} gap-2 px-4 py-3 md:items-center md:gap-3 ${busy ? 'opacity-60' : ''}`}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium">{def.label}</span>
                      <Badge color={audience.color}>{audience.label}</Badge>
                    </div>
                    <div className="text-[12px] text-muted">{def.description}</div>
                    {def.key === 'paging' && <div className="text-[11.5px] text-subtle">Unlocking a channel lets engineers mute pages on it; email and in-app still arrive.</div>}
                  </div>
                  {def.key === 'briefing' ? (
                    <div className="text-[12px] text-muted md:col-span-4">Chosen by each person on their Daily briefing card.</div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2 md:contents">
                      <Cell label="Email default" checked={row.emailDefault} onChange={(v) => save(row, { emailDefault: v, ...(v ? {} : { emailLocked: false }) })} disabled={!canWrite} reason={readOnly} />
                      <Cell label="Email locked" checked={row.emailLocked} onChange={(v) => save(row, { emailLocked: v })} disabled={!canWrite || !row.emailDefault} reason={!canWrite ? readOnly : 'A locked channel must be on by default'} />
                      {def.whatsapp ? (
                        <>
                          <Cell label="WhatsApp default" checked={row.whatsappDefault} onChange={(v) => save(row, { whatsappDefault: v, ...(v ? {} : { whatsappLocked: false }) })} disabled={!canWrite} reason={readOnly} />
                          <Cell label="WhatsApp locked" checked={row.whatsappLocked} onChange={(v) => save(row, { whatsappLocked: v })} disabled={!canWrite || !row.whatsappDefault} reason={!canWrite ? readOnly : 'A locked channel must be on by default'} />
                        </>
                      ) : (
                        <>
                          <Dash label="WhatsApp default" />
                          <Dash label="WhatsApp locked" />
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {f.pager && <Pagination page={f.pager.page} pageSize={f.pager.pageSize} total={f.pager.total} onPage={f.pager.onPage} />}
        </Card>
      )}
      <p className="mt-3 text-[12px] text-subtle">A WhatsApp lock never overrides a person&apos;s opt-in: WhatsApp still needs their mobile number and consent. Every change is recorded in the audit log.</p>
    </div>
  );
}
