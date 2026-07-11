import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import AuthShell, { AuthField } from '../components/AuthShell';
import { api } from '../lib/api';
import { authErrorText } from '../lib/authError';
import { useAuthStore } from '../stores/auth';

type Role = 'student' | 'teacher';

export default function RegisterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { setTokens, setUser } = useAuthStore();

  const [role, setRole] = useState<Role>('student');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingDone, setPendingDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (role === 'student') {
        const { data } = await api.post('/auth/register/student', {
          fullName: fullName.trim(), email: email.trim(), password,
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          deviceName: navigator.userAgent.split(') ')[0].split(' (')[0],
        });
        setTokens(data.accessToken, data.refreshToken);
        setUser(data.user);
        navigate('/');
      } else {
        await api.post('/auth/register/teacher', {
          fullName: fullName.trim(), email: email.trim(), password, phone: phone.trim(),
        });
        setPendingDone(true);
      }
    } catch (err) {
      setError(authErrorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  if (pendingDone) {
    return (
      <AuthShell title={t('auth.pendingTitle')} subtitle={t('auth.pendingSub')}>
        <div className="rounded-2xl border border-secondary/40 bg-secondary-container/30 p-6 text-center">
          <span className="material-symbols-outlined mb-2 text-5xl text-secondary">mark_email_read</span>
          <p className="font-heading text-lg font-bold">{t('auth.pendingHeadline')}</p>
          <p className="mt-1 text-sm text-on-surface-variant">{t('auth.pendingBody')}</p>
        </div>
        <Link to="/login" className="btn-primary mt-6 block w-full py-3 text-center">{t('auth.backToLogin')}</Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t('auth.createAccount')}
      subtitle={t('auth.signupSubtitle')}
      footer={
        <>
          {t('auth.haveAccount')}{' '}
          <Link to="/login" className="font-bold text-primary hover:underline">{t('auth.loginLink')}</Link>
        </>
      }
    >
      {/* Role toggle */}
      <div className="mb-6 grid grid-cols-2 gap-1 rounded-2xl bg-surface-container-low p-1">
        {(['student', 'teacher'] as Role[]).map((r) => (
          <button key={r} type="button" onClick={() => setRole(r)}
            className={`flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-bold transition ${
              role === r ? 'bg-primary text-on-primary shadow' : 'text-on-surface-variant hover:text-primary'}`}>
            <span className="material-symbols-outlined text-lg">{r === 'student' ? 'backpack' : 'cast_for_education'}</span>
            {t(r === 'student' ? 'auth.asStudent' : 'auth.asTeacher')}
          </button>
        ))}
      </div>

      <form onSubmit={submit}>
        {error && (
          <p className="mb-4 rounded-xl bg-error-container px-4 py-2.5 text-sm text-on-error-container" role="alert">
            {error}
          </p>
        )}
        <AuthField icon="person" label={t('auth.fullName')} placeholder={t('auth.fullNamePh')}
          value={fullName} onChange={setFullName} autoComplete="name" />
        <AuthField icon="mail" type="email" dir="ltr" label={t('auth.email')} placeholder="name@example.com"
          value={email} onChange={setEmail} autoComplete="email" />
        <AuthField icon="phone" type="tel" dir="ltr" label={role === 'teacher' ? t('auth.phone') : t('auth.phoneOptional')}
          placeholder="01xxxxxxxxx" value={phone} onChange={setPhone} autoComplete="tel" />
        <AuthField icon="lock" type={show ? 'text' : 'password'} dir="ltr" label={t('auth.password')}
          placeholder="••••••••" value={password} onChange={setPassword} autoComplete="new-password"
          reveal revealed={show} onReveal={() => setShow((s) => !s)} />
        <p className="mb-6 -mt-2 text-xs text-outline">{t('auth.passwordHint')}</p>

        <button className="btn-primary w-full py-3" disabled={busy}>
          {busy ? t('auth.creating') : t('auth.createBtn')}
        </button>
      </form>
    </AuthShell>
  );
}
