import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useGroupDetail, useGroups } from '../../lib/academyOps';
import {
  ConflictErrorBody,
  Room,
  ScheduleSession,
  useCancelSession,
  useCreateRoom,
  useCreateSession,
  useMyHomeAcademySlug,
  useRooms,
  useMySchedule,
  useSchedule,
  useUpdateRoom,
} from '../../lib/scheduling';
import { Badge, EmptyState, ErrorNote, Modal, PageHeader, Skeleton } from '../../components/ui';

const TABS = ['calendar', 'rooms'] as const;
type Tab = (typeof TABS)[number];
type ViewMode = 'month' | 'week' | 'day';

// Cairo-local day math, mirroring the server's own convention
// (gamification/period.util.ts) without pulling in a date library.
function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function startOfWeek(d: Date): Date {
  // Saturday-start week, same convention as weekKey() server-side.
  const day = d.getDay(); // 0=Sun..6=Sat
  const sinceSaturday = (day + 1) % 7;
  return startOfDay(addDays(d, -sinceSaturday));
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
/** Local-day key. toISOString() would give the UTC date, which for a
 *  local-midnight Date in Cairo (UTC+2/+3) is the *previous* day — every
 *  session would land one cell off. */
function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
/** The 6×7 grid a real calendar app shows — the visible month plus enough
 *  of the neighbouring months to fill whole weeks, Saturday-start. */
function monthGrid(anchor: Date): Date[] {
  const first = startOfWeek(startOfMonth(anchor));
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

const CONFLICT_KEY: Record<string, string> = {
  ROOM_CONFLICT: 'schedule.conflictRoom',
  TEACHER_CONFLICT: 'schedule.conflictTeacher',
  GROUP_CONFLICT: 'schedule.conflictGroup',
};

function ConflictNote({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const body = (error as { response?: { data?: ConflictErrorBody } })?.response?.data;
  if (!body?.code) return <ErrorNote error={error} />;
  return (
    <p className="mt-3 rounded-xl border border-error/15 bg-error-container px-4 py-2 text-sm text-on-error-container">
      {t(CONFLICT_KEY[body.code] ?? 'common.error')}
    </p>
  );
}

function CreateSessionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: groupsData } = useGroups({ pageSize: 100 });
  const [groupId, setGroupId] = useState('');
  const { data: group } = useGroupDetail(groupId || undefined);
  const { data: rooms } = useRooms();
  const [roomId, setRoomId] = useState('');
  const [teacherUserId, setTeacherUserId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [mode, setMode] = useState<'ONLINE' | 'PHYSICAL' | 'HYBRID'>('PHYSICAL');
  const [locationType, setLocationType] = useState<'CENTER' | 'TEACHER' | 'STUDENT' | 'OTHER'>(
    'CENTER',
  );
  const [locationNote, setLocationNote] = useState('');
  const [joinUrl, setJoinUrl] = useState('');
  const createSession = useCreateSession(groupId);
  const physical = mode !== 'ONLINE';
  const online = mode !== 'PHYSICAL';

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupId || !start || !end) return;
    createSession.mutate(
      {
        startAt: new Date(start).toISOString(),
        endAt: new Date(end).toISOString(),
        mode,
        ...(physical
          ? {
              locationType: roomId ? 'CENTER' : locationType,
              ...(locationNote ? { locationNote } : {}),
            }
          : {}),
        ...(physical && roomId ? { roomId } : {}),
        ...(online && joinUrl ? { joinUrl } : {}),
        ...(teacherUserId ? { teacherUserId } : {}),
      },
      { onSuccess: () => onClose() },
    );
  };

  return (
    <Modal open={open} onClose={onClose} title={t('schedule.createSession')}>
      <form onSubmit={submit} className="grid gap-4">
        <label className="grid gap-1.5">
          <span className="text-sm font-bold">{t('schedule.group')}</span>
          <select
            value={groupId}
            onChange={(e) => {
              setGroupId(e.target.value);
              setTeacherUserId('');
            }}
            className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary"
            required
          >
            <option value="">{t('schedule.selectGroup')}</option>
            {groupsData?.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5">
          <span className="text-sm font-bold">{t('schedule.mode')}</span>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
            className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary"
          >
            {(['PHYSICAL', 'ONLINE', 'HYBRID'] as const).map((m) => (
              <option key={m} value={m}>
                {t(`schedule.modes.${m}`)}
              </option>
            ))}
          </select>
        </label>
        {physical && (
          <label className="grid gap-1.5">
            <span className="text-sm font-bold">{t('schedule.locationType')}</span>
            <select
              value={roomId ? 'CENTER' : locationType}
              onChange={(e) => setLocationType(e.target.value as typeof locationType)}
              disabled={!!roomId}
              className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary"
            >
              {(['CENTER', 'TEACHER', 'STUDENT', 'OTHER'] as const).map((l) => (
                <option key={l} value={l}>
                  {t(`schedule.locations.${l}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        {physical && (
          <label className="grid gap-1.5">
            <span className="text-sm font-bold">{t('schedule.room')}</span>
            <select
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary"
            >
              <option value="">{t('schedule.noRoom')}</option>
              {rooms
                ?.filter((r) => r.status === 'ACTIVE')
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        {physical && !roomId && (
          <label className="grid gap-1.5">
            <span className="text-sm font-bold">{t('schedule.locationNote')}</span>
            <input
              value={locationNote}
              onChange={(e) => setLocationNote(e.target.value)}
              maxLength={120}
              className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary"
            />
          </label>
        )}
        {online && (
          <label className="grid gap-1.5">
            <span className="text-sm font-bold">{t('schedule.joinUrl')}</span>
            <input
              type="url"
              dir="ltr"
              value={joinUrl}
              onChange={(e) => setJoinUrl(e.target.value)}
              placeholder="https://"
              className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary"
            />
            <span className="text-xs text-outline">{t('schedule.joinUrlHint')}</span>
          </label>
        )}
        <label className="grid gap-1.5">
          <span className="text-sm font-bold">{t('schedule.teacher')}</span>
          <select
            value={teacherUserId}
            onChange={(e) => setTeacherUserId(e.target.value)}
            className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary"
            disabled={!groupId}
          >
            <option value="">{t('schedule.noTeacher')}</option>
            {group?.assignments.map((a) => (
              <option key={a.userId} value={a.userId}>
                {a.fullName}
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5">
            <span className="text-sm font-bold">{t('schedule.start')}</span>
            <input
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary"
              required
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-sm font-bold">{t('schedule.end')}</span>
            <input
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary"
              required
            />
          </label>
        </div>
        <button type="submit" className="btn-primary py-2.5" disabled={createSession.isPending}>
          {createSession.isPending ? t('common.saving') : t('common.save')}
        </button>
        <ConflictNote error={createSession.error} />
      </form>
    </Modal>
  );
}

/** One session chip — the small, colored, always-legible unit both the
 *  month grid and the day-detail panel are built from. */
function SessionChip({
  s,
  onCancel,
  cancelling,
  dense,
}: {
  s: ScheduleSession;
  onCancel: () => void;
  cancelling: boolean;
  dense?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const timeLabel = (iso: string) =>
    new Date(iso).toLocaleTimeString(i18n.language === 'ar' ? 'ar-EG' : 'en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });
  if (dense) {
    return (
      <p
        className={`truncate rounded-md px-1.5 py-0.5 text-[11px] font-bold ${s.status === 'CANCELLED' ? 'bg-surface-container-high text-outline line-through' : 'bg-primary-fixed text-on-primary-fixed-variant'}`}
      >
        <span dir="ltr">{timeLabel(s.startAt)}</span> {s.group?.name ?? s.title ?? ''}
      </p>
    );
  }
  return (
    <div className={`card p-3 ${s.status === 'CANCELLED' ? 'opacity-50' : ''}`}>
      <p className="truncate font-heading text-sm font-bold">{s.group?.name ?? s.title ?? ''}</p>
      <p className="text-xs text-on-surface-variant tabular-nums" dir="ltr">
        {timeLabel(s.startAt)}–{timeLabel(s.endAt)}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {s.academy && (
          <Badge tone={s.academy.kind === 'CENTER' ? 'teal' : 'neutral'}>{s.academy.name}</Badge>
        )}
        {(s.kind === 'LIVE' || s.mode) && (
          <Badge tone="warn">{t(`schedule.modes.${s.kind === 'LIVE' ? 'ONLINE' : s.mode}`)}</Badge>
        )}
        {s.locationType && s.locationType !== 'CENTER' && (
          <Badge tone="neutral">{t(`schedule.locations.${s.locationType}`)}</Badge>
        )}
        {s.room && <Badge tone="neutral">{s.room.name}</Badge>}
        {s.teacher && <Badge tone="primary">{s.teacher.fullName}</Badge>}
        {s.status === 'CANCELLED' && <Badge tone="error">{t('schedule.cancelled')}</Badge>}
      </div>
      {s.status === 'SCHEDULED' && s.kind !== 'LIVE' && (
        <button
          className="mt-2 text-xs font-bold text-error hover:underline"
          onClick={onCancel}
          disabled={cancelling}
        >
          {t('schedule.cancel')}
        </button>
      )}
    </div>
  );
}

function CalendarTab() {
  const { t, i18n } = useTranslation();
  const slug = useMyHomeAcademySlug();
  const [view, setView] = useState<ViewMode>('month');
  const [anchor, setAnchor] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState(() => isoDate(new Date()));
  const [showCreate, setShowCreate] = useState(false);
  const cancelSession = useCancelSession();
  const locale = i18n.language === 'ar' ? 'ar-EG' : 'en-GB';

  const rangeStart =
    view === 'day'
      ? startOfDay(anchor)
      : view === 'week'
        ? startOfWeek(anchor)
        : startOfWeek(startOfMonth(anchor));
  const rangeEnd =
    view === 'day'
      ? addDays(rangeStart, 1)
      : view === 'week'
        ? addDays(rangeStart, 7)
        : addDays(rangeStart, 42);
  const days = useMemo(() => {
    if (view === 'month') return monthGrid(anchor);
    return Array.from({ length: view === 'day' ? 1 : 7 }, (_, i) => addDays(rangeStart, i));
  }, [rangeStart, view, anchor]);
  const [allWorkspaces, setAllWorkspaces] = useState(false);
  const center = useSchedule(
    allWorkspaces ? undefined : slug,
    rangeStart.toISOString(),
    rangeEnd.toISOString(),
  );
  const mine = useMySchedule(allWorkspaces, rangeStart.toISOString(), rangeEnd.toISOString());
  const sessions = allWorkspaces ? mine.data : center.data;
  const isLoading = allWorkspaces ? mine.isLoading : center.isLoading;

  const byDay = useMemo(() => {
    const map = new Map<string, ScheduleSession[]>();
    for (const d of days) map.set(isoDate(d), []);
    for (const s of sessions ?? []) {
      const key = isoDate(new Date(s.startAt));
      if (map.has(key)) map.get(key)!.push(s);
    }
    return map;
  }, [sessions, days]);

  const step = (dir: 1 | -1) => {
    if (view === 'day') setAnchor((a) => addDays(a, dir));
    else if (view === 'week') setAnchor((a) => addDays(a, 7 * dir));
    else setAnchor((a) => addMonths(a, dir));
  };
  const goToday = () => {
    const now = new Date();
    setAnchor(now);
    setSelectedDay(isoDate(now));
  };

  const headerLabel =
    view === 'month'
      ? anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' })
      : view === 'week'
        ? `${rangeStart.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} – ${addDays(rangeStart, 6).toLocaleDateString(locale, { day: 'numeric', month: 'short' })}`
        : anchor.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });

  const weekdayLabels = Array.from({ length: 7 }, (_, i) =>
    addDays(startOfWeek(new Date()), i).toLocaleDateString(locale, { weekday: 'short' }),
  );
  const todayIso = isoDate(new Date());
  const dayNumLabel = (d: Date) => d.toLocaleDateString(locale, { day: 'numeric' });
  const dayLabel = (d: Date) =>
    d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button className="btn-secondary px-3 py-2" onClick={() => step(-1)}>
            <span className="material-symbols-outlined">chevron_right</span>
          </button>
          <button
            className="rounded-lg border border-outline px-3 py-2 text-sm font-bold hover:bg-surface-container-low"
            onClick={goToday}
          >
            {t('schedule.today')}
          </button>
          <button className="btn-secondary px-3 py-2" onClick={() => step(1)}>
            <span className="material-symbols-outlined">chevron_left</span>
          </button>
          <p className="ms-2 font-heading text-lg font-bold">{headerLabel}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setAllWorkspaces((v) => !v)}
            className={`rounded-full px-4 py-1.5 text-sm font-bold transition ${allWorkspaces ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest text-on-surface-variant shadow-card hover:bg-surface-container-low'}`}
            title={t('schedule.allWorkspacesHint')}
          >
            {t('schedule.allWorkspaces')}
          </button>
          <div className="flex gap-1 rounded-full bg-surface-container-lowest p-1 shadow-card">
            {(['month', 'week', 'day'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded-full px-4 py-1.5 text-sm font-bold transition ${view === v ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container-low'}`}
              >
                {t(`schedule.view.${v}`)}
              </button>
            ))}
          </div>
          <button className="btn-primary px-5 py-2 text-sm" onClick={() => setShowCreate(true)}>
            <span className="material-symbols-outlined align-middle text-lg">add</span>{' '}
            {t('schedule.createSession')}
          </button>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-96 rounded-2xl" />
      ) : view === 'month' ? (
        <>
          <div className="overflow-hidden rounded-2xl border border-outline-variant/50">
            <div className="grid grid-cols-7 border-b border-outline-variant/50 bg-surface-container-lowest">
              {weekdayLabels.map((w) => (
                <p key={w} className="p-2 text-center text-xs font-bold text-on-surface-variant">
                  {w}
                </p>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {days.map((d, i) => {
                const iso = isoDate(d);
                const inMonth = d.getMonth() === anchor.getMonth();
                const daySessions = byDay.get(iso) ?? [];
                const isToday = iso === todayIso;
                const isSelected = iso === selectedDay;
                return (
                  <button
                    key={iso}
                    onClick={() => setSelectedDay(iso)}
                    className={`min-h-24 border-b border-e border-outline-variant/30 p-1.5 text-start align-top transition last:border-e-0 [&:nth-child(7n)]:border-e-0 ${
                      inMonth ? 'bg-surface' : 'bg-surface-container-lowest/40'
                    } ${isSelected ? 'ring-2 ring-inset ring-primary' : ''} hover:bg-surface-container-low`}
                    style={i >= 35 ? { borderBottomWidth: 0 } : undefined}
                  >
                    <span
                      className={`mb-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold tabular-nums ${
                        isToday
                          ? 'bg-primary text-on-primary'
                          : inMonth
                            ? 'text-on-surface'
                            : 'text-outline'
                      }`}
                    >
                      {dayNumLabel(d)}
                    </span>
                    <div className="space-y-0.5">
                      {daySessions.slice(0, 2).map((s) => (
                        <SessionChip
                          key={s!.id}
                          s={s!}
                          dense
                          onCancel={() => {}}
                          cancelling={false}
                        />
                      ))}
                      {daySessions.length > 2 && (
                        <p className="px-1.5 text-[11px] font-bold text-on-surface-variant">
                          {t('schedule.moreSessions', { count: daySessions.length - 2 })}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-5">
            <p className="mb-3 font-heading text-lg font-bold">
              {new Date(`${selectedDay}T00:00:00`).toLocaleDateString(locale, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
            </p>
            <div className="grid gap-2">
              {!(byDay.get(selectedDay) ?? []).length && (
                <p className="text-sm text-outline">{t('schedule.noSessions')}</p>
              )}
              {(byDay.get(selectedDay) ?? []).map((s) => (
                <SessionChip
                  key={s!.id}
                  s={s!}
                  onCancel={() => cancelSession.mutate(s!.id)}
                  cancelling={cancelSession.isPending}
                />
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className={`grid gap-4 ${view === 'week' ? 'md:grid-cols-7' : ''}`}>
          {days.map((d) => (
            <div key={isoDate(d)} className="min-w-0">
              <p className="mb-2 text-center text-sm font-bold text-on-surface-variant">
                {dayLabel(d)}
              </p>
              <div className="grid gap-2">
                {(byDay.get(isoDate(d)) ?? []).length === 0 && (
                  <p className="text-center text-xs text-outline">{t('schedule.noSessions')}</p>
                )}
                {(byDay.get(isoDate(d)) ?? []).map((s) => (
                  <SessionChip
                    key={s!.id}
                    s={s!}
                    onCancel={() => cancelSession.mutate(s!.id)}
                    cancelling={cancelSession.isPending}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <CreateSessionModal open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  );
}

function RoomsTab() {
  const { t } = useTranslation();
  const { data: rooms, isLoading } = useRooms();
  const createRoom = useCreateRoom();
  const updateRoom = useUpdateRoom();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [capacity, setCapacity] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createRoom.mutate(
      {
        name: name.trim(),
        location: location.trim() || undefined,
        capacity: capacity ? Number(capacity) : undefined,
      },
      {
        onSuccess: () => {
          setShowCreate(false);
          setName('');
          setLocation('');
          setCapacity('');
        },
      },
    );
  };

  if (isLoading) return <Skeleton className="h-64 rounded-2xl" />;

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <button className="btn-primary px-5 py-2.5 text-sm" onClick={() => setShowCreate(true)}>
          <span className="material-symbols-outlined align-middle text-lg">add</span>{' '}
          {t('schedule.addRoom')}
        </button>
      </div>
      {!rooms?.length ? (
        <EmptyState icon="meeting_room" title={t('schedule.noRooms')} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rooms.map((r: Room) => (
            <div key={r.id} className="card flex flex-col gap-2 p-4">
              <div className="flex items-center justify-between">
                <p className="font-heading font-bold">{r.name}</p>
                {r.status === 'ARCHIVED' && <Badge tone="neutral">{t('schedule.archived')}</Badge>}
              </div>
              {r.location && <p className="text-sm text-on-surface-variant">{r.location}</p>}
              {r.capacity && (
                <p className="text-xs text-outline">
                  {t('schedule.capacity', { count: r.capacity })}
                </p>
              )}
              <button
                className="mt-2 self-start rounded-lg border border-outline px-3 py-1.5 text-xs font-bold text-on-surface-variant hover:bg-surface-container-low"
                onClick={() =>
                  updateRoom.mutate({
                    roomId: r.id,
                    status: r.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE',
                  })
                }
                disabled={updateRoom.isPending}
              >
                {r.status === 'ACTIVE' ? t('schedule.archiveRoom') : t('schedule.reactivateRoom')}
              </button>
            </div>
          ))}
        </div>
      )}

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title={t('schedule.addRoom')}>
        <form onSubmit={submit} className="grid gap-4">
          <label className="grid gap-1.5">
            <span className="text-sm font-bold">{t('schedule.roomName')}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary"
              required
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-sm font-bold">{t('schedule.location')}</span>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary"
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-sm font-bold">{t('schedule.capacityLabel')}</span>
            <input
              type="number"
              min={1}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary"
            />
          </label>
          <button type="submit" className="btn-primary py-2.5" disabled={createRoom.isPending}>
            {t('common.save')}
          </button>
          <ErrorNote error={createRoom.error} />
        </form>
      </Modal>
    </div>
  );
}

export default function TeacherSchedulePage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'calendar';

  return (
    <div className="page">
      <PageHeader title={t('schedule.title')} subtitle={t('schedule.subtitle')} />
      <div className="mb-6 flex gap-2">
        {TABS.map((tb) => (
          <button
            key={tb}
            className={`rounded-full px-5 py-2 font-heading text-sm font-bold transition ${
              tab === tb
                ? 'bg-primary text-on-primary'
                : 'bg-surface-container-lowest text-on-surface-variant shadow-card hover:bg-surface-container-low'
            }`}
            onClick={() => setParams(tb === 'calendar' ? {} : { tab: tb })}
          >
            {t(`schedule.tab.${tb}`)}
          </button>
        ))}
      </div>
      {tab === 'calendar' && <CalendarTab />}
      {tab === 'rooms' && <RoomsTab />}
    </div>
  );
}
