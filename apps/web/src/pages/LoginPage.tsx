import { m } from 'framer-motion';
import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import AuthShell, { AuthField, AuthSegmented, AuthSubmit, rise } from '../components/AuthShell';
import { api } from '../lib/api';
import { authErrorText } from '../lib/authError';
import { arrivalAcademy } from '../lib/arrival';
import { useAcademyBranding } from '../lib/academy';
import { REDIRECT_PARAM, safeRedirect, withRedirect } from '../lib/redirect';
import { useAuthStore } from '../stores/auth';

/** What a person signs in with. The server works it out either way; the
 *  choice here just gives them the right keyboard and the right hint. */
type Method = 'email' | 'phone' | 'username';
const METHOD_KEY = 'darsly-login-method';

function rememberedMethod(): Method {
  try {
    const v = localStorage.getItem(METHOD_KEY);
    return v === 'phone' || v === 'username' ? v : 'email';
  } catch {
    return 'email';
  }
}

export default function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Where the visitor was heading before being asked to sign in.
  const destination = safeRedirect(params.get(REDIRECT_PARAM));
  const { setTokens, setUser } = useAuthStore();
  const arrival = arrivalAcademy();
  const { data: academy } = useAcademyBranding(arrival ?? undefined);

  const [method, setMethod] = useState<Method>(rememberedMethod);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const pickMethod = (mth: Method) => {
    setMethod(mth);
    setIdentifier('');
    try {
      localStorage.setItem(METHOD_KEY, mth);
    } catch {
      /* private mode — the choice just doesn't stick */
    }
  };

  const field = {
    email: { icon: 'mail', type: 'email', inputMode: 'email' as const, placeholder: 'name@example.com', autoComplete: 'email', label: t('auth.email') },
    phone: { icon: 'smartphone', type: 'tel', inputMode: 'tel' as const, placeholder: '01xxxxxxxxx', autoComplete: 'tel', label: t('auth.phone') },
    username: { icon: 'alternate_email', type: 'text', inputMode: 'text' as const, placeholder: 'ahmed_m', autoComplete: 'username', label: t('auth.username') },
  }[method];

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
        <AuthSegmented
          value={method}
          onChange={pickMethod}
          options={[
            { value: 'email', label: t('auth.methodEmail'), icon: 'mail' },
            { value: 'phone', label: t('auth.methodPhone'), icon: 'smartphone' },
            { value: 'username', label: t('auth.methodUsername'), icon: 'alternate_email' },
          ]}
        />
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
        {/* Keyed on the method so the field re-mounts and steps in fresh. */}
        <AuthField key={method} {...field} dir="ltr" value={identifier} onChange={setIdentifier} maxLength={160} autoFocus />
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
