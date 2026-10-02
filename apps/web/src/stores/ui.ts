import { create } from 'zustand';

interface UiState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  assistantOpen: boolean;
  setAssistantOpen: (v: boolean) => void;
  assistantContext: Record<string, unknown> | null;
  setAssistantContext: (c: Record<string, unknown> | null) => void;
  searchOpen: boolean;
  setSearchOpen: (v: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: (() => {
    try {
      return localStorage.getItem('itsm.sidebar') === 'collapsed';
    } catch {
      return false;
    }
  })(),
  toggleSidebar: () =>
    set((s) => {
      const next = !s.sidebarCollapsed;
      try {
        localStorage.setItem('itsm.sidebar', next ? 'collapsed' : 'open');
      } catch {
        /* ignore */
      }
      return { sidebarCollapsed: next };
    }),
  assistantOpen: false,
  setAssistantOpen: (assistantOpen) => set({ assistantOpen }),
  assistantContext: null,
  setAssistantContext: (assistantContext) => set({ assistantContext }),
  searchOpen: false,
  setSearchOpen: (searchOpen) => set({ searchOpen }),
}));

// The product ships a single light theme; clear any legacy dark preference.
try {
  document.documentElement.classList.remove('dark');
  localStorage.removeItem('itsm.theme');
} catch {
  /* ignore */
}
