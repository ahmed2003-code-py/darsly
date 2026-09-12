import { useQuery } from '@tanstack/react-query';
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

type Role = 'student' | 'teacher';

/** Mirrors `EducationStage` on the API. */
const STAGES = ['PRIMARY', 'PREPARATORY', 'SECONDARY', 'BACCALAUREATE'] as const;
type Stage = (typeof STAGES)[number];

export default function RegisterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Where the visitor was heading before being asked to sign in.
  const destination = safeRedirect(params.get(REDIRECT_PARAM));
  const { setTokens, setUser } = useAuthStore();

  // Someone who followed a teacher's link is here to be that teacher's student.
  // Offering "sign up as a teacher" at that moment is an invitation to make the
  // wrong account — and a teacher account cannot even sign in until an admin
  // approves it, so the mistake ends the journey rather than delaying it.
  const fromAcademy = !!arrivalAcademy();
  // Only the name is shown, not the courses or colours already carried by
  // BrandTheme — this is the one screen the teacher never designed, so it
  // borrows just enough of their identity to say "still their door in", not a
  // second copy of their site.
  const { data: academy } = useAcademyBranding(fromAcademy ? arrivalAcademy()! : undefined);
  const [role, setRole] = useState<Role>('student');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingDone, setPendingDone] = useState(false);
  // Asked here rather than in a settings page afterwards: everything a teacher
  // publishes is filed under these two answers, so a profile without them can
  // build courses no student will ever be shown.
  const [subjectId, setSubjectId] = useState('');
  const [stages, setStages] = useState<Stage[]>([]);
  const { data: subjects } = useQuery({
    queryKey: ['subjects'],
    queryFn: async () => (await api.get('/catalog/subjects')).data,
    enabled: role === 'teacher',
  });
  const toggleStage = (st: Stage) =>
    setStages((cur) => (cur.includes(st) ? cur.filter((x) => x !== st) : [...cur, st]));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (role === 'student') {
        const { data } = await api.post('/auth/register/student', {
          fullName: fullName.trim(), email: email.trim(), password, phone: phone.trim(),
          deviceName: navigator.userAgent.split(') ')[0].split(' (')[0],
        });
        setTokens(data.accessToken, data.refreshToken);
        setUser(data.user);
        navigate(destination, { replace: true });
      } else {
        // Caught here so the answer is a sentence under the field rather than a
        // validation error from a round trip that created nothing.
        if (!subjectId) throw new Error(t('auth.subjectRequired'));
        if (!stages.length) throw new Error(t('auth.stagesRequired'));
        await api.post('/auth/register/teacher', {
          fullName: fullName.trim(), email: email.trim(), password, phone: phone.trim(),
          subjectId, stages,
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
        <m.div variants={rise} className="rounded-2xl border border-secondary/40 bg-secondary-container/30 p-6 text-center">
          <m.span
            className="material-symbols-outlined mb-2 inline-block text-5xl text-secondary"
            initial={{ scale: 0.6, rotate: -10 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 18, delay: 0.15 }}
          >
            mark_email_read
          </m.span>
          <p className="font-heading text-lg font-bold">{t('auth.pendingHeadline')}</p>
          <p className="mt-1 text-sm text-on-surface-variant">{t('auth.pendingBody')}</p>
        </m.div>
        <m.div variants={rise}>
          <Link to={withRedirect('/login', destination)} className="btn-primary mt-6 block w-full py-3 text-center">{t('auth.backToLogin')}</Link>
        </m.div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={academy ? t('auth.joinAcademyTitle', { name: academy.name }) : t('auth.createAccount')}
      subtitle={academy ? t('auth.joinAcademySubtitle', { name: academy.name }) : t('auth.signupSubtitle')}
      brandName={academy?.name}
      brandTagline={academy?.tagline}
      footer={
        <>
          {t('auth.haveAccount')}{' '}
          <Link to={withRedirect('/login', destination)} className="font-bold text-primary hover:underline">{t('auth.loginLink')}</Link>
        </>
      }
    >
      <form onSubmit={submit}>
        {/* Role toggle — hidden for anyone who came in through an academy. */}
        {!fromAcademy && (
          <AuthSegmented<Role>
            value={role}
            onChange={setRole}
            options={[
              { value: 'student', label: t('auth.asStudent'), icon: 'backpack' },
              { value: 'teacher', label: t('auth.asTeacher'), icon: 'cast_for_education' },
            ]}
          />
        )}
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
        <AuthField icon="person" label={t('auth.fullName')} placeholder={t('auth.fullNamePh')}
          value={fullName} onChange={setFullName} autoComplete="name" maxLength={120} />
        <AuthField icon="mail" type="email" dir="ltr" label={t('auth.email')} placeholder="name@example.com"
          value={email} onChange={setEmail} autoComplete="email" maxLength={160} />
        {/* Mirrors EGY_PHONE_REGEX on the API — a wrong number is caught here
            rather than after a round trip that also creates nothing. */}
        <AuthField icon="phone" type="tel" dir="ltr" label={t('auth.phone')} inputMode="tel"
          pattern="(\+20|0020|20|0)?1[0125][0-9]{8}" title={t('auth.phoneHint')} maxLength={16}
          placeholder="01xxxxxxxxx" value={phone} onChange={setPhone} autoComplete="tel" />
        <AuthField icon="lock" type={show ? 'text' : 'password'} dir="ltr" label={t('auth.password')}
          placeholder="••••••••" value={password} onChange={setPassword} autoComplete="new-password"
          reveal revealed={show} onReveal={() => setShow((s) => !s)} hint={t('auth.passwordHint')} />

        {role === 'teacher' && (
          <>
            <label className="mb-4 block">
              <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
                {t('auth.subject')}
              </span>
              <select className="input" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                <option value="">{t('auth.subjectPh')}</option>
                {(subjects ?? []).map((sub: { id: string; nameAr: string; nameEn: string }) => (
                  <option key={sub.id} value={sub.id}>{sub.nameAr}</option>
                ))}
              </select>
            </label>

            {/* Toggles rather than a multi-select: picking more than one is the
                normal case here, and a native multi-select hides that you can. */}
            <div className="mb-4">
              <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
                {t('auth.stages')}
              </span>
              <div className="flex flex-wrap gap-2">
                {STAGES.map((st) => {
                  const on = stages.includes(st);
                  return (
                    <button key={st} type="button" onClick={() => toggleStage(st)} aria-pressed={on}
                      className={`rounded-full border px-4 py-2 text-sm font-semibold transition ${
                        on
                          ? 'border-primary bg-primary text-on-primary'
                          : 'border-outline-variant text-on-surface-variant hover:border-outline'
                      }`}>
                      {t(`stage.${st}`)}
                    </button>
                  );
                })}
              </div>
              <span className="mt-1.5 block text-xs text-outline">{t('auth.stagesHint')}</span>
            </div>
          </>
        )}

        <div className="mt-6">
          <AuthSubmit busy={busy}>{busy ? t('auth.creating') : t('auth.createBtn')}</AuthSubmit>
        </div>
      </form>
    </AuthShell>
  );
}
