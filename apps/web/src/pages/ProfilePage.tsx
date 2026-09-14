import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { authErrorText } from '../lib/authError';
import { dateShort } from '../lib/format';
import { imageToDataUrl } from '../lib/image';
import { setLanguage } from '../i18n';
import { useAuthStore } from '../stores/auth';
import { Badge, ErrorNote, Field, PageHeader, Spinner } from '../components/ui';
import { Role } from '@darsly/shared-types';
import { GAMIFICATION_KEY, useGamification, useLocalized } from '../lib/gamification';
import { LevelCard } from '../components/gamification/LevelCard';
import GradeSelect from '../components/GradeSelect';
import SubjectPicker from '../components/SubjectPicker';
import { STAGES } from '../lib/stages';
import { STUDENT_TRACKS, type StudentTrack, type Subject } from '../lib/subjects';

/** A titled block, so the page reads as a set of decisions rather than a form. */
function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-fixed text-on-primary-fixed">
          <span className="material-symbols-outlined text-xl">{icon}</span>
        </span>
        <div>
          <h3 className="font-heading text-lg font-bold">{title}</h3>
          {hint && <p className="text-sm text-on-surface-variant">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

/** A password box with an eye — what you typed, when you want to see it. */
function PasswordInput({
  value, onChange, autoComplete, minLength,
}: {
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  minLength?: number;
}) {
  const [shown, setShown] = useState(false);
  // The whole box is LTR, like the password inside it, so the eye and the
  // padding that makes room for it land on the same side in either language.
  return (
    <span className="relative block" dir="ltr">
      <input
        className="input pe-12"
        type={shown ? 'text' : 'password'}
        dir="ltr"
        autoComplete={autoComplete}
        required
        minLength={minLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        tabIndex={-1}
        className="absolute end-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-lg text-outline transition hover:bg-surface-container-low hover:text-primary"
        onClick={() => setShown((v) => !v)}
        aria-label={shown ? 'hide password' : 'show password'}
      >
        <span className="material-symbols-outlined text-xl">{shown ? 'visibility_off' : 'visibility'}</span>
      </button>
    </span>
  );
}

function ReadOnlyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border-b border-outline-variant/40 py-3 last:border-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm text-on-surface-variant">{label}</span>
        <span className="min-w-0 break-all font-semibold" dir="auto">
          {value}
        </span>
      </div>
      {/* On its own line rather than tucked under the value: right-aligned, a
          sentence-long hint wraps to three ragged lines in a half-width card. */}
      {hint && <p className="mt-1 text-xs text-outline">{hint}</p>}
    </div>
  );
}

