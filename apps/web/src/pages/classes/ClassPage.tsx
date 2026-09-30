import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { EmptyState, ErrorNote, Modal, Skeleton } from '../../components/ui';
import { askConfirm } from '../../lib/confirm';
import {
  AttendanceStatus,
  ClassRoster,
  RosterStudent,
  formatClock,
  formatInstant,
  formatLocalDate,
  useAddMakeup,
  useClassRoster,
  useCloseAttendance,
  useMakeupCandidates,
  useMarkAttendance,
  useStartClass,
} from '../../lib/classOps';
import { ClassStateChip, STATUS_ICON, STATUS_PRESSED, StatusLabel } from './classParts';

type Filter = 'ALL' | 'UNMARKED' | AttendanceStatus | 'MAKEUP';
const FILTERS: Filter[] = ['ALL', 'UNMARKED', 'PRESENT', 'LATE', 'ABSENT', 'EXCUSED', 'MAKEUP'];

/**
 * One class, the way a teacher uses it with forty students at the door:
 * one line per student, one tap to mark (✓ present, ✗ absent, ⋯ for late or
 * excused), the counts always in view, and the two class-wide actions — the
 * rest present, close the sheet — in a bar that stays above the phone's
 * navigation. Every tap is saved at once; there is no Save to forget.
 *
 * Taps are sent one after another (a queue), so answers can never arrive out
 * of order and put back a state the teacher already changed. What the
 * server decided (a check-in after the grace is LATE) is what the row shows.
 */
