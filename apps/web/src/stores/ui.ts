import { create } from 'zustand';

/** Where the user is: the route and the filters it understands (sent to the assistant with every message). */
export interface PageContext {
  pathname: string;
  route?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
}

interface UiState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (v: boolean) => void;
  assistantOpen: boolean;
  setAssistantOpen: (v: boolean) => void;
  toggleAssistant: () => void;
  assistantContext: Record<string, unknown> | null;
  setAssistantContext: (c: Record<string, unknown> | null) => void;
  assistantPage: PageContext | null;
  setAssistantPage: (p: PageContext | null) => void;
  searchOpen: boolean;
  setSearchOpen: (v: boolean) => void;
  /** The id of the last daily brief this browser opened; the top-bar button shows a dot while today's brief is another one. */
  briefingSeenId: string | null;
  setBriefingSeenId: (id: string | null) => void;
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
  setSidebarCollapsed: (sidebarCollapsed) => {
    try {
      localStorage.setItem('itsm.sidebar', sidebarCollapsed ? 'collapsed' : 'open');
    } catch {
      /* ignore */
    }
    set({ sidebarCollapsed });
  },
  assistantOpen: false,
  setAssistantOpen: (assistantOpen) => set({ assistantOpen }),
  toggleAssistant: () => set((s) => ({ assistantOpen: !s.assistantOpen })),
  assistantContext: null,
  setAssistantContext: (assistantContext) => set({ assistantContext }),
  assistantPage: null,
  setAssistantPage: (assistantPage) => set({ assistantPage }),
  searchOpen: false,
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  briefingSeenId: (() => {
    try {
      return localStorage.getItem('itsm.briefing.seen');
    } catch {
      return null;
    }
  })(),
  setBriefingSeenId: (briefingSeenId) => {
    try {
      if (briefingSeenId) localStorage.setItem('itsm.briefing.seen', briefingSeenId);
      else localStorage.removeItem('itsm.briefing.seen');
    } catch {
      /* ignore */
    }
    set({ briefingSeenId });
  },
}));

// The product ships a single light theme; clear any legacy dark preference.
try {
  document.documentElement.classList.remove('dark');
  localStorage.removeItem('itsm.theme');
} catch {
  /* ignore */
}
