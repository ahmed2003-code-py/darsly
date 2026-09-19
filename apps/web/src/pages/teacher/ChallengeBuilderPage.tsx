import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { type Grade } from '../../lib/stages';
import { type Subject } from '../../lib/subjects';
import {
  ChallengeQuestionRow,
  useSaveChallengeQuestions,
  useTeacherChallenge,
} from '../../lib/challenges';
import { Badge, ErrorNote, PageHeader, Spinner } from '../../components/ui';
import i18n from '../../i18n';

const STEPS = ['basic', 'settings', 'questions', 'preview', 'publish'] as const;
type Step = (typeof STEPS)[number];

const rid = () => Math.random().toString(36).slice(2, 8);
const blankQuestion = (type: ChallengeQuestionRow['type']): ChallengeQuestionRow => {
  const base = {
    prompt: '', explanation: '', points: 100, timeLimitSec: null, topic: null, difficulty: 1,
    imageUrl: null,
  };
  if (type === 'TRUE_FALSE') {
    return { ...base, type, options: [{ id: 'true', text: i18n.t('assess.true') }, { id: 'false', text: i18n.t('assess.false') }], correctOptionIds: ['true'] };
  }
  const ids = [rid(), rid(), rid(), rid()];
  return { ...base, type: 'MCQ', options: ids.map((id) => ({ id, text: '' })), correctOptionIds: [ids[0]] };
};

const COVER_ICONS = ['bolt', 'psychology', 'rocket_launch', 'military_tech', 'quiz', 'extension', 'emoji_events', 'calculate'];