export default function ClassPage() {
  const { sessionId = '' } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const roster = useClassRoster(sessionId);
  const mark = useMarkAttendance(sessionId);
  const close = useCloseAttendance(sessionId);
  const start = useStartClass(sessionId);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [search, setSearch] = useState('');
  const [menuFor, setMenuFor] = useState<RosterStudent | null>(null);
  const [makeupOpen, setMakeupOpen] = useState(false);
  /** Taps sent but not answered yet: shown at once, cleared by the answer. */
  const [pending, setPending] = useState<Record<string, AttendanceStatus>>({});
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const data = roster.data;
  const students = useMemo(
    () =>
      (data?.students ?? []).map((s) =>
        pending[s.studentId] ? { ...s, status: pending[s.studentId] } : s,
      ),
    [data, pending],
  );

  if (roster.isLoading)
    return (
      <div className="page">
        <Skeleton className="mb-4 h-32 rounded-2xl" />
        <Skeleton className="h-96 rounded-2xl" />
      </div>
    );
  if (roster.error || !data)
    return (
      <div className="page">
        <BackLink />
        <ErrorNote error={roster.error} />
      </div>
    );

  const s = data.session;
  const cancelled = s.status === 'CANCELLED';
  const closed = !!data.closedAt;
  const nowMs = new Date(data.now).getTime();
  const live = nowMs >= new Date(s.startAt).getTime() && nowMs < new Date(s.endAt).getTime();
  const unmarked = students.filter((x) => x.expected && !x.status);
  const canRest = data.canMark && !closed && unmarked.length > 0;

  const send = (records: { studentId: string; status: AttendanceStatus }[]) => {
    setPending((p) => ({
      ...p,
      ...Object.fromEntries(records.map((r) => [r.studentId, r.status])),
    }));
    queue.current = queue.current
      .then(() => mark.mutateAsync(records))
      .catch(() => undefined)
      .finally(() =>
        setPending((p) => {
          const next = { ...p };
          for (const r of records) if (next[r.studentId] === r.status) delete next[r.studentId];
          return next;
        }),
      );
  };

  const restPresent = async () => {
    if (!unmarked.length) return;
    const ok = await askConfirm(t('classes.restPresentConfirm', { count: unmarked.length }), {
      title: t('classes.restPresent'),
      confirmLabel: t('classes.restPresentAction'),
    });
    if (ok) send(unmarked.map((x) => ({ studentId: x.studentId, status: 'PRESENT' as const })));
  };

  const closeSheet = async () => {
    const ok = await askConfirm(
      unmarked.length
        ? t('classes.closeConfirm', { count: unmarked.length })
        : t('classes.closeConfirmNone'),
      {
        title: t('classes.close'),
        confirmLabel: t('classes.closeAction'),
        danger: unmarked.length > 0,
      },
    );
    if (ok) await queue.current.then(() => close.mutate());
  };

  const q = search.trim().toLowerCase();
  const shown = students.filter((x) => {
    if (q && !x.fullName.toLowerCase().includes(q) && !(x.code ?? '').includes(q)) return false;
    if (filter === 'ALL') return true;
    if (filter === 'UNMARKED') return !x.status;
    if (filter === 'MAKEUP') return !!x.makeup;
    return x.status === filter;
  });
  const countOf = (f: Filter) =>
    f === 'ALL'
      ? students.length
      : f === 'UNMARKED'
        ? students.filter((x) => !x.status).length
        : f === 'MAKEUP'
          ? students.filter((x) => x.makeup).length
          : students.filter((x) => x.status === f).length;

  return (
    <div className="page pb-4">
      <BackLink />

      {/* The class: what, when, where, who, and where it stands. */}
      <header className="mb-4 rounded-2xl border border-outline-variant bg-surface-container-lowest p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <h1 className="min-w-0 font-heading text-xl font-extrabold leading-snug [overflow-wrap:anywhere] sm:text-2xl">
            <bdi>{s.group.name}</bdi>
          </h1>
          <ClassStateChip
            status={s.status}
            startedAt={s.startedAt}
            closedAt={data.closedAt}
            live={live}
          />
        </div>
        <p className="mt-1 text-sm text-on-surface-variant">
          {formatLocalDate(s.date, lang)} ·{' '}
          <span className="tabular-nums">
            {formatClock(s.startTime, lang)} – {formatClock(s.endTime, lang)}
          </span>
        </p>
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-on-surface-variant">
          {s.room && (
            <span className="inline-flex items-center gap-1">
              <span className="material-symbols-outlined text-base" aria-hidden>
                meeting_room
              </span>
              <bdi>{s.room.name}</bdi>
            </span>
          )}
          {s.teacher && (
            <span className="inline-flex items-center gap-1">
              <span className="material-symbols-outlined text-base" aria-hidden>
                person
              </span>
              <bdi>{s.teacher.fullName}</bdi>
            </span>
          )}
          {data.capacity != null && (
            <span className="inline-flex items-center gap-1">
              <span className="material-symbols-outlined text-base" aria-hidden>
                event_seat
              </span>
              {t('classes.seats', { count: data.capacity })}
            </span>
          )}
        </p>

        {!cancelled && !closed && data.canMark && (
          <p className="mt-3 rounded-xl bg-surface-container-low px-3 py-2 text-xs text-on-surface-variant">
            {t('classes.lateRule', {
              time: formatInstant(data.lateAfter, data.timezone, lang),
              count: data.graceMin,
            })}
          </p>
        )}
        {cancelled && <Banner tone="error" icon="block" text={t('classes.cancelledNote')} />}
        {closed && (
          <Banner
            tone="neutral"
            icon="task_alt"
            text={t('classes.closedNote', {
              time: formatInstant(data.closedAt!, data.timezone, lang),
            })}
          />
        )}
        {!cancelled && !data.canMark && (
          <Banner tone="neutral" icon="schedule" text={t('classes.notOpenNote')} />
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          {data.canStart && !s.startedAt && (
            <button
              className="btn-primary min-h-11 px-4"
              disabled={start.isPending}
              onClick={() => start.mutate()}
            >
              <span className="material-symbols-outlined text-lg" aria-hidden>
                play_arrow
              </span>
              {t('classes.start')}
            </button>
          )}
          {s.startedAt && (
            <span className="inline-flex min-h-11 items-center gap-1 text-sm text-on-surface-variant">
              <span className="material-symbols-outlined text-base" aria-hidden>
                play_circle
              </span>
              {t('classes.startedAt', { time: formatInstant(s.startedAt, data.timezone, lang) })}
            </span>
          )}
          {data.canMark && (
            <button className="btn-secondary min-h-11 px-4" onClick={() => setMakeupOpen(true)}>
              <span className="material-symbols-outlined text-lg" aria-hidden>
                person_add
              </span>
              {t('classes.makeup')}
            </button>
          )}
          <button
            className="btn-ghost min-h-11 px-3"
            onClick={() => printSheet(data, t, lang)}
            disabled={!students.length}
          >
            <span className="material-symbols-outlined text-lg" aria-hidden>
              print
            </span>
            {t('classes.print')}
          </button>
        </div>
        <ErrorNote error={start.error} />
      </header>

      {/* Counts that double as filters; one rail, scrolls sideways on a phone. */}
      <div
        className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none]"
        role="tablist"
        aria-label={t('classes.filterLabel')}
      >
        {FILTERS.filter((f) => f === 'ALL' || f === 'UNMARKED' || countOf(f) > 0).map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={`min-h-10 shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition ${
              filter === f
                ? 'bg-primary text-on-primary'
                : 'bg-surface-container-lowest text-on-surface-variant ring-1 ring-inset ring-outline-variant'
            }`}
          >
            {t(`classes.filter.${f}`)} <span className="tabular-nums">{countOf(f)}</span>
          </button>
        ))}
      </div>

      {students.length > 12 && (
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('classes.searchRoster')}
          aria-label={t('classes.searchRoster')}
          className="mb-3 w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-4 py-2.5 outline-none focus:border-primary"
        />
      )}

      <ErrorNote error={mark.error} />
      <ErrorNote error={close.error} />

      {!students.length ? (
        <EmptyState
          icon="groups"
          title={t('classes.noStudents')}
          hint={t('classes.noStudentsHint')}
        />
      ) : !shown.length ? (
        <p className="py-8 text-center text-sm text-on-surface-variant">
          {t('classes.noneInFilter')}
        </p>
      ) : (
        <ul className="grid gap-2" aria-label={t('classes.rosterLabel')}>
          {shown.map((x) => (
            <RosterRow
              key={x.studentId}
              s={x}
              data={data}
              disabled={!data.canMark}
              onMark={(status) => send([{ studentId: x.studentId, status }])}
              onMore={() => setMenuFor(x)}
            />
          ))}
        </ul>
      )}

      {/* The class-wide actions, above the phone's bottom navigation. */}
      {/* Only while there is something to do; one row on a phone — the counts
          are already in the filter chips, so the bar carries just the actions. */}
      {!cancelled && students.length > 0 && (canRest || data.canClose) && (
        <div className="sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-10 mt-4 flex items-center gap-2 rounded-2xl border border-outline-variant bg-surface-container-lowest p-2 shadow-lg sm:p-3 lg:bottom-3">
          <p className="me-auto hidden text-sm text-on-surface-variant sm:block">
            <span className="font-bold tabular-nums text-on-surface">
              {countOf('PRESENT') + countOf('LATE')}
            </span>{' '}
            {t('classes.cameOf', { count: students.filter((x) => x.expected).length })}
          </p>
          {canRest && (
            <button
              className="btn-secondary min-h-11 flex-1 px-3 sm:flex-none sm:px-4"
              onClick={restPresent}
            >
              {t('classes.restPresent')}
              <span className="rounded-full bg-surface-container-high px-2 text-xs tabular-nums">
                {unmarked.length}
              </span>
            </button>
          )}
          {data.canClose && (
            <button
              className="btn-primary min-h-11 flex-1 px-3 sm:flex-none sm:px-4"
              onClick={closeSheet}
              disabled={close.isPending}
              aria-busy={close.isPending}
            >
              <span className="material-symbols-outlined text-lg" aria-hidden>
                lock
              </span>
              {t('classes.close')}
            </button>
          )}
        </div>
      )}

      {menuFor && (
        <Modal open title={`⁨${menuFor.fullName}⁩`} onClose={() => setMenuFor(null)}>
          <div className="grid gap-2">
            {(['PRESENT', 'LATE', 'ABSENT', 'EXCUSED'] as const).map((st) => {
              const on = (pending[menuFor.studentId] ?? menuFor.status) === st;
              return (
                <button
                  key={st}
                  aria-pressed={on}
                  className={`flex min-h-12 items-center gap-3 rounded-xl border px-4 text-start font-semibold ${
                    on ? STATUS_PRESSED[st] : 'border-outline-variant bg-surface-container-lowest'
                  }`}
                  onClick={() => {
                    send([{ studentId: menuFor.studentId, status: st }]);
                    setMenuFor(null);
                  }}
                >
                  <span className="material-symbols-outlined" aria-hidden>
                    {STATUS_ICON[st]}
                  </span>
                  {t(`classes.status.${st}`)}
                </button>
              );
            })}
          </div>
        </Modal>
      )}

      {makeupOpen && <MakeupDialog sessionId={sessionId} onClose={() => setMakeupOpen(false)} />}
    </div>
  );
}

