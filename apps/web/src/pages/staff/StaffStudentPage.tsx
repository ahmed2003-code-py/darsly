import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import Avatar from '../../components/Avatar';
import { Badge, EmptyState, ProgressBar, Skeleton, Spinner } from '../../components/ui';
import { dateShort } from '../../lib/format';
import { useAssistantWorkspace, useStaffProgress, useStaffStudent } from '../../lib/staff';

/**
 * One student, as far as the assistant's courses go: their enrollments in
 * those courses, their progress there, and a way to message them — each part
 * only when the assistant holds the matching access. A student outside the
 * assistant's courses is a 404 from the server, shown as "not found" here.
 */
export default function StaffStudentPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const ws = useAssistantWorkspace();
  const student = useStaffStudent(ws.academyId, id);
  const progress = useStaffProgress(ws.academyId, id, !!student.data?.can.progress);

  if (ws.isLoading || student.isLoading) {
    return (
      <div className="page grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  if (!student.data) {
    return (
      <div className="page">
        <EmptyState
          icon="person_off"
          title={t('staff.studentNotFound')}
          hint={t('staff.studentNotFoundHint')}
        />
        <div className="mt-4 text-center">
          <Link to="/staff" className="btn-secondary">
            {t('staff.backToStudents')}
          </Link>
        </div>
      </div>
    );
  }
  const s = student.data;

  return (
    <div className="page">
      <Link
        to="/staff"
        className="mb-4 inline-flex items-center gap-1 text-sm font-bold text-primary-text"
      >
        <span className="material-symbols-outlined text-[18px] rtl:-scale-x-100">arrow_back</span>
        {t('staff.backToStudents')}
      </Link>

      <div className="card mb-6 flex flex-wrap items-center gap-4 p-5">
        <Avatar id={s.id} name={s.name} url={s.avatarUrl} size={64} />
        <div className="min-w-[12rem] flex-1">
          <h1 className="font-heading text-2xl font-bold text-on-surface">
            <bdi>{s.name}</bdi>
          </h1>
          <div className="mt-1 flex flex-wrap gap-1">
            {s.courses.map((c) => (
              <Badge key={c.id} tone={c.status === 'ACTIVE' ? 'primary' : 'neutral'}>
                {c.title} · {t(`staff.enrollment.${c.status}`, c.status)}
              </Badge>
            ))}
          </div>
        </div>
        {s.can.message && ws.academyId && (
          <Link
            to={`/messages?student=${encodeURIComponent(s.id)}&academy=${encodeURIComponent(ws.academyId)}`}
            className="btn-primary w-full justify-center sm:w-auto"
          >
            <span className="material-symbols-outlined text-[20px]">chat</span>
            {t('staff.message')}
          </Link>
        )}
      </div>

      {s.can.progress ? (
        <section>
          <h2 className="mb-3 font-heading text-lg font-bold text-on-surface">
            {t('staff.progress')}
          </h2>
          {progress.isLoading ? (
            <Skeleton className="h-40 rounded-2xl" />
          ) : !progress.data?.length ? (
            <EmptyState icon="insights" title={t('staff.noProgress')} />
          ) : (
            <div className="space-y-4">
              {progress.data.map((p) => (
                <article key={p.course.id} className="card p-5">
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="font-heading font-bold text-on-surface">
                      <bdi>{p.course.title}</bdi>
                    </h3>
                    <span className="text-sm text-on-surface-variant">
                      {t('staff.lessonsDone', {
                        done: p.lessons.completed,
                        total: p.lessons.total,
                      })}
                    </span>
                  </div>
                  <ProgressBar pct={p.percent} />
                  <p className="mt-2 text-xs text-on-surface-variant">
                    {p.lastActivityAt
                      ? t('staff.lastActive', { date: dateShort(p.lastActivityAt) })
                      : t('staff.notStarted')}
                  </p>

                  {p.quizzes.length > 0 && (
                    <div className="mt-4">
                      <h4 className="mb-1 text-sm font-bold text-on-surface">
                        {t('staff.quizzes')}
                      </h4>
                      <ul className="divide-y divide-outline-variant/40 text-sm">
                        {p.quizzes.map((q) => (
                          <li
                            key={q.lessonId}
                            className="flex items-center justify-between gap-3 py-2"
                          >
                            <bdi className="min-w-0 truncate text-on-surface">{q.lessonTitle}</bdi>
                            {q.needsManualGrading ? (
                              <Badge tone="warn">{t('staff.awaitingMarking')}</Badge>
                            ) : (
                              <Badge tone={q.passed ? 'primary' : 'error'}>
                                <span dir="ltr">{q.scorePct ?? 0}%</span>
                              </Badge>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {p.assignments.length > 0 && (
                    <div className="mt-4">
                      <h4 className="mb-1 text-sm font-bold text-on-surface">
                        {t('staff.assignments')}
                      </h4>
                      <ul className="divide-y divide-outline-variant/40 text-sm">
                        {p.assignments.map((a) => (
                          <li
                            key={a.lessonId}
                            className="flex items-center justify-between gap-3 py-2"
                          >
                            <bdi className="min-w-0 truncate text-on-surface">{a.lessonTitle}</bdi>
                            {a.gradedAt ? (
                              <Badge>
                                <span dir="ltr">
                                  {a.score}/{a.maxScore}
                                </span>
                              </Badge>
                            ) : (
                              <Badge tone="warn">{t('staff.awaitingMarking')}</Badge>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      ) : (
        <p className="text-sm text-on-surface-variant">{t('staff.noProgressAccess')}</p>
      )}
    </div>
  );
}
