import { useEffect, useRef, lazy, Suspense, type ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth';
import { LoadingBlock } from '@/components/ui';
import { AppShell } from '@/layouts/AppShell';
import { PortalShell } from '@/layouts/PortalShell';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import LoginPage from '@/pages/auth/LoginPage';
import type { Permission } from '@itsm/shared';
import { routes as appRoutes } from '@/routes';

const ResetPasswordPage = lazy(() => import('@/pages/auth/ResetPasswordPage'));
const PublicStatusPage = lazy(() => import('@/pages/public/PublicStatusPage'));
const SurveyPage = lazy(() => import('@/pages/public/SurveyPage'));

function Guard({ perm, children }: { perm?: Permission[]; children: ReactNode }) {
  const can = useAuthStore((s) => s.can);
  if (perm && perm.length && !can(...perm)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  const { user, ready, setSession, setReady } = useAuthStore();
  const location = useLocation();
  const bootstrapped = useRef(false);

  useEffect(() => {
    if (ready || bootstrapped.current) return;
    bootstrapped.current = true;
    (async () => {
      try {
        const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setSession(data.accessToken, data.user);
          return;
        }
      } catch {
        /* offline */
      }
      setReady();
    })();
  }, [ready, setSession, setReady]);

  if (!ready) return <div className="h-full flex items-center justify-center"><LoadingBlock label="Starting…" /></div>;

  // The public status page lives outside both shells: a token link, no sign-in, signed in or not.
  if (location.pathname.startsWith('/status/')) {
    return (
      <Suspense fallback={<LoadingBlock />}>
        <Routes>
          <Route path="/status/:token" element={<PublicStatusPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    );
  }

  // The satisfaction survey page is the same kind of link: one token from the email, no sign-in needed.
  if (location.pathname.startsWith('/survey/')) {
    return (
      <Suspense fallback={<LoadingBlock />}>
        <Routes>
          <Route path="/survey/:token" element={<SurveyPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    );
  }

  if (!user) {
    return (
      <Suspense fallback={<LoadingBlock />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="*" element={<Navigate to="/login" state={{ from: location.pathname }} replace />} />
        </Routes>
      </Suspense>
    );
  }

  const isCustomer = user.userType === 'customer';
  const Shell = isCustomer ? PortalShell : AppShell;
  const visible = appRoutes.filter((r) => (isCustomer ? r.portal : !r.portal || r.shared));

  return (
    <Shell>
      <ErrorBoundary resetKey={location.pathname} compact>
      <Suspense fallback={<LoadingBlock />}>
        <Routes>
          {visible.map((r) => (
            <Route
              key={r.path}
              path={r.path}
              element={
                <Guard perm={r.perm}>
                  <r.component />
                </Guard>
              }
            />
          ))}
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      </ErrorBoundary>
    </Shell>
  );
}