function BackLink() {
  const { t } = useTranslation();
  return (
    <Link
      to="/classes"
      className="mb-3 inline-flex min-h-11 items-center gap-1 text-sm text-on-surface-variant hover:text-on-surface"
    >
      <span className="material-symbols-outlined text-lg rtl:rotate-180" aria-hidden>
        arrow_back
      </span>
      {t('classes.backToday')}
    </Link>
  );
}

function Banner({ tone, icon, text }: { tone: 'error' | 'neutral'; icon: string; text: string }) {
  return (
    <p
      className={`mt-3 flex items-start gap-2 rounded-xl px-3 py-2 text-sm ${
        tone === 'error'
          ? 'bg-error-container text-on-error-container'
          : 'bg-surface-container-low text-on-surface-variant'
      }`}
    >
      <span className="material-symbols-outlined text-lg" aria-hidden>
        {icon}
      </span>
      <span>{text}</span>
    </p>
  );
}

function RosterRow({
  s,
  data,
  disabled,
  onMark,
  onMore,
}: {
  s: RosterStudent;
  data: ClassRoster;
  disabled: boolean;
  onMark: (status: AttendanceStatus) => void;
  onMore: () => void;
}) {
  const { t, i18n } = useTranslation();
  const time =
    s.checkedInAt && (s.status === 'PRESENT' || s.status === 'LATE')
      ? formatInstant(s.checkedInAt, data.timezone, i18n.language)
      : null;
  const btn = (st: AttendanceStatus, icon: string, label: string) => {
    const on = s.status === st;
    return (
      <button
        type="button"
        aria-pressed={on}
        aria-label={`${label} — ${s.fullName}`}
        title={label}
        disabled={disabled}
        onClick={() => onMark(st)}
        className={`grid h-11 min-w-11 place-items-center rounded-xl border px-2 transition active:scale-95 disabled:opacity-40 sm:flex sm:items-center sm:gap-1 sm:px-3 ${
          on
            ? STATUS_PRESSED[st]
            : 'border-outline-variant bg-surface-container-lowest text-on-surface-variant'
        }`}
      >
        <span className="material-symbols-outlined text-xl" aria-hidden>
          {icon}
        </span>
        <span className="hidden text-sm font-semibold sm:inline">{label}</span>
      </button>
    );
  };
  return (
    <li className="flex items-center gap-2 rounded-2xl border border-outline-variant bg-surface-container-lowest px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="font-bold leading-snug [overflow-wrap:anywhere]">
          <bdi>{s.fullName}</bdi>
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          {s.code && (
            <span className="font-mono tabular-nums text-outline" dir="ltr">
              {s.code}
            </span>
          )}
          <StatusLabel status={s.status} auto={s.method === 'AUTO'} time={time} />
        </p>
        {s.makeup && (
          <p className="mt-0.5 text-xs text-on-surface-variant">
            {t('classes.makeupFrom')} <bdi className="font-semibold">{s.makeup.homeGroup.name}</bdi>
          </p>
        )}
      </div>
      <div
        role="group"
        aria-label={t('classes.markFor', { name: s.fullName })}
        className="flex shrink-0 gap-1.5"
      >
        {btn('PRESENT', 'check', t('classes.status.PRESENT'))}
        {btn('ABSENT', 'close', t('classes.status.ABSENT'))}
        <button
          type="button"
          aria-label={t('classes.moreFor', { name: s.fullName })}
          aria-haspopup="dialog"
          disabled={disabled}
          onClick={onMore}
          className={`grid h-11 w-11 place-items-center rounded-xl border transition disabled:opacity-40 ${
            s.status === 'LATE' || s.status === 'EXCUSED'
              ? STATUS_PRESSED[s.status]
              : 'border-outline-variant bg-surface-container-lowest text-on-surface-variant'
          }`}
        >
          <span className="material-symbols-outlined text-xl" aria-hidden>
            {s.status === 'LATE' || s.status === 'EXCUSED' ? STATUS_ICON[s.status] : 'more_horiz'}
          </span>
        </button>
      </div>
    </li>
  );
}

