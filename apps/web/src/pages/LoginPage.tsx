import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import AuthShell, { AuthField } from '../components/AuthShell';
import { api } from '../lib/api';
import { authErrorText } from '../lib/authError';
import { useAuthStore } from '../stores/auth';

export default function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { setTokens, setUser } = useAuthStore();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { data } = await api.post('/auth/login', {
        email: email.trim(),
        password,
        deviceName: navigator.userAgent.split(') ')[0].split(' (')[0],
      });
      setTokens(data.accessToken, data.refreshToken);
      setUser(data.user);
      navigate('/');
    } catch (err) {
      setError(authErrorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title={t('auth.welcomeBack')}
      subtitle={t('auth.loginSubtitle')}
      footer={
        <>
          {t('auth.noAccount')}{' '}
          <Link to="/register" className="font-bold text-primary hover:underline">{t('auth.signupLink')}</Link>
        </>
      }
    >
      <form onSubmit={submit}>
        {error && (
          <p className="mb-4 rounded-xl bg-error-container px-4 py-2.5 text-sm text-on-error-container" role="alert">
            {error}
          </p>
        )}
        <AuthField icon="mail" type="email" dir="ltr" autoComplete="username" label={t('auth.email')}
          placeholder="name@example.com" value={email} onChange={setEmail} />
        <AuthField icon="lock" type={show ? 'text' : 'password'} dir="ltr" autoComplete="current-password"
          label={t('auth.password')} placeholder="••••••••" value={password} onChange={setPassword}
          reveal revealed={show} onReveal={() => setShow((s) => !s)} />

        <div className="mb-6 text-end">
          <Link to="/forgot-password" className="text-sm text-primary hover:underline">{t('auth.forgot')}</Link>
        </div>

        <button className="btn-primary w-full py-3" disabled={busy}>
          {busy ? t('auth.signingIn') : t('auth.loginBtn')}
        </button>
      </form>
    </AuthShell>
  );
}
