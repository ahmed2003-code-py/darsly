import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Avatar from '../../components/Avatar';
import { Badge, EmptyState, Modal, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { RegistryStudent, localPhone, useRegistryAcademyId } from '../../lib/centerStudents';
import { formatClock, formatInstant } from '../../lib/classOps';
import { askConfirm } from '../../lib/confirm';
import {
  CheckInResult,
  classifyDeskInput,
  DeskClass,
  DeskIdentity,
  DeskView,
  errorCode,
  isNetworkFailure,
  useDeskAccess,
  useDeskCheckIn,
  useDeskResolve,
} from '../../lib/desk';
import { errorMessage } from '../../lib/errorMessage';
import { NewStudentModal } from '../center/CenterStudentsPage';
import CardPanel from './CardPanel';
import DeskFeeStrip from '../fees/DeskFeeStrip';

const QrScanner = lazy(() => import('./QrScanner'));

/** How long Rush mode shows an outcome before it is ready for the next learner. */
const RUSH_DONE_MS = 2200;
const RUSH_REFUSED_MS = 4000;

type Panel =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'search'; q: string; items: RegistryStudent[] | null }
  | { kind: 'view'; who: DeskIdentity; view: DeskView }
  | { kind: 'done'; who: DeskIdentity; result: CheckInResult }
  | { kind: 'refused'; error: unknown }
  | { kind: 'offline'; retry: () => void };

interface Recent {
  key: string;
  name: string;
  group: string;
  status: string;
  already: boolean;
  at: string;
}

type Sound = 'ok' | 'late' | 'already' | 'no';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* the setting simply is not remembered */
  }
}

/** Short tones through Web Audio — nothing to download; silent when muted or unsupported. */
function useTones(muted: boolean) {
  const ctx = useRef<AudioContext | null>(null);
  return useCallback(
    (kind: Sound) => {
      if (muted) return;
      try {
        ctx.current ??= new AudioContext();
        const c = ctx.current;
        const tones: [number, number][] =
          kind === 'ok'
            ? [[880, 0.12]]
            : kind === 'late'
              ? [
                  [660, 0.12],
                  [880, 0.12],
                ]
              : kind === 'already'
                ? [
                    [620, 0.09],
                    [620, 0.09],
                  ]
                : [[220, 0.35]];
        let at = c.currentTime;
        for (const [f, d] of tones) {
          const o = c.createOscillator();
          const g = c.createGain();
          o.type = kind === 'no' ? 'square' : 'sine';
          o.frequency.value = f;
          g.gain.setValueAtTime(0.12, at);
          g.gain.exponentialRampToValueAtTime(0.001, at + d);
          o.connect(g).connect(c.destination);
          o.start(at);
          o.stop(at + d);
          at += d + 0.05;
        }
      } catch {
        /* no audio here */
      }
    },
    [muted],
  );
}

/**
 * The reception desk (Center Operations C3).
 *
 * One loop: a learner arrives → scan their card (camera or USB scanner), or
 * type their code, or search the register → their classes today appear →
 * check in → next. Everything that decides anything — who, which class,
 * PRESENT or LATE, seats, closed — is the server's; this page never guesses:
 * Rush mode checks in on the scan only when the server says there is exactly
 * one class of theirs open now, and stops to ask otherwise.
 *
 * Keyboard-first on a desk computer: the box keeps focus, a USB scanner's
 * digits land in it even if focus wandered, Enter on an empty box checks in
 * the class on screen. Phone-first with the camera: one big Scan button.
 */
