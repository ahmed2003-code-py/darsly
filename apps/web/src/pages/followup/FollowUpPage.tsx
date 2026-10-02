import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Pager from '../../components/Pager';
import { EmptyState, ErrorNote, Modal, Skeleton, Spinner, TabRail } from '../../components/ui';
import { useFeesAccess } from '../../lib/centerFees';
import { useRegistryAcademyId } from '../../lib/centerStudents';
import { formatInstant } from '../../lib/classOps';
import {
  CaseStatus,
  CaseView,
  SIGNAL_REASONS,
  SignalReason,
  SignalRow,
  useCases,
  useContactsToday,
  useFollowUpAccess,
  useFollowUpActions,
  useFollowUpSettings,
  useSignals,
} from '../../lib/followUp';
import { usePaperExamsAccess } from '../../lib/paperExams';
import {
  AssignDialog,
  CaseLine,
  CloseCaseDialog,
  ContactDialog,
  OpenCaseDialog,
  ReasonChip,
  SignalDetail,
} from './followParts';
import StudentFollowUpPanel from './StudentFollowUpPanel';

type Tab = 'today' | 'cases' | 'contacts' | 'settings';

/**
 * Student follow-up (C5): who needs a call today, the cases being worked, and
 * who was contacted. Signals are derived by the server from attendance and
 * fees on every read; nothing here changes attendance or money, and nothing
 * is sent by itself — staff call or open WhatsApp on their own phone and log
 * what happened.
 */
export default function FollowUpPage() {
  const { t } = useTranslation();
  const academyId = useRegistryAcademyId();
  const access = useFollowUpAccess(academyId);
  const a = access.data;
  const [tab, setTab] = useState<Tab>('today');
  const [sheet, setSheet] = useState<{ id: string; name: string } | null>(null);
  if (!academyId || access.isLoading)
    return (
      <div className="page grid place-items-center py-24">
        <Spinner />
      </div>
    );
  if (!a?.enabled)
    return (
      <div className="page">
        <EmptyState icon="toggle_off" title={t('followUp.off')} hint={t('followUp.offHint')} />
      </div>
    );
  if (!a.canView)
    return (
      <div className="page">
        <EmptyState icon="lock" title={t('followUp.noAccess')} hint={t('followUp.noAccessHint')} />
      </div>
    );
  const tabs: Tab[] = [
    'today',
    'cases',
    'contacts',
    ...(a.canSettings ? (['settings'] as const) : []),
  ];
  const openStudent = (id: string, name: string) => setSheet({ id, name });
  return (
    <div className="page max-w-5xl">
      <h1 className="mb-1 font-heading text-2xl font-extrabold sm:text-3xl">
        {t('followUp.page.title')}
      </h1>
      <p className="mb-4 text-sm text-on-surface-variant">{t('followUp.page.sub')}</p>
      <div className="mb-4">
        <TabRail
          tabs={tabs}
          value={tab}
          onChange={setTab}
          labelOf={(k) => t(`followUp.page.tab.${k}`)}
        />
      </div>
      {tab === 'today' && (
        <Today academyId={academyId} canManage={a.canManage} onOpen={openStudent} />
      )}
      {tab === 'cases' && (
        <Cases academyId={academyId} canManage={a.canManage} onOpen={openStudent} />
      )}
      {tab === 'contacts' && <ContactsToday academyId={academyId} onOpen={openStudent} />}
      {tab === 'settings' && a.canSettings && <Settings academyId={academyId} />}
      {sheet && (
        <Modal open title={sheet.name} onClose={() => setSheet(null)} variant="sheet">
          <StudentFollowUpPanel
            academyId={academyId}
            academyStudentId={sheet.id}
            canManage={a.canManage}
          />
        </Modal>
      )}
    </div>
  );
}

