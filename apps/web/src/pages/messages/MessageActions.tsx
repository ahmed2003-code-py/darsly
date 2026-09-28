import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CHAT_REACTIONS } from '@darsly/shared-types';

type T = (k: string, o?: any) => string;

/**
 * What can be done to a message. Desktop: a small toolbar that appears on
 * hover or keyboard focus of a bubble. Phone: a bottom sheet opened by a long
 * press. Both offer the same things; neither leaves buttons on every message.
 */
export interface MessageActionHandlers {
  /** Absent for a deleted message: there is nothing to answer. */
  onReply?: () => void;
  onReact?: (emoji: string | null) => void;
  onCopy?: () => void;
  /** Hide it from my copy of the conversation. Always offered. */
  onDeleteForMe: () => void;
  /** Take it back for everyone — only on my own messages. */
  onDeleteForEveryone?: () => void;
  myReaction: string | null;
}

export function ReactionRow({
  mine,
  onPick,
  t,
  size = 'md',
}: {
  mine: string | null;
  onPick: (emoji: string | null) => void;
  t: T;
  size?: 'md' | 'lg';
}) {
  return (
    <div role="group" aria-label={t('messages.react')} className="flex items-center gap-0.5">
      {CHAT_REACTIONS.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => onPick(mine === e ? null : e)}
          aria-pressed={mine === e}
          aria-label={t('messages.reactWith', { emoji: e })}
          className={`grid place-items-center rounded-full transition hover:scale-110 hover:bg-surface-container-high ${
            size === 'lg' ? 'h-12 w-12 text-2xl' : 'h-9 w-9 text-xl'
          } ${mine === e ? 'bg-primary-fixed' : ''}`}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

/** The desktop toolbar; rendered inside the bubble row, shown on hover/focus. */
export function HoverToolbar({
  handlers,
  mine,
  pickerOpen,
  setPickerOpen,
  t,
}: {
  handlers: MessageActionHandlers;
  mine: boolean;
  pickerOpen: boolean;
  setPickerOpen: (v: boolean) => void;
  t: T;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setPickerOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [pickerOpen, setPickerOpen]);

  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [menuOpen]);

  const btn =
    'grid h-8 w-8 place-items-center rounded-full text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary';
  const menuItem =
    'flex w-full items-center gap-3 whitespace-nowrap px-3 py-2 text-start text-sm transition hover:bg-surface-container-high focus-visible:bg-surface-container-high focus-visible:outline-none';
  return (
    <div
      ref={ref}
      className={`relative hidden shrink-0 items-center gap-0.5 self-center opacity-0 transition-opacity group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 sm:flex ${
        pickerOpen || menuOpen ? 'opacity-100' : ''
      }`}
    >
      {handlers.onReact && (
        <button
          type="button"
          className={btn}
          onClick={() => setPickerOpen(!pickerOpen)}
          aria-label={t('messages.react')}
          aria-expanded={pickerOpen}
          title={t('messages.react')}
        >
          <span className="material-symbols-outlined text-[19px]">add_reaction</span>
        </button>
      )}
      {handlers.onReply && (
        <button
          type="button"
          className={btn}
          onClick={handlers.onReply}
          aria-label={t('messages.reply')}
          title={t('messages.reply')}
        >
          <span className="material-symbols-outlined text-[19px] rtl:-scale-x-100">reply</span>
        </button>
      )}
      {handlers.onCopy && (
        <button
          type="button"
          className={btn}
          onClick={handlers.onCopy}
          aria-label={t('messages.copy')}
          title={t('messages.copy')}
        >
          <span className="material-symbols-outlined text-[18px]">content_copy</span>
        </button>
      )}
      <button
        type="button"
        className={btn}
        onClick={() => setMenuOpen(!menuOpen)}
        aria-label={t('messages.more')}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={t('messages.more')}
      >
        <span className="material-symbols-outlined text-[19px]">more_vert</span>
      </button>
      {menuOpen && (
        <div
          role="menu"
          className={`absolute top-full z-20 mt-1 min-w-[11rem] overflow-hidden rounded-sm bg-surface-container-lowest py-1 shadow-elevated ring-1 ring-outline-variant/40 ${
            mine ? 'end-0' : 'start-0'
          }`}
        >
          <button
            type="button"
            role="menuitem"
            className={menuItem}
            onClick={() => {
              setMenuOpen(false);
              handlers.onDeleteForMe();
            }}
          >
            <span className="material-symbols-outlined text-[19px]">visibility_off</span>
            {t('messages.deleteForMe')}
          </button>
          {handlers.onDeleteForEveryone && (
            <button
              type="button"
              role="menuitem"
              className={`${menuItem} text-error`}
              onClick={() => {
                setMenuOpen(false);
                handlers.onDeleteForEveryone!();
              }}
            >
              <span className="material-symbols-outlined text-[19px]">delete</span>
              {t('messages.deleteForEveryone')}
            </button>
          )}
        </div>
      )}
      {pickerOpen && handlers.onReact && (
        <div
          className={`absolute bottom-full z-20 mb-1 rounded-full bg-surface-container-lowest p-1 shadow-elevated ring-1 ring-outline-variant/40 ${
            mine ? 'end-0' : 'start-0'
          }`}
        >
          <ReactionRow
            mine={handlers.myReaction}
            onPick={(e) => {
              handlers.onReact!(e);
              setPickerOpen(false);
            }}
            t={t}
          />
        </div>
      )}
    </div>
  );
}

/** The phone's action sheet, opened by a long press on a bubble. */
export function ActionSheet({
  handlers,
  preview,
  onClose,
  t,
}: {
  handlers: MessageActionHandlers;
  preview: string;
  onClose: () => void;
  t: T;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  // The finger that long-pressed is still down when the sheet appears; lifting
  // it fires a click at the same spot — on the sheet. Ignore clicks for a beat
  // so that click cannot press "Reply" or close the sheet by itself.
  const openedAt = useRef(Date.now());
  const settled = () => Date.now() - openedAt.current > 400;
  const guard = (fn: () => void) => () => settled() && fn();
  const item =
    'flex w-full items-center gap-4 px-5 py-3.5 text-start text-[15px] font-bold transition active:bg-surface-container-high';
  return createPortal(
    <div
      className="fixed inset-0 z-[55] flex flex-col justify-end bg-black/40"
      onClick={guard(onClose)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('messages.actions')}
        className="s-pop-in rounded-t-[20px] bg-surface-container-lowest pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-outline-variant" aria-hidden />
        {preview && (
          <p dir="auto" className="line-clamp-2 px-5 pt-3 text-sm text-on-surface-variant">
            {preview}
          </p>
        )}
        {handlers.onReact && (
          <div className="flex justify-center px-3 py-3">
            <ReactionRow
              mine={handlers.myReaction}
              onPick={(e) => {
                if (!settled()) return;
                handlers.onReact!(e);
                onClose();
              }}
              t={t}
              size="lg"
            />
          </div>
        )}
        <div className="border-t border-outline-variant/40">
          {handlers.onReply && (
            <button
              type="button"
              autoFocus
              className={item}
              onClick={guard(() => {
                handlers.onReply!();
                onClose();
              })}
            >
              <span className="material-symbols-outlined rtl:-scale-x-100">reply</span>
              {t('messages.reply')}
            </button>
          )}
          {handlers.onCopy && (
            <button
              type="button"
              className={item}
              onClick={guard(() => {
                handlers.onCopy!();
                onClose();
              })}
            >
              <span className="material-symbols-outlined">content_copy</span>
              {t('messages.copy')}
            </button>
          )}
          <button
            type="button"
            className={item}
            onClick={guard(() => {
              onClose();
              handlers.onDeleteForMe();
            })}
          >
            <span className="material-symbols-outlined">visibility_off</span>
            {t('messages.deleteForMe')}
          </button>
          {handlers.onDeleteForEveryone && (
            <button
              type="button"
              className={`${item} text-error`}
              onClick={guard(() => {
                onClose();
                handlers.onDeleteForEveryone!();
              })}
            >
              <span className="material-symbols-outlined">delete</span>
              {t('messages.deleteForEveryone')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A long press that does not fight scrolling: it fires after 450 ms held
 * still, cancels as soon as the finger moves, and suppresses the click that
 * follows so the press does not also "tap" a link or image.
 */
export function useLongPress(onLongPress: () => void, ms = 450) {
  const timer = useRef<number>();
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    window.clearTimeout(timer.current);
    start.current = null;
  };
  return {
    onTouchStart: (e: React.TouchEvent) => {
      fired.current = false;
      const p = e.touches[0];
      start.current = { x: p.clientX, y: p.clientY };
      timer.current = window.setTimeout(() => {
        fired.current = true;
        if (navigator.vibrate) navigator.vibrate(10);
        onLongPress();
      }, ms);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const p = e.touches[0];
      if (start.current && Math.hypot(p.clientX - start.current.x, p.clientY - start.current.y) > 8)
        cancel();
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
    onClickCapture: (e: React.MouseEvent) => {
      if (fired.current) {
        e.preventDefault();
        e.stopPropagation();
        fired.current = false;
      }
    },
    onContextMenu: (e: React.MouseEvent) => {
      // A long press on touch would otherwise also open the browser's menu.
      if (start.current || fired.current) e.preventDefault();
    },
  };
}

/** How far the finger must travel (px) before letting go replies. */
export const SWIPE_REPLY_AT = 56;
/** The most the bubble follows the finger. */
const SWIPE_MAX = 80;

/**
 * Swipe to reply, on touch screens.
 *
 * The bubble follows a horizontal drag toward the reading direction's end
 * (right in English, left in Arabic) and a reply arrow fades in behind it;
 * past SWIPE_REPLY_AT a tick of haptics says "let go to reply", and letting
 * go there replies. Anything short of it springs back.
 *
 * Scrolling wins every tie: the gesture only claims a drag whose first few
 * pixels are clearly sideways, and the row is `touch-action: pan-y`, so the
 * browser keeps vertical scrolling native and never waits on this code.
 */
export function useSwipeReply(onReply: (() => void) | undefined) {
  const [dx, setDx] = useState(0);
  const [settling, setSettling] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const mode = useRef<'undecided' | 'swipe' | 'scroll'>('undecided');
  const armed = useRef(false);
  const dir = () => (document.documentElement.dir === 'rtl' ? -1 : 1);

  const end = () => {
    if (mode.current === 'swipe') {
      if (armed.current) onReply?.();
      setSettling(true);
      setDx(0);
      window.setTimeout(() => setSettling(false), 180);
    }
    start.current = null;
    mode.current = 'undecided';
    armed.current = false;
  };

  if (!onReply) return { dx: 0, progress: 0, settling: false, handlers: {}, swiping: () => false };
  return {
    dx,
    progress: Math.min(1, Math.abs(dx) / SWIPE_REPLY_AT),
    settling,
    handlers: {
      onTouchStart: (e: React.TouchEvent) => {
        const p = e.touches[0];
        start.current = { x: p.clientX, y: p.clientY };
        mode.current = 'undecided';
        armed.current = false;
      },
      onTouchMove: (e: React.TouchEvent) => {
        if (!start.current) return;
        const p = e.touches[0];
        const x = (p.clientX - start.current.x) * dir();
        const y = p.clientY - start.current.y;
        if (mode.current === 'undecided') {
          if (Math.abs(y) > 8 && Math.abs(y) >= Math.abs(x)) mode.current = 'scroll';
          else if (x > 10 && x > Math.abs(y) * 1.5) mode.current = 'swipe';
          else return;
        }
        if (mode.current !== 'swipe') return;
        const along = Math.max(0, Math.min(SWIPE_MAX, x * 0.75));
        const nowArmed = along >= SWIPE_REPLY_AT;
        if (nowArmed && !armed.current && navigator.vibrate) navigator.vibrate(12);
        armed.current = nowArmed;
        setDx(along * dir());
      },
      onTouchEnd: end,
      onTouchCancel: end,
    },
    /** True while a swipe owns the gesture — a long press must not also fire. */
    swiping: () => mode.current === 'swipe',
  };
}
