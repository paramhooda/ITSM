import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useAuthStore } from './stores/auth';
import { useUiStore } from './stores/ui';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: (count, err) => (err as { status?: number })?.status === 401 || (err as { status?: number })?.status === 403 ? false : count < 1, refetchOnWindowFocus: false },
  },
});

// Nothing fetched for one person survives a sign-out or a sign-in as someone else:
// the query cache and the assistant's screen context are reset whenever the user changes.
let lastUserId: string | null = null;
useAuthStore.subscribe((state) => {
  const id = state.user?.id ?? null;
  if (id === lastUserId) return;
  lastUserId = id;
  queryClient.removeQueries();
  useUiStore.getState().setAssistantContext(null);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
        <Toaster position="top-right" closeButton toastOptions={{ style: { fontSize: '13px', borderRadius: '10px', boxShadow: 'var(--shadow-raised)' } }} />
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
