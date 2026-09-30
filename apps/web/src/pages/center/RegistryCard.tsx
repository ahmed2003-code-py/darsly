import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui';
import { localPhone, useRegistryAccess, useRegistryRecord } from '../../lib/centerStudents';
import { useDeskAccess } from '../../lib/desk';
import CardPanel from '../desk/CardPanel';

/**
 * Student 360's register strip: this academy's code for the learner and what
 * it keeps about them (contacts, school, year, groups, status). Shown only to
 * someone allowed to read the register (`student.directory`, checked again by
 * the server) and only when the learner is on it — otherwise nothing renders.
 */
export default function RegistryCard({
  academyId,
  studentId,
}: {
  academyId: string;
  studentId: string;
}) {
  const { t, i18n } = useTranslation();
  const access = useRegistryAccess(academyId);
  const record = useRegistryRecord(academyId, studentId, !!access.data?.canView);
  const desk = useDeskAccess(academyId);
  const r = record.data;
  if (!r) return null;
  const ar = i18n.language !== 'en';
  // Only what the center actually recorded: a wall of labels over "—" said
  // nothing on a phone and pushed the student's courses and chats below the fold.
  const facts = [
    [t('registry.form.grade'), r.grade ? (ar ? r.grade.nameAr : r.grade.nameEn) : null, false],
    [t('registry.form.school'), r.school, false],
    [t('registry.form.guardianName'), r.guardianName, false],
    [t('registry.form.guardianPhone'), r.guardianPhone ? localPhone(r.guardianPhone) : null, true],
    [t('registry.form.studentPhone'), r.studentPhone ? localPhone(r.studentPhone) : null, true],
  ].filter((f): f is [string, string, boolean] => !!f[1]);
  return (
    <section aria-label={t('registry.card')} className="card mb-4 p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span
          className="rounded-xl bg-primary-fixed px-3 py-1.5 font-mono text-lg font-bold tracking-wider text-on-primary-fixed tabular-nums"
          dir="ltr"
          aria-label={t('registry.codeLabel', { code: r.code })}
        >
          {r.code}
        </span>
        <Badge tone={r.status === 'ACTIVE' ? 'primary' : 'warn'}>
          {t(`registry.status.${r.status}`)}
        </Badge>
        <Badge tone="neutral">{t(`registry.source.${r.source}`)}</Badge>
        {!r.hasAccount && <Badge tone="neutral">{t('registry.noAccount')}</Badge>}
        {access.data?.canRegister && (
          <Link
            className="-my-2 ms-auto inline-flex min-h-11 items-center px-1 text-sm font-semibold text-primary hover:underline"
            to={`/center/students?academy=${academyId}`}
          >
            {t('registry.manage')}
          </Link>
        )}
      </div>
      {facts.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-5">
          {facts.map(([label, value, ltr]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-outline">{label}</dt>
              <dd className="font-semibold [overflow-wrap:anywhere]">
                {ltr ? (
                  <span dir="ltr" className="tabular-nums">
                    {value}
                  </span>
                ) : (
                  value
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {r.groups.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-outline">{t('registry.groups')}</span>
          {r.groups.map((g) => (
            <Badge key={g.id} tone="primary">
              <bdi>{g.name}</bdi>
            </Badge>
          ))}
        </div>
      )}
      {/* The learner's QR card (C3), for whoever may issue cards here. */}
      {desk.data?.canManageCards && (
        <CardPanel
          academyId={academyId}
          academyStudentId={r.id}
          withdrawn={r.status !== 'ACTIVE'}
        />
      )}
    </section>
  );
}
