import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import Avatar from '../../components/Avatar';
import { EmptyState, ErrorNote, Skeleton, Spinner } from '../../components/ui';
import { useGuardianChildren, useGuardianOverview } from '../../lib/guardian';
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
          <LiveList live={o.live} />
          <ActivityList activity={o.activity} />
          <p className="px-1 text-center text-xs text-outline">{t('guardian.privacyNote')}</p>
        </div>
      ) : null}
    </div>
  );
}
