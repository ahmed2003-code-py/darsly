import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import AuthShell, { AuthField } from '../components/AuthShell';
import { api } from '../lib/api';
import { authErrorText } from '../lib/authError';

export default function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  // Dev convenience: without SMTP the API returns the token so you can test.
  const [devLink, setDevLink] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { data } = await api.post('/auth/forgot-password', { email: email.trim() });
      setSent(true);
      if (data?.devResetToken) setDevLink(`/reset-password?token=${data.devResetToken}`);
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
      {sent ? (
        <div className="rounded-2xl border border-secondary/40 bg-secondary-container/30 p-6 text-center">
          <span className="material-symbols-outlined mb-2 text-5xl text-secondary">outgoing_mail</span>
          <p className="font-heading text-lg font-bold">{t('auth.forgotSentTitle')}</p>
          <p className="mt-1 text-sm text-on-surface-variant">{t('auth.forgotSentBody')}</p>
          {devLink && (
            <Link to={devLink} className="mt-4 inline-block break-all rounded-lg bg-primary-fixed/60 px-3 py-2 text-xs text-primary hover:underline">
              {t('auth.devResetLink')} →
            </Link>
          )}
        </div>
      ) : (
        <form onSubmit={submit}>
          {error && (
            <p className="mb-4 rounded-xl bg-error-container px-4 py-2.5 text-sm text-on-error-container" role="alert">{error}</p>
          )}
          <AuthField icon="mail" type="email" dir="ltr" label={t('auth.email')} placeholder="name@example.com"
            value={email} onChange={setEmail} autoComplete="email" />
          <button className="btn-primary mt-2 w-full py-3" disabled={busy}>
            {busy ? t('auth.sending') : t('auth.sendResetLink')}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
