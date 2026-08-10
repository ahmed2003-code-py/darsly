import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import AuthShell, { AuthField } from '../components/AuthShell';
import { api } from '../lib/api';
import { authErrorText } from '../lib/authError';

/**
 * Step 1 of the reset: prove the account exists and get a code into the inbox.
 *
 * An unknown address is now an error the user can see, rather than the old
 * always-"ok" answer that left a typo looking exactly like success.
 */
export default function ForgotPasswordPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { data } = await api.post('/auth/forgot-password', { email: email.trim() });
      // Dev convenience: without a mail provider the API hands back the code.
      const devCode = data?.devResetCode ? `&code=${data.devResetCode}` : '';
      navigate(`/reset-password?email=${encodeURIComponent(email.trim())}${devCode}`);
    } catch (err) {
      setError(authErrorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title={t('auth.forgotTitle')}
      subtitle={t('auth.forgotSub')}
      footer={<Link to="/login" className="font-bold text-primary hover:underline">{t('auth.backToLogin')}</Link>}
    >
      <form onSubmit={submit}>
        {error && (
          <p className="mb-4 rounded-xl bg-error-container px-4 py-2.5 text-sm text-on-error-container" role="alert">{error}</p>
        )}
        <AuthField icon="mail" type="email" dir="ltr" label={t('auth.email')} placeholder="name@example.com"
          value={email} onChange={setEmail} autoComplete="email" maxLength={160} />
        <button className="btn-primary mt-2 w-full py-3" disabled={busy}>
          {busy ? t('auth.sending') : t('auth.sendResetCode')}
        </button>
      </form>
    </AuthShell>
  );
}
