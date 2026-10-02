import { create } from 'zustand';
import type { Permission, Principal } from '@itsm/shared';

interface AuthState {
  accessToken: string | null;
  user: Principal | null;
  ready: boolean;
  setSession: (token: string, user: Principal) => void;
  setUser: (user: Principal) => void;
  clear: () => void;
  setReady: () => void;
  can: (...perms: Permission[]) => boolean;
  isCustomer: () => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  accessToken: null,
  user: null,
  ready: false,
  setSession: (accessToken, user) => set({ accessToken, user, ready: true }),
  setUser: (user) => set({ user }),
  clear: () => set({ accessToken: null, user: null, ready: true }),
  setReady: () => set({ ready: true }),
  can: (...perms) => {
    const u = get().user;
    if (!u) return false;
    return perms.some((p) => u.permissions.includes(p));
  },
  isCustomer: () => get().user?.userType === 'customer',
}));

export const useCan = () => useAuthStore((s) => s.can);
export const useUser = () => useAuthStore((s) => s.user);