export default function ChallengeBuilderPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>('basic');

  const { data: challenge, isLoading } = useTeacherChallenge(id);

  // Basic + settings form state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [coverIcon, setCoverIcon] = useState('bolt');
  const [type, setType] = useState<'PRACTICE' | 'RANKED'>('PRACTICE');
  const [difficulty, setDifficulty] = useState(1);
  const [courseId, setCourseId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [gradeId, setGradeId] = useState('');
  const [topic, setTopic] = useState('');
  const [durationMin, setDurationMin] = useState('');
  const [questionTimeSec, setQuestionTimeSec] = useState('');
  const [scoring, setScoring] = useState<'STANDARD' | 'SPEED_BASED'>('STANDARD');
  const [maxAttempts, setMaxAttempts] = useState('1');
  const [leaderboardEnabled, setLeaderboardEnabled] = useState(true);
  const [answerReveal, setAnswerReveal] = useState('AFTER_SUBMISSION');
  const [randomize, setRandomize] = useState('NONE');
  const [questions, setQuestions] = useState<ChallengeQuestionRow[]>([]);
  const [publishErrors, setPublishErrors] = useState<string[] | null>(null);

  useEffect(() => {
    if (!challenge) return;
    setTitle(challenge.title);
    setDescription(challenge.description ?? '');
    setCoverIcon(challenge.coverIcon || 'bolt');
    setType(challenge.type);
    setDifficulty(challenge.difficulty ?? 1);
    setCourseId(challenge.courseId ?? '');
    setSubjectId(challenge.subjectId ?? '');
    setGradeId(challenge.gradeId ?? '');
    setTopic(challenge.topic ?? '');
    setDurationMin(challenge.durationSec ? String(Math.round(challenge.durationSec / 60)) : '');
    setQuestionTimeSec(challenge.questionTimeSec != null ? String(challenge.questionTimeSec) : '');
    setScoring(challenge.scoring);
    setMaxAttempts(String(challenge.maxAttempts));
    setLeaderboardEnabled(challenge.leaderboardEnabled);
    setAnswerReveal(challenge.answerReveal);
    setRandomize(challenge.randomize);
    // Loaded rows carry DB-only fields (id, challengeId, sortOrder, createdAt,
    // updatedAt) the save DTO doesn't declare — sending them back verbatim on
    // the next save is rejected by the whitelist validator. Keep local state
    // to exactly the shape the editor (and the DTO) actually own.
    setQuestions(
      (challenge.questions ?? []).map((q) => ({
        type: q.type,
        prompt: q.prompt,
        imageUrl: q.imageUrl,
        options: q.options,
        correctOptionIds: q.correctOptionIds,
        explanation: q.explanation,
        points: q.points,
        timeLimitSec: q.timeLimitSec,
        topic: q.topic,
        difficulty: q.difficulty,
      })),
    );
  }, [challenge]);

  const { data: profile } = useQuery({
    queryKey: ['teacher-profile'],
    queryFn: async () => (await api.get('/teacher/profile')).data,
  });
  const mySubjects: Subject[] = (profile?.subjects ?? []).map((s: { subject: Subject }) => s.subject);
  const myStages: string[] = profile?.stages ?? [];
  const { data: grades } = useQuery({ queryKey: ['grades'], queryFn: async () => (await api.get('/catalog/grades')).data });
  const myGrades: Grade[] = (grades ?? []).filter((g: Grade) => g.stage && myStages.includes(g.stage));
  const { data: courses } = useQuery({ queryKey: ['teacher-courses'], queryFn: async () => (await api.get('/teacher/courses')).data });

  const isDraft = !challenge || challenge.status === 'DRAFT';

  const saveSettings = useMutation({
    mutationFn: async () => {
      const minutes = Number(durationMin);
      const qSec = Number(questionTimeSec);
      const attempts = Number(maxAttempts);
      return (
        await api.put(`/teacher/challenges/${id}`, {
          title, description, coverIcon, type, difficulty,
          courseId: courseId || null, subjectId: subjectId || null, gradeId: gradeId || null,
          topic: topic || null,
          durationSec: durationMin.trim() && minutes > 0 ? Math.round(minutes * 60) : null,
          questionTimeSec: questionTimeSec.trim() && qSec > 0 ? Math.round(qSec) : null,
          scoring,
          maxAttempts: maxAttempts.trim() ? Math.max(0, Math.min(50, Math.round(attempts))) : 1,
          leaderboardEnabled, answerReveal, randomize,
        })
      ).data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teacher-challenge', id] }),
  });

  const saveQuestionsM = useSaveChallengeQuestions(id);

  const saveAll = useMutation({
    mutationFn: async () => {
      await saveSettings.mutateAsync();
      if (questions.length) await saveQuestionsM.mutateAsync(questions);
    },
  });

  const publish = useMutation({
    mutationFn: async () => {
      await saveAll.mutateAsync();
      setPublishErrors(null);
      return (await api.post(`/teacher/challenges/${id}/publish`)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['teacher-challenge', id] });
      qc.invalidateQueries({ queryKey: ['teacher-challenges'] });
    },
    onError: (e: any) => {
      // Two different shapes can land here: our own publish validation
      // ({errors: string[]}), or a raw NestJS ValidationPipe 400 (whose
      // `message` is itself an array of per-field strings, not a single
      // string) — flatten both into one clean list rather than rendering an
      // array-inside-an-array as one run-on bullet.
      const data = e?.response?.data;
      const msg = data?.errors ?? data?.message ?? String(e);
      setPublishErrors(Array.isArray(msg) ? msg : [msg]);
    },
  });

  const unpublish = useMutation({
    mutationFn: async () => (await api.post(`/teacher/challenges/${id}/unpublish`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teacher-challenge', id] }),
  });

  if (isLoading) return <div className="grid place-items-center py-20"><Spinner /></div>;

  const setQ = (i: number, patch: Partial<ChallengeQuestionRow>) =>
    setQuestions((qs) => qs.map((q, j) => (j === i ? { ...q, ...patch } : q)));

  return (
    <div className="page">
      <Link to="/teacher/challenges" className="mb-2 inline-flex items-center gap-1 text-sm text-primary hover:underline">
        <span className="material-symbols-outlined text-base rtl:-scale-x-100">arrow_back</span>
        {t('challenges.teacher.title')}
      </Link>
      <PageHeader
        title={title || t('challenges.teacher.create')}
        subtitle={challenge ? t(`challenges.teacher.status.${challenge.status}`) : undefined}
        action={
          challenge && challenge.status !== 'DRAFT' ? (
            <button className="btn-ghost" onClick={() => unpublish.mutate()}>{t('challenges.teacher.unpublish')}</button>
          ) : undefined
        }
      />

      {/* Step tabs */}
      <div className="mb-6 flex flex-wrap gap-1 rounded-full bg-surface-container-high p-1">
        {STEPS.map((s, i) => (
          <button
            key={s}
            onClick={() => setStep(s)}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-bold transition ${
              step === s ? 'bg-surface-container-lowest text-primary shadow-hairline' : 'text-on-surface-variant'
            }`}
          >
            <span className={`grid h-5 w-5 place-items-center rounded-full text-[11px] ${step === s ? 'bg-primary text-on-primary' : 'bg-surface-container-high'}`}>
              {i + 1}
            </span>
            {t(`challenges.teacher.steps.${s}`)}
          </button>
        ))}
      </div>

      {step === 'basic' && (
        <div className="card max-w-2xl space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm font-bold">{t('challenges.teacher.basic.title')}</span>
            <input className="input" dir="auto" value={title} placeholder={t('challenges.teacher.basic.titlePh')}
              onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-bold">{t('challenges.teacher.basic.description')}</span>
            <textarea className="input min-h-[4rem]" dir="auto" value={description} placeholder={t('challenges.teacher.basic.descriptionPh')}
              onChange={(e) => setDescription(e.target.value)} />
          </label>

          <div>
            <span className="mb-2 block text-sm font-bold">{t('challenges.teacher.basic.type')}</span>
            <div className="grid gap-3 sm:grid-cols-2">
              {(['PRACTICE', 'RANKED'] as const).map((ty) => (
                <button key={ty} type="button" onClick={() => setType(ty)}
                  className={`rounded-xl border p-3 text-start transition ${type === ty ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant'}`}>
                  <span className="block font-heading font-bold">{t(`challenges.teacher.basic.type${ty === 'PRACTICE' ? 'Practice' : 'Ranked'}`)}</span>
                  <span className="mt-1 block text-xs text-on-surface-variant">{t(`challenges.teacher.basic.type${ty === 'PRACTICE' ? 'Practice' : 'Ranked'}Hint`)}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="mb-2 block text-sm font-bold">{t('challenges.teacher.basic.difficulty')}</span>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map((d) => (
                <button key={d} type="button" onClick={() => setDifficulty(d)}
                  className={`h-9 w-9 rounded-full font-bold transition ${difficulty === d ? 'bg-primary text-on-primary' : 'bg-surface-container-high text-on-surface-variant'}`}>
                  {d}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="mb-2 block text-sm font-bold">{t('challenges.teacher.basic.coverIcon')}</span>
            <div className="flex flex-wrap gap-2">
              {COVER_ICONS.map((ic) => (
                <button key={ic} type="button" onClick={() => setCoverIcon(ic)}
                  className={`grid h-10 w-10 place-items-center rounded-full transition ${coverIcon === ic ? 'bg-primary text-on-primary' : 'bg-surface-container-high text-on-surface-variant'}`}>
                  <span className="material-symbols-outlined text-[20px]">{ic}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-bold">{t('challenges.teacher.basic.course')}</span>
              <select className="input" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
                <option value="">{t('challenges.teacher.basic.courseNone')}</option>
                {(courses ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-bold">{t('challenges.teacher.basic.subject')}</span>
              <select className="input" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                <option value="">—</option>
                {mySubjects.map((s) => <option key={s.id} value={s.id}>{i18n.language === 'ar' ? s.nameAr : s.nameEn}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-bold">{t('challenges.teacher.basic.grade')}</span>
              <select className="input" value={gradeId} onChange={(e) => setGradeId(e.target.value)}>
                <option value="">—</option>
                {myGrades.map((g) => <option key={g.id} value={g.id}>{i18n.language === 'ar' ? g.nameAr : g.nameEn}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-bold">{t('challenges.teacher.basic.topic')}</span>
              <input className="input" dir="auto" value={topic} onChange={(e) => setTopic(e.target.value)} />
            </label>
          </div>

          <SaveBar mutation={saveSettings} />
        </div>
      )}

      {step === 'settings' && (
        <div className="card max-w-2xl space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm font-bold">{t('challenges.teacher.settings.duration')}</span>
            <input className="input" inputMode="numeric" placeholder={t('challenges.teacher.settings.durationNone')}
              value={durationMin} onChange={(e) => setDurationMin(e.target.value.replace(/\D/g, '').slice(0, 4))} />
            <span className="mt-1 block text-xs text-outline">{t('challenges.teacher.settings.durationHint')}</span>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-bold">{t('challenges.teacher.settings.questionTime')}</span>
            <input className="input" inputMode="numeric" placeholder={t('challenges.teacher.settings.questionTimeNone')}
              value={questionTimeSec} onChange={(e) => setQuestionTimeSec(e.target.value.replace(/\D/g, '').slice(0, 4))} />
            <span className="mt-1 block text-xs text-outline">{t('challenges.teacher.settings.questionTimeHint')}</span>
          </label>
          <div>
            <span className="mb-2 block text-sm font-bold">{t('challenges.teacher.settings.scoring')}</span>
            <div className="grid gap-3 sm:grid-cols-2">
              {(['STANDARD', 'SPEED_BASED'] as const).map((sc) => (
                <button key={sc} type="button" onClick={() => setScoring(sc)}
                  className={`rounded-xl border p-3 text-start transition ${scoring === sc ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant'}`}>
                  <span className="block font-heading font-bold">{t(`challenges.teacher.settings.scoring${sc === 'STANDARD' ? 'Standard' : 'Speed'}`)}</span>
                  <span className="mt-1 block text-xs text-on-surface-variant">{t(`challenges.teacher.settings.scoring${sc === 'STANDARD' ? 'Standard' : 'Speed'}Hint`)}</span>
                </button>
              ))}
            </div>
          </div>
          <label className="block">
            <span className="mb-1 block text-sm font-bold">{t('challenges.teacher.settings.maxAttempts')}</span>
            <input className="input" inputMode="numeric" placeholder={t('challenges.teacher.settings.unlimited')}
              value={maxAttempts === '0' ? '' : maxAttempts}
              onChange={(e) => setMaxAttempts(e.target.value.replace(/\D/g, '').slice(0, 2) || '0')} />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 accent-primary" checked={leaderboardEnabled}
              onChange={(e) => setLeaderboardEnabled(e.target.checked)} />
            <span className="font-bold">{t('challenges.teacher.settings.leaderboard')}</span>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-bold">{t('challenges.teacher.settings.answerReveal')}</span>
            <select className="input" value={answerReveal} onChange={(e) => setAnswerReveal(e.target.value)}>
              <option value="IMMEDIATE">{t('challenges.teacher.settings.revealImmediate')}</option>
              <option value="AFTER_SUBMISSION">{t('challenges.teacher.settings.revealAfterSubmission')}</option>
              <option value="AFTER_CLOSE">{t('challenges.teacher.settings.revealAfterClose')}</option>
              <option value="NEVER">{t('challenges.teacher.settings.revealNever')}</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-bold">{t('challenges.teacher.settings.randomize')}</span>
            <select className="input" value={randomize} onChange={(e) => setRandomize(e.target.value)}>
              <option value="NONE">{t('challenges.teacher.settings.randomizeNone')}</option>
              <option value="QUESTIONS">{t('challenges.teacher.settings.randomizeQuestions')}</option>
              <option value="ANSWERS">{t('challenges.teacher.settings.randomizeAnswers')}</option>
              <option value="BOTH">{t('challenges.teacher.settings.randomizeBoth')}</option>
            </select>
          </label>

          <SaveBar mutation={saveSettings} />
        </div>
      )}

      {step === 'questions' && (
        <div className="space-y-4">
          {!isDraft && (
            <p className="rounded-xl bg-surface-container-low px-4 py-3 text-sm text-on-surface-variant">
              {t('challenges.teacher.q.locked')}
            </p>
          )}
          {questions.map((q, i) => (
            <div key={i} className="card">
              <div className="mb-3 flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-fixed text-sm font-bold text-on-primary-fixed">{i + 1}</span>
                  <select className="input py-1.5 text-sm" value={q.type} disabled={!isDraft}
                    onChange={(e) => setQuestions((qs) => qs.map((qq, j) => (j === i ? blankQuestion(e.target.value as any) : qq)))}>
                    <option value="MCQ">{t('assess.q.mcq')}</option>
                    <option value="TRUE_FALSE">{t('assess.q.trueFalse')}</option>
                  </select>
                </span>
                <button disabled={!isDraft} className="text-error/70 hover:text-error disabled:opacity-30"
                  onClick={() => setQuestions((qs) => qs.filter((_, j) => j !== i))}>
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>

              <textarea className="input mb-3 min-h-[3rem]" dir="auto" disabled={!isDraft}
                placeholder={t('challenges.teacher.q.promptPh')} value={q.prompt}
                onChange={(e) => setQ(i, { prompt: e.target.value })} />

              <div className="space-y-2">
                {q.options.map((o) => {
                  const on = q.correctOptionIds.includes(o.id);
                  return (
                    <label key={o.id} className="flex items-center gap-2">
                      <input type="radio" className="accent-primary" checked={on} disabled={!isDraft}
                        onChange={() => setQ(i, { correctOptionIds: [o.id] })} />
                      {q.type === 'TRUE_FALSE' ? (
                        <span className="flex-1 select-none rounded-lg bg-surface-container-low px-3 py-2 text-sm font-semibold">{o.text}</span>
                      ) : (
                        <input className="input py-1.5 text-sm" dir="auto" disabled={!isDraft} value={o.text}
                          placeholder={t('assess.q.optionPlaceholder')}
                          onChange={(e) => setQ(i, { options: q.options.map((oo) => (oo.id === o.id ? { ...oo, text: e.target.value } : oo)) })} />
                      )}
                      {q.type === 'MCQ' && q.options.length > 2 && isDraft && (
                        <button type="button" className="text-outline hover:text-error"
                          onClick={() => setQ(i, { options: q.options.filter((oo) => oo.id !== o.id), correctOptionIds: q.correctOptionIds.filter((x) => x !== o.id) })}>
                          <span className="material-symbols-outlined text-base">close</span>
                        </button>
                      )}
                    </label>
                  );
                })}
                {q.type === 'MCQ' && isDraft && (
                  <button type="button" className="text-sm text-primary hover:underline"
                    onClick={() => setQ(i, { options: [...q.options, { id: rid(), text: '' }] })}>
                    + {t('challenges.teacher.q.addOption')}
                  </button>
                )}
                <p className="text-xs text-outline">{t('challenges.teacher.q.pickCorrect')}</p>
              </div>

              <label className="mt-3 block">
                <span className="mb-1 block text-sm font-semibold text-on-surface-variant">{t('challenges.teacher.q.explanation')}</span>
                <textarea className="input min-h-[3rem]" dir="auto" disabled={!isDraft} value={q.explanation}
                  onChange={(e) => setQ(i, { explanation: e.target.value })} />
              </label>

              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <label className="text-sm">
                  <span className="mb-1 block font-semibold text-on-surface-variant">{t('challenges.teacher.q.points')}</span>
                  <input className="input py-1 text-sm" inputMode="numeric" disabled={!isDraft}
                    value={String(q.points)} onChange={(e) => setQ(i, { points: Number(e.target.value.replace(/\D/g, '')) || 0 })}
                    onBlur={() => setQ(i, { points: Math.max(1, q.points) })} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-semibold text-on-surface-variant">{t('challenges.teacher.q.timeLimit')}</span>
                  <input className="input py-1 text-sm" inputMode="numeric" disabled={!isDraft}
                    placeholder={t('challenges.teacher.q.timeLimitInherit')}
                    value={q.timeLimitSec != null ? String(q.timeLimitSec) : ''}
                    onChange={(e) => { const v = e.target.value.replace(/\D/g, ''); setQ(i, { timeLimitSec: v ? Number(v) : null }); }} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-semibold text-on-surface-variant">{t('challenges.teacher.q.topic')}</span>
                  <input className="input py-1 text-sm" dir="auto" disabled={!isDraft}
                    value={q.topic ?? ''} onChange={(e) => setQ(i, { topic: e.target.value || null })} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-semibold text-on-surface-variant">{t('challenges.teacher.q.difficulty')}</span>
                  <select className="input py-1 text-sm" disabled={!isDraft} value={q.difficulty}
                    onChange={(e) => setQ(i, { difficulty: Number(e.target.value) })}>
                    {[1, 2, 3, 4, 5].map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </label>
              </div>
            </div>
          ))}

          {!questions.length && <p className="card py-10 text-center text-sm text-on-surface-variant">{t('challenges.teacher.q.empty')}</p>}

          {isDraft && (
            <div className="flex flex-wrap gap-2">
              <button className="btn-ghost" onClick={() => setQuestions((qs) => [...qs, blankQuestion('MCQ')])}>{t('challenges.teacher.q.addMcq')}</button>
              <button className="btn-ghost" onClick={() => setQuestions((qs) => [...qs, blankQuestion('TRUE_FALSE')])}>{t('challenges.teacher.q.addTrueFalse')}</button>
            </div>
          )}

          <SaveBar mutation={saveAll} disabled={!isDraft} />
        </div>
      )}

      {step === 'preview' && (
        <div className="max-w-md">
          <p className="mb-3 text-sm text-on-surface-variant">{t('challenges.teacher.preview.hint')}</p>
          <div className="card space-y-4">
            <div className="flex items-center gap-3">
              <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-primary-fixed text-on-primary-fixed">
                <span className="material-symbols-outlined text-[26px]">{coverIcon}</span>
              </span>
              <div className="min-w-0">
                <h3 className="truncate font-heading text-lg font-extrabold">{title || '—'}</h3>
                <p className="text-xs text-on-surface-variant">{t('challenges.card.questions', { count: questions.length })}</p>
              </div>
            </div>
            {description && <p className="text-sm text-on-surface-variant">{description}</p>}
            {questions[0] && (
              <div className="rounded-xl border border-outline-variant p-4">
                <p className="mb-3 text-xs font-bold uppercase text-outline">{t('challenges.play.question', { n: 1, total: questions.length })}</p>
                <p className="mb-3 font-semibold" dir="auto">{questions[0].prompt || '—'}</p>
                <div className="space-y-2">
                  {questions[0].options.map((o) => (
                    <div key={o.id} className="rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 text-sm" dir="auto">
                      {o.text || '—'}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {step === 'publish' && (
        <div className="card max-w-lg space-y-4">
          {challenge?.status === 'DRAFT' ? (
            <>
              <p className="font-heading font-bold">{t('challenges.teacher.publishStep.title')}</p>
              {publishErrors && (
                <div className="rounded-xl border border-error/15 bg-error-container p-3 text-sm text-on-error-container">
                  <p className="mb-1 font-bold">{t('challenges.teacher.publishStep.notReady')}</p>
                  <ul className="list-inside list-disc space-y-0.5">
                    {publishErrors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}
              <button className="btn-primary w-full" disabled={publish.isPending} onClick={() => publish.mutate()}>
                {t('challenges.teacher.publishStep.confirm')}
              </button>
            </>
          ) : (
            <div className="flex items-center gap-3">
              <Badge tone="teal">{t(`challenges.teacher.status.${challenge?.status}`)}</Badge>
              <p className="text-sm text-on-surface-variant">{t('challenges.teacher.publishStep.ready')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SaveBar({ mutation, disabled }: { mutation: { isPending: boolean; isSuccess: boolean; error: unknown; mutate: () => void }; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="border-t border-outline-variant/50 pt-4">
      <button className="btn-primary" disabled={mutation.isPending || disabled} onClick={() => mutation.mutate()}>
        {mutation.isPending ? t('common.saving') : t('common.save')}
      </button>
      {mutation.isSuccess && <span className="ms-3 text-sm text-secondary">{t('common.saved')}</span>}
      <ErrorNote error={mutation.error} />
    </div>
  );
}
