import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { setLanguage } from '../i18n';
import { api } from '../lib/api';
import { useAuthStore } from '../stores/auth';

type Step = 'phone' | 'otp' | 'password';

/**
 * Faithful implementation of the student_onboarding design:
 * centered brand, white card (24px radius, modal shadow), LTR phone digits
 * inside an RTL layout, +20 country code, indigo primary CTA.
 */
export default function LoginPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { setTokens, setUser } = useAuthStore();

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [needsName, setNeedsName] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submitPhone(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/auth/otp/request', { phone });
      setStep('otp');
    } catch (err: any) {
      setError(err.response?.data?.message?.toString() ?? t('login.errorGeneric'));
    } finally {
      setBusy(false);
    }
  }

  async function submitOtp(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { data } = await api.post('/auth/otp/verify', {
        phone,
        code,
        ...(needsName && fullName ? { fullName } : {}),
        deviceName: navigator.userAgent.split(') ')[0].split(' (')[0],
      });
      setTokens(data.accessToken, data.refreshToken);
      setUser(data.user);
      navigate('/');
    } catch (err: any) {
      if (err.response?.data?.message?.code === 'SIGNUP_NAME_REQUIRED' ||
          err.response?.data?.message === 'fullName is required for signup' ||
          err.response?.data?.code === 'SIGNUP_NAME_REQUIRED') {
        setNeedsName(true);
      } else {
        setError(err.response?.data?.message?.toString() ?? t('login.errorGeneric'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { data } = await api.post('/auth/login', { emailOrPhone: email, password });
      setTokens(data.accessToken, data.refreshToken);
      setUser(data.user);
      navigate('/');
    } catch (err: any) {
      setError(err.response?.data?.message?.toString() ?? t('login.errorGeneric'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-surface via-surface-container-low to-secondary-container/20 px-4 py-10">
      <div className="mb-8 flex flex-col items-center gap-3">
        <div className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-primary-container to-primary text-on-primary shadow-[0_10px_30px_rgba(66,46,199,0.35)]">
          <span className="material-symbols-outlined text-4xl">school</span>
        </div>
        <h1 className="font-heading text-5xl font-extrabold leading-[1.35] text-primary">{t('brand')}</h1>
        <p className="-mt-1 text-on-surface-variant">{t('brandTagline')}</p>
      </div>

      <div className="w-full max-w-md rounded-xl bg-surface-container-lowest p-8 shadow-modal">
        {step === 'phone' && (
          <form onSubmit={submitPhone}>
            <h2 className="mb-6 text-center text-2xl font-bold">{t('login.title')}</h2>
            <label className="mb-2 block text-sm text-on-surface-variant">
              {t('login.phoneLabel')}
            </label>
            <div className="flex overflow-hidden rounded-lg border border-outline-variant focus-within:ring-2 focus-within:ring-primary" dir="ltr">
              <span className="flex items-center gap-1 border-e border-outline-variant bg-surface-container-low px-3 text-on-surface-variant">
                🇪🇬 +20
              </span>
              <input
                className="w-full px-4 py-3 outline-none placeholder:text-outline"
                placeholder={t('login.phonePlaceholder')}
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
              />
            </div>
            <p className="mt-2 text-sm text-outline">{t('login.otpHint')}</p>
            <button className="btn-primary mt-6 w-full" disabled={busy}>
              {t('login.continue')} ←
            </button>
          </form>
        )}

        {step === 'otp' && (
          <form onSubmit={submitOtp}>
            <h2 className="mb-2 text-center text-2xl font-bold">{t('login.otpTitle')}</h2>
            <p className="mb-6 text-center text-sm text-on-surface-variant" dir="ltr">
              {t('login.otpSentTo', { phone: `+20 ${phone.replace(/^0/, '')}` })}
            </p>
            <input
              className="input text-center text-2xl tracking-[0.5em]"
              dir="ltr"
              maxLength={4}
              inputMode="numeric"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
            {needsName && (
              <div className="mt-4">
                <p className="mb-2 text-sm text-on-surface-variant">{t('login.nameHint')}</p>
                <input
                  className="input"
                  placeholder={t('login.namePlaceholder')}
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                />
              </div>
            )}
            <button className="btn-primary mt-6 w-full" disabled={busy}>
              {t('login.verify')}
            </button>
            <button
              type="button"
              className="mt-3 w-full text-sm text-primary hover:underline"
              onClick={() => setStep('phone')}
            >
              {t('login.back')} →
            </button>
          </form>
        )}

        {step === 'password' && (
          <form onSubmit={submitPassword}>
            <h2 className="mb-6 text-center text-2xl font-bold">{t('login.teacherLogin')}</h2>
            <label className="mb-2 block text-sm text-on-surface-variant">
              {t('login.emailLabel')}
            </label>
            <input
              className="input mb-4"
              dir="ltr"
              type="text"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <label className="mb-2 block text-sm text-on-surface-variant">
              {t('login.passwordLabel')}
            </label>
            <input
              className="input"
              dir="ltr"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button className="btn-primary mt-6 w-full" disabled={busy}>
              {t('login.continue')}
            </button>
          </form>
        )}

        {error && (
          <p className="mt-4 rounded-md bg-error-container px-4 py-2 text-sm text-on-error-container">
            {error}
          </p>
        )}
      </div>

      <button
        className="mt-6 text-sm text-primary hover:underline"
        onClick={() => setStep(step === 'password' ? 'phone' : 'password')}
      >
        {step === 'password' ? t('login.studentLogin') : t('login.teacherLogin')}
      </button>

      <button
        className="mt-2 text-xs text-outline hover:text-primary"
        onClick={() => setLanguage(i18n.language === 'ar' ? 'en' : 'ar')}
      >
        {t('common.language')}
      </button>
    </div>
  );
}
