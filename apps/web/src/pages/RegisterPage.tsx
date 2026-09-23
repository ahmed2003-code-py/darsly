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
import {
  invitationTokenFromPath,
  registerViaInvitation,
  useInvitationPreview,
} from '../lib/invitationLinks';
import { REDIRECT_PARAM, safeRedirect, withRedirect } from '../lib/redirect';
import { useAuthStore } from '../stores/auth';
import GradeSelect from '../components/GradeSelect';
import SubjectPicker from '../components/SubjectPicker';
import { Skeleton } from '../components/ui';
import { STAGES, type Stage } from '../lib/stages';
import { STUDENT_TRACKS, type StudentTrack, type Subject } from '../lib/subjects';

type Role = 'student' | 'teacher';

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
  // Someone who followed a Center's invitation link is here to join THAT
  // Center in the role the link names. The server's preview says which; the
  // question "teacher or student?" is never asked, and the answer is never
  // sent — the token carries it.
  const inviteToken = invitationTokenFromPath(destination);
  const {
    data: invite,
    isLoading: inviteLoading,
    isError: inviteInvalid,
  } = useInvitationPreview(inviteToken ?? undefined);
  const [role, setRole] = useState<Role>('student');
  // Which extra questions the form asks. An invited TEACHER still names what
  // they teach (courses are filed under it); an invited ASSISTANT authors
  // nothing and is asked for neither that nor a student's year.
  const asksTeaching = inviteToken ? invite?.role === 'TEACHER' : role === 'teacher';
  const asksStudent = !inviteToken && role === 'student';
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
  const [subjectIds, setSubjectIds] = useState<string[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  // A student's year decides what the whole app shows them, so it is asked for
  // here rather than left to a settings page they would have no reason to open.
  const [gradeId, setGradeId] = useState('');
  // And which of the two school systems they are in, for the same reason: the
  // syllabus behind a subject name is not the same in both.
  const [track, setTrack] = useState<StudentTrack | ''>('');
  const { data: grades } = useQuery({
    queryKey: ['grades'],
    queryFn: async () => (await api.get('/catalog/grades')).data,
    enabled: asksStudent,
  });
  // The whole catalogue, both systems: a teacher signing up has not said which
  // ones they teach yet, and that is exactly what this list is for.
  const { data: subjects } = useQuery<Subject[]>({
    queryKey: ['subjects', 'all'],
    queryFn: async () => (await api.get('/catalog/subjects')).data,
    enabled: asksTeaching,
  });
  const toggleStage = (st: Stage) =>
    setStages((cur) => (cur.includes(st) ? cur.filter((x) => x !== st) : [...cur, st]));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (inviteToken) {
        if (asksTeaching && !subjectIds.length) throw new Error(t('auth.subjectRequired'));
        if (asksTeaching && !stages.length) throw new Error(t('auth.stagesRequired'));
        // No role, no Center, no owner in this body — the token is all of them.
        const data = await registerViaInvitation({
          token: inviteToken,
          fullName: fullName.trim(),
          email: email.trim(),
          password,
          phone: phone.trim(),
          ...(asksTeaching ? { subjectIds, stages } : {}),
          deviceName: navigator.userAgent.split(') ')[0].split(' (')[0],
        });
        setTokens(data.accessToken, data.refreshToken);
        setUser(data.user);
        navigate('/teacher', { replace: true });
      } else if (role === 'student') {
        if (!gradeId) throw new Error(t('auth.gradeRequired'));
        if (!track) throw new Error(t('auth.trackRequired'));
        const { data } = await api.post('/auth/register/student', {
          fullName: fullName.trim(),
          email: email.trim(),
          password,
          phone: phone.trim(),
          gradeId,
          track,
          deviceName: navigator.userAgent.split(') ')[0].split(' (')[0],
        });
        setTokens(data.accessToken, data.refreshToken);
        setUser(data.user);
        navigate(destination, { replace: true });
      } else {
        // Caught here so the answer is a sentence under the field rather than a
        // validation error from a round trip that created nothing.
        if (!subjectIds.length) throw new Error(t('auth.subjectRequired'));
        if (!stages.length) throw new Error(t('auth.stagesRequired'));
        await api.post('/auth/register/teacher', {
          fullName: fullName.trim(),
          email: email.trim(),
          password,
          phone: phone.trim(),
          subjectIds,
          stages,
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
        <m.div
          variants={rise}
          className="rounded-2xl border border-secondary/40 bg-secondary-container/30 p-6 text-center"
        >
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
          <Link
            to={withRedirect('/login', destination)}
            className="btn-primary mt-6 block w-full py-3 text-center"
          >
            {t('auth.backToLogin')}
          </Link>
        </m.div>
      </AuthShell>
    );
  }

  // An invitation that cannot be previewed is one that cannot be joined: say
  // so here rather than let someone fill a form the server will refuse.
  if (inviteToken && inviteInvalid) {
    return (
      <AuthShell title={t('joinCenter.title')}>
        <m.div variants={rise} className="card p-6 text-center">
          <span className="material-symbols-outlined mb-2 text-5xl text-error">link_off</span>
          <p className="font-heading font-bold">{t('joinCenter.invalid')}</p>
          <p className="mt-1 text-sm text-on-surface-variant">{t('joinCenter.invalidHint')}</p>
        </m.div>
      </AuthShell>
    );
  }

  const inviteRoleLabel = invite
    ? t(invite.role === 'TEACHER' ? 'academy.roleTeacher' : 'academy.roleAssistant')
    : '';
  const title = invite
    ? t('auth.joinCenterTitle', { name: invite.academyName })
    : academy
      ? t('auth.joinAcademyTitle', { name: academy.name })
      : t('auth.createAccount');
  const subtitle = invite
    ? t('auth.joinCenterSubtitle', { role: inviteRoleLabel })
    : academy
      ? t('auth.joinAcademySubtitle', { name: academy.name })
      : t('auth.signupSubtitle');

  return (
    <AuthShell
      title={title}
      subtitle={subtitle}
      brandName={invite?.academyName ?? academy?.name}
      brandTagline={academy?.tagline}
      footer={
        <>
          {t('auth.haveAccount')}{' '}
          <Link
            to={withRedirect('/login', destination)}
            className="font-bold text-primary hover:underline"
          >
            {t('auth.loginLink')}
          </Link>
        </>
      }
    >
      <form onSubmit={submit}>
        {inviteToken && inviteLoading && <Skeleton className="mb-4 h-10 rounded-xl" />}
        {invite && (
          <m.div
            variants={rise}
            className="mb-4 flex items-center gap-2 rounded-xl bg-primary-container/40 px-4 py-2.5 text-sm"
          >
            <span className="material-symbols-outlined text-primary">apartment</span>
            <span>
              {t('joinCenter.invitedAs')} <span className="font-bold">{inviteRoleLabel}</span> ·{' '}
              {invite.academyName}
            </span>
          </m.div>
        )}
        {/* Role toggle — hidden for anyone who came in through an academy or a
            Center invitation: in both cases the door they used already says
            who they are. */}
        {!fromAcademy && !inviteToken && (
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
        <AuthField
          icon="person"
          label={t('auth.fullName')}
          placeholder={t('auth.fullNamePh')}
          value={fullName}
          onChange={setFullName}
          autoComplete="name"
          maxLength={120}
        />
        <AuthField
          icon="mail"
          type="email"
          dir="ltr"
          label={t('auth.email')}
          placeholder="name@example.com"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          maxLength={160}
        />
        {/* Mirrors EGY_PHONE_REGEX on the API — a wrong number is caught here
            rather than after a round trip that also creates nothing. */}
        <AuthField
          icon="phone"
          type="tel"
          dir="ltr"
          label={t('auth.phone')}
          inputMode="tel"
          pattern="(\+20|0020|20|0)?1[0125][0-9]{8}"
          title={t('auth.phoneHint')}
          maxLength={16}
          placeholder="01xxxxxxxxx"
          value={phone}
          onChange={setPhone}
          autoComplete="tel"
        />
        <AuthField
          icon="lock"
          type={show ? 'text' : 'password'}
          dir="ltr"
          label={t('auth.password')}
          placeholder="••••••••"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          reveal
          revealed={show}
          onReveal={() => setShow((s) => !s)}
          hint={t('auth.passwordHint')}
        />

        {asksStudent && (
          <label className="mb-4 block">
            <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
              {t('auth.grade')}
            </span>
            {/* Grouped by stage: fifteen years in one flat list is a scroll, and
                the groups are how a student thinks about which one is theirs. */}
            <GradeSelect value={gradeId} onChange={setGradeId} grades={grades} />
            <span className="mt-1.5 block text-xs text-outline">{t('auth.gradeHint')}</span>
          </label>
        )}

        {asksStudent && (
          <div className="mb-4">
            <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
              {t('auth.track')}
            </span>
            {/* Two buttons rather than a dropdown: there are exactly two answers
                and both fit on the narrowest phone, so nothing is worth hiding
                behind a tap. */}
            <div className="grid grid-cols-2 gap-2">
              {STUDENT_TRACKS.map((tr) => (
                <button
                  key={tr}
                  type="button"
                  onClick={() => setTrack(tr)}
                  className={`rounded-xl border px-3 py-3 text-sm font-bold transition ${
                    track === tr
                      ? 'border-primary bg-primary text-on-primary'
                      : 'border-outline-variant hover:border-primary hover:text-primary'
                  }`}
                >
                  {t(`subjects.track.${tr}`)}
                </button>
              ))}
            </div>
            <span className="mt-1.5 block text-xs text-outline">{t('auth.trackHint')}</span>
          </div>
        )}

        {asksTeaching && (
          <>
            <label className="mb-4 block">
              <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
                {t('auth.subject')}
              </span>
              <SubjectPicker
                subjects={subjects ?? []}
                value={subjectIds}
                onChange={setSubjectIds}
              />
              <span className="mt-1.5 block text-xs text-outline">{t('auth.subjectHint')}</span>
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
                    <button
                      key={st}
                      type="button"
                      onClick={() => toggleStage(st)}
                      aria-pressed={on}
                      className={`rounded-full border px-4 py-2 text-sm font-semibold transition ${
                        on
                          ? 'border-primary bg-primary text-on-primary'
                          : 'border-outline-variant text-on-surface-variant hover:border-outline'
                      }`}
                    >
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
          <AuthSubmit busy={busy || (!!inviteToken && !invite)}>
            {busy ? t('auth.creating') : t('auth.createBtn')}
          </AuthSubmit>
        </div>
      </form>
    </AuthShell>
  );
}
