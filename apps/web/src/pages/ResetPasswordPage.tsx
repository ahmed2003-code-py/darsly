import { FormEvent, useState } from 'react';
import { OtpInput } from '../components/OtpInput';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import AuthShell, { AuthField } from '../components/AuthShell';
import { api } from '../lib/api';
import { authErrorText } from '../lib/authError';

/**
 * Step 2 of the reset: the 6-digit code from the email plus the new password.
 *
 * The email travels in the query string because the code alone identifies
 * nobody — the API hashes the code together with the account it was issued to.
 */
export default function ResetPasswordPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const email = params.get('email') ?? '';

  const [code, setCode] = useState(params.get('code') ?? '');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setResent('');
    setBusy(true);
    try {
      await api.post('/auth/reset-password', { email, code: code.trim(), password });
      setDone(true);
      setTimeout(() => navigate('/login'), 1800);
    } catch (err) {
      setError(authErrorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setError('');
    setResent('');
    setBusy(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setResent(t('auth.codeResent'));
      setCode('');
    } catch (err) {
      setError(authErrorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  // Landing here without an email means the first step was skipped — there is
  // no account for a code to belong to, so send them back rather than fail late.
  if (!email) {
    return (
      <AuthShell title={t('auth.resetTitle')} footer={<Link to="/forgot-password" className="font-bold text-primary hover:underline">{t('auth.forgotTitle')}</Link>}>
        <p className="rounded-xl bg-error-container px-4 py-3 text-sm text-on-error-container">{t('auth.err.invalidToken')}</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t('auth.resetTitle')}
      subtitle={t('auth.codeSentTo', { email })}
      footer={<Link to="/forgot-password" className="font-bold text-primary hover:underline">{t('auth.changeEmail')}</Link>}
    >
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
          {resent && (
            <p className="mb-4 rounded-xl bg-secondary-container/40 px-4 py-2.5 text-sm text-on-secondary-container" role="status">{resent}</p>
          )}
          {/* Six boxes in a row is the dull way to ask for a code; this deals
              them as a hand and lands a card per digit. See OtpInput. */}
          <label className="mb-1.5 block text-sm font-bold">{t('auth.resetCode')}</label>
          <OtpInput value={code} onChange={setCode} length={6} ariaLabel={t('auth.resetCode')} autoFocus />
          <AuthField icon="lock" type={show ? 'text' : 'password'} dir="ltr" label={t('auth.newPassword')}
            placeholder="••••••••" value={password} onChange={setPassword} autoComplete="new-password"
            reveal revealed={show} onReveal={() => setShow((s) => !s)} />
          <p className="mb-6 -mt-2 text-xs text-outline">{t('auth.passwordHint')}</p>
          <button className="btn-primary w-full py-3" disabled={busy}>
            {busy ? t('auth.saving') : t('auth.resetBtn')}
          </button>
          <button type="button" onClick={resend} disabled={busy}
            className="mt-3 w-full py-2 text-sm font-semibold text-primary hover:underline disabled:opacity-50">
            {t('auth.resendCode')}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