function Today({
  academyId,
  canManage,
  onOpen,
}: {
  academyId: string;
  canManage: boolean;
  onOpen: (id: string, name: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<SignalReason | undefined>();
  const [notContacted, setNotContacted] = useState(false);
  const [page, setPage] = useState(1);
  const [contact, setContact] = useState<SignalRow | null>(null);
  const [opening, setOpening] = useState<SignalRow | null>(null);
  useEffect(() => setPage(1), [reason, notContacted]);
  const q = useSignals(academyId, { reason, notContacted, page });
  const fees = useFeesAccess(academyId);
  const currency = fees.data?.currency ?? undefined;
  // C6: the low-grade card only for someone who may see grades.
  const grades = !!usePaperExamsAccess(academyId).data?.canView;
  const reasons = SIGNAL_REASONS.filter((r) => r !== 'LOW_GRADE' || grades);
  const d = q.data;
  return (
    <section>
      {d && (
        <div
          className={`mb-4 grid grid-cols-2 gap-2 ${reasons.length > 4 ? 'sm:grid-cols-5' : 'sm:grid-cols-4'}`}
        >
          {reasons.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setReason(reason === r ? undefined : r)}
              aria-pressed={reason === r}
              className={`card min-h-16 min-w-0 p-3 text-start ${reason === r ? 'border-2 border-primary' : ''}`}
            >
              <span className="line-clamp-2 block text-xs text-on-surface-variant">
                {t(`followUp.reason.${r}`)}
              </span>
              <span className="block text-lg font-extrabold tabular-nums">{d.totals[r] ?? 0}</span>
            </button>
          ))}
        </div>
      )}
      <label className="mb-3 flex min-h-11 items-center gap-2 text-sm font-semibold">
        <input
          type="checkbox"
          className="size-5"
          checked={notContacted}
          onChange={(e) => setNotContacted(e.target.checked)}
        />
        {t('followUp.page.notContacted')}
      </label>
      <ErrorNote error={q.error} />
      {!d ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : d.items.length === 0 ? (
        <EmptyState
          icon="task_alt"
          title={t('followUp.page.noSignals')}
          hint={t('followUp.page.noSignalsHint')}
        />
      ) : (
        <ul className="divide-y divide-outline-variant/40 rounded-2xl border border-outline-variant/50">
          {d.items.map((r) => (
            <li key={`${r.academyStudentId}:${r.reason}:${r.signalKey}`} className="px-3 py-2">
              <button
                type="button"
                className="block w-full min-w-0 text-start"
                onClick={() => r.student && onOpen(r.student.id, r.student.fullName)}
              >
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate font-semibold">
                    <bdi>{r.student?.fullName}</bdi>
                  </span>
                  <span className="font-mono text-xs text-on-surface-variant" dir="ltr">
                    {r.student?.code}
                  </span>
                  <ReasonChip reason={r.reason} />
                </span>
                <span className="mt-0.5 block text-sm text-on-surface-variant">
                  <SignalDetail row={r} currency={currency} />
                </span>
              </button>
              <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {r.contactedToday && (
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-800 dark:text-emerald-300">
                    {t('followUp.page.contactedToday')}
                  </span>
                )}
                {r.openCase && (
                  <span className="rounded-full bg-primary-fixed/50 px-2 py-0.5 text-xs font-semibold">
                    {t('followUp.page.caseOpen')}
                  </span>
                )}
                {canManage && (
                  <span className="ms-auto flex gap-1.5">
                    <button
                      type="button"
                      className="btn-ghost min-h-11 px-3"
                      onClick={() => setContact(r)}
                    >
                      {t('followUp.contact.log')}
                    </button>
                    {!r.openCase && (
                      <button
                        type="button"
                        className="btn-ghost min-h-11 px-3"
                        onClick={() => setOpening(r)}
                      >
                        {t('followUp.case.open')}
                      </button>
                    )}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {d && d.total > d.pageSize && (
        <div className="mt-3">
          <Pager page={page} pages={Math.ceil(d.total / d.pageSize)} onGo={setPage} />
        </div>
      )}
      {contact && (
        <ContactDialog
          academyId={academyId}
          academyStudentId={contact.academyStudentId}
          followUpId={contact.openCase?.id}
          onClose={() => setContact(null)}
        />
      )}
      {opening && (
        <OpenCaseDialog
          academyId={academyId}
          academyStudentId={opening.academyStudentId}
          name={opening.student?.fullName ?? ''}
          reason={opening.reason}
          signalKey={opening.signalKey}
          onClose={() => setOpening(null)}
        />
      )}
    </section>
  );
}

function Cases({
  academyId,
  canManage,
  onOpen,
}: {
  academyId: string;
  canManage: boolean;
  onOpen: (id: string, name: string) => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CaseStatus>('OPEN');
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const [closing, setClosing] = useState<CaseView | null>(null);
  const [assigning, setAssigning] = useState<CaseView | null>(null);
  useEffect(() => setPage(1), [status, mine]);
  const q = useCases(academyId, { status, mine, page });
  const d = q.data;
  return (
    <section>
      <div
        className="mb-3 flex gap-1.5 overflow-x-auto pb-1"
        role="tablist"
        aria-label={t('followUp.page.filter')}
      >
        {(['OPEN', 'RESOLVED', 'DISMISSED'] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={status === s}
            onClick={() => setStatus(s)}
            className={`min-h-11 shrink-0 rounded-full px-4 text-sm font-semibold ${
              status === s
                ? 'bg-primary text-on-primary'
                : 'bg-surface-container text-on-surface-variant'
            }`}
          >
            {t(`followUp.status.${s}`)}
          </button>
        ))}
      </div>
      <label className="mb-3 flex min-h-11 items-center gap-2 text-sm font-semibold">
        <input
          type="checkbox"
          className="size-5"
          checked={mine}
          onChange={(e) => setMine(e.target.checked)}
        />
        {t('followUp.page.mine')}
      </label>
      <ErrorNote error={q.error} />
      {!d ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : d.items.length === 0 ? (
        <EmptyState icon="inbox" title={t('followUp.page.noCases')} />
      ) : (
        <ul className="space-y-2">
          {d.items.map((c) => (
            <li key={c.id} className="rounded-2xl border border-outline-variant/50 p-3">
              <button
                type="button"
                className="flex w-full min-w-0 text-start"
                onClick={() => c.student && onOpen(c.student.id, c.student.fullName)}
              >
                <CaseLine c={c} showStudent />
              </button>
              {canManage && c.status === 'OPEN' && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-ghost min-h-11 px-3"
                    onClick={() => setAssigning(c)}
                  >
                    {t('followUp.case.assign')}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost min-h-11 px-3"
                    onClick={() => setClosing(c)}
                  >
                    {t('followUp.case.close')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {d && d.total > d.pageSize && (
        <div className="mt-3">
          <Pager page={page} pages={Math.ceil(d.total / d.pageSize)} onGo={setPage} />
        </div>
      )}
      {closing && (
        <CloseCaseDialog academyId={academyId} c={closing} onClose={() => setClosing(null)} />
      )}
      {assigning && (
        <AssignDialog academyId={academyId} c={assigning} onClose={() => setAssigning(null)} />
      )}
    </section>
  );
}

function ContactsToday({
  academyId,
  onOpen,
}: {
  academyId: string;
  onOpen: (id: string, name: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'en' ? 'en' : 'ar';
  const [page, setPage] = useState(1);
  const q = useContactsToday(academyId, page);
  const d = q.data;
  return (
    <section>
      <ErrorNote error={q.error} />
      {!d ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : d.items.length === 0 ? (
        <EmptyState icon="call" title={t('followUp.page.noContactsToday')} />
      ) : (
        <ul className="divide-y divide-outline-variant/40 rounded-2xl border border-outline-variant/50">
          {d.items.map((k) => (
            <li key={k.id}>
              <button
                type="button"
                className="block min-h-14 w-full px-3 py-2 text-start hover:bg-surface-container-low"
                onClick={() => k.student && onOpen(k.student.id, k.student.fullName)}
              >
                <span className="block truncate font-semibold">
                  <bdi>{k.student?.fullName}</bdi>{' '}
                  <span className="font-mono text-xs font-normal text-on-surface-variant" dir="ltr">
                    {k.student?.code}
                  </span>
                </span>
                <span className="block text-sm text-on-surface-variant">
                  {t(`followUp.channel.${k.channel}`)} · {t(`followUp.outcome.${k.outcome}`)} ·{' '}
                  {t(`followUp.party.${k.party}`)}
                </span>
                <span className="block text-xs text-on-surface-variant">
                  {k.contactedBy} · {formatInstant(k.contactedAt, d.timezone, lang)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {d && d.total > d.pageSize && (
        <div className="mt-3">
          <Pager page={page} pages={Math.ceil(d.total / d.pageSize)} onGo={setPage} />
        </div>
      )}
    </section>
  );
}

/** The few knobs — thresholds for signals, and whether guardians see fees. */
function Settings({ academyId }: { academyId: string }) {
  const { t } = useTranslation();
  const q = useFollowUpSettings(academyId);
  const act = useFollowUpActions(academyId);
  const [v, setV] = useState<{
    absenceStreak: number;
    lateStreak: number;
    overdueDays: number;
    guardianFeesVisible: boolean;
  } | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (q.data && !v) setV(q.data);
  }, [q.data, v]);
  if (!v) return <Skeleton className="h-48 rounded-2xl" />;
  const num = (k: 'absenceStreak' | 'lateStreak' | 'overdueDays', min: number, max: number) => (
    <label className="mb-3 block">
      <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
        {t(`followUp.settings.${k}`)}
      </span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        className="input min-h-11"
        value={v[k]}
        onChange={(e) => {
          setSaved(false);
          setV({ ...v, [k]: Math.max(min, Math.min(max, Number(e.target.value) || min)) });
        }}
      />
      <span className="mt-1 block text-xs text-on-surface-variant">
        {t(`followUp.settings.${k}Hint`, { min, max })}
      </span>
    </label>
  );
  return (
    <form
      className="card max-w-lg p-4"
      onSubmit={(e) => {
        e.preventDefault();
        act.updateSettings.mutate(v, { onSuccess: () => setSaved(true) });
      }}
    >
      {num('absenceStreak', 2, 10)}
      {num('lateStreak', 2, 10)}
      {num('overdueDays', 0, 90)}
      <label className="mb-1 flex min-h-11 items-center gap-2 text-sm font-semibold">
        <input
          type="checkbox"
          className="size-5"
          checked={v.guardianFeesVisible}
          onChange={(e) => {
            setSaved(false);
            setV({ ...v, guardianFeesVisible: e.target.checked });
          }}
        />
        {t('followUp.settings.guardianFeesVisible')}
      </label>
      <p className="mb-3 text-xs text-on-surface-variant">
        {t('followUp.settings.guardianFeesHint')}
      </p>
      <p className="mb-3 text-xs text-on-surface-variant">{t('followUp.settings.rewriteHint')}</p>
      <ErrorNote error={act.updateSettings.error} />
      {saved && (
        <p
          className="mb-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400"
          role="status"
        >
          {t('followUp.settings.saved')}
        </p>
      )}
      <button
        type="submit"
        className="btn-primary min-h-12 w-full"
        disabled={act.updateSettings.isPending}
      >
        {t('common.save')}
      </button>
    </form>
  );
}
