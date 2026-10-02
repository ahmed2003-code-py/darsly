import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import Avatar from '../../components/Avatar';
import { Badge, EmptyState, Spinner, TabRail } from '../../components/ui';
import { dateShort, egp } from '../../lib/format';
import {
  useAssistantWorkspace,
  useStaffCare,
  useStaffProgress,
  useStaffStudent,
  useStudentPayments,
} from '../../lib/staff';
import { useStaffAcademyStore } from '../../stores/staffAcademy';
import { AttendanceCard, CourseProgressList, LiveList } from '../care/CareViews';
import GuardianManager from '../care/GuardianManager';
import { useRegistryRecord } from '../../lib/centerStudents';
import { useFeesAccess } from '../../lib/centerFees';
import StudentFeesPanel from '../fees/StudentFeesPanel';
import { useFollowUpAccess } from '../../lib/followUp';
import StudentFollowUpPanel from '../followup/StudentFollowUpPanel';
import { usePaperExamsAccess } from '../../lib/paperExams';
import StudentGradesPanel from '../exams/StudentGradesPanel';
import RegistryCard from '../center/RegistryCard';

type Tab =
  | 'overview'
  | 'progress'
  | 'groups'
  | 'guardians'
  | 'payments'
  | 'fees'
  | 'followup'
  | 'grades'
  | 'care';

/**
 * Student 360 — one student, as far as the viewer's reach goes.
 *
 * Every section is read through the viewer's scope on the server: a
 * course-limited assistant sees their courses' slice and nothing else; the
 * owner sees their academy's. A section the viewer holds no capability for is
 * not shown (and would be refused). No wallet, nothing platform-wide.
 */
