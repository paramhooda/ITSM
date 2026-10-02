import { create } from 'zustand';

type Theme = 'light' | 'dark' | 'system';

interface UiState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  assistantOpen: boolean;
  setAssistantOpen: (v: boolean) => void;
  assistantContext: Record<string, unknown> | null;
  setAssistantContext: (c: Record<string, unknown> | null) => void;
  searchOpen: boolean;
  setSearchOpen: (v: boolean) => void;
}

function applyTheme(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

const initialTheme = ((): Theme => {
  try {
    return (localStorage.getItem('itsm.theme') as Theme) || 'system';
  } catch {
    return 'system';
  }
})();

export const useUiStore = create<UiState>((set) => ({
  theme: initialTheme,
  setTheme: (theme) => {
    try {
      if (theme === 'system') localStorage.removeItem('itsm.theme');
      else localStorage.setItem('itsm.theme', theme);
    } catch {
      /* ignore */
    }
    applyTheme(theme);
    set({ theme });
  },
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

applyTheme(initialTheme);
