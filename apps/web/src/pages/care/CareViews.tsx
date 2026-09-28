import { useTranslation } from 'react-i18next';
import { Badge, EmptyState, ProgressBar } from '../../components/ui';
import { dateShort } from '../../lib/format';
import type { AttendanceSummary, CourseProgress, GuardianOverview } from '../../lib/guardian';

/**
 * Read-only views of a student's learning, shared by Student 360 (staff) and
 * the guardian dashboard — so both read the same numbers the same way. They
 * draw only what the platform records; a section with nothing to show says so
 * instead of inventing a figure.
 */

export function CourseProgressList({ courses }: { courses: CourseProgress[] }) {
  const { t } = useTranslation();
  if (!courses.length) return <EmptyState icon="insights" title={t('care.noProgress')} />;
  return (
    <div className="space-y-3">
      {courses.map((p) => (
        <article key={p.course.id} className="card p-4">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="min-w-0 font-heading font-bold text-on-surface">
              <bdi className="break-words">{p.course.title}</bdi>
            </h3>
            <span className="text-sm text-on-surface-variant">
              {t('care.lessonsDone', { done: p.lessons.completed, total: p.lessons.total })}
            </span>
          </div>
          <ProgressBar pct={p.percent} />
          <p className="mt-2 text-xs text-on-surface-variant">
            {p.lastActivityAt
              ? t('care.lastActive', { date: dateShort(p.lastActivityAt) })
              : t('care.notStarted')}
          </p>
          {p.quizzes.length > 0 && (
            <Section title={t('care.exams')}>
              {p.quizzes.map((q) => (
                <Row key={q.lessonId} label={q.lessonTitle}>
                  {q.needsManualGrading ? (
                    <Badge tone="warn">{t('care.awaitingMarking')}</Badge>
                  ) : (
                    <Badge tone={q.passed ? 'primary' : 'error'}>
                      <span dir="ltr">{q.scorePct ?? 0}%</span>
                    </Badge>
                  )}
                </Row>
              ))}
            </Section>
          )}
          {p.assignments.length > 0 && (
            <Section title={t('care.homework')}>
              {p.assignments.map((a) => (
                <Row key={a.lessonId} label={a.lessonTitle}>
                  {a.gradedAt ? (
                    <Badge>
                      <span dir="ltr">
                        {a.score}/{a.maxScore}
                      </span>
                    </Badge>
                  ) : (
                    <Badge tone="warn">{t('care.awaitingMarking')}</Badge>
                  )}
                </Row>
              ))}
            </Section>
          )}
        </article>
      ))}
    </div>
  );
}

export function AttendanceCard({ attendance }: { attendance: AttendanceSummary | null }) {
  const { t } = useTranslation();
  if (!attendance) return null;
  const rate = attendance.total
    ? Math.round(((attendance.PRESENT + attendance.LATE) / attendance.total) * 100)
    : 0;
  return (
    <article className="card p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="font-heading font-bold text-on-surface">{t('care.attendance')}</h3>
        <span className="text-sm font-bold text-primary-text" dir="ltr">
          {rate}%
        </span>
      </div>
      <div className="mb-3 grid grid-cols-4 gap-2 text-center text-xs">
        {(['PRESENT', 'LATE', 'ABSENT', 'EXCUSED'] as const).map((k) => (
          <div key={k} className="rounded-sm bg-surface-container-low p-2">
            <div className="text-lg font-bold text-on-surface">{attendance[k]}</div>
            <div className="text-on-surface-variant">{t(`care.att.${k}`)}</div>
          </div>
        ))}
      </div>
      <ul className="divide-y divide-outline-variant/40 text-sm">
        {attendance.recent.map((r, i) => (
          <Row key={i} label={`${r.group} · ${dateShort(r.date)}`}>
            <Badge
              tone={r.status === 'ABSENT' ? 'error' : r.status === 'LATE' ? 'warn' : 'primary'}
            >
              {t(`care.att.${r.status}`)}
            </Badge>
          </Row>
        ))}
      </ul>
    </article>
  );
}

export function LiveList({
  live,
}: {
  live: { title: string; startsAt: string; minutes: number }[];
}) {
  const { t } = useTranslation();
  if (!live.length) return null;
  return (
    <article className="card p-4">
      <h3 className="mb-2 font-heading font-bold text-on-surface">{t('care.live')}</h3>
      <ul className="divide-y divide-outline-variant/40 text-sm">
        {live.map((l, i) => (
          <Row key={i} label={`${l.title} · ${dateShort(l.startsAt)}`}>
            <span className="text-on-surface-variant">
              {t('care.minutes', { count: l.minutes })}
            </span>
          </Row>
        ))}
      </ul>
    </article>
  );
}

export function ActivityList({ activity }: { activity: GuardianOverview['activity'] }) {
  const { t } = useTranslation();
  if (!activity.length) return null;
  const icon = {
    QUIZ: 'quiz',
    ASSIGNMENT: 'assignment',
    ATTENDANCE: 'event_available',
    LIVE: 'sensors',
  };
  return (
    <article className="card p-4">
      <h3 className="mb-2 font-heading font-bold text-on-surface">{t('care.activity')}</h3>
      <ul className="space-y-2.5">
        {activity.map((a, i) => (
          <li key={i} className="flex items-start gap-3 text-sm">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-fixed text-on-primary-fixed">
              <span className="material-symbols-outlined text-[18px]">{icon[a.kind]}</span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-on-surface">
                <bdi className="break-words">
                  {a.kind === 'ATTENDANCE' ? t(`care.att.${a.title}`) : a.title}
                </bdi>
                {a.kind === 'QUIZ' && a.scorePct != null && (
                  <span className="text-on-surface-variant" dir="ltr">
                    {' '}
                    · {a.scorePct}%
                  </span>
                )}
                {a.kind === 'ASSIGNMENT' && a.score && (
                  <span className="text-on-surface-variant" dir="ltr">
                    {' '}
                    · {a.score}
                  </span>
                )}
              </span>
              <span className="block truncate text-xs text-on-surface-variant">
                {t(`care.kind.${a.kind}`)}
                {a.course ? ` · ${a.course}` : ''} · {dateShort(a.at)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <h4 className="mb-1 text-sm font-bold text-on-surface">{title}</h4>
      <ul className="divide-y divide-outline-variant/40 text-sm">{children}</ul>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <bdi className="min-w-0 truncate text-on-surface">{label}</bdi>
      <span className="shrink-0">{children}</span>
    </li>
  );
}