export default function StaffStudentPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const ws = useAssistantWorkspace();
  const selected = useStaffAcademyStore((s) => s.academyId);
  const academyId = params.get('academy') ?? ws.academyId ?? selected ?? undefined;
  const student = useStaffStudent(academyId, id);
  const s = student.data;
  const progress = useStaffProgress(academyId, id, !!s?.can.progress);
  const care = useStaffCare(academyId, s ? id : undefined);
  const payments = useStudentPayments(academyId, id, !!s?.can.payments);
  const [tab, setTab] = useState<Tab>('overview');
  // The center's own fees (C4) — separate from the platform's course payments above.
  const feesAccess = useFeesAccess(academyId);
  // Student follow-up (C5) — cases, contacts and the timeline.
  const followUpAccess = useFollowUpAccess(academyId);
  // Paper exams (C6) — published grades in the groups this person reaches.
  const gradesAccess = usePaperExamsAccess(academyId);
  const record = useRegistryRecord(
    academyId,
    id,
    !!feesAccess.data?.canView || !!followUpAccess.data?.canView,
  );
  const feesFor = feesAccess.data?.canView ? record.data?.id : undefined;
  const followUpFor = followUpAccess.data?.canView ? record.data?.id : undefined;
  // By the learner's profile: a teacher grades without register access.
  const gradesFor = gradesAccess.data?.canView ? id : undefined;

  const tabs = useMemo(
    () =>
      (
        [
          ['overview', true],
          ['progress', !!s?.can.progress],
          ['groups', true],
          ['guardians', !!s?.can.guardians],
          ['payments', !!s?.can.payments],
          ['fees', !!feesFor],
          ['followup', !!followUpFor],
          ['grades', !!gradesFor],
          ['care', true],
        ] as [Tab, boolean][]
      )
        .filter(([, ok]) => ok)
        .map(([k]) => k),
    [s, feesFor, followUpFor, gradesFor],
  );

  if (ws.isLoading || student.isLoading) {
    return (
      <div className="page grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  if (!s || !academyId) {
    return (
      <div className="page">
        <EmptyState
          icon="person_off"
          title={t('staff.studentNotFound')}
          hint={t('staff.studentNotFoundHint')}
        />
      </div>
    );
  }

  const avg = progress.data?.length
    ? Math.round(progress.data.reduce((n, p) => n + p.percent, 0) / progress.data.length)
    : null;
  const teamThread = care.data?.conversations.find(
    (c) => c.kind === 'TEAM' && c.learner === 'STUDENT',
  );

  return (
    <div className="page">
      <div className="card mb-4 flex flex-wrap items-center gap-4 p-4 sm:p-5">
        <Avatar id={s.id} name={s.name} url={s.avatarUrl} size={60} />
        <div className="min-w-[12rem] flex-1">
          <h1 className="font-heading text-2xl font-bold text-on-surface">
            <bdi className="break-words">{s.name}</bdi>
          </h1>
          <div className="mt-1 flex flex-wrap gap-1">
            {s.courses.map((c) => (
              <Badge key={c.id} tone={c.status === 'ACTIVE' ? 'primary' : 'neutral'}>
                {c.title} · {t(`staff.enrollment.${c.status}`, c.status)}
              </Badge>
            ))}
            {s.guardians > 0 && (
              <Badge tone="neutral">
                <span className="material-symbols-outlined text-[14px]">family_restroom</span>
                {t('care.guardiansCount', { count: s.guardians })}
              </Badge>
            )}
          </div>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          {s.can.message && (
            <Link
              to={`/messages?student=${encodeURIComponent(s.id)}&academy=${encodeURIComponent(academyId)}`}
              className="btn-primary flex-1 justify-center sm:flex-none"
            >
              <span className="material-symbols-outlined text-[20px]">chat</span>
              {t('staff.message')}
            </Link>
          )}
          {teamThread && (
            <Link
              to={`/messages?t=${teamThread.id}`}
              className="btn-secondary flex-1 justify-center sm:flex-none"
            >
              <span className="material-symbols-outlined text-[20px]">support_agent</span>
              {t('care.supportConversation')}
            </Link>
          )}
        </div>
      </div>

      <RegistryCard academyId={academyId} studentId={s.id} />

      <div className="mb-4">
        <TabRail tabs={tabs} value={tab} onChange={setTab} labelOf={(k) => t(`care.tab.${k}`)} />
      </div>

      {tab === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label={t('care.tile.courses')} value={String(s.courses.length)} />
            <Tile label={t('care.tile.progress')} value={avg != null ? `${avg}%` : '—'} />
            <Tile
              label={t('care.tile.attendance')}
              value={
                care.data?.attendance
                  ? `${Math.round(((care.data.attendance.PRESENT + care.data.attendance.LATE) / care.data.attendance.total) * 100)}%`
                  : '—'
              }
            />
            <Tile label={t('care.tile.groups')} value={String(care.data?.groups.length ?? '—')} />
          </div>
          <AttendanceCard attendance={care.data?.attendance ?? null} />
          <LiveList live={care.data?.live ?? []} />
          {!care.data?.attendance && !care.data?.live.length && (
            <p className="text-sm text-on-surface-variant">{t('care.nothingRecorded')}</p>
          )}
        </div>
      )}

      {tab === 'progress' &&
        (progress.isLoading ? <Spinner /> : <CourseProgressList courses={progress.data ?? []} />)}

      {tab === 'groups' &&
        (!care.data?.groups.length ? (
          <EmptyState icon="diversity_3" title={t('care.noGroups')} />
        ) : (
          <ul className="space-y-2">
            {care.data.groups.map((g) => (
              <li key={g.id} className="card flex items-center gap-3 p-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-secondary-container text-on-secondary-container">
                  <span className="material-symbols-outlined text-[20px]">groups</span>
                </span>
                <div className="min-w-0 flex-1">
                  <bdi className="block truncate font-bold text-on-surface">{g.name}</bdi>
                  <span className="text-xs text-on-surface-variant">
                    {t('care.since', { date: dateShort(g.since) })}
                  </span>
                </div>
                {g.chat ? (
                  <Link to={`/messages?t=${g.chat.threadId}`} className="btn-secondary shrink-0">
                    <span className="material-symbols-outlined text-[18px]">forum</span>
                    {t('care.groupChat')}
                  </Link>
                ) : (
                  <span className="text-xs text-outline">{t('care.noGroupChat')}</span>
                )}
              </li>
            ))}
          </ul>
        ))}

      {tab === 'guardians' && (
        <GuardianManager
          academyId={academyId}
          studentId={s.id}
          studentName={s.name}
          // C5: the register's guardian contact, offered for an explicit invitation.
          registerContact={
            followUpFor && record.data?.guardianPhone
              ? { name: record.data.guardianName, phone: record.data.guardianPhone }
              : null
          }
        />
      )}

      {tab === 'payments' &&
        (payments.isLoading ? (
          <Spinner />
        ) : !payments.data?.length ? (
          <EmptyState icon="receipt_long" title={t('staff.noPayments')} />
        ) : (
          <ul className="card divide-y divide-outline-variant/40 p-0">
            {payments.data.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1 truncate text-sm text-on-surface">
                  {p.course?.title} · {dateShort(p.createdAt)}
                </span>
                <span className="font-bold text-on-surface" dir="ltr">
                  {egp(p.amountCents)}
                </span>
                <Badge
                  tone={
                    p.status === 'PAID' ? 'primary' : p.status === 'PENDING' ? 'warn' : 'neutral'
                  }
                >
                  {t(`staff.paymentStatus.${p.status}`, p.status)}
                </Badge>
              </li>
            ))}
          </ul>
        ))}

      {tab === 'fees' && feesFor && academyId && (
        <StudentFeesPanel academyId={academyId} academyStudentId={feesFor} />
      )}
      {tab === 'followup' && followUpFor && academyId && (
        <StudentFollowUpPanel
          academyId={academyId}
          academyStudentId={followUpFor}
          canManage={!!followUpAccess.data?.canManage}
          onGoGuardians={s.can.guardians ? () => setTab('guardians') : undefined}
        />
      )}
      {tab === 'grades' && gradesFor && academyId && (
        <StudentGradesPanel academyId={academyId} studentId={gradesFor} />
      )}
      {tab === 'care' &&
        (!care.data?.conversations.length ? (
          <EmptyState icon="forum" title={t('care.noConversations')} />
        ) : (
          <ul className="space-y-2">
            {care.data.conversations.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/messages?t=${c.id}`}
                  className="card flex items-center gap-3 p-3 hover:bg-surface-container-low"
                >
                  <span className="material-symbols-outlined text-primary-text">
                    {c.kind === 'GROUP' ? 'groups' : c.kind === 'TEAM' ? 'support_agent' : 'chat'}
                  </span>
                  <span className="min-w-0 flex-1 text-sm font-bold text-on-surface">
                    {t(`care.conv.${c.kind}`)}
                    {c.learner === 'GUARDIAN' ? ` · ${t('care.withGuardian')}` : ''}
                  </span>
                  {c.resolved != null && (
                    <Badge tone={c.resolved ? 'neutral' : 'warn'}>
                      {c.resolved ? t('messages.resolved') : t('care.open')}
                    </Badge>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-3 text-center">
      <div className="font-heading text-2xl font-bold text-on-surface" dir="ltr">
        {value}
      </div>
      <div className="text-xs text-on-surface-variant">{label}</div>
    </div>
  );
}
