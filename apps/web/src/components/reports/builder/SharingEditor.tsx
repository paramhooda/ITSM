import { Field, Toggle } from '@/components/ui';
import { Segmented } from '@/components/dashboards/Panel';
import type { BuilderCatalog, CatalogEntity } from '../types';

function Chips({ options, value, onChange, empty }: { options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void; empty: string }) {
  if (!options.length) return <div className="text-[12px] text-subtle">{empty}</div>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button key={o.value} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])} className={`rounded-md border px-2 py-0.5 text-[12px] transition-colors ${on ? 'bg-brand-600 border-brand-600 text-white' : 'border-default text-muted hover:bg-surface-2'}`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Private or shared with roles and teams, and the portal publication (only portal-capable entities with portal-safe fields). */
export function SharingEditor({ visibility, sharedRoleKeys, sharedTeamIds, portalVisible, shareTargets, entity, blockingFields, onChange }: { visibility: 'private' | 'shared'; sharedRoleKeys: string[]; sharedTeamIds: string[]; portalVisible: boolean; shareTargets: BuilderCatalog['shareTargets']; entity: CatalogEntity | null; blockingFields: string[]; onChange: (patch: { visibility?: 'private' | 'shared'; sharedRoleKeys?: string[]; sharedTeamIds?: string[]; portalVisible?: boolean }) => void }) {
  const portalBlocked = !entity || !entity.portal || blockingFields.length > 0;
  const reason = !entity ? 'Pick an entity first' : !entity.portal ? `${entity.label} reports stay internal` : blockingFields.length ? `Internal fields block publication: ${blockingFields.join(', ')}` : 'Customer administrators and users with portal report access see it in their Reports catalogue, pinned to their organisation';
  return (
    <div className="flex flex-col gap-3">
      <Field label="Who can see it">
        <Segmented size="sm" value={visibility} onChange={(v) => onChange({ visibility: v, ...(v === 'private' ? { sharedRoleKeys: [], sharedTeamIds: [] } : {}) })} options={[{ value: 'private', label: 'Only me' }, { value: 'shared', label: 'Shared' }]} />
      </Field>
      {visibility === 'shared' && (
        <>
          <Field label="Roles" hint="Everyone with one of these roles who may also read the entity">
            <Chips options={shareTargets.roles.map((r) => ({ value: r.key, label: r.name }))} value={sharedRoleKeys} onChange={(v) => onChange({ sharedRoleKeys: v })} empty="No staff roles" />
          </Field>
          <Field label="Teams">
            <Chips options={shareTargets.teams.map((t) => ({ value: t.id, label: t.name }))} value={sharedTeamIds} onChange={(v) => onChange({ sharedTeamIds: v })} empty="No active teams" />
          </Field>
          {sharedRoleKeys.length === 0 && sharedTeamIds.length === 0 && <div className="text-[12px] text-subtle">Shared with nobody yet: report managers still see it; pick roles or teams.</div>}
        </>
      )}
      <div className="flex flex-col gap-1">
        <span className={portalBlocked ? 'opacity-60' : ''}>
          <Toggle checked={portalVisible && !portalBlocked} onChange={(v) => !portalBlocked && onChange({ portalVisible: v })} label="Visible in the customer portal" />
        </span>
        <div className={`text-[12px] ${blockingFields.length ? 'text-amber-700' : 'text-subtle'}`} data-portal-hint>{reason}</div>
      </div>
    </div>
  );
}
