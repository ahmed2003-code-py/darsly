import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorNote, Modal, Skeleton } from '../../components/ui';
import { useGroupDetail, useGroups } from '../../lib/academyOps';
import { askConfirm, confirmDelete } from '../../lib/confirm';
import {
  ClassAccess,
  Slot,
  SlotChangeSummary,
  SlotInput,
  formatClock,
  formatLocalDate,
  newRequestKey,
  shiftDate,
  useCancelClass,
  useCreateSlot,
  useDeleteSlot,
  useGroupClasses,
  useGroupOptions,
  useSlots,
  useTransferMember,
  useUpdateGroupConfig,
  useUpdateSlot,
} from '../../lib/classOps';
import { ClassCard } from './ClassesTodayPage';

/** 0 = Sunday … 6 = Saturday, in the order an Egyptian week is read (from Saturday). */
const WEEK_ORDER = [6, 0, 1, 2, 3, 4, 5];
const DURATIONS = [60, 90, 120, 150, 180];

// ── Classes tab ──────────────────────────────────────────────────────────

/**
 * A group's classes: the next two weeks and the last two, each opening its
 * attendance. Cancelling ONE class lives here, on the class — kept apart from
 * the timetable, where changes apply to every week.
 */
export function GroupClassesTab({
  groupId,
  access,
  onLegacy,
}: {
  groupId: string;
  access: ClassAccess;
  onLegacy: () => void;
}) {
  const { t, i18n } = useTranslation();
  const today = access.today ?? new Date().toISOString().slice(0, 10);
  const list = useGroupClasses(groupId, shiftDate(today, -14), shiftDate(today, 14));
  const cancel = useCancelClass();
  const nowMs = Date.now();
  const classes = list.data?.classes ?? [];
  const upcoming = classes.filter((c) => new Date(c.endAt).getTime() > nowMs);
  const past = classes.filter((c) => new Date(c.endAt).getTime() <= nowMs).reverse();

  const cancelOne = async (id: string, date: string, time: string) => {
    const ok = await confirmDelete({
      kind: 'cancel',
      title: t('classes.cancelOneTitle'),
      message: t('classes.cancelOneBody', {
        date: formatLocalDate(date, i18n.language),
        time: formatClock(time, i18n.language),
      }),
      confirmLabel: t('classes.cancelOneAction'),
    });
    if (ok) cancel.mutate(id);
  };

  return (
    <div className="grid gap-5">
      <ErrorNote error={list.error} />
      <ErrorNote error={cancel.error} />
      {list.isLoading ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : !classes.length ? (
        <EmptyState
          icon="event_note"
          title={t('classes.groupNone')}
          hint={access.canSchedule ? t('classes.groupNoneHintPlan') : t('classes.noneHint')}
        />
      ) : (
        <>
          <section>
            <h2 className="mb-2 font-heading text-base font-bold">{t('classes.upcoming')}</h2>
            {!upcoming.length ? (
              <p className="text-sm text-on-surface-variant">{t('classes.upcomingNone')}</p>
            ) : (
              <ul className="grid gap-3 lg:grid-cols-2">
                {upcoming.map((c) => (
                  <div key={c.id} className="grid gap-1">
                    <p className="px-1 text-xs font-semibold text-on-surface-variant">
                      {formatLocalDate(c.date, i18n.language)}
                    </p>
                    <ClassCard c={c} nowMs={nowMs} />
                    {access.canSchedule &&
                      c.status === 'SCHEDULED' &&
                      !c.startedAt &&
                      // Only a class that has not begun: one already under way is
                      // taken in the room, not called off from a list.
                      new Date(c.startAt).getTime() > nowMs && (
                        <button
                          className="btn-ghost min-h-11 justify-self-start px-3 text-sm text-error"
                          onClick={() => cancelOne(c.id, c.date, c.startTime)}
                          disabled={cancel.isPending}
                        >
                          <span className="material-symbols-outlined text-base" aria-hidden>
                            event_busy
                          </span>
                          {t('classes.cancelOne')}
                        </button>
                      )}
                  </div>
                ))}
              </ul>
            )}
          </section>
          {past.length > 0 && (
            <section>
              <h2 className="mb-2 font-heading text-base font-bold">{t('classes.past')}</h2>
              <ul className="grid gap-3 lg:grid-cols-2">
                {past.map((c) => (
                  <div key={c.id} className="grid gap-1">
                    <p className="px-1 text-xs font-semibold text-on-surface-variant">
                      {formatLocalDate(c.date, i18n.language)}
                    </p>
                    <ClassCard c={c} nowMs={nowMs} />
                  </div>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      <button className="btn-ghost min-h-11 justify-self-start px-3 text-sm" onClick={onLegacy}>
        <span className="material-symbols-outlined text-base" aria-hidden>
          history
        </span>
        {t('classes.legacyLink')}
      </button>
    </div>
  );
}

// ── Timetable tab ────────────────────────────────────────────────────────

export function GroupTimetableTab({ groupId, access }: { groupId: string; access: ClassAccess }) {
  const { t, i18n } = useTranslation();
  const slots = useSlots(groupId);
  const [editing, setEditing] = useState<Slot | 'new' | null>(null);
  const del = useDeleteSlot(groupId);

  const remove = async (slot: Slot) => {
    const preview = await del.mutateAsync({ slotId: slot.id, dryRun: true }).catch(() => null);
    const ok = await confirmDelete({
      kind: 'remove',
      title: t('timetable.removeTitle'),
      message: t('timetable.removeBody', {
        slot: slotLabel(slot, t, i18n.language),
        removed: preview?.summary.removed ?? 0,
        kept: preview?.summary.kept ?? 0,
      }),
    });
    if (ok) del.mutate({ slotId: slot.id });
  };

  return (
    <div className="grid gap-5">
      {access.canManageGroups && <GroupSettingsCard groupId={groupId} />}

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-heading text-base font-bold">{t('timetable.title')}</h2>
          <button className="btn-primary min-h-11 px-4" onClick={() => setEditing('new')}>
            <span className="material-symbols-outlined text-lg" aria-hidden>
              add
            </span>
            {t('timetable.add')}
          </button>
        </div>
        <p className="mb-3 text-sm text-on-surface-variant">{t('timetable.hint')}</p>
        <ErrorNote error={slots.error} />
        <ErrorNote error={del.error} />
        {slots.isLoading ? (
          <Skeleton className="h-24 rounded-2xl" />
        ) : !slots.data?.length ? (
          <EmptyState
            icon="calendar_add_on"
            title={t('timetable.empty')}
            hint={t('timetable.emptyHint')}
          />
        ) : (
          <ul className="grid gap-2">
            {[...slots.data]
              .sort(
                (a, b) =>
                  WEEK_ORDER.indexOf(a.weekday) - WEEK_ORDER.indexOf(b.weekday) ||
                  a.startTime.localeCompare(b.startTime),
              )
              .map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center gap-3 rounded-2xl border border-outline-variant bg-surface-container-lowest p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-bold">
                      {t(`timetable.weekday.${s.weekday}`)} ·{' '}
                      <span className="tabular-nums">
                        {formatClock(s.startTime, i18n.language)} –{' '}
                        {formatClock(addMinutes(s.startTime, s.durationMin), i18n.language)}
                      </span>
                    </p>
                    <p className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-on-surface-variant">
                      {s.room ? (
                        <bdi>{s.room.name}</bdi>
                      ) : (
                        s.locationType && t(`timetable.place.${s.locationType}`)
                      )}
                      {s.teacher && <bdi>{s.teacher.fullName}</bdi>}
                      {s.validTo && (
                        <span>
                          {t('timetable.until', {
                            date: formatLocalDate(s.validTo, i18n.language),
                          })}
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <button
                      className="btn-ghost min-h-11 px-3 text-sm"
                      onClick={() => setEditing(s)}
                    >
                      {t('timetable.edit')}
                    </button>
                    <button
                      className="btn-ghost min-h-11 px-3 text-sm text-error"
                      onClick={() => remove(s)}
                      disabled={del.isPending}
                    >
                      {t('timetable.remove')}
                    </button>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </section>
      {editing && (
        <SlotForm
          groupId={groupId}
          slot={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function addMinutes(hhmm: string, min: number) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (h * 60 + m + min) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function slotLabel(s: Pick<Slot, 'weekday' | 'startTime'>, t: (k: string) => string, lang: string) {
  return `${t(`timetable.weekday.${s.weekday}`)} ${formatClock(s.startTime, lang)}`;
}

/**
 * Add or change a weekly class. A change is first asked of the server as a
 * dry run, and the reader is told in words what will happen — how many
 * coming classes move, from which date, and that started, cancelled and
 * hand-edited ones stay — before anything is saved.
 */
function SlotForm({
  groupId,
  slot,
  onClose,
}: {
  groupId: string;
  slot: Slot | null;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const options = useGroupOptions(groupId);
  const create = useCreateSlot(groupId);
  const update = useUpdateSlot(groupId);
  const [requestKey] = useState(newRequestKey);
  const [form, setForm] = useState<SlotInput>({
    weekday: slot?.weekday ?? 6,
    startTime: slot?.startTime ?? '18:00',
    durationMin: slot?.durationMin ?? 90,
    roomId: slot?.roomId ?? null,
    teacherUserId: slot?.teacherUserId ?? null,
    locationType: slot?.locationType ?? (options.data?.kind === 'PERSONAL' ? 'TEACHER' : 'CENTER'),
    locationNote: slot?.locationNote ?? null,
  });
  const set = <K extends keyof SlotInput>(k: K, v: SlotInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const busy = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  const describe = (s: SlotChangeSummary) =>
    [
      s.updated + s.created + s.removed
        ? t('timetable.changeBody', {
            count: s.updated + s.removed,
            date: formatLocalDate(s.from, i18n.language),
          })
        : t('timetable.changeNothing'),
      // Said only when it happens — "and 0 new classes" is noise.
      s.created ? t('timetable.changeCreated', { count: s.created }) : '',
      s.kept ? t('timetable.changeKept', { count: s.kept }) : '',
    ]
      .filter(Boolean)
      .join(' ');

  const save = async () => {
    const dto: SlotInput = {
      ...form,
      locationType: form.roomId ? 'CENTER' : form.locationType,
    };
    if (!slot) {
      create.mutate({ ...dto, requestKey }, { onSuccess: onClose });
      return;
    }
    const preview = await update
      .mutateAsync({ slotId: slot.id, dto, dryRun: true })
      .catch(() => null);
    if (!preview) return;
    const ok = await askConfirm(describe(preview.summary), {
      title: t('timetable.changeTitle'),
      confirmLabel: t('timetable.changeAction'),
    });
    if (ok) update.mutate({ slotId: slot.id, dto }, { onSuccess: onClose });
  };

  const field =
    'min-h-11 w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-3';
  return (
    <Modal open title={slot ? t('timetable.editTitle') : t('timetable.addTitle')} onClose={onClose}>
      <div className="grid gap-4">
        <label className="grid gap-1 text-sm">
          <span className="font-semibold">{t('timetable.day')}</span>
          <select
            className={field}
            value={form.weekday}
            onChange={(e) => set('weekday', Number(e.target.value))}
          >
            {WEEK_ORDER.map((d) => (
              <option key={d} value={d}>
                {t(`timetable.weekday.${d}`)}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1 text-sm">
            <span className="font-semibold">{t('timetable.start')}</span>
            <input
              type="time"
              required
              className={field}
              value={form.startTime}
              onChange={(e) => set('startTime', e.target.value)}
              dir="ltr"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-semibold">{t('timetable.duration')}</span>
            <select
              className={field}
              value={form.durationMin}
              onChange={(e) => set('durationMin', Number(e.target.value))}
            >
              {[...new Set([...DURATIONS, form.durationMin])]
                .sort((a, b) => a - b)
                .map((d) => (
                  <option key={d} value={d}>
                    {t('timetable.minutes', { count: d })}
                  </option>
                ))}
            </select>
          </label>
        </div>
        {!!options.data?.rooms.length && (
          <label className="grid gap-1 text-sm">
            <span className="font-semibold">{t('timetable.room')}</span>
            <select
              className={field}
              value={form.roomId ?? ''}
              onChange={(e) => set('roomId', e.target.value || null)}
            >
              <option value="">{t('timetable.noRoom')}</option>
              {options.data.rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {!form.roomId && (
          <label className="grid gap-1 text-sm">
            <span className="font-semibold">{t('timetable.placeLabel')}</span>
            <select
              className={field}
              value={form.locationType ?? 'CENTER'}
              onChange={(e) => set('locationType', e.target.value as SlotInput['locationType'])}
            >
              {(['CENTER', 'TEACHER', 'STUDENT', 'OTHER'] as const).map((p) => (
                <option key={p} value={p}>
                  {t(`timetable.place.${p}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="grid gap-1 text-sm">
          <span className="font-semibold">{t('timetable.teacher')}</span>
          <select
            className={field}
            value={form.teacherUserId ?? ''}
            onChange={(e) => set('teacherUserId', e.target.value || null)}
          >
            <option value="">{t('timetable.noTeacher')}</option>
            {options.data?.teachers.map((tc) => (
              <option key={tc.id} value={tc.id}>
                {tc.fullName}
              </option>
            ))}
          </select>
        </label>
        {!slot && <p className="text-xs text-on-surface-variant">{t('timetable.addNote')}</p>}
        <ErrorNote error={error} />
        <ConflictDetail error={error} />
        <button
          className="btn-primary min-h-12"
          onClick={save}
          disabled={busy || !form.startTime}
          aria-busy={busy}
        >
          {busy ? t('common.saving') : slot ? t('timetable.saveChange') : t('timetable.saveNew')}
        </button>
      </div>
    </Modal>
  );
}

/** Which week the conflict is in, when the server named it. */
function ConflictDetail({ error }: { error: unknown }) {
  const { t, i18n } = useTranslation();
  const date = (error as { response?: { data?: { date?: string } } })?.response?.data?.date;
  if (!date) return null;
  return (
    <p className="-mt-2 text-sm text-on-surface-variant">
      {t('timetable.conflictOn', { date: formatLocalDate(date, i18n.language) })}
    </p>
  );
}

/** Seats, subject, year and late grace — the class side of a group's settings. */
function GroupSettingsCard({ groupId }: { groupId: string }) {
  const { t, i18n } = useTranslation();
  const detail = useGroupDetail(groupId);
  const options = useGroupOptions(groupId);
  const save = useUpdateGroupConfig(groupId);
  const [open, setOpen] = useState(false);
  const d = detail.data;
  const [form, setForm] = useState<{
    subjectId: string;
    gradeId: string;
    capacity: string;
    lateGraceMin: string;
  } | null>(null);
  const ar = i18n.language !== 'en';
  const name = (x?: { nameAr: string; nameEn: string } | null) =>
    x ? (ar ? x.nameAr : x.nameEn) : null;
  if (!d) return null;
  const facts = [
    [t('groupConfig.subject'), name(d.subject)],
    [t('groupConfig.grade'), name(d.grade)],
    [
      t('groupConfig.capacity'),
      d.capacity != null
        ? t('groupConfig.seatsOf', { seated: d.members.length, count: d.capacity })
        : t('groupConfig.unlimited'),
    ],
    [
      t('groupConfig.grace'),
      d.lateGraceMin != null
        ? t('groupConfig.minutes', { count: d.lateGraceMin })
        : t('groupConfig.graceDefault'),
    ],
  ];
  const field =
    'min-h-11 w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-3';
  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="font-heading text-base font-bold">{t('groupConfig.title')}</h2>
        <button
          className="btn-ghost min-h-11 px-3 text-sm"
          onClick={() => {
            setForm({
              subjectId: d.subject?.id ?? '',
              gradeId: d.grade?.id ?? '',
              capacity: d.capacity != null ? String(d.capacity) : '',
              lateGraceMin: d.lateGraceMin != null ? String(d.lateGraceMin) : '',
            });
            setOpen(true);
          }}
        >
          {t('timetable.edit')}
        </button>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        {facts.map(([k, v]) => (
          <div key={k as string} className="min-w-0">
            <dt className="text-xs text-outline">{k}</dt>
            <dd className="font-semibold [overflow-wrap:anywhere]">{v ?? '—'}</dd>
          </div>
        ))}
      </dl>
      {open && form && (
        <Modal open title={t('groupConfig.title')} onClose={() => setOpen(false)}>
          <div className="grid gap-4">
            <label className="grid gap-1 text-sm">
              <span className="font-semibold">{t('groupConfig.subject')}</span>
              <select
                className={field}
                value={form.subjectId}
                onChange={(e) => setForm({ ...form, subjectId: e.target.value })}
              >
                <option value="">—</option>
                {options.data?.subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {ar ? s.nameAr : s.nameEn}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-semibold">{t('groupConfig.grade')}</span>
              <select
                className={field}
                value={form.gradeId}
                onChange={(e) => setForm({ ...form, gradeId: e.target.value })}
              >
                <option value="">—</option>
                {options.data?.grades.map((g) => (
                  <option key={g.id} value={g.id}>
                    {ar ? g.nameAr : g.nameEn}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1 text-sm">
                <span className="font-semibold">{t('groupConfig.capacity')}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={1000}
                  placeholder={t('groupConfig.unlimited')}
                  className={field}
                  value={form.capacity}
                  onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="font-semibold">{t('groupConfig.grace')}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={120}
                  placeholder={t('groupConfig.graceDefault')}
                  className={field}
                  value={form.lateGraceMin}
                  onChange={(e) => setForm({ ...form, lateGraceMin: e.target.value })}
                />
              </label>
            </div>
            <ErrorNote error={save.error} />
            <button
              className="btn-primary min-h-12"
              disabled={save.isPending}
              onClick={() =>
                save.mutate(
                  {
                    subjectId: form.subjectId || null,
                    gradeId: form.gradeId || null,
                    capacity: form.capacity ? Number(form.capacity) : null,
                    lateGraceMin: form.lateGraceMin ? Number(form.lateGraceMin) : null,
                  },
                  { onSuccess: () => setOpen(false) },
                )
              }
            >
              {t('common.save')}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

// ── Transfer ─────────────────────────────────────────────────────────────

/** Move one student to another group, in one step (their history stays). */
export function TransferDialog({
  groupId,
  student,
  onClose,
}: {
  groupId: string;
  student: { studentId: string; fullName: string };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const groups = useGroups({ page: 1, pageSize: 100 });
  const transfer = useTransferMember(groupId);
  const [to, setTo] = useState('');
  const targets = (groups.data?.groups ?? []).filter(
    (g) => g.id !== groupId && g.status === 'ACTIVE',
  );
  return (
    <Modal open title={t('transfer.title')} onClose={onClose}>
      <p className="mb-3 text-sm">
        {t('transfer.body')} <bdi className="font-bold">{student.fullName}</bdi>
      </p>
      <label className="grid gap-1 text-sm">
        <span className="font-semibold">{t('transfer.to')}</span>
        <select
          className="min-h-11 w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-3"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        >
          <option value="">—</option>
          {targets.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
              {g.capacity != null ? ` (${g.studentsCount}/${g.capacity})` : ''}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-2 text-xs text-on-surface-variant">{t('transfer.note')}</p>
      <ErrorNote error={transfer.error} />
      <button
        className="btn-primary mt-4 min-h-12 w-full"
        disabled={!to || transfer.isPending}
        onClick={() =>
          transfer.mutate({ studentId: student.studentId, toGroupId: to }, { onSuccess: onClose })
        }
      >
        {t('transfer.action')}
      </button>
    </Modal>
  );
}
