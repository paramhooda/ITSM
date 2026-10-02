import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
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
    <div className="min-h-full flex flex-col bg-app relative overflow-hidden">
      <div className="absolute inset-0 bg-dots [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)] pointer-events-none" aria-hidden />
      <div className="flex-1 flex items-center justify-center p-6 relative">
        <div className="w-full max-w-[400px] rise-in">
          <div className="flex justify-center mb-8">
            <img src="/logo.png" alt="Progression" className="h-10 w-auto" draggable={false} />
          </div>
          <form onSubmit={submit} className="card p-7 flex flex-col gap-5 shadow-raised">
            <div>
              <h1 className="text-[22px] font-semibold tracking-[-0.025em]">{forgot ? 'Reset your password' : 'Sign in'}</h1>
              <p className="text-[13.5px] text-muted mt-1">{forgot ? 'We will email you a link to choose a new password.' : 'Welcome back to the service management platform.'}</p>
            </div>
            {sent ? (
              <div className="text-[13.5px] text-secondary">
                If an account exists for <span className="font-medium text-default">{email}</span>, a password reset link has been emailed.
              </div>
            ) : (
              <>
                <Field label="Email">
                  <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus placeholder="you@company.com" />
                </Field>
                {!forgot && (
                  <Field label="Password">
                    <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="••••••••••" />
                  </Field>
                )}
                {error && <div className="text-[13px] text-red-700 bg-red-50 border border-red-200/70 rounded-lg px-3 py-2">{error}</div>}
                <Button type="submit" loading={loading} size="lg" className="w-full justify-center">
                  {forgot ? 'Send reset link' : 'Continue'}
                  {!loading && <ArrowRight className="h-4 w-4" />}
                </Button>
              </>
            )}
            <button
              type="button"
              className="text-[13px] text-muted hover:text-default text-center"
              onClick={() => {
                setForgot(!forgot);
                setSent(false);
                setError(null);
              }}
            >
              {forgot ? 'Back to sign in' : 'Forgot your password?'}
            </button>
          </form>
        </div>
      </div>
      <div className="py-5 text-center text-[12px] text-subtle relative">© {new Date().getFullYear()} Progression · Managed services platform</div>
    </div>
  );
}
