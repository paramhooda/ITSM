import { useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { get } from '@/api/client';
import { Button, Select } from '@/components/ui';
import { useCustomersLookup } from '@/hooks/useLookups';

export interface RoleRow {
  id: string;
  key: string;
  name: string;
  userType: 'msp' | 'customer';
  isSystem: boolean;
  permissions: string[];
  userCount: number;
  description?: string | null;
}

export interface RoleAssignment {
  roleId: string;
  customerId: string | null;
}

export function useRoles() {
  return useQuery({ queryKey: ['iam', 'roles'], queryFn: () => get<RoleRow[]>('/iam/roles'), staleTime: 60_000 });
}

/**
 * Rows of role + scope ("All customers" or one customer). Customer users always
 * hold roles for their own organization, so the scope column is hidden for them.
 */
export function RoleAssignmentsEditor({ value, onChange, userType, disabled }: { value: RoleAssignment[]; onChange: (v: RoleAssignment[]) => void; userType: 'msp' | 'customer'; disabled?: boolean }) {
  const roles = useRoles();
  const customers = useCustomersLookup();
  const roleOptions = (roles.data ?? []).filter((r) => r.userType === userType).map((r) => ({ value: r.id, label: r.name }));
  const customerOptions = (customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }));
  const update = (i: number, patch: Partial<RoleAssignment>) => onChange(value.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  return (
    <div className="flex flex-col gap-2">
      {value.length === 0 && <div className="text-[12.5px] text-subtle">No roles assigned. The user will be able to sign in but see nothing.</div>}
      {value.map((a, i) => (
        <div key={i} className="flex items-center gap-2">
          <Select value={a.roleId} placeholder="Select role…" options={roleOptions} disabled={disabled} onChange={(e) => update(i, { roleId: e.target.value })} className="flex-1" />
          {userType === 'msp' && (
            <Select value={a.customerId ?? ''} disabled={disabled} onChange={(e) => update(i, { customerId: e.target.value || null })} className="flex-1">
              <option value="">All customers</option>
              {customerOptions.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
          <button type="button" className="h-7 w-7 inline-flex items-center justify-center rounded-md text-subtle hover:text-red-600 hover:bg-surface-2 shrink-0" title="Remove" disabled={disabled} onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div>
        <Button type="button" variant="outline" size="sm" icon={<Plus className="h-3.5 w-3.5" />} disabled={disabled} onClick={() => onChange([...value, { roleId: roleOptions[0]?.value ?? '', customerId: null }])}>
          Add role
        </Button>
      </div>
      {userType === 'msp' && customers.isError && <div className="text-[11.5px] text-subtle">Customer list unavailable; scoped assignments can be added once the customers module is live.</div>}
    </div>
  );
}
