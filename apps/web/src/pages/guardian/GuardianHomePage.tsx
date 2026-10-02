import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import Avatar from '../../components/Avatar';
import { EmptyState, ErrorNote, Skeleton, Spinner } from '../../components/ui';
import { GuardianOverview, useGuardianChildren, useGuardianOverview } from '../../lib/guardian';
import { dayLabel, Money } from '../fees/feeParts';
import { formatMarks, formatPct } from '../../lib/paperExams';
import { ActivityList, AttendanceCard, CourseProgressList, LiveList } from '../care/CareViews';

/**
 * The guardian's home: one child at a time, in one academy, read only. A
 * guardian with several children switches between them here; each child's
 * data is fetched through that child's own link — never "everything this
 * phone number might be related to".
 */
export default function GuardianHomePage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const children = useGuardianChildren();
  const list = children.data ?? [];
  const selected = list.find((c) => c.linkId === params.get('child')) ?? list[0];
  const overview = useGuardianOverview(selected?.linkId);

  if (children.isLoading) {
    return (
      <div className="page grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  if (!list.length) {
    return (
      <div className="page">
        <EmptyState
          icon="family_restroom"
          title={t('guardian.noChildren')}
          hint={t('guardian.noChildrenHint')}
        />
      </div>
    );
  }
  const o = overview.data;

  return (
    <div className="page mx-auto max-w-2xl">
      {list.length > 1 && (
        <div
          className="mb-4 flex gap-2 overflow-x-auto pb-1"
          role="tablist"
          aria-label={t('guardian.children')}
        >
          {list.map((c) => {
            const active = c.linkId === selected?.linkId;
            return (
              <button
                key={c.linkId}
                role="tab"
                aria-selected={active}
                onClick={() => setParams({ child: c.linkId })}
                className={`flex shrink-0 items-center gap-2 rounded-full py-1.5 pe-4 ps-1.5 text-sm font-bold transition ${
                  active
                    ? 'bg-primary text-on-primary'
                    : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                }`}
              >
                <Avatar
                  id={c.student.id}
                  name={c.student.name}
                  url={c.student.avatarUrl}
                  size={28}
                />
                <bdi className="max-w-[9rem] truncate">{c.student.name.split(' ')[0]}</bdi>
              </button>
            );
          })}
        </div>
      )}

      {selected && (
        <header className="card mb-4 flex items-center gap-3 p-4">
          <Avatar
            id={selected.student.id}
            name={selected.student.name}
            url={selected.student.avatarUrl}
            size={56}
          />
          <div className="min-w-0 flex-1">
            <h1 className="font-heading text-xl font-bold text-on-surface">
              <bdi className="break-words">{selected.student.name}</bdi>
            </h1>
            <p className="truncate text-sm text-on-surface-variant">
              <bdi>{selected.academy.name}</bdi> · {t(`guardian.rel.${selected.relationship}`)}
            </p>
          </div>
          <Link
            to={`/messages?child=${encodeURIComponent(selected.student.id)}&academy=${encodeURIComponent(selected.academy.id)}`}
            className="btn-primary shrink-0"
            aria-label={t('guardian.contact')}
          >
            <span className="material-symbols-outlined text-[20px]">chat</span>
            <span className="hidden sm:inline">{t('guardian.contact')}</span>
          </Link>
        </header>
      )}

      {overview.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-32 rounded-2xl" />
          <Skeleton className="h-24 rounded-2xl" />
        </div>
      ) : overview.error ? (
        <ErrorNote error={overview.error} />
      ) : o ? (
        <div className="space-y-4">
          <section>
            <h2 className="mb-2 font-heading text-lg font-bold text-on-surface">
              {t('guardian.courses')}
            </h2>
            <CourseProgressList courses={o.courses} />
          </section>
          <AttendanceCard attendance={o.attendance} />
          {/* C5: only when the academy chose to show guardians fees (off by default). */}
          {o.fees && <GuardianFeesCard fees={o.fees} />}
          {/* C6: only when the academy chose to show guardians grades (off by default). */}
          {o.grades && <GuardianGradesCard grades={o.grades} />}
          <LiveList live={o.live} />
          <ActivityList activity={o.activity} />
          <p className="px-1 text-center text-xs text-outline">{t('guardian.privacyNote')}</p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * What this child owes the center and their receipts — what the academy chose
 * to share, nothing internal (no notes, no discounts' reasons, no collector).
 */
function GuardianFeesCard({ fees }: { fees: NonNullable<GuardianOverview['fees']> }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'en' ? 'en' : 'ar';
  return (
    <article className="card p-4">
      <h2 className="mb-3 font-heading text-lg font-bold text-on-surface">
        {t('guardian.fees.title')}
      </h2>
      <div className="mb-3 grid grid-cols-2 gap-2">
        <div className="min-w-0 rounded-xl bg-surface-container-low p-3">
          <p className="text-xs text-on-surface-variant">{t('guardian.fees.owed')}</p>
          <Money
            cents={fees.outstandingCents}
            currency={fees.currency}
            className="block font-extrabold"
          />
        </div>
        <div className="min-w-0 rounded-xl bg-surface-container-low p-3">
          <p className="text-xs text-on-surface-variant">{t('guardian.fees.overdue')}</p>
          <Money
            cents={fees.overdueCents}
            currency={fees.currency}
            className="block font-extrabold"
          />
        </div>
      </div>
      {fees.receipts.length === 0 ? (
        <p className="text-sm text-on-surface-variant">{t('guardian.fees.noReceipts')}</p>
      ) : (
        <ul className="divide-y divide-outline-variant/40 text-sm">
          {fees.receipts.map((r) => (
            <li key={r.receiptNumber} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-xs" dir="ltr">
                  {r.receiptNumber}
                </span>
                <span className="block text-xs text-on-surface-variant">
                  {dayLabel(r.localDate, lang)} · {t(`fees.method.${r.method}`)}
                  {r.reversed && ` · ${t('guardian.fees.reversed')}`}
                </span>
              </span>
              <Money
                cents={r.amountCents}
                currency={r.currency}
                className={`shrink-0 font-bold ${r.reversed ? 'line-through opacity-60' : ''}`}
              />
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/**
 * The child's published exam grades — the mark, the maximum, the percentage
 * and pass/fail where the exam has a pass mark. Nothing internal: no drafts,
 * notes, correction reasons, who entered it, other learners or ranks.
 */
function GuardianGradesCard({ grades }: { grades: NonNullable<GuardianOverview['grades']> }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'en' ? 'en' : 'ar';
  const newest = [...grades].reverse();
  return (
    <article className="card p-4">
      <h2 className="mb-3 font-heading text-lg font-bold text-on-surface">
        {t('guardian.grades.title')}
      </h2>
      {newest.length === 0 ? (
        <p className="text-sm text-on-surface-variant">{t('guardian.grades.none')}</p>
      ) : (
        <ul className="divide-y divide-outline-variant/40 text-sm">
          {newest.map((g) => (
            <li key={g.examId} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{g.title}</span>
                <span className="block text-xs text-on-surface-variant">
                  {dayLabel(g.examDate, lang)}
                  {g.kind === 'MAKEUP' && ` · ${t('exams.kind.MAKEUP')}`}
                  {g.passed != null && ` · ${t(g.passed ? 'exams.passed' : 'exams.failed')}`}
                </span>
              </span>
              <span className="shrink-0 text-end tabular-nums" dir="ltr">
                {g.status === 'SCORED' && g.score != null ? (
                  <>
                    <span className="block font-bold">
                      {formatMarks(g.score)} / {formatMarks(g.maxScore)}
                    </span>
                    {g.pctBps != null && (
                      <span className="block text-xs text-on-surface-variant">
                        {formatPct(g.pctBps)}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-on-surface-variant">{t(`exams.status.${g.status}`)}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