export default function DeskPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'en' ? 'en' : 'ar';
  const academyId = useRegistryAcademyId();
  const access = useDeskAccess(academyId);
  const resolveM = useDeskResolve(academyId);
  const checkInM = useDeskCheckIn(academyId);
  const [text, setText] = useState('');
  const [panel, setPanel] = useState<Panel>({ kind: 'idle' });
  const [rush, setRush] = useState(() => readFlag('darsly-desk-rush'));
  const [muted, setMuted] = useState(() => readFlag('darsly-desk-mute'));
  const [scanning, setScanning] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [recent, setRecent] = useState<Recent[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const resetTimer = useRef(0);
  const tone = useTones(muted);
  const touch = useMemo(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches,
    [],
  );
  const a = access.data;

  const focusBox = useCallback(() => {
    if (!touch) window.setTimeout(() => input.current?.focus({ preventScroll: true }), 0);
  }, [touch]);

  const settle = useCallback(
    (next: Panel, after?: number) => {
      window.clearTimeout(resetTimer.current);
      setPanel(next);
      if (after) resetTimer.current = window.setTimeout(() => setPanel({ kind: 'idle' }), after);
      focusBox();
    },
    [focusBox],
  );
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const remember = useCallback(
    (r: CheckInResult) => {
      if (!r.record) return;
      const cls = r.view.classes.find((c) => c.sessionId === r.record!.sessionId);
      setRecent((list) =>
        [
          {
            key: `${r.view.student.id}-${r.record!.sessionId}`,
            name: r.view.student.fullName,
            group: cls?.group.name ?? '',
            status: r.record!.status,
            already: r.outcome === 'ALREADY',
            at:
              r.record!.checkedInAt && r.view.timezone
                ? formatInstant(r.record!.checkedInAt, r.view.timezone, lang)
                : '',
          },
          ...list.filter((x) => x.key !== `${r.view.student.id}-${r.record!.sessionId}`),
        ].slice(0, 10),
      );
    },
    [lang],
  );

  const fail = useCallback(
    (e: unknown, retry: () => void) => {
      if (isNetworkFailure(e)) {
        tone('no');
        settle({ kind: 'offline', retry });
        return;
      }
      tone('no');
      settle({ kind: 'refused', error: e }, rush ? RUSH_REFUSED_MS : undefined);
    },
    [rush, settle, tone],
  );

  const checkIn = useCallback(
    (
      who: DeskIdentity,
      extra: { sessionId?: string; makeup?: boolean; homeGroupId?: string } = {},
    ) => {
      window.clearTimeout(resetTimer.current);
      setPanel({ kind: 'busy' });
      checkInM.mutate(
        { ...who, ...extra },
        {
          onSuccess: (r) => {
            if (r.outcome === 'NEEDS_DESK') {
              tone('already');
              settle({ kind: 'view', who, view: r.view });
              return;
            }
            remember(r);
            tone(r.outcome === 'ALREADY' ? 'already' : r.record?.status === 'LATE' ? 'late' : 'ok');
            settle({ kind: 'done', who, result: r }, rush ? RUSH_DONE_MS : undefined);
          },
          onError: (e) => fail(e, () => checkIn(who, extra)),
        },
      );
    },
    [checkInM, fail, remember, rush, settle, tone],
  );

  const resolve = useCallback(
    (who: DeskIdentity) => {
      window.clearTimeout(resetTimer.current);
      setPanel({ kind: 'busy' });
      resolveM.mutate(who, {
        onSuccess: (view) => settle({ kind: 'view', who, view }),
        onError: (e) => fail(e, () => resolve(who)),
      });
    },
    [fail, resolveM, settle],
  );

  const search = useCallback(
    async (q: string) => {
      if (!a?.canSearch) {
        settle({ kind: 'refused', error: { response: { data: { code: 'DESK_SEARCH_OFF' } } } });
        return;
      }
      setPanel({ kind: 'search', q, items: null });
      try {
        const r = await api.get<{ items: RegistryStudent[] }>('/center-students', {
          headers: { 'X-Academy-Id': academyId ?? '' },
          params: { q, status: 'ALL', pageSize: 8 },
        });
        settle({ kind: 'search', q, items: r.data.items });
      } catch (e) {
        fail(e, () => void search(q));
      }
    },
    [a?.canSearch, academyId, fail, settle],
  );

  /** Whatever arrived: typed, a USB scanner's burst, or the camera. */
  const take = useCallback(
    (raw: string) => {
      setText('');
      const c = classifyDeskInput(raw);
      if (c.kind === 'EMPTY') {
        // Enter on an empty box: check in the one class on screen.
        if (panel.kind === 'view' && panel.view.action.kind === 'CHECK_IN')
          checkIn(panel.who, { sessionId: panel.view.action.sessionId });
        return;
      }
      if (c.kind === 'BAD_SCAN') {
        tone('no');
        settle(
          { kind: 'refused', error: { response: { data: { code: 'CARD_NOT_FOUND' } } } },
          rush ? RUSH_REFUSED_MS : undefined,
        );
        return;
      }
      if (c.kind === 'SEARCH') return void search(c.q);
      const who: DeskIdentity = c.kind === 'TOKEN' ? { token: c.token } : { code: c.code };
      if (rush) checkIn(who);
      else resolve(who);
    },
    [checkIn, panel, resolve, rush, search, settle, tone],
  );

  // A USB scanner types wherever focus is. If it wandered off the box (a
  // click on the page), the first digit brings it back and the rest follows.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || scanning || registering) return;
      const el = document.activeElement as HTMLElement | null;
      const editable = el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      if (editable || document.querySelector('[role="dialog"]')) return;
      if (/^[0-9٠-٩۰-۹]$/.test(e.key)) input.current?.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [registering, scanning]);

  if (!academyId || access.isLoading)
    return (
      <div className="page grid place-items-center py-24">
        <Spinner />
      </div>
    );
  if (!a?.enabled)
    return (
      <div className="page">
        <EmptyState icon="toggle_off" title={t('desk.off')} hint={t('desk.offHint')} />
      </div>
    );
  if (!a.canCheckIn)
    return (
      <div className="page">
        <EmptyState icon="lock" title={t('desk.noAccess')} hint={t('desk.noAccessHint')} />
      </div>
    );

  const toggleRush = () => {
    setRush((v) => {
      writeFlag('darsly-desk-rush', !v);
      return !v;
    });
    focusBox();
  };
  const toggleMute = () =>
    setMuted((v) => {
      writeFlag('darsly-desk-mute', !v);
      return !v;
    });

  return (
    <div className="page max-w-6xl pb-6">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="me-auto font-heading text-2xl font-extrabold sm:text-3xl">
          {t('desk.title')}
        </h1>
        <button
          type="button"
          role="switch"
          aria-checked={rush}
          onClick={toggleRush}
          className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-bold transition ${
            rush
              ? 'border-primary bg-primary text-on-primary'
              : 'border-outline-variant text-on-surface-variant hover:bg-surface-container-low'
          }`}
        >
          <span className="material-symbols-outlined text-lg" aria-hidden>
            bolt
          </span>
          {t('desk.rush')}
        </button>
        <button
          type="button"
          onClick={toggleMute}
          aria-pressed={muted}
          aria-label={muted ? t('desk.soundOn') : t('desk.soundOff')}
          title={muted ? t('desk.soundOn') : t('desk.soundOff')}
          className="grid h-11 w-11 place-items-center rounded-full border border-outline-variant text-on-surface-variant hover:bg-surface-container-low"
        >
          <span className="material-symbols-outlined" aria-hidden>
            {muted ? 'volume_off' : 'volume_up'}
          </span>
        </button>
      </header>
      {rush && <p className="mb-3 text-sm text-on-surface-variant">{t('desk.rushHint')}</p>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0">
          {/* The one way in: camera on a phone, the box on a desk computer (both everywhere). */}
          <button
            type="button"
            onClick={() => setScanning(true)}
            className="btn-primary mb-3 flex min-h-14 w-full items-center justify-center gap-2 text-lg lg:hidden"
          >
            <span className="material-symbols-outlined text-2xl" aria-hidden>
              qr_code_scanner
            </span>
            {t('desk.scanButton')}
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              take(text);
            }}
            className="mb-4 flex gap-2"
          >
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">{t('desk.inputLabel')}</span>
              <span
                aria-hidden
                className="material-symbols-outlined pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-xl text-outline [direction:inherit]"
              >
                barcode_reader
              </span>
              <input
                ref={input}
                data-desk-input
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="w-full rounded-2xl border border-outline-variant bg-surface-container-lowest py-3.5 pe-3 ps-11 text-base outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
                placeholder={a.canSearch ? t('desk.inputPh') : t('desk.inputPhNoSearch')}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                autoFocus={!touch}
              />
            </label>
            <button
              type="button"
              onClick={() => setScanning(true)}
              className="hidden min-h-12 items-center gap-2 rounded-2xl border border-outline-variant px-4 font-semibold hover:bg-surface-container-low lg:inline-flex"
            >
              <span className="material-symbols-outlined" aria-hidden>
                photo_camera
              </span>
              {t('desk.camera')}
            </button>
          </form>

          <section aria-live="polite" aria-atomic="true">
            <PanelView
              panel={panel}
              lang={lang}
              academyId={academyId}
              canManageCards={a.canManageCards}
              canRegister={a.canRegister}
              onCheckIn={checkIn}
              onPick={(s) => resolve({ academyStudentId: s.id })}
              onNext={() => settle({ kind: 'idle' })}
              onRegister={() => setRegistering(true)}
            />
          </section>
        </div>

        <aside className="min-w-0">
          <RecentList items={recent} />
        </aside>
      </div>

      {scanning && (
        <Suspense fallback={null}>
          <QrScanner
            continuous={rush}
            onClose={() => {
              setScanning(false);
              focusBox();
            }}
            onCode={(code) => {
              if (!rush) setScanning(false);
              take(code);
            }}
          >
            {rush && panel.kind !== 'idle' ? (
              <div className="rounded-2xl bg-surface p-3 text-on-surface">
                <PanelView
                  panel={panel}
                  lang={lang}
                  academyId={academyId}
                  canManageCards={false}
                  canRegister={false}
                  compact
                  onCheckIn={checkIn}
                  onPick={(s) => resolve({ academyStudentId: s.id })}
                  onNext={() => settle({ kind: 'idle' })}
                  onRegister={() => undefined}
                />
              </div>
            ) : undefined}
          </QrScanner>
        </Suspense>
      )}
      {registering && (
        <NewStudentModal
          academyId={academyId}
          onClose={() => {
            setRegistering(false);
            focusBox();
          }}
          onRegistered={(s) => {
            setRegistering(false);
            resolve({ academyStudentId: s.id });
          }}
        />
      )}
    </div>
  );
}

function PanelView({
  panel,
  lang,
  academyId,
  canManageCards,
  canRegister,
  compact = false,
  onCheckIn,
  onPick,
  onNext,
  onRegister,
}: {
  panel: Panel;
  lang: string;
  academyId: string;
  canManageCards: boolean;
  canRegister: boolean;
  compact?: boolean;
  onCheckIn: (
    who: DeskIdentity,
    extra?: { sessionId?: string; makeup?: boolean; homeGroupId?: string },
  ) => void;
  onPick: (s: RegistryStudent) => void;
  onNext: () => void;
  onRegister: () => void;
}) {
  const { t } = useTranslation();
  switch (panel.kind) {
    case 'idle':
      return compact ? null : (
        <div className="card flex flex-col items-center gap-2 p-8 text-center">
          <span className="material-symbols-outlined text-5xl text-primary" aria-hidden>
            qr_code_scanner
          </span>
          <p className="text-lg font-bold">{t('desk.ready')}</p>
          <p className="max-w-md text-sm text-on-surface-variant">{t('desk.readyHint')}</p>
          {canRegister && (
            <button type="button" className="btn-ghost mt-2 min-h-11 px-4" onClick={onRegister}>
              <span className="material-symbols-outlined text-lg" aria-hidden>
                person_add
              </span>
              {t('desk.newStudent')}
            </button>
          )}
        </div>
      );
    case 'busy':
      return (
        <div className="card grid place-items-center p-8" role="status">
          <Spinner />
          <span className="sr-only">{t('desk.working')}</span>
        </div>
      );
    case 'search':
      return (
        <SearchResults
          panel={panel}
          onPick={onPick}
          onRegister={canRegister ? onRegister : undefined}
        />
      );
    case 'view':
      return (
        <StudentView
          who={panel.who}
          view={panel.view}
          lang={lang}
          academyId={academyId}
          canManageCards={canManageCards}
          compact={compact}
          onCheckIn={onCheckIn}
        />
      );
    case 'done':
      return <Done result={panel.result} lang={lang} onNext={onNext} compact={compact} />;
    case 'refused':
      return <Refused error={panel.error} onNext={onNext} compact={compact} />;
    case 'offline':
      return (
        <div className="card border-2 border-amber-500/40 p-5" role="alert">
          <p className="mb-1 flex items-center gap-2 text-lg font-bold">
            <span className="material-symbols-outlined" aria-hidden>
              wifi_off
            </span>
            {t('desk.offline')}
          </p>
          <p className="mb-4 text-sm text-on-surface-variant">{t('desk.offlineHint')}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary min-h-11 px-5"
              onClick={panel.retry}
              autoFocus
            >
              {t('desk.retry')}
            </button>
            <button type="button" className="btn-ghost min-h-11 px-4" onClick={onNext}>
              {t('desk.next')}
            </button>
          </div>
        </div>
      );
  }
}

function SearchResults({
  panel,
  onPick,
  onRegister,
}: {
  panel: Extract<Panel, { kind: 'search' }>;
  onPick: (s: RegistryStudent) => void;
  onRegister?: () => void;
}) {
  const { t } = useTranslation();
  if (!panel.items)
    return (
      <div className="card grid place-items-center p-8" role="status">
        <Spinner />
      </div>
    );
  return (
    <div className="card p-2">
      {panel.items.length === 0 ? (
        <p className="p-4 text-center text-on-surface-variant">
          {t('desk.noMatch', { q: panel.q })}
        </p>
      ) : (
        <ul className="divide-y divide-outline-variant/40">
          {panel.items.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onPick(s)}
                className="flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2 text-start hover:bg-surface-container-low"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">
                    <bdi>{s.fullName}</bdi>
                  </span>
                  <span className="block truncate text-xs text-on-surface-variant">
                    {[s.groups.map((g) => g.name).join('، '), localPhone(s.guardianPhone)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                {s.status === 'WITHDRAWN' && (
                  <Badge tone="warn">{t('registry.status.WITHDRAWN')}</Badge>
                )}
                <span className="font-mono font-bold tabular-nums" dir="ltr">
                  {s.code}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {onRegister && (
        <div className="border-t border-outline-variant/40 p-2">
          <button type="button" className="btn-ghost min-h-11 w-full" onClick={onRegister}>
            <span className="material-symbols-outlined text-lg" aria-hidden>
              person_add
            </span>
            {t('desk.newStudent')}
          </button>
        </div>
      )}
    </div>
  );
}

function StudentHeader({ view, lang }: { view: DeskView; lang: string }) {
  const { t } = useTranslation();
  const s = view.student;
  return (
    <div className="flex items-start gap-3">
      <Avatar id={s.studentId} name={s.fullName} url={s.avatarUrl} size={64} />
      <div className="min-w-0 flex-1">
        <p className="text-xl font-extrabold leading-tight [overflow-wrap:anywhere]">
          <bdi>{s.fullName}</bdi>
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-on-surface-variant">
          <span className="font-mono font-bold tabular-nums text-on-surface" dir="ltr">
            {s.code}
          </span>
          {s.grade && <span>{lang === 'en' ? s.grade.nameEn : s.grade.nameAr}</span>}
          {s.status === 'WITHDRAWN' && <Badge tone="warn">{t('registry.status.WITHDRAWN')}</Badge>}
          <Badge tone={s.card === 'ACTIVE' ? 'neutral' : 'warn'}>
            {t(s.card === 'ACTIVE' ? 'desk.hasCard' : 'desk.noCard')}
          </Badge>
        </p>
      </div>
    </div>
  );
}

function StudentView({
  who,
  view,
  lang,
  academyId,
  canManageCards,
  compact,
  onCheckIn,
}: {
  who: DeskIdentity;
  view: DeskView;
  lang: string;
  academyId: string;
  canManageCards: boolean;
  compact: boolean;
  onCheckIn: (
    who: DeskIdentity,
    extra?: { sessionId?: string; makeup?: boolean; homeGroupId?: string },
  ) => void;
}) {
  const { t } = useTranslation();
  const [cards, setCards] = useState(false);
  const [homeFor, setHomeFor] = useState<DeskClass | null>(null);
  const act = view.action;
  const note =
    act.kind === 'CHOOSE'
      ? t('desk.choose')
      : act.kind === 'WITHDRAWN'
        ? t('desk.withdrawn')
        : act.kind === 'NO_CLASS'
          ? act.reason === 'CLASSES_OFF'
            ? t('desk.classesOff')
            : (() => {
                const next = view.classes.find((c) => c.sessionId === act.nextSessionId);
                return next
                  ? t('desk.nextClass', {
                      time: formatClock(next.startTime, lang),
                      group: next.group.name,
                    })
                  : t('desk.noClass');
              })()
          : null;

  const makeup = async (c: DeskClass) => {
    if (view.student.groups.length > 1) return setHomeFor(c);
    if (
      await askConfirm(
        t('desk.makeupConfirm', { name: view.student.fullName, group: c.group.name }),
        {
          title: t('desk.makeupTitle'),
          confirmLabel: t('desk.makeupAction'),
        },
      )
    )
      onCheckIn(who, { sessionId: c.sessionId, makeup: true });
  };

  return (
    <div className={compact ? '' : 'card p-4 sm:p-5'}>
      <StudentHeader view={view} lang={lang} />
      {/* The center's fees (C4): shown beside, never in the way of, checking in. */}
      {!compact && <DeskFeeStrip academyId={academyId} academyStudentId={view.student.id} />}
      {note && (
        <p
          className={`mt-3 rounded-xl px-3 py-2 text-sm font-semibold ${
            act.kind === 'WITHDRAWN'
              ? 'bg-error-container text-on-error-container'
              : 'bg-surface-container-low text-on-surface'
          }`}
          role="status"
        >
          {note}
        </p>
      )}

      {view.classes.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {view.classes.map((c) => (
            <ClassRow
              key={c.sessionId}
              c={c}
              lang={lang}
              primary={act.kind === 'CHECK_IN' && act.sessionId === c.sessionId}
              onCheckIn={
                view.student.status === 'ACTIVE' && c.state === 'OPEN' && !c.attendance
                  ? () => onCheckIn(who, { sessionId: c.sessionId })
                  : undefined
              }
            />
          ))}
        </ul>
      )}

      {!compact && view.makeupOptions.length > 0 && (
        <details
          className="mt-3 rounded-xl border border-outline-variant/50"
          open={view.classes.length === 0}
        >
          <summary className="flex min-h-11 cursor-pointer items-center px-3 font-semibold">
            {t('desk.makeupOptions', { count: view.makeupOptions.length })}
          </summary>
          <ul className="flex flex-col gap-2 p-2">
            {view.makeupOptions.map((c) => (
              <ClassRow
                key={c.sessionId}
                c={c}
                lang={lang}
                makeup
                onCheckIn={c.full ? undefined : () => void makeup(c)}
              />
            ))}
          </ul>
        </details>
      )}

      {!compact &&
        canManageCards &&
        view.student.card === 'NONE' &&
        view.student.status === 'ACTIVE' && (
          <button
            type="button"
            className="btn-ghost mt-3 min-h-11 px-3 text-sm"
            onClick={() => setCards(true)}
          >
            <span className="material-symbols-outlined text-lg" aria-hidden>
              add_card
            </span>
            {t('desk.issueCard')}
          </button>
        )}
      {cards && (
        <Modal open title={t('card.title')} onClose={() => setCards(false)}>
          <CardPanel
            academyId={academyId}
            academyStudentId={view.student.id}
            withdrawn={false}
            compact
          />
        </Modal>
      )}
      {homeFor && (
        <Modal open title={t('desk.makeupTitle')} onClose={() => setHomeFor(null)}>
          <p className="mb-3 text-sm text-on-surface-variant">
            {t('desk.pickHome', { name: view.student.fullName, group: homeFor.group.name })}
          </p>
          <div className="flex flex-col gap-2">
            {view.student.groups
              .filter((g) => g.id !== homeFor.group.id)
              .map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className="btn-secondary min-h-11"
                  onClick={() => {
                    setHomeFor(null);
                    onCheckIn(who, {
                      sessionId: homeFor.sessionId,
                      makeup: true,
                      homeGroupId: g.id,
                    });
                  }}
                >
                  <bdi>{g.name}</bdi>
                </button>
              ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function ClassRow({
  c,
  lang,
  primary = false,
  makeup = false,
  onCheckIn,
}: {
  c: DeskClass;
  lang: string;
  primary?: boolean;
  makeup?: boolean;
  onCheckIn?: () => void;
}) {
  const { t } = useTranslation();
  const chip = c.attendance
    ? {
        tone:
          c.attendance.status === 'LATE'
            ? 'warn'
            : c.attendance.status === 'PRESENT'
              ? 'primary'
              : 'neutral',
        text: t(`classes.status.${c.attendance.status}`),
      }
    : c.state !== 'OPEN'
      ? { tone: 'neutral', text: t(`desk.state.${c.state}`) }
      : makeup && c.full
        ? { tone: 'warn', text: t('desk.full') }
        : null;
  return (
    <li
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border p-3 ${
        primary ? 'border-primary bg-primary-fixed/30' : 'border-outline-variant/50'
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="font-bold">
          <span className="tabular-nums">
            {formatClock(c.startTime, lang)} – {formatClock(c.endTime, lang)}
          </span>{' '}
          · <bdi>{c.group.name}</bdi>
        </p>
        <p className="truncate text-xs text-on-surface-variant">
          {[
            c.room?.name,
            c.teacher?.fullName,
            makeup && c.capacity != null
              ? t('desk.seats', { seated: c.seated ?? 0, capacity: c.capacity })
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      {chip && <Badge tone={chip.tone as 'primary' | 'warn' | 'neutral'}>{chip.text}</Badge>}
      {onCheckIn && (
        <button
          type="button"
          onClick={onCheckIn}
          className={`${primary ? 'btn-primary' : 'btn-secondary'} min-h-12 px-4 font-bold`}
        >
          <span className="material-symbols-outlined text-lg" aria-hidden>
            {makeup ? 'swap_horiz' : 'how_to_reg'}
          </span>
          {makeup ? t('desk.makeupAction') : c.lateNow ? t('desk.checkInLate') : t('desk.checkIn')}
        </button>
      )}
    </li>
  );
}

function Done({
  result,
  lang,
  onNext,
  compact,
}: {
  result: CheckInResult;
  lang: string;
  onNext: () => void;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const rec = result.record;
  const already = result.outcome === 'ALREADY';
  const status =
    rec?.status ?? (result.view.action.kind === 'ALREADY' ? result.view.action.status : null);
  const cls = result.view.classes.find(
    (c) =>
      c.sessionId ===
      (rec?.sessionId ??
        (result.view.action.kind === 'ALREADY' ? result.view.action.sessionId : '')),
  );
  const late = status === 'LATE';
  const look = already
    ? {
        icon: 'task_alt',
        ring: 'border-sky-500/50 bg-sky-500/10',
        title: t('desk.done.already', { status: status ? t(`classes.status.${status}`) : '' }),
      }
    : late
      ? {
          icon: 'schedule',
          ring: 'border-amber-500/60 bg-amber-500/10',
          title: t('desk.done.late'),
        }
      : {
          icon: 'check_circle',
          ring: 'border-emerald-500/60 bg-emerald-500/10',
          title: t('desk.done.present'),
        };
  const time =
    rec?.checkedInAt && result.view.timezone
      ? formatInstant(rec.checkedInAt, result.view.timezone, lang)
      : null;
  return (
    <div className={`card border-2 ${look.ring} ${compact ? 'p-3' : 'p-5'}`} role="status">
      <div className="flex items-center gap-3">
        <span
          className={`material-symbols-outlined ${compact ? 'text-4xl' : 'text-6xl'}`}
          aria-hidden
        >
          {look.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className={`${compact ? 'text-lg' : 'text-2xl'} font-extrabold`}>{look.title}</p>
          <p className="font-semibold [overflow-wrap:anywhere]">
            <bdi>{result.view.student.fullName}</bdi>
          </p>
          <p className="text-sm text-on-surface-variant">
            {cls && (
              <>
                <bdi>{cls.group.name}</bdi> · {formatClock(cls.startTime, lang)}
              </>
            )}
            {time && <span className="ms-1">· {t('desk.at', { time })}</span>}
            {rec?.makeup && <span className="ms-1">· {t('desk.asMakeup')}</span>}
          </p>
        </div>
      </div>
      {!compact && (
        <button type="button" className="btn-secondary mt-4 min-h-11 px-5" onClick={onNext}>
          {t('desk.next')}
        </button>
      )}
    </div>
  );
}

function Refused({
  error,
  onNext,
  compact,
}: {
  error: unknown;
  onNext: () => void;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const code = errorCode(error);
  const icon =
    code === 'CARD_REVOKED' || code === 'CARD_NOT_FOUND'
      ? 'credit_card_off'
      : code === 'GROUP_FULL'
        ? 'event_busy'
        : code === 'ATTENDANCE_CLOSED'
          ? 'lock'
          : 'block';
  return (
    <div
      className={`card border-2 border-error/50 bg-error-container/40 ${compact ? 'p-3' : 'p-5'}`}
      role="alert"
    >
      <p className={`flex items-center gap-2 ${compact ? 'text-base' : 'text-lg'} font-bold`}>
        <span className="material-symbols-outlined text-3xl" aria-hidden>
          {icon}
        </span>
        {errorMessage(error) || t('desk.refusedGeneric')}
      </p>
      {code && t(`desk.hint.${code}`, { defaultValue: '' }) && (
        <p className="mt-1 text-sm text-on-surface-variant">{t(`desk.hint.${code}`)}</p>
      )}
      {!compact && (
        <button type="button" className="btn-secondary mt-4 min-h-11 px-5" onClick={onNext}>
          {t('desk.next')}
        </button>
      )}
    </div>
  );
}

function RecentList({ items }: { items: Recent[] }) {
  const { t } = useTranslation();
  return (
    <section className="card p-3" aria-label={t('desk.recent')}>
      <h2 className="mb-2 px-1 text-sm font-bold text-on-surface-variant">{t('desk.recent')}</h2>
      {items.length === 0 ? (
        <p className="px-1 pb-1 text-sm text-outline">{t('desk.recentEmpty')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((r) => (
            <li key={r.key} className="flex items-center gap-2 rounded-lg px-1 py-1.5 text-sm">
              <span
                className={`material-symbols-outlined text-lg ${r.status === 'LATE' ? 'text-amber-600' : 'text-emerald-600'}`}
                aria-hidden
              >
                {r.already ? 'task_alt' : r.status === 'LATE' ? 'schedule' : 'check_circle'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">
                  <bdi>{r.name}</bdi>
                </span>
                <span className="block truncate text-xs text-on-surface-variant">
                  <bdi>{r.group}</bdi> · {t(`classes.status.${r.status}`)}
                </span>
              </span>
              <span className="shrink-0 text-xs tabular-nums text-outline">{r.at}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