/**
 * Makeup: a student of another group sits in this class. Found by their
 * code (the teacher's way in); by name too for someone holding the register.
 */
function MakeupDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [home, setHome] = useState<string>('');
  const [missed, setMissed] = useState<string>('');
  const found = useMakeupCandidates(sessionId, q);
  const add = useAddMakeup(sessionId);
  const cand = found.data?.candidates.find((c) => c.studentId === picked) ?? null;
  const needsHome = !!cand && !missed && cand.groups.length > 1;

  return (
    <Modal open title={t('classes.makeupTitle')} onClose={onClose}>
      <p className="mb-3 text-sm text-on-surface-variant">{t('classes.makeupHint')}</p>
      <input
        autoFocus
        inputMode={found.data?.mode === 'CODE_ONLY' || /^\d*$/.test(q) ? 'numeric' : 'text'}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setPicked(null);
        }}
        placeholder={t('classes.makeupSearch')}
        aria-label={t('classes.makeupSearch')}
        className="mb-3 w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-4 py-3 text-lg outline-none focus:border-primary"
      />
      {found.data?.mode === 'CODE_ONLY' && (
        <p className="mb-3 text-sm text-on-surface-variant">{t('classes.makeupCodeOnly')}</p>
      )}
      <div className="grid max-h-72 gap-2 overflow-y-auto">
        {found.data?.candidates.map((c) => (
          <button
            key={c.studentId}
            disabled={c.belongsHere}
            onClick={() => {
              setPicked(c.studentId);
              setHome(c.groups[0]?.id ?? '');
              setMissed(c.missed[0]?.sessionId ?? '');
            }}
            aria-pressed={picked === c.studentId}
            className={`rounded-xl border p-3 text-start disabled:opacity-50 ${
              picked === c.studentId ? 'border-primary bg-primary-fixed' : 'border-outline-variant'
            }`}
          >
            <p className="font-bold">
              <bdi>{c.fullName}</bdi>{' '}
              <span className="font-mono text-xs text-outline" dir="ltr">
                {c.code}
              </span>
            </p>
            <p className="text-xs text-on-surface-variant">
              {c.belongsHere
                ? t('classes.makeupBelongs')
                : c.groups.length
                  ? c.groups.map((g) => g.name).join(' · ')
                  : t('classes.makeupNoGroup')}
            </p>
          </button>
        ))}
        {q.trim().length >= 2 &&
          found.data &&
          !found.data.candidates.length &&
          found.data.mode !== 'CODE_ONLY' && (
            <p className="p-3 text-center text-sm text-on-surface-variant">
              {t('classes.makeupNone')}
            </p>
          )}
      </div>

      {cand && !cand.belongsHere && (
        <div className="mt-4 grid gap-3">
          {cand.missed.length > 0 && (
            <label className="grid gap-1 text-sm">
              <span className="font-semibold">{t('classes.makeupFor')}</span>
              <select
                value={missed}
                onChange={(e) => setMissed(e.target.value)}
                className="min-h-11 rounded-xl border border-outline-variant bg-surface-container-lowest px-3"
              >
                <option value="">{t('classes.makeupForNone')}</option>
                {cand.missed.map((m) => (
                  <option key={m.sessionId} value={m.sessionId}>
                    {m.group.name} — {m.date} {m.time}
                  </option>
                ))}
              </select>
            </label>
          )}
          {needsHome && (
            <label className="grid gap-1 text-sm">
              <span className="font-semibold">{t('classes.makeupHome')}</span>
              <select
                value={home}
                onChange={(e) => setHome(e.target.value)}
                className="min-h-11 rounded-xl border border-outline-variant bg-surface-container-lowest px-3"
              >
                {cand.groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className="btn-primary min-h-12"
            disabled={add.isPending}
            aria-busy={add.isPending}
            onClick={() =>
              add.mutate(
                {
                  studentId: cand.studentId,
                  ...(missed
                    ? { makeupForSessionId: missed }
                    : needsHome
                      ? { homeGroupId: home }
                      : {}),
                },
                { onSuccess: onClose },
              )
            }
          >
            {t('classes.makeupAdd')}
          </button>
        </div>
      )}
      <ErrorNote error={add.error} />
    </Modal>
  );
}

/**
 * A paper sheet for the class, in its own window: names, codes, what was
 * marked, and an empty column to sign or tick by hand. No phones, no
 * guardians — only what a sheet on a desk needs. Every value is escaped.
 */
function printSheet(
  data: ClassRoster,
  t: (k: string, o?: Record<string, unknown>) => string,
  lang: string,
) {
  const esc = (v: string) =>
    v.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
  const s = data.session;
  const dir = lang === 'en' ? 'ltr' : 'rtl';
  const rows = data.students
    .map(
      (x, i) =>
        `<tr><td>${i + 1}</td><td><bdi>${esc(x.fullName)}</bdi>${x.makeup ? ` <small>(${esc(t('classes.makeupShort'))})</small>` : ''}</td><td dir="ltr">${esc(x.code ?? '')}</td><td>${x.status ? esc(t(`classes.status.${x.status}`)) : ''}</td><td></td></tr>`,
    )
    .join('');
  const html = `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><title>${esc(s.group.name)}</title>
<style>body{font-family:system-ui,'Segoe UI',Tahoma,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0 0 4px}p{margin:0 0 12px;color:#444}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{border:1px solid #999;padding:6px 8px;text-align:start}th{background:#eee}td:first-child{width:32px}td:last-child{width:120px}</style></head>
<body><h1><bdi>${esc(s.group.name)}</bdi></h1><p>${esc(formatLocalDate(s.date, lang))} · ${esc(formatClock(s.startTime, lang))} – ${esc(formatClock(s.endTime, lang))}${s.room ? ` · <bdi>${esc(s.room.name)}</bdi>` : ''}${s.teacher ? ` · <bdi>${esc(s.teacher.fullName)}</bdi>` : ''}</p>
<table><thead><tr><th>#</th><th>${esc(t('classes.printName'))}</th><th>${esc(t('classes.printCode'))}</th><th>${esc(t('classes.printStatus'))}</th><th>${esc(t('classes.printSign'))}</th></tr></thead><tbody>${rows}</tbody></table>
<script>window.onload=function(){window.print()}</script></body></html>`;
  const w = window.open('', '_blank', 'noopener=no');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
}
