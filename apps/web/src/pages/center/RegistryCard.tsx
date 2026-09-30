import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui';
import { localPhone, useRegistryAccess, useRegistryRecord } from '../../lib/centerStudents';

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
  const r = record.data;
  if (!r) return null;
  const ar = i18n.language !== 'en';
  const item = (label: string, value: string | null, ltr = false) => (
    <div className="min-w-0">
      <dt className="text-xs text-outline">{label}</dt>
      <dd className="truncate font-semibold" dir={ltr && value ? 'ltr' : undefined}>
        {value || <span className="font-normal text-outline">—</span>}
      </dd>
    </div>
  );
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
            className="ms-auto text-sm font-semibold text-primary hover:underline"
            to={`/center/students?academy=${academyId}`}
          >
            {t('registry.manage')}
          </Link>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
        {item(t('registry.form.grade'), r.grade ? (ar ? r.grade.nameAr : r.grade.nameEn) : null)}
        {item(t('registry.form.school'), r.school)}
        {item(t('registry.form.guardianName'), r.guardianName)}
        {item(t('registry.form.guardianPhone'), localPhone(r.guardianPhone), true)}
        {item(t('registry.form.studentPhone'), localPhone(r.studentPhone), true)}
        {item(t('registry.groups'), r.groups.map((g) => g.name).join('، '))}
      </dl>
    </section>
  );
}
