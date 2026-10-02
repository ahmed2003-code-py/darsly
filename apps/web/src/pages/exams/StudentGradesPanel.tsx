import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { EmptyState, ErrorNote, Skeleton } from '../../components/ui';
import { formatMarks, formatPct, useStudentGrades } from '../../lib/paperExams';
import { dayLabel } from '../fees/feeParts';

/**
 * Student 360 — this learner's published paper-exam grades in the groups the
 * viewer reaches (C6). A list, newest first; no trend graph, no rank. A makeup
 * sits beside the original absence, which is never rewritten.
 */
export default function StudentGradesPanel({
  academyId,
  studentId,
}: {
  academyId: string;
  studentId: string;
}) {
  const { t, i18n } = useTranslation();
  const q = useStudentGrades(academyId, studentId);
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Skeleton className="h-40 rounded-2xl" />;
  const items = [...q.data.items].reverse();
  if (!items.length) return <EmptyState icon="grading" title={t('exams.student.none')} />;
  return (
    <ul className="divide-y divide-outline-variant/40 rounded-2xl border border-outline-variant/50">
      {items.map((g) => (
        <li key={g.examId} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
          <span className="min-w-0 flex-1 basis-48">
            <Link
              to={`/center/exams/${g.examId}?academy=${academyId}`}
              className="flex min-h-11 items-center truncate font-semibold text-primary"
            >
              {g.title}
            </Link>
            <span className="block text-xs text-on-surface-variant">
              {g.groupName} · {dayLabel(g.examDate, i18n.language)}
              {g.kind === 'MAKEUP' && ` · ${t('exams.kind.MAKEUP')}`}
              {g.guest && ` · ${t('exams.sheet.guest')}`}
              {g.corrected && ` · ${t('exams.sheet.corrected')}`}
            </span>
          </span>
          <span className="shrink-0 text-end">
            {g.status === 'SCORED' && g.score != null ? (
              <span className="tabular-nums" dir="ltr">
                <span className="font-bold">{formatMarks(g.score)}</span>
                <span className="text-on-surface-variant"> / {formatMarks(g.maxScore)}</span>
              </span>
            ) : (
              <span className="font-semibold text-on-surface-variant">
                {t(`exams.status.${g.status}`)}
              </span>
            )}
            {g.pctBps != null && (
              <span className="block text-xs text-on-surface-variant" dir="ltr">
                {formatPct(g.pctBps)}
                {g.passed != null && ` · ${t(g.passed ? 'exams.passed' : 'exams.failed')}`}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
