import { m } from 'framer-motion';
import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import AuthShell, { AuthField, AuthSubmit, rise } from '../components/AuthShell';
import { api } from '../lib/api';
import { authErrorText } from '../lib/authError';
import { arrivalAcademy } from '../lib/arrival';
import { useAcademyBranding } from '../lib/academy';
import { REDIRECT_PARAM, safeRedirect, withRedirect } from '../lib/redirect';
import { useAuthStore } from '../stores/auth';

export default function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Where the visitor was heading before being asked to sign in.
  const destination = safeRedirect(params.get(REDIRECT_PARAM));
  const { setTokens, setUser } = useAuthStore();
  const arrival = arrivalAcademy();
  const { data: academy } = useAcademyBranding(arrival ?? undefined);

  // One field; the server tells an email from a phone number. Nothing to pick.
  const [identifier, setIdentifier] = useState('');
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
        identifier: identifier.trim(),
        password,
        deviceName: navigator.userAgent.split(') ')[0].split(' (')[0],
      });
      setTokens(data.accessToken, data.refreshToken);
      setUser(data.user);
      navigate(destination, { replace: true });
    } catch (err) {
      setError(authErrorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title={academy ? t('auth.welcomeAcademy', { name: academy.name }) : t('auth.welcomeBack')}
      subtitle={academy ? t('auth.loginAcademySubtitle', { name: academy.name }) : t('auth.loginSubtitle')}
      brandName={academy?.name}
      brandTagline={academy?.tagline}
      footer={
        <>
          {t('auth.noAccount')}{' '}
          <Link to={withRedirect('/register', destination)} className="font-bold text-primary hover:underline">{t('auth.signupLink')}</Link>
        </>
      }
    >
      <form onSubmit={submit}>
        {error && (
          <m.p
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 rounded-xl bg-error-container px-4 py-2.5 text-sm text-on-error-container"
            role="alert"
          >
            {error}
          </m.p>
        )}
        <AuthField icon="person" dir="ltr" inputMode="email" autoComplete="username"
          label={t('auth.identifier')} placeholder={t('auth.identifierPh')}
          value={identifier} onChange={setIdentifier} maxLength={160} autoFocus />
        <AuthField icon="lock" type={show ? 'text' : 'password'} dir="ltr" autoComplete="current-password"
          label={t('auth.password')} placeholder="••••••••" value={password} onChange={setPassword}
          reveal revealed={show} onReveal={() => setShow((s) => !s)} />

        <m.div variants={rise} className="mb-6 text-end">
          <Link to={withRedirect('/forgot-password', destination)} className="text-sm text-primary hover:underline">{t('auth.forgot')}</Link>
        </m.div>

        <AuthSubmit busy={busy}>{busy ? t('auth.signingIn') : t('auth.loginBtn')}</AuthSubmit>
      </form>
    </AuthShell>
  );
}