export default function ProfilePage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user, setUser, clear } = useAuthStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  // Kept alongside the name rather than buried: moving up a year is the one
  // edit a student actually comes here to make, and it changes every listing
  // they see afterwards.
  const [gradeId, setGradeId] = useState('');
  // Nobody who signed up before the question existed has an answer on file, so
  // this is also where they give one for the first time.
  const [track, setTrack] = useState<StudentTrack | ''>('');

  const { data, isLoading } = useQuery({
    queryKey: ['my-profile'],
    queryFn: async () => (await api.get('/me/profile')).data,
  });
  const isStudent = data?.role === 'STUDENT';
  const { data: grades } = useQuery({
    queryKey: ['grades'],
    queryFn: async () => (await api.get('/catalog/grades')).data,
    enabled: isStudent,
  });
  useEffect(() => {
    if (data?.fullName) setName(data.fullName);
    if (data?.studentProfile?.gradeId) setGradeId(data.studentProfile.gradeId);
    if (data?.studentProfile?.track) setTrack(data.studentProfile.track);
  }, [data]);

  const syncUser = (patch: Record<string, unknown>) => {
    if (user) setUser({ ...user, ...patch } as any);
    qc.invalidateQueries({ queryKey: ['my-profile'] });
  };

  const avatar = useMutation({
    mutationFn: async (file: File) => {
      const dataUrl = await imageToDataUrl(file, { maxW: 512, maxH: 512, quality: 0.85, square: true });
      return (await api.post('/me/avatar', { dataUrl })).data;
    },
    onSuccess: (d) => syncUser({ avatarUrl: d.avatarUrl }),
  });
  const removeAvatar = useMutation({
    mutationFn: async () => (await api.delete('/me/avatar')).data,
    onSuccess: () => syncUser({ avatarUrl: null }),
  });
  const saveName = useMutation({
    mutationFn: async () =>
      (await api.patch('/me/profile', {
        fullName: name.trim(),
        ...(isStudent && gradeId ? { gradeId } : {}),
        ...(isStudent && track ? { track } : {}),
      })).data,
    onSuccess: (d) => {
      syncUser({ fullName: d.fullName });
      // Every listing is filtered by the year, so they all have to be re-asked.
      qc.invalidateQueries({ queryKey: ['discover-courses'] });
      qc.invalidateQueries({ queryKey: ['discover-teachers'] });
    },
  });

  // Changed right here, against the current password — the emailed link it
  // replaced depended on a mail provider the platform doesn't reliably have.
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwMismatch, setPwMismatch] = useState(false);
  const changePassword = useMutation({
    mutationFn: async () =>
      (await api.post('/auth/change-password', { currentPassword: currentPw, newPassword: newPw })).data,
    onSuccess: () => {
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
    },
  });
  function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    const mismatch = newPw !== confirmPw;
    setPwMismatch(mismatch);
    if (!mismatch) changePassword.mutate();
  }

  async function logout() {
    // Best effort: the local session must be cleared even if the call fails,
    // otherwise a user who taps "sign out" offline stays signed in.
    try {
      await api.post('/auth/logout');
    } catch {
      /* ignore */
    }
    clear();
    navigate('/login', { replace: true });
  }

  if (isLoading) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }

  const avatarUrl = data?.avatarUrl ?? user?.avatarUrl;
  const role = data?.role ?? user?.role;

  return (
    <div className="mx-auto max-w-container px-4 py-5 sm:px-8 sm:py-8">
      <PageHeader title={t('profile.title')} subtitle={t('profile.subtitle')} />

      {/*
        Identity on one side, the settings beside it. As a single narrow column
        this was five cards deep — a page of mostly empty margin that had to be
        scrolled to reach a language dropdown. Nothing here is long enough to
        deserve its own screenful, so on a wide viewport it all sits above the
        fold, and the columns collapse back to the stack on a phone.
      */}
      <div className="grid items-start gap-4 sm:gap-5 lg:grid-cols-[minmax(0,22rem)_1fr]">
        {/* Identity — who the account belongs to, and the one thing here that is
            editable inline. Sticky, so it stays put while the rest is read. */}
        <section className="card lg:sticky lg:top-8">
          <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:items-center sm:gap-5 sm:text-start">
            <div className="relative">
              <div className="grid h-24 w-24 place-items-center overflow-hidden rounded-full bg-primary-fixed text-3xl font-extrabold text-on-primary-fixed shadow-card">
                {avatarUrl ? (
                  <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  (name?.trim()?.[0] ?? '?')
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && avatar.mutate(e.target.files[0])}
              />
              <button
                className="absolute -bottom-1 -end-1 grid h-9 w-9 place-items-center rounded-full bg-primary text-on-primary shadow-glow transition hover:scale-105"
                disabled={avatar.isPending}
                onClick={() => fileRef.current?.click()}
                title={t('profile.changePhoto')}
                aria-label={t('profile.changePhoto')}
              >
                <span className="material-symbols-outlined text-lg">
                  {avatar.isPending ? 'hourglass' : 'photo_camera'}
                </span>
              </button>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                <p className="font-heading text-xl font-extrabold">{data?.fullName}</p>
                {role && <Badge tone="primary">{t(`profile.role${role}`)}</Badge>}
              </div>
              <p className="text-sm text-outline" dir="ltr">
                {data?.email ?? data?.phone}
              </p>
              {avatarUrl && (
                <button
                  className="mt-2 text-sm text-error hover:underline"
                  onClick={() => removeAvatar.mutate()}
                >
                  {t('profile.removePhoto')}
                </button>
              )}
            </div>
          </div>

          <div className="mt-6 border-t border-outline-variant/40 pt-6">
            <Field label={t('profile.fullName')}>
              <input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            {isStudent && (
              <Field label={t('auth.grade')} hint={t('profile.gradeHint')}>
                <GradeSelect value={gradeId} onChange={setGradeId} grades={grades} />
              </Field>
            )}
            {isStudent && (
              <Field label={t('auth.track')} hint={t('profile.trackHint')}>
                <div className="grid grid-cols-2 gap-2">
                  {STUDENT_TRACKS.map((tr) => (
                    <button
                      key={tr}
                      type="button"
                      aria-pressed={track === tr}
                      onClick={() => setTrack(tr)}
                      className={`rounded-xl border px-3 py-2.5 text-sm font-bold transition ${
                        track === tr
                          ? 'border-primary bg-primary text-on-primary'
                          : 'border-outline-variant text-on-surface-variant hover:border-outline'
                      }`}
                    >
                      {t(`subjects.track.${tr}`)}
                    </button>
                  ))}
                </div>
              </Field>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <button
                className="btn-primary w-full sm:w-auto"
                disabled={
                  saveName.isPending ||
                  !name.trim() ||
                  (name.trim() === data?.fullName &&
                    gradeId === (data?.studentProfile?.gradeId ?? '') &&
                    track === (data?.studentProfile?.track ?? ''))
                }
                onClick={() => saveName.mutate()}
              >
                {saveName.isPending ? t('common.saving') : t('common.save')}
              </button>
              {saveName.isSuccess && (
                <span className="text-sm font-semibold text-primary">{t('common.saved')}</span>
              )}
            </div>
            <ErrorNote error={saveName.error ?? avatar.error} />
          </div>
        </section>

        {/* Everything that is not the identity card shares the wide column.
            Left as siblings of the two-column grid they were auto-placed one
            per cell, so the settings block wrapped underneath the 22rem
            identity card and had to squeeze its own two columns into it. */}
        <div className="space-y-4 sm:space-y-5">
        {/* The learning half of a profile. A student's identity here is what
            they have learned, not only what their account settings say. */}
        <LearningSection />

        {/* A teacher's equivalent of the year above: the two answers every
            course they publish is filed under. It lives here because this is
            where the course form sends them looking for it. */}
        <TeachingSection role={data?.role} />
        <MessagingSection role={data?.role} />

        {/* Two-up once there is room for it — these blocks are three rows
            each, not articles. */}
        <div className="grid gap-4 sm:gap-5 xl:grid-cols-2">
        <Section icon="badge" title={t('profile.sectionAccount')}>
          <ReadOnlyRow
            label={t('profile.email')}
            value={data?.email ?? t('profile.notSet')}
            hint={data?.email ? t('profile.emailLocked') : undefined}
          />
          <ReadOnlyRow
            label={t('profile.phone')}
            value={data?.phone ?? t('profile.notSet')}
            hint={data?.phone ? t('profile.phoneLocked') : undefined}
          />
          {data?.createdAt && (
            <ReadOnlyRow label={t('profile.memberSince')} value={dateShort(data.createdAt)} />
          )}
        </Section>

        <Section icon="tune" title={t('profile.sectionPrefs')}>
          <Field label={t('profile.language')} hint={t('profile.languageHint')}>
            <select
              className="input py-2"
              value={i18n.language.startsWith('ar') ? 'ar' : 'en'}
              onChange={(e) => setLanguage(e.target.value as 'ar' | 'en')}
            >
              <option value="ar">العربية</option>
              <option value="en">English</option>
            </select>
          </Field>
        </Section>

        <Section icon="lock" title={t('profile.sectionSecurity')}>
          <p className="font-semibold">{t('profile.password')}</p>
          <p className="mb-4 text-sm text-on-surface-variant">{t('profile.passwordHint')}</p>
          <form onSubmit={submitPassword} className="grid gap-3 sm:max-w-md">
            <Field label={t('profile.currentPassword')}>
              <PasswordInput value={currentPw} onChange={setCurrentPw} autoComplete="current-password" />
            </Field>
            <Field label={t('profile.newPassword')} hint={t('auth.passwordHint')}>
              <PasswordInput value={newPw} onChange={setNewPw} autoComplete="new-password" minLength={8} />
            </Field>
            <Field label={t('profile.confirmPassword')}>
              <PasswordInput
                value={confirmPw}
                onChange={(v) => { setConfirmPw(v); setPwMismatch(false); }}
                autoComplete="new-password"
              />
            </Field>
            {pwMismatch && (
              <p className="rounded-xl bg-error-container px-4 py-2 text-sm text-on-error-container" role="alert">
                {t('profile.passwordMismatch')}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <button className="btn-primary w-full sm:w-auto" disabled={changePassword.isPending || !currentPw || !newPw || !confirmPw}>
                {changePassword.isPending ? t('common.saving') : t('profile.changePassword')}
              </button>
              {changePassword.isSuccess && (
                <span className="flex items-center gap-1 text-sm font-semibold text-secondary">
                  <span className="material-symbols-outlined text-base">check_circle</span>
                  {t('profile.passwordChanged')}
                </span>
              )}
            </div>
            {changePassword.error && (
              <p className="rounded-xl bg-error-container px-4 py-2 text-sm text-on-error-container" role="alert">
                {authErrorText(changePassword.error, t)}
              </p>
            )}
          </form>
        </Section>

        <Section icon="logout" title={t('profile.sectionSession')}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold">{t('profile.logoutTitle')}</p>
              <p className="text-sm text-on-surface-variant">{t('profile.logoutHint')}</p>
            </div>
            <button
              className="w-full rounded-xl border border-error/40 px-5 py-2.5 font-bold text-error transition hover:bg-error-container/40 sm:w-auto"
              onClick={() => window.confirm(t('profile.logoutConfirm')) && logout()}
            >
              <span className="material-symbols-outlined me-1 align-middle text-base">logout</span>
              {t('dashboard.logout')}
            </button>
          </div>
        </Section>
        </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Level, streak and title, for students only.
 *
 * Teachers and admins have no gamification profile — rendering an empty level
 * card for them would be worse than rendering nothing.
 */
function LearningSection() {
  const { t } = useTranslation();
  const L = useLocalized();
  const qc = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const isStudent = role === Role.STUDENT;
  const { data: g } = useGamification(isStudent);

  const setTitle = useMutation({
    mutationFn: async (titleKey: string | null) =>
      (await api.post('/student/gamification/title', { titleKey })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: GAMIFICATION_KEY }),
  });

  if (!isStudent || !g) return null;

  return (
    <div className="mb-4 space-y-4 sm:mb-5">
      <LevelCard g={g} />

      {g.titles.length > 0 && (
        <div className="card">
          <h2 className="mb-1 font-heading font-extrabold">{t('gamification.titles.title')}</h2>
          <p className="mb-3 text-sm text-on-surface-variant">{t('gamification.titles.pick')}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setTitle.mutate(null)}
              className={`rounded-full border px-3 py-1.5 text-sm font-semibold transition ${
                !g.activeTitle ? 'border-primary bg-primary-fixed text-on-primary-fixed' : 'border-outline-variant text-on-surface-variant'
              }`}
            >
              {t('gamification.titles.none')}
            </button>
            {g.titles.map((ti) => {
              const label = L({ ar: ti.labelAr, en: ti.labelEn });
              const on = g.activeTitle === label || g.activeTitle === ti.key;
              return (
                <button
                  key={ti.key}
                  type="button"
                  onClick={() => setTitle.mutate(ti.key)}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-semibold transition ${
                    on ? 'border-primary bg-primary-fixed text-on-primary-fixed' : 'border-outline-variant text-on-surface-variant'
                  }`}
                >
                  <span className="material-symbols-outlined text-[18px]">{ti.icon}</span>
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * What a teacher teaches: one subject, and the stages they take.
 *
 * Answered at sign-up, but every account created before the question existed
 * has neither — and without them the course form has nothing to file a course
 * under and refuses to aim it anywhere. So it is editable, and it is here
 * rather than in the academy console because the subject and the stages belong
 * to the person, not to the academy's branding.
 */
/**
 * Whether this academy is reachable by message at all.
 *
 * A teacher who does not want to run a chat channel should not be handed one
 * they have to ignore, and a student should not be offered a message button
 * that goes nowhere. Turning it off closes both ends: the conversations
 * disappear from the teacher's console, the button disappears from the student
 * list, and a student can no longer start one.
 */
function MessagingSection({ role }: { role?: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const isTeacher = role === 'TEACHER';
  const { data: profile } = useQuery({
    queryKey: ['teacher-profile'],
    queryFn: async () => (await api.get('/teacher/profile')).data,
    enabled: isTeacher,
  });
  const save = useMutation({
    mutationFn: async (accepts: boolean) =>
      (await api.patch('/teacher/profile', { acceptsStudentMessages: accepts })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['teacher-profile'] });
      qc.invalidateQueries({ queryKey: ['chat-threads'] });
    },
  });
  if (!isTeacher || !profile) return null;
  const on = profile.acceptsStudentMessages !== false;

  return (
    <Section icon="forum" title={t('profile.sectionMessaging')} hint={t('profile.messagingHint')}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={save.isPending}
        onClick={() => save.mutate(!on)}
        className="flex w-full items-center gap-4 rounded-xl border border-outline-variant p-4 text-start transition hover:border-outline disabled:opacity-60"
      >
        <span
          className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? 'bg-primary' : 'bg-surface-container-high'}`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface-container-lowest shadow-card transition-[inset-inline-start] ${
              on ? 'start-[1.375rem]' : 'start-0.5'
            }`}
          />
        </span>
        <span className="min-w-0">
          <span className="block font-bold">{t('profile.acceptMessages')}</span>
          <span className="mt-0.5 block text-sm text-on-surface-variant">
            {t(on ? 'profile.acceptMessagesOn' : 'profile.acceptMessagesOff')}
          </span>
        </span>
      </button>
      <ErrorNote error={save.error} />
    </Section>
  );
}

function TeachingSection({ role }: { role?: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const isTeacher = role === 'TEACHER';
  const { data: profile } = useQuery({
    queryKey: ['teacher-profile'],
    queryFn: async () => (await api.get('/teacher/profile')).data,
    enabled: isTeacher,
  });
  const { data: subjects } = useQuery<Subject[]>({
    queryKey: ['subjects', 'all'],
    queryFn: async () => (await api.get('/catalog/subjects')).data,
    enabled: isTeacher,
  });
  const [draft, setDraft] = useState<{ subjectIds: string[]; stages: string[] } | null>(null);
  useEffect(() => {
    if (profile && !draft) {
      setDraft({
        subjectIds: (profile.subjects ?? []).map((s: { subjectId: string }) => s.subjectId),
        stages: profile.stages ?? [],
      });
    }
  }, [profile]); // eslint-disable-line

  const save = useMutation({
    mutationFn: async () =>
      (await api.patch('/teacher/profile', {
        subjectIds: draft!.subjectIds.length ? draft!.subjectIds : undefined,
        stages: draft!.stages,
      })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['teacher-profile'] });
      qc.invalidateQueries({ queryKey: ['teacher-courses'] });
    },
  });
  if (!isTeacher || !draft) return null;

  const toggle = (st: string) =>
    setDraft({
      ...draft,
      stages: draft.stages.includes(st) ? draft.stages.filter((x) => x !== st) : [...draft.stages, st],
    });
  const saved: string[] = (profile?.subjects ?? []).map((s: { subjectId: string }) => s.subjectId);
  const unchanged =
    draft.subjectIds.length === saved.length &&
    draft.subjectIds.every((id) => saved.includes(id)) &&
    draft.stages.length === (profile?.stages?.length ?? 0) &&
    draft.stages.every((s: string) => (profile?.stages ?? []).includes(s));

  return (
    <Section icon="school" title={t('profile.sectionTeaching')} hint={t('profile.teachingHint')}>
      <Field label={t('auth.subject')} hint={t('auth.subjectHint')}>
        <SubjectPicker
          subjects={subjects ?? []}
          value={draft.subjectIds}
          onChange={(subjectIds) => setDraft({ ...draft, subjectIds })}
        />
      </Field>
      <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">{t('auth.stages')}</span>
      <div className="flex flex-wrap gap-2">
        {STAGES.map((st) => {
          const on = draft.stages.includes(st);
          return (
            <button key={st} type="button" aria-pressed={on} onClick={() => toggle(st)}
              className={`rounded-full border px-4 py-2 text-sm font-semibold transition ${
                on ? 'border-primary bg-primary text-on-primary' : 'border-outline-variant text-on-surface-variant hover:border-outline'
              }`}>
              {t(`stage.${st}`)}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-xs text-outline">{t('academy.teachHint')}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button className="btn-primary w-full sm:w-auto" disabled={save.isPending || unchanged}
          onClick={() => save.mutate()}>
          {save.isPending ? t('common.saving') : t('common.save')}
        </button>
        {save.isSuccess && <span className="text-sm font-semibold text-primary">{t('common.saved')}</span>}
      </div>
      <ErrorNote error={save.error} />
    </Section>
  );
}
