import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Pager from '../../components/Pager';
import { EmptyState, ErrorNote, Skeleton, Spinner, TabRail } from '../../components/ui';
import { useRegistryAcademyId } from '../../lib/centerStudents';
import {
  ExamStatus,
  formatMarks,
  formatPct,
  useExamGroups,
  useExams,
  useExamsAcademy,
  useGradeSettings,
  usePaperExamActions,
  usePaperExamsAccess,
} from '../../lib/paperExams';
import { dayLabel } from '../fees/feeParts';
import { ExamDialog, StatusBadge } from './examParts';

type Tab = 'exams' | 'settings';

/**
 * Paper exams and grades (C6): the exams of the groups this person reaches,
 * newest first, with the server's statistics. Grades are entered on the
 * exam's sheet. Separate from online quizzes and assignments.
 */
export default function ExamsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const preferred = useRegistryAcademyId();
  const place = useExamsAcademy(params.get('academy') ?? preferred);
  // Where exams are not mine to see, ask the workspace itself: "no access", not "off".
  const academyId = place.academyId ?? params.get('academy') ?? preferred;
  const access = usePaperExamsAccess(academyId);
  const a = access.data;
  const [tab, setTab] = useState<Tab>('exams');
  if (place.loading || (academyId && access.isLoading))
    return (
      <div className="page grid place-items-center py-24">
        <Spinner />
      </div>
    );
  if (!academyId || !a?.enabled)
    return (
      <div className="page">
        <EmptyState icon="toggle_off" title={t('exams.off')} hint={t('exams.offHint')} />
      </div>
    );
  if (!a.canView)
    return (
      <div className="page">
        <EmptyState icon="lock" title={t('exams.noAccess')} hint={t('exams.noAccessHint')} />
      </div>
    );
  const tabs: Tab[] = ['exams', ...(a.canSettings ? (['settings'] as const) : [])];
  return (
    <div className="page max-w-5xl">
      <h1 className="mb-1 font-heading text-2xl font-extrabold sm:text-3xl">
        {t('exams.page.title')}
      </h1>
      <p className="mb-4 text-sm text-on-surface-variant">{t('exams.page.sub')}</p>
      {place.academies.length > 1 && (
        <label className="mb-4 block max-w-sm">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('exams.page.academy')}
          </span>
          <select
            className="input min-h-11"
            value={academyId}
            onChange={(e) => setParams({ academy: e.target.value }, { replace: true })}
          >
            {place.academies.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {tabs.length > 1 && (
        <div className="mb-4">
          <TabRail
            tabs={tabs}
            value={tab}
            onChange={setTab}
            labelOf={(k) => t(`exams.page.tab.${k}`)}
          />
        </div>
      )}
      {tab === 'exams' && <ExamList academyId={academyId} canManage={a.canManage} />}
      {tab === 'settings' && a.canSettings && <Settings academyId={academyId} />}
    </div>
  );
}

function ExamList({ academyId, canManage }: { academyId: string; canManage: boolean }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [groupId, setGroupId] = useState('');
  const [status, setStatus] = useState<ExamStatus | ''>('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  useEffect(() => setPage(1), [groupId, status]);
  const groups = useExamGroups(academyId);
  const q = useExams(academyId, {
    groupId: groupId || undefined,
    status: status || undefined,
    page,
  });
  const open = (id: string) => navigate(`/center/exams/${id}?academy=${academyId}`);
  return (
    <section>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 sm:max-w-xs">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('exams.form.group')}
          </span>
          <select
            className="input min-h-11"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
          >
            <option value="">{t('exams.list.allGroups')}</option>
            {(groups.data ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 flex-1 sm:max-w-[12rem]">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('exams.list.status')}
          </span>
          <select
            className="input min-h-11"
            value={status}
            onChange={(e) => setStatus(e.target.value as ExamStatus | '')}
          >
            <option value="">{t('exams.list.anyStatus')}</option>
            {(['DRAFT', 'PUBLISHED', 'VOID'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`exams.examStatus.${s}`)}
              </option>
            ))}
          </select>
        </label>
        {canManage && (
          <button
            type="button"
            className="btn-primary min-h-11 w-full px-5 sm:ms-auto sm:w-auto"
            onClick={() => setCreating(true)}
          >
            <span className="material-symbols-outlined text-lg" aria-hidden>
              add
            </span>
            {t('exams.list.new')}
          </button>
        )}
      </div>
      {q.error ? (
        <ErrorNote error={q.error} />
      ) : !q.data ? (
        <Skeleton className="h-48 rounded-2xl" />
      ) : !q.data.items.length ? (
        <EmptyState
          icon="grading"
          title={t('exams.list.empty')}
          hint={canManage ? t('exams.list.emptyHint') : undefined}
        />
      ) : (
        <>
          <ul className="space-y-2">
            {q.data.items.map((e) => (
              <li key={e.id}>
                <Link
                  to={`/center/exams/${e.id}?academy=${academyId}`}
                  className="card flex min-h-16 flex-wrap items-center gap-x-3 gap-y-1 p-3 hover:border-primary"
                >
                  <span className="min-w-0 flex-1 basis-56">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-bold">{e.title}</span>
                      {e.kind === 'MAKEUP' && (
                        <span className="shrink-0 rounded-full bg-surface-container px-2 py-0.5 text-xs">
                          {t('exams.kind.MAKEUP')}
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-on-surface-variant">
                      {e.groupName} · {dayLabel(e.examDate, i18n.language)} ·{' '}
                      {t('exams.list.outOf', { max: formatMarks(e.maxScore) })}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3 text-xs text-on-surface-variant">
                    {e.stats && e.stats.scored > 0 && e.stats.average != null && (
                      <span className="tabular-nums" dir="ltr">
                        {t('exams.stats.average')}: {formatMarks(e.stats.average)}
                      </span>
                    )}
                    {e.stats?.passRateBps != null && (
                      <span className="tabular-nums" dir="ltr">
                        {t('exams.stats.passRate')}: {formatPct(e.stats.passRateBps)}
                      </span>
                    )}
                    <StatusBadge status={e.status} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <Pager page={page} pages={Math.ceil(q.data.total / q.data.pageSize)} onGo={setPage} />
        </>
      )}
      {creating && (
        <ExamDialog
          academyId={academyId}
          defaultGroupId={groupId || undefined}
          onClose={() => setCreating(false)}
          onCreated={open}
        />
      )}
    </section>
  );
}

function Settings({ academyId }: { academyId: string }) {
  const { t } = useTranslation();
  const q = useGradeSettings(academyId);
  const act = usePaperExamActions(academyId);
  const [v, setV] = useState<{ lowGradePercent: number; guardianGradesVisible: boolean } | null>(
    null,
  );
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (q.data && !v) setV(q.data);
  }, [q.data, v]);
  if (!v) return <Skeleton className="h-48 rounded-2xl" />;
  return (
    <form
      className="card max-w-lg p-4"
      onSubmit={(e) => {
        e.preventDefault();
        act.updateSettings.mutate(v, { onSuccess: () => setSaved(true) });
      }}
    >
      <label className="mb-3 block">
        <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
          {t('exams.settings.lowGradePercent')}
        </span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={100}
          className="input min-h-11"
          value={v.lowGradePercent}
          onChange={(e) => {
            setSaved(false);
            setV({
              ...v,
              lowGradePercent: Math.max(1, Math.min(100, Math.trunc(Number(e.target.value)) || 1)),
            });
          }}
        />
        <span className="mt-1 block text-xs text-on-surface-variant">
          {t('exams.settings.lowGradeHint')}
        </span>
      </label>
      <label className="mb-1 flex min-h-11 items-center gap-2 text-sm font-semibold">
        <input
          type="checkbox"
          className="size-5"
          checked={v.guardianGradesVisible}
          onChange={(e) => {
            setSaved(false);
            setV({ ...v, guardianGradesVisible: e.target.checked });
          }}
        />
        {t('exams.settings.guardianGradesVisible')}
      </label>
      <p className="mb-3 text-xs text-on-surface-variant">
        {t('exams.settings.guardianGradesHint')}
      </p>
      <ErrorNote error={act.updateSettings.error} />
      <button
        type="submit"
        className="btn-primary min-h-11 w-full"
        disabled={act.updateSettings.isPending}
      >
        {saved ? t('exams.settings.saved') : t('common.save')}
      </button>
    </form>
  );
}
