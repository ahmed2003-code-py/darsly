import { FormEvent, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Role } from '@darsly/shared-types';
import { useOwnedAcademy } from '../../lib/academy';
import { askConfirm } from '../../lib/confirm';
import {
  useAcademySubjects,
  useCreateSubject,
  useSetAllSubjectsOffered,
  useSetSubjectOffered,
  type AcademySubjectRow,
} from '../../lib/academySubjects';
import { useAuthStore } from '../../stores/auth';
import {
  Badge,
  EmptyState,
  ErrorNote,
  Field,
  Modal,
  PageHeader,
  Skeleton,
} from '../../components/ui';

/**
 * Which platform subjects this Center offers.
 *
 * The master catalogue is the platform's and is never edited here — a Center
 * only switches a row on or off for itself. Three things the first version got
 * wrong and this one does not: the list is ordered by the answer (what the
 * Center offers, first), it can be searched, and a tick is immediate rather
 * than a round trip plus a refetch of forty rows.
 */
export default function CenterSubjectsPage() {
  const { t, i18n } = useTranslation();
  const { academy, isLoading } = useOwnedAcademy();
  const { data, isLoading: loadingSubjects } = useAcademySubjects(academy?.slug);
  const set = useSetSubjectOffered(academy?.slug);
  const setAll = useSetAllSubjectsOffered(academy?.slug);
  const isPlatformOwner = useAuthStore((s) => s.user?.role) === Role.SUPER_ADMIN;
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const ar = i18n.language?.startsWith('ar');

  const name = (s: AcademySubjectRow) => (ar ? s.nameAr : s.nameEn);
  const other = (s: AcademySubjectRow) => (ar ? s.nameEn : s.nameAr);

  /**
   * Offered first, then core, then the catalogue's own order.
   *
   * What a Center offers is the short list it actually works from; everything
   * else is a catalogue to go shopping in. Sorting on `offered` alone would
   * reshuffle the list under the owner's finger on every tick, so the order is
   * computed from the server's answer and held still while they work — it
   * settles on the next load.
   */
  const rows = useMemo(() => {
    const all = data?.subjects ?? [];
    const needle = q.trim().toLowerCase();
    const found = needle
      ? all.filter((s) => `${s.nameAr} ${s.nameEn} ${s.code ?? ''}`.toLowerCase().includes(needle))
      : all;
    return [...found].sort(
      (a, b) => Number(b.offered) - Number(a.offered) || Number(b.isCore) - Number(a.isCore),
    );
    // `data?.subjects` is the dependency on purpose: the optimistic cache write
    // re-runs this, which is the one place the order is allowed to move.
  }, [data?.subjects, q]);

  const offeredCount = (data?.subjects ?? []).filter((s) => s.offered).length;

  if (isLoading || loadingSubjects)
    return (
      <div className="page">
        <Skeleton className="h-40 rounded-2xl" />
      </div>
    );
  if (!academy || !data)
    return (
      <div className="page">
        <EmptyState icon="apartment" title={t('center.noCenter')} />
      </div>
    );

  const busy = setAll.isPending;

  return (
    <div className="page">
      <PageHeader
        title={t('center.subjects')}
        subtitle={t('center.subjectsSub')}
        action={
          isPlatformOwner ? (
            <button className="btn-secondary" onClick={() => setAdding(true)}>
              <span className="material-symbols-outlined">add</span>
              {t('center.subjectAdd')}
            </button>
          ) : undefined
        }
      />
      <ErrorNote error={set.error ?? setAll.error} />

      {/* The toolbar stays at the top of the list, where the owner's hands are. */}
      <div className="mb-4 rounded-2xl border border-outline-variant bg-surface-container-low p-3 sm:p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <span className="material-symbols-outlined pointer-events-none absolute inset-y-0 start-3 my-auto h-fit text-outline">
              search
            </span>
            <input
              className="input w-full ps-11 pe-10"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('center.subjectSearch')}
              aria-label={t('center.subjectSearch')}
            />
            {q && (
              <button
                onClick={() => setQ('')}
                aria-label={t('common.clear')}
                className="absolute inset-y-0 end-2 my-auto grid h-7 w-7 place-items-center rounded-full text-outline transition hover:bg-surface-container-highest hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            )}
          </div>
          {data.gated && (
            <div className="flex shrink-0 gap-2">
              <button
                className="btn-secondary px-4 py-2 text-sm"
                disabled={busy}
                onClick={() => setAll.mutate(true)}
              >
                {t('center.subjectEnableAll')}
              </button>
              <button
                className="rounded-xl border border-error/30 px-4 py-2 text-sm font-bold text-error transition hover:bg-error-container/40"
                disabled={busy}
                onClick={async () => {
                  if (await askConfirm(t('center.subjectDisableAllConfirm'))) setAll.mutate(false);
                }}
              >
                {t('center.subjectDisableAll')}
              </button>
            </div>
          )}
        </div>
        {data.gated && (
          <p className="mt-3 border-t border-outline-variant/60 pt-3 text-sm text-on-surface-variant">
            {t('center.subjectOfferedCount', { count: offeredCount, total: data.subjects.length })}
          </p>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState icon="menu_book" title={t('center.subjectNoMatch')} />
      ) : (
        <div className="card p-0">
          <ul className="divide-y divide-outline-variant">
            {rows.map((s) => (
              <li key={s.id} className="flex items-center gap-3 p-4">
                <span className="material-symbols-outlined text-2xl text-primary">
                  {s.icon ?? 'menu_book'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold">{name(s)}</p>
                  <p className="truncate text-xs text-outline">{other(s)}</p>
                </div>
                {s.isCore && <Badge tone="primary">{t('center.subjectCore')}</Badge>}
                <Badge tone={s.offered ? 'teal' : 'neutral'}>
                  {s.offered ? t('center.subjectOffered') : t('center.subjectNotOffered')}
                </Badge>
                {data.gated && (
                  <button
                    className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold ${s.offered ? 'border border-error/40 text-error hover:bg-error-container/40' : 'btn-primary'}`}
                    disabled={busy}
                    onClick={() => set.mutate({ subjectId: s.id, isActive: !s.offered })}
                  >
                    {s.offered ? t('center.subjectDisable') : t('center.subjectEnable')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {isPlatformOwner && (
        <AddSubjectModal open={adding} onClose={() => setAdding(false)} slug={academy.slug} />
      )}
    </div>
  );
}

/** Platform-owner only: a subject the shipped catalogue does not have. */
function AddSubjectModal({
  open,
  onClose,
  slug,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
}) {
  const { t } = useTranslation();
  const create = useCreateSubject(slug);
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [track, setTrack] = useState('BOTH');
  const [isCore, setIsCore] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { nameAr, nameEn, track, isCore },
      {
        onSuccess: () => {
          setNameAr('');
          setNameEn('');
          setIsCore(false);
          onClose();
        },
      },
    );
  };

  return (
    <Modal open={open} title={t('center.subjectAdd')} onClose={onClose}>
      <form onSubmit={submit} className="grid gap-4">
        <p className="text-sm text-on-surface-variant">{t('center.subjectAddHint')}</p>
        <ErrorNote error={create.error} />
        <Field label={t('center.subjectNameAr')}>
          <input
            className="input"
            required
            minLength={2}
            maxLength={80}
            value={nameAr}
            onChange={(e) => setNameAr(e.target.value)}
          />
        </Field>
        <Field label={t('center.subjectNameEn')}>
          <input
            className="input"
            required
            minLength={2}
            maxLength={80}
            value={nameEn}
            onChange={(e) => setNameEn(e.target.value)}
            dir="ltr"
          />
        </Field>
        <Field label={t('center.subjectTrack')}>
          <select className="input" value={track} onChange={(e) => setTrack(e.target.value)}>
            <option value="BOTH">{t('center.subjectTrackBoth')}</option>
            <option value="GENERAL">{t('center.subjectTrackGeneral')}</option>
            <option value="LANGUAGES">{t('center.subjectTrackLanguages')}</option>
          </select>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isCore} onChange={(e) => setIsCore(e.target.checked)} />
          {t('center.subjectMarkCore')}
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary px-4 py-2" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn-primary px-4 py-2" disabled={create.isPending}>
            {create.isPending ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
