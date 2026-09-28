import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatAttachmentDto } from '@darsly/shared-types';
import { formatBytes } from './format';
import { mediaUrl } from '../../lib/api';

type T = (k: string, o?: any) => string;

const FILE_LOOK: Record<string, { icon: string; label: string }> = {
  'application/pdf': { icon: 'picture_as_pdf', label: 'PDF' },
  'application/msword': { icon: 'description', label: 'Word' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    icon: 'description',
    label: 'Word',
  },
  'application/vnd.ms-excel': { icon: 'table_chart', label: 'Excel' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    icon: 'table_chart',
    label: 'Excel',
  },
  'application/vnd.ms-powerpoint': { icon: 'slideshow', label: 'PowerPoint' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    icon: 'slideshow',
    label: 'PowerPoint',
  },
  'text/plain': { icon: 'article', label: 'TXT' },
};
export const fileLook = (mime: string) => FILE_LOOK[mime] ?? { icon: 'draft', label: 'File' };

/** The files of one message: images as a grid, everything else as cards. */
export function MessageAttachments({
  items,
  mine,
  lang,
  t,
}: {
  items: ChatAttachmentDto[];
  mine: boolean;
  lang: string;
  t: T;
}) {
  const images = items.filter((a) => a.kind === 'IMAGE');
  const files = items.filter((a) => a.kind !== 'IMAGE');
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      {images.length > 0 && (
        <div className={`grid gap-1 ${images.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {images.map((a, i) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setOpen(i)}
              aria-label={t('messages.openImage', { name: a.name })}
              className="group/img relative block overflow-hidden rounded-sm bg-surface-container-high focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              style={
                images.length === 1 && a.width && a.height
                  ? { aspectRatio: `${a.width} / ${a.height}`, maxHeight: 320, width: '100%' }
                  : { aspectRatio: '1 / 1' }
              }
            >
              <img
                src={mediaUrl(a.previewUrl ?? a.url)!}
                alt={a.name}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover transition duration-200 group-hover/img:scale-[1.02]"
              />
            </button>
          ))}
        </div>
      )}
      {files.map((a) => (
        <FileCard key={a.id} a={a} mine={mine} lang={lang} t={t} />
      ))}
      {open !== null && (
        <Lightbox
          images={images}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          t={t}
        />
      )}
    </div>
  );
}

export function FileCard({
  a,
  mine,
  lang,
  t,
}: {
  a: ChatAttachmentDto;
  mine: boolean;
  lang: string;
  t: T;
}) {
  const look = fileLook(a.mimeType);
  return (
    <div
      className={`flex min-w-0 items-center gap-3 rounded-sm p-2.5 ${
        mine ? 'bg-black/10' : 'bg-surface-container-high'
      }`}
    >
      <span
        className={`grid h-10 w-10 shrink-0 place-items-center rounded-sm ${
          mine ? 'bg-black/15 text-on-primary' : 'bg-primary-fixed text-on-primary-fixed'
        }`}
        aria-hidden
      >
        <span className="material-symbols-outlined text-[22px]">{look.icon}</span>
      </span>
      <span className="min-w-0 flex-1">
        <bdi className="block truncate text-sm font-bold" title={a.name}>
          {a.name}
        </bdi>
        <span
          className={`block text-xs ${mine ? 'text-on-primary/75' : 'text-on-surface-variant'}`}
        >
          {look.label} · <span dir="ltr">{formatBytes(a.size, lang)}</span>
        </span>
      </span>
      <a
        href={mediaUrl(a.url)!}
        target="_blank"
        rel="noopener noreferrer"
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-full transition ${
          mine ? 'hover:bg-black/15' : 'hover:bg-surface-container-highest'
        }`}
        aria-label={t('messages.openFile', { name: a.name })}
        title={t('messages.open')}
      >
        <span className="material-symbols-outlined text-[20px]">open_in_new</span>
      </a>
      <a
        href={mediaUrl(a.downloadUrl)!}
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-full transition ${
          mine ? 'hover:bg-black/15' : 'hover:bg-surface-container-highest'
        }`}
        aria-label={t('messages.downloadFile', { name: a.name })}
        title={t('messages.download')}
      >
        <span className="material-symbols-outlined text-[20px]">download</span>
      </a>
    </div>
  );
}

/** Full-screen image viewer: arrows / swipe-free buttons, Esc closes, focus stays inside. */
function Lightbox({
  images,
  index,
  onIndex,
  onClose,
  t,
}: {
  images: ChatAttachmentDto[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  t: T;
}) {
  const a = images[index];
  const go = useCallback(
    (d: number) => onIndex((index + d + images.length) % images.length),
    [index, images.length, onIndex],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      // Arrow keys follow reading direction: in RTL, "next" is to the left.
      const rtl = document.documentElement.dir === 'rtl';
      if (e.key === 'ArrowRight') go(rtl ? -1 : 1);
      if (e.key === 'ArrowLeft') go(rtl ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [go, onClose]);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={a.name}
      className="fixed inset-0 z-[55] flex flex-col bg-black/90 text-white"
      onClick={onClose}
    >
      <div
        className="flex items-center gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]"
        onClick={(e) => e.stopPropagation()}
      >
        <bdi className="min-w-0 flex-1 truncate text-sm">{a.name}</bdi>
        {images.length > 1 && (
          <span className="text-xs text-white/70" dir="ltr">
            {index + 1} / {images.length}
          </span>
        )}
        <a
          href={mediaUrl(a.downloadUrl)!}
          className="grid h-11 w-11 place-items-center rounded-full hover:bg-white/10"
          aria-label={t('messages.download')}
        >
          <span className="material-symbols-outlined">download</span>
        </a>
        <button
          type="button"
          autoFocus
          onClick={onClose}
          className="grid h-11 w-11 place-items-center rounded-full hover:bg-white/10"
          aria-label={t('common.close')}
        >
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <img
          src={mediaUrl(a.url)!}
          alt={a.name}
          className="max-h-full max-w-full rounded-sm object-contain"
          onClick={(e) => e.stopPropagation()}
        />
        {images.length > 1 && (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                go(-1);
              }}
              className="absolute start-2 grid h-11 w-11 place-items-center rounded-full bg-black/40 hover:bg-black/60"
              aria-label={t('messages.previous')}
            >
              <span className="material-symbols-outlined rtl:-scale-x-100">chevron_left</span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                go(1);
              }}
              className="absolute end-2 grid h-11 w-11 place-items-center rounded-full bg-black/40 hover:bg-black/60"
              aria-label={t('messages.next')}
            >
              <span className="material-symbols-outlined rtl:-scale-x-100">chevron_right</span>
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
