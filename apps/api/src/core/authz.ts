import type { Permission } from '@itsm/shared';
import { ForbiddenError } from './errors';
import type { Principal } from './principal';

/** Does the principal hold `perm` globally, or for the given customer? */
export function can(p: Principal, perm: Permission, customerId?: string | null): boolean {
  if (p.isSystem) return true;
  if (p.globalPermissions.has(perm)) return true;
  if (customerId && p.customerPermissions.get(customerId)?.has(perm)) return true;
  if (!customerId) {
    // Permission granted for at least one customer is enough for list/landing endpoints;
    // data visibility is then narrowed by the customer scope.
    for (const set of p.customerPermissions.values()) if (set.has(perm)) return true;
  }
  return false;
}

export function canAny(p: Principal, perms: Permission[], customerId?: string | null) {
  return perms.some((x) => can(p, x, customerId));
}

export function requirePermission(p: Principal, perm: Permission, customerId?: string | null) {
  if (!can(p, perm, customerId)) throw new ForbiddenError(`Missing permission: ${perm}`);
}

export function requireAny(p: Principal, perms: Permission[], customerId?: string | null) {
  if (!canAny(p, perms, customerId)) throw new ForbiddenError(`Missing permission: one of ${perms.join(', ')}`);
}

export function canSeeCustomer(p: Principal, customerId: string): boolean {
  if (p.isSystem) return true;
  return p.customerScope === 'all' || p.customerScope.includes(customerId);
}

export function requireCustomerAccess(p: Principal, customerId: string | null | undefined) {
  if (!customerId) throw new ForbiddenError('Customer context required');
  if (!canSeeCustomer(p, customerId)) throw new ForbiddenError('You do not have access to this customer');
}

export const isCustomerUser = (p: Principal) => p.userType === 'customer';
