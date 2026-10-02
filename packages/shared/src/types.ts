import type { Permission } from './permissions.js';

/** Authenticated principal as returned by GET /api/auth/me. */
export interface Principal {
  id: string;
  email: string;
  name: string;
  phone?: string | null;
  userType: 'msp' | 'customer';
  customerId: string | null;
  permissions: Permission[];
  /** Customer IDs the user may see, or 'all'. */
  customerScope: 'all' | string[];
  roles: { id: string; key: string; name: string; customerId: string | null }[];
  teams: { id: string; key: string; name: string }[];
  timezone: string;
  preferences: Record<string, unknown>;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiError {
  statusCode: number;
  error: string;
  message: string;
  code?: string;
  details?: unknown;
}
