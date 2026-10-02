import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '@/api/client';
import { Button, Input, Field } from '@/components/ui';
import { toast } from 'sonner';

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError('Passwords do not match');
    setLoading(true);
    setError(null);
    try {
      await api('/auth/reset-password', { body: { token, password } });
      toast.success('Password updated. Please sign in.');
      navigate('/login');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to reset password');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <form onSubmit={submit} className="card p-6 w-full max-w-sm flex flex-col gap-4">
        <div className="font-semibold text-base">Choose a new password</div>
        <Field label="New password" hint="At least 10 characters with upper, lower case and a number.">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        </Field>
        <Field label="Confirm password">
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </Field>
        {error && <div className="text-[13px] text-red-600">{error}</div>}
        <Button type="submit" loading={loading} className="justify-center">Update password</Button>
      </form>
    </div>
  );
}
