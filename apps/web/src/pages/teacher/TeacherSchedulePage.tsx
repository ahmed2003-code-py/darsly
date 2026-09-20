import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useGroupDetail, useGroups } from '../../lib/academyOps';
import {
  ConflictErrorBody,
  Room,
  useCancelSession,
  useCreateRoom,
  useCreateSession,
  useMyHomeAcademySlug,
  useRooms,
  useSchedule,
  useUpdateRoom,
} from '../../lib/scheduling';
import { Badge, EmptyState, ErrorNote, Modal, PageHeader, Skeleton } from '../../components/ui';

const TABS = ['calendar', 'rooms'] as const;
type Tab = (typeof TABS)[number];
type ViewMode = 'day' | 'week';

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
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
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
  const createSession = useCreateSession(groupId);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupId || !start || !end) return;
    createSession.mutate(
      {
        startAt: new Date(start).toISOString(),
        endAt: new Date(end).toISOString(),
        ...(roomId ? { roomId } : {}),
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
          <select value={groupId} onChange={(e) => { setGroupId(e.target.value); setTeacherUserId(''); }} className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary" required>
            <option value="">{t('schedule.selectGroup')}</option>
            {groupsData?.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <label className="grid gap-1.5">
          <span className="text-sm font-bold">{t('schedule.room')}</span>
          <select value={roomId} onChange={(e) => setRoomId(e.target.value)} className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary">
            <option value="">{t('schedule.noRoom')}</option>
            {rooms?.filter((r) => r.status === 'ACTIVE').map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <label className="grid gap-1.5">
          <span className="text-sm font-bold">{t('schedule.teacher')}</span>
          <select value={teacherUserId} onChange={(e) => setTeacherUserId(e.target.value)} className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary" disabled={!groupId}>
            <option value="">{t('schedule.noTeacher')}</option>
            {group?.assignments.map((a) => <option key={a.userId} value={a.userId}>{a.fullName}</option>)}
          </select>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5">
            <span className="text-sm font-bold">{t('schedule.start')}</span>
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary" required />
          </label>
          <label className="grid gap-1.5">
            <span className="text-sm font-bold">{t('schedule.end')}</span>
            <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary" required />
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

function CalendarTab() {
  const { t, i18n } = useTranslation();
  const slug = useMyHomeAcademySlug();
  const [view, setView] = useState<ViewMode>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [showCreate, setShowCreate] = useState(false);
  const cancelSession = useCancelSession();

  const rangeStart = view === 'day' ? startOfDay(anchor) : startOfWeek(anchor);
  const rangeEnd = view === 'day' ? addDays(rangeStart, 1) : addDays(rangeStart, 7);
  const days = useMemo(
    () => Array.from({ length: view === 'day' ? 1 : 7 }, (_, i) => addDays(rangeStart, i)),
    [rangeStart, view],
  );
  const { data: sessions, isLoading } = useSchedule(slug, rangeStart.toISOString(), rangeEnd.toISOString());

  const byDay = useMemo(() => {
    const map = new Map<string, typeof sessions>();
    for (const d of days) map.set(isoDate(d), []);
    for (const s of sessions ?? []) {
      const key = isoDate(new Date(s.startAt));
      if (map.has(key)) map.get(key)!.push(s);
    }
    return map;
  }, [sessions, days]);

  const dayLabel = (d: Date) => d.toLocaleDateString(i18n.language === 'ar' ? 'ar-EG' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString(i18n.language === 'ar' ? 'ar-EG' : 'en-GB', { hour: '2-digit', minute: '2-digit' });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button className="btn-secondary px-3 py-2" onClick={() => setAnchor((a) => addDays(a, view === 'day' ? -1 : -7))}>
            <span className="material-symbols-outlined">chevron_right</span>
          </button>
          <button className="rounded-lg border border-outline px-3 py-2 text-sm font-bold hover:bg-surface-container-low" onClick={() => setAnchor(new Date())}>
            {t('schedule.today')}
          </button>
          <button className="btn-secondary px-3 py-2" onClick={() => setAnchor((a) => addDays(a, view === 'day' ? 1 : 7))}>
            <span className="material-symbols-outlined">chevron_left</span>
          </button>
        </div>
        <div className="flex gap-2">
          <div className="flex gap-1 rounded-full bg-surface-container-lowest p-1 shadow-card">
            {(['day', 'week'] as const).map((v) => (
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
            <span className="material-symbols-outlined align-middle text-lg">add</span> {t('schedule.createSession')}
          </button>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-96 rounded-2xl" />
      ) : (
        <div className={`grid gap-4 ${view === 'week' ? 'md:grid-cols-7' : ''}`}>
          {days.map((d) => (
            <div key={isoDate(d)} className="min-w-0">
              <p className="mb-2 text-center text-sm font-bold text-on-surface-variant">{dayLabel(d)}</p>
              <div className="grid gap-2">
                {(byDay.get(isoDate(d)) ?? []).length === 0 && <p className="text-center text-xs text-outline">{t('schedule.noSessions')}</p>}
                {(byDay.get(isoDate(d)) ?? []).map((s) => (
                  <div key={s!.id} className={`card p-3 ${s!.status === 'CANCELLED' ? 'opacity-50' : ''}`}>
                    <p className="truncate font-heading text-sm font-bold">{s!.group.name}</p>
                    <p className="text-xs text-on-surface-variant tabular-nums" dir="ltr">{timeLabel(s!.startAt)}–{timeLabel(s!.endAt)}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {s!.room && <Badge tone="neutral">{s!.room.name}</Badge>}
                      {s!.teacher && <Badge tone="primary">{s!.teacher.fullName}</Badge>}
                      {s!.status === 'CANCELLED' && <Badge tone="error">{t('schedule.cancelled')}</Badge>}
                    </div>
                    {s!.status === 'SCHEDULED' && (
                      <button
                        className="mt-2 text-xs font-bold text-error hover:underline"
                        onClick={() => cancelSession.mutate(s!.id)}
                        disabled={cancelSession.isPending}
                      >
                        {t('schedule.cancel')}
                      </button>
                    )}
                  </div>
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
      { name: name.trim(), location: location.trim() || undefined, capacity: capacity ? Number(capacity) : undefined },
      { onSuccess: () => { setShowCreate(false); setName(''); setLocation(''); setCapacity(''); } },
    );
  };

  if (isLoading) return <Skeleton className="h-64 rounded-2xl" />;

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <button className="btn-primary px-5 py-2.5 text-sm" onClick={() => setShowCreate(true)}>
          <span className="material-symbols-outlined align-middle text-lg">add</span> {t('schedule.addRoom')}
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
              {r.capacity && <p className="text-xs text-outline">{t('schedule.capacity', { count: r.capacity })}</p>}
              <button
                className="mt-2 self-start rounded-lg border border-outline px-3 py-1.5 text-xs font-bold text-on-surface-variant hover:bg-surface-container-low"
                onClick={() => updateRoom.mutate({ roomId: r.id, status: r.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE' })}
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
            <input value={name} onChange={(e) => setName(e.target.value)} className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary" required />
          </label>
          <label className="grid gap-1.5">
            <span className="text-sm font-bold">{t('schedule.location')}</span>
            <input value={location} onChange={(e) => setLocation(e.target.value)} className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary" />
          </label>
          <label className="grid gap-1.5">
            <span className="text-sm font-bold">{t('schedule.capacityLabel')}</span>
            <input type="number" min={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary" />
          </label>
          <button type="submit" className="btn-primary py-2.5" disabled={createRoom.isPending}>{t('common.save')}</button>
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
              tab === tb ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest text-on-surface-variant shadow-card hover:bg-surface-container-low'
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
