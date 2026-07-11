import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import AuthShell, { AuthField } from '../components/AuthShell';
import { api } from '../lib/api';
import { authErrorText } from '../lib/authError';

export default function ResetPasswordPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
      setTimeout(() => navigate('/login'), 1800);
    } catch (err) {
      setError(authErrorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <AuthShell title={t('auth.resetTitle')} footer={<Link to="/forgot-password" className="font-bold text-primary hover:underline">{t('auth.forgotTitle')}</Link>}>
        <p className="rounded-xl bg-error-container px-4 py-3 text-sm text-on-error-container">{t('auth.err.invalidToken')}</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t('auth.resetTitle')} subtitle={t('auth.resetSub')}>
      {done ? (
        <div className="rounded-2xl border border-secondary/40 bg-secondary-container/30 p-6 text-center">
          <span className="material-symbols-outlined mb-2 text-5xl text-secondary">task_alt</span>
          <p className="font-heading text-lg font-bold">{t('auth.resetDone')}</p>
          <p className="mt-1 text-sm text-on-surface-variant">{t('auth.resetRedirect')}</p>
        </div>
      ) : (
        <form onSubmit={submit}>
          {error && (
            <p className="mb-4 rounded-xl bg-error-container px-4 py-2.5 text-sm text-on-error-container" role="alert">{error}</p>
          )}
          <AuthField icon="lock" type={show ? 'text' : 'password'} dir="ltr" label={t('auth.newPassword')}
            placeholder="••••••••" value={password} onChange={setPassword} autoComplete="new-password"
            reveal revealed={show} onReveal={() => setShow((s) => !s)} />
          <p className="mb-6 -mt-2 text-xs text-outline">{t('auth.passwordHint')}</p>
          <button className="btn-primary w-full py-3" disabled={busy}>
            {busy ? t('auth.saving') : t('auth.resetBtn')}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
