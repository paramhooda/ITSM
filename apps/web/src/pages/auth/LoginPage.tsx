import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { api, ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { Button, Input, Field } from '@/components/ui';
import type { Principal } from '@itsm/shared';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [sent, setSent] = useState(false);
  const setSession = useAuthStore((s) => s.setSession);
  const navigate = useNavigate();
  const location = useLocation();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (forgot) {
        await api('/auth/forgot-password', { body: { email } });
        setSent(true);
        return;
      }
      const data = await api<{ accessToken: string; user: Principal }>('/auth/login', { body: { email, password } });
      setSession(data.accessToken, data.user);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-full flex items-center justify-center p-6 bg-app">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-6 justify-center">
          <div className="h-9 w-9 rounded-lg bg-slate-900 dark:bg-brand-600 text-sky-400 dark:text-white flex items-center justify-center">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <div className="font-semibold leading-tight">MSP Service Management</div>
            <div className="text-xs text-muted">ITSM · Helpdesk · Assets · CMDB</div>
          </div>
        </div>
        <form onSubmit={submit} className="card p-6 flex flex-col gap-4">
          <div className="font-semibold text-base">{forgot ? 'Reset your password' : 'Sign in'}</div>
          {sent ? (
            <div className="text-[13px] text-muted">If an account exists for <strong>{email}</strong>, a password reset link has been emailed.</div>
          ) : (
            <>
              <Field label="Email">
                <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              </Field>
              {!forgot && (
                <Field label="Password">
                  <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </Field>
              )}
              {error && <div className="text-[13px] text-red-600 bg-red-50 dark:bg-red-500/10 rounded-md px-3 py-2">{error}</div>}
              <Button type="submit" loading={loading} size="lg" className="w-full justify-center">
                {forgot ? 'Send reset link' : 'Sign in'}
              </Button>
            </>
          )}
          <button type="button" className="text-xs text-muted hover:text-default text-center" onClick={() => { setForgot(!forgot); setSent(false); setError(null); }}>
            {forgot ? 'Back to sign in' : 'Forgot your password?'}
          </button>
        </form>
        <div className="text-center text-xs text-subtle mt-4">
          <Link to="/login">Enterprise Managed Services Platform</Link>
        </div>
      </div>
    </div>
  );
}
