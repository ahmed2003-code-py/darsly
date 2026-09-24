import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { askConfirm } from '../../lib/confirm';
import { dateShort, egp } from '../../lib/format';
import {
  Badge,
  CardGridSkeleton,
  EmptyState,
  ErrorNote,
  PageHeader,
  ProgressBar,
} from '../../components/ui';

const STATUS_TONE: Record<string, 'teal' | 'warn' | 'error' | 'neutral'> = {
  ACTIVE: 'teal',
  PENDING_PAYMENT: 'warn',
  REJECTED: 'error',
  REVOKED: 'error',
  EXPIRED: 'neutral',
};

// A dead enrolment has nothing left to do, so the student can take it off their
// list. One they are using, or one whose payment is still being checked, stays.
const REMOVABLE = ['REVOKED', 'REJECTED', 'EXPIRED'];

export default function MyCoursesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['my-enrollments'],
    queryFn: async () => (await api.get('/enrollments/mine')).data,
  });

  const hide = useMutation({
    mutationFn: async (id: string) => (await api.post(`/enrollments/${id}/hide`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['my-enrollments'] }),
  });

  return (
    <div className="page">
      <PageHeader title={t('myCourses.title')} subtitle={t('myCourses.subtitle')} />

      {isLoading ? (
        <CardGridSkeleton count={3} />
      ) : !data?.length ? (
        <div>
          <EmptyState
            icon="auto_stories"
            title={t('myCourses.empty')}
            hint={t('myCourses.emptyHint')}
          />
          <div className="mt-4 text-center">
            <Link to="/" className="btn-primary inline-block">
              {t('myCourses.browse')}
            </Link>
          </div>
        </div>
      ) : (
        <>
          <ErrorNote error={hide.error} />
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {data.map((e: any) =>
              e.course.kind === 'EXAM' && e.course.exam ? (
                <ExamCard
                  key={e.id}
                  enrollment={e}
                  removing={hide.isPending}
                  onRemove={() => hide.mutate(e.id)}
                />
              ) : (
                <Link
                  key={e.id}
                  to={`/course/${e.course.id}`}
                  className="card flex flex-col overflow-hidden p-0 transition hover:shadow-modal"
                >
                  <div className="relative h-40 bg-surface-container-high">
                    {e.course.thumbnailUrl && (
                      <img
                        src={e.course.thumbnailUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    )}
                    <span className="absolute start-3 top-3">
                      <Badge tone={STATUS_TONE[e.status] ?? 'neutral'}>
                        {t(`myCourses.status.${e.status}`)}
                      </Badge>
                    </span>
                    {REMOVABLE.includes(e.status) && (
                      <button
                        title={t('myCourses.remove')}
                        aria-label={t('myCourses.remove')}
                        disabled={hide.isPending}
                        className="absolute end-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-surface-container-lowest/90 text-outline shadow-card backdrop-blur transition hover:bg-error-container hover:text-on-error-container disabled:opacity-50"
                        onClick={async (ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          if (await askConfirm(t('myCourses.removeConfirm'))) hide.mutate(e.id);
                        }}
                      >
                        <span className="material-symbols-outlined text-[20px]">close</span>
                      </button>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col p-5">
                    <h3 className="mb-1 font-heading text-lg font-bold">{e.course.title}</h3>
                    <p className="mb-3 text-sm text-primary">{e.course.teacherName}</p>

                    {e.status === 'ACTIVE' && e.course.lessonsCount > 0 && (
                      <div className="mb-3">
                        <div className="mb-1 flex items-center justify-between text-xs text-outline">
                          <span>{t('myCourses.progress')}</span>
                          <span className="font-bold text-on-surface-variant">
                            {e.completedLessons}/{e.course.lessonsCount} · {e.progressPct}%
                          </span>
                        </div>
                        <ProgressBar
                          pct={e.progressPct}
                          tone={e.progressPct >= 100 ? 'accent' : 'primary'}
                        />
                      </div>
                    )}

                    <div className="mt-auto flex items-center justify-between text-xs text-outline">
                      <span>{t('course.lessonsCount', { count: e.course.lessonsCount })}</span>
                      {e.expiresAt ? (
                        <span>{t('myCourses.expiresAt', { date: dateShort(e.expiresAt) })}</span>
                      ) : (
                        <span>
                          {e.course.priceCents === 0
                            ? t('myCourses.free')
                            : egp(e.course.priceCents)}
                        </span>
                      )}
                    </div>

                    {e.certificateToken && (
                      <span
                        className="mt-3 flex items-center justify-center gap-1 rounded-lg border border-primary-container/60 bg-primary-fixed/40 py-2 text-sm font-bold text-on-primary-fixed"
                        onClick={(ev) => {
                          ev.preventDefault();
                          navigate(`/certificate/${e.certificateToken}`);
                        }}
                      >
                        <span className="material-symbols-outlined text-base">
                          workspace_premium
                        </span>
                        {t('myCourses.viewCertificate')}
                      </span>
                    )}
                  </div>
                </Link>
              ),
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * An exam, as an exam.
 *
 * An exam made in the Studio is stored as a course with one lesson, and this
 * page used to draw it like one: "1 lesson", a progress bar, "0 ج.م". A
 * student looking at their list needs to tell at a glance which of these is a
 * paper to sit, so it gets its own face — what the paper is (questions, time,
 * pass mark) and where they stand on it — and it opens the paper itself, not
 * a course page with a curriculum of one.
 */
function ExamCard({
  enrollment: e,
  removing,
  onRemove,
}: {
  enrollment: any;
  removing: boolean;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const exam = e.course.exam as {
    lessonId: string;
    questionCount: number;
    timeLimitSec: number | null;
    passingScore: number;
    attemptsUsed: number;
    bestScorePct: number | null;
    passed: boolean;
    awaitingMarking: boolean;
  };
  const active = e.status === 'ACTIVE';
  // Pending payment and the like still go to the course page, which is where
  // the enrolment's state is explained; only an open enrolment goes straight
  // to the paper.
  const to = active ? `/learn/${e.course.id}/${exam.lessonId}` : `/course/${e.course.id}`;
  const scored = exam.bestScorePct != null;

  return (
    <Link
      to={to}
      className="card flex flex-col overflow-hidden border-2 border-primary/25 p-0 transition hover:border-primary/60 hover:shadow-modal"
    >
      <div className="relative h-40 overflow-hidden bg-gradient-to-br from-primary to-primary-container text-on-primary">
        {e.course.thumbnailUrl ? (
          <img src={e.course.thumbnailUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          // A sheet with a clock on it, drawn in the page's own colours: an
          // exam has no cover photo, and a grey box says "missing", not "exam".
          <span className="absolute inset-0 grid place-items-center">
            <span className="material-symbols-outlined text-[88px] opacity-90">quiz</span>
          </span>
        )}
        <span className="absolute start-3 top-3 flex items-center gap-1 rounded-full bg-surface-container-lowest px-3 py-1 text-xs font-extrabold text-primary shadow-card">
          <span className="material-symbols-outlined text-[16px]">assignment</span>
          {t('myCourses.exam.badge')}
        </span>
        {!active && (
          <span className="absolute bottom-3 start-3">
            <Badge tone={STATUS_TONE[e.status] ?? 'neutral'}>
              {t(`myCourses.status.${e.status}`)}
            </Badge>
          </span>
        )}
        {REMOVABLE.includes(e.status) && (
          <button
            title={t('myCourses.remove')}
            aria-label={t('myCourses.remove')}
            disabled={removing}
            className="absolute end-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-surface-container-lowest/90 text-outline shadow-card backdrop-blur transition hover:bg-error-container hover:text-on-error-container disabled:opacity-50"
            onClick={async (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              if (await askConfirm(t('myCourses.removeConfirm'))) onRemove();
            }}
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        )}
      </div>

      <div className="flex flex-1 flex-col p-5">
        <h3 className="mb-1 font-heading text-lg font-bold">{e.course.title}</h3>
        <p className="mb-4 text-sm text-primary">{e.course.teacherName}</p>

        {/* What the paper is. */}
        <div className="mb-4 grid grid-cols-3 gap-2 text-center text-xs">
          <Fact icon="help" text={t('myCourses.exam.questions', { count: exam.questionCount })} />
          <Fact
            icon="timer"
            text={
              exam.timeLimitSec
                ? t('myCourses.exam.minutes', { n: Math.round(exam.timeLimitSec / 60) })
                : t('myCourses.exam.noLimit')
            }
          />
          <Fact icon="flag" text={t('myCourses.exam.passMark', { pct: exam.passingScore })} />
        </div>

        {/* Where they stand on it. */}
        <div className="mt-auto border-t border-outline-variant/60 pt-4">
          {scored ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-on-surface-variant">
                {t('myCourses.exam.yourScore')}
              </span>
              <span className="flex items-center gap-2">
                <span className="font-heading text-2xl font-extrabold tabular-nums">
                  {exam.bestScorePct}%
                </span>
                <Badge tone={exam.passed ? 'teal' : 'error'}>
                  {t(exam.passed ? 'myCourses.exam.passed' : 'myCourses.exam.failed')}
                </Badge>
              </span>
            </div>
          ) : exam.awaitingMarking ? (
            <p className="flex items-center gap-2 text-sm font-semibold text-on-surface-variant">
              <span className="material-symbols-outlined text-[18px]">hourglass_top</span>
              {t('myCourses.exam.awaiting')}
            </p>
          ) : active ? (
            <span className="btn-primary flex w-full items-center justify-center gap-2 py-2.5">
              <span className="material-symbols-outlined text-[18px]">play_arrow</span>
              {t('myCourses.exam.start')}
            </span>
          ) : (
            <p className="text-sm text-outline">{t('myCourses.exam.notTaken')}</p>
          )}
        </div>
      </div>
    </Link>
  );
}

function Fact({ icon, text }: { icon: string; text: string }) {
  return (
    <span className="flex flex-col items-center gap-1 rounded-xl bg-surface-container px-2 py-2.5 font-semibold text-on-surface-variant">
      <span className="material-symbols-outlined text-[20px] text-primary">{icon}</span>
      {text}
    </span>
  );
}
