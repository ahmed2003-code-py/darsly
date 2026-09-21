import { FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import AuthShell, { AuthField } from '../components/AuthShell';
import { api } from '../lib/api';
import { authErrorText } from '../lib/authError';

/**
 * A designated Center Admin follows the one-time link from their email, sees
 * who it is for, and chooses their own password. The server decides everything
 * from the token; nothing here can change which account or Center it unlocks.
 */
export default function ActivateAccountPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [preview, setPreview] = useState<{ fullName: string; email: string | null; academyName: string } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) { setInvalid(true); return; }
    api.get(`/auth/activation/${encodeURIComponent(token)}`)
      .then((r) => setPreview(r.data))
      .catch(() => setInvalid(true));
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/auth/activation', { token, password });
      setDone(true);
      setTimeout(() => navigate('/login'), 1800);
    } catch (err) {
      setError(authErrorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  if (invalid) {
    return (
      <AuthShell title={t('auth.activateTitle')} footer={<Link to="/login" className="font-bold text-primary hover:underline">{t('auth.loginTitle')}</Link>}>
        <p className="rounded-xl bg-error-container px-4 py-3 text-sm text-on-error-container">{t('auth.err.activationInvalid')}</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t('auth.activateTitle')}
      subtitle={preview ? t('auth.activateFor', { name: preview.fullName, center: preview.academyName }) : undefined}
      footer={<Link to="/login" className="font-bold text-primary hover:underline">{t('auth.loginTitle')}</Link>}
    >
      {done ? (
        <div className="rounded-2xl border border-secondary/40 bg-secondary-container/30 p-6 text-center">
          <span className="material-symbols-outlined mb-2 text-5xl text-secondary">task_alt</span>
          <p className="font-heading font-bold">{t('auth.activateDone')}</p>
        </div>
      ) : !preview ? (
        <p className="text-sm text-outline">{t('common.loading')}</p>
      ) : (
        <form onSubmit={submit}>
          {error && (
            <p className="mb-4 rounded-xl bg-error-container px-4 py-2.5 text-sm text-on-error-container" role="alert">{error}</p>
          )}
          {preview.email && <p className="mb-4 text-sm text-on-surface-variant" dir="ltr">{preview.email}</p>}
          <AuthField icon="lock" type={show ? 'text' : 'password'} dir="ltr" label={t('auth.newPassword')}
            placeholder="••••••••" value={password} onChange={setPassword} autoComplete="new-password"
            reveal revealed={show} onReveal={() => setShow((s) => !s)} autoFocus />
          <p className="mb-6 -mt-2 text-xs text-outline">{t('auth.passwordHint')}</p>
          <button className="btn-primary w-full py-3" disabled={busy}>
            {busy ? t('auth.saving') : t('auth.activateBtn')}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
