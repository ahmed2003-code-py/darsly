import { KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessageDto } from '@darsly/shared-types';
import { ACCEPT, UploadItem } from './useUploads';
import { fileLook } from './Attachments';
import { shouldSendOnKey } from './composerKeys';
import { clock, formatBytes } from './format';
import { messagePreview } from './MessageBubble';
import type { LocalMessage } from './messageList';
import VoiceNote from './VoiceNote';

type T = (k: string, o?: any) => string;

/** Five minutes, matching the server. A voice note is a thought, not a lecture. */
const VOICE_MAX_SECONDS = 300;
const MAX_ROWS_PX = 6 * 24 + 16;

/** A phone or tablet without a hardware keyboard: Enter must stay a new line there. */
const touchFirst = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

export interface ComposerProps {
  draft: string;
  setDraft: (v: string) => void;
  replyTo: ChatMessageDto | null;
  onCancelReply: () => void;
  uploads: {
    items: UploadItem[];
    add: (files: FileList | File[]) => string | null;
    retry: (key: string) => void;
    remove: (key: string) => void;
    busy: boolean;
    failed: boolean;
    hasVoice: boolean;
  };
  /** Recording is possible before the first message: a note is a pending asset. */
  canRecord: boolean;
  onVoice: (blob: Blob, seconds: number) => void;
  onSend: () => void;
  onType: () => void;
  onNotice: (m: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  lang: string;
  t: T;
}

export default function Composer(props: ComposerProps) {
  const { draft, setDraft, replyTo, uploads, onSend, onType, inputRef, t, lang } = props;
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  // Grow with the text, up to six lines, then scroll inside.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  }, [draft, inputRef]);

  const hasFiles = uploads.items.length > 0;
  const canSend =
    (!!draft.trim() || uploads.items.some((i) => i.status === 'done')) &&
    !uploads.busy &&
    !uploads.failed;

  function addFiles(files: FileList | File[] | null) {
    if (!files || !files.length) return;
    const error = uploads.add(files);
    if (error) props.onNotice(error);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      shouldSendOnKey(
        e.nativeEvent as unknown as Parameters<typeof shouldSendOnKey>[0],
        !!touchFirst(),
      )
    ) {
      e.preventDefault();
      if (canSend) onSend();
    }
  }

  return (
    <div
      className={`relative border-t border-outline-variant/40 bg-surface-container-lowest px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-3 ${
        dragging ? 'ring-2 ring-inset ring-primary' : ''
      }`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      {replyTo && (
        // One compact row: who, and one line of what. It must not eat the
        // conversation on a phone with the keyboard up.
        <div className="mb-1.5 flex items-center gap-2 rounded-[10px] border-s-[3px] border-primary bg-surface-container-low py-1 pe-1 ps-2.5">
          <span className="min-w-0 flex-1 text-xs leading-snug">
            <span className="block truncate font-bold text-primary-text">
              {t('messages.replyingTo', {
                name: replyTo.mine ? t('messages.you') : replyTo.senderName,
              })}
            </span>
            <span dir="auto" className="block truncate text-on-surface-variant">
              {messagePreview(replyTo as LocalMessage, t)}
            </span>
          </span>
          <button
            type="button"
            onClick={props.onCancelReply}
            aria-label={t('messages.cancelReply')}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-on-surface-variant transition hover:bg-surface-container-high"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      )}

      {hasFiles && (
        <ul className="mb-2 flex gap-2 overflow-x-auto pb-1" aria-label={t('messages.attachments')}>
          {uploads.items.map((u) => (
            <UploadChip
              key={u.key}
              u={u}
              onRetry={() => uploads.retry(u.key)}
              onRemove={() => uploads.remove(u.key)}
              lang={lang}
              t={t}
            />
          ))}
        </ul>
      )}

      <Recorder {...props}>
        {(startRecording) => (
          <div className="flex items-end gap-1.5">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploads.items.filter((i) => !i.voiceSec).length >= 5}
              aria-label={t('messages.attach')}
              title={t('messages.attach')}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface disabled:opacity-40"
            >
              <span className="material-symbols-outlined">attach_file</span>
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <textarea
              ref={inputRef}
              rows={1}
              dir="auto"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                onType();
              }}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files ?? []);
                if (files.length) {
                  e.preventDefault();
                  addFiles(files);
                }
              }}
              placeholder={t('messages.typePlaceholder')}
              aria-label={t('messages.typePlaceholder')}
              enterKeyHint={touchFirst() ? 'enter' : 'send'}
              className="min-h-11 flex-1 resize-none rounded-[22px] border border-outline-variant/60 bg-surface-container-low px-4 py-[11px] text-[15px] leading-6 text-on-surface outline-none transition placeholder:text-outline focus:border-primary focus:bg-surface-container-lowest"
            />
            {/* The mic stays until a note is recorded — next to Send too, so a
                voice note can go with text and files in one message, in
                whatever order they were added. */}
            {props.canRecord && !uploads.hasVoice && (
              <button
                type="button"
                onClick={startRecording}
                aria-label={t('messages.record')}
                title={t('messages.record')}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary-fixed text-on-primary-fixed transition hover:bg-primary hover:text-on-primary"
              >
                <span className="material-symbols-outlined">mic</span>
              </button>
            )}
            {(hasFiles || !!draft.trim() || !props.canRecord) && (
              <button
                type="button"
                onClick={onSend}
                disabled={!canSend}
                aria-label={t('messages.send')}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary text-on-primary transition hover:bg-primary-hover disabled:bg-surface-container-high disabled:text-outline"
              >
                <span className="material-symbols-outlined rtl:-scale-x-100">send</span>
              </button>
            )}
          </div>
        )}
      </Recorder>
    </div>
  );
}

function UploadChip({
  u,
  onRetry,
  onRemove,
  lang,
  t,
}: {
  u: UploadItem;
  onRetry: () => void;
  onRemove: () => void;
  lang: string;
  t: T;
}) {
  const look = fileLook(
    u.attachment?.mimeType ?? (u.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : ''),
  );
  if (u.voiceSec) {
    // A recorded note waiting to go with the message: listen before sending.
    return (
      <li className="relative flex w-64 shrink-0 items-center gap-1 rounded-sm bg-surface-container-low p-2 pe-9">
        {u.status === 'failed' ? (
          <span className="flex min-w-0 flex-1 items-center gap-2 text-xs">
            <span className="material-symbols-outlined text-error">mic_off</span>
            <span className="line-clamp-3 text-error" title={u.error}>
              {u.error ?? t('messages.uploadFailed')}
            </span>
            {u.retryable !== false && (
              <button
                type="button"
                onClick={onRetry}
                className="shrink-0 font-bold text-primary-text"
              >
                {t('messages.retry')}
              </button>
            )}
          </span>
        ) : (
          <span className={`min-w-0 flex-1 ${u.status === 'uploading' ? 'opacity-70' : ''}`}>
            <VoiceNote src={u.localUrl} seconds={u.voiceSec} mine={false} t={t} />
          </span>
        )}
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('messages.removeVoice')}
          className="absolute end-1 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full text-on-surface-variant transition hover:bg-surface-container-high"
        >
          <span className="material-symbols-outlined text-[18px]">delete</span>
        </button>
      </li>
    );
  }
  return (
    <li className="relative flex w-56 shrink-0 items-center gap-2.5 rounded-sm bg-surface-container-low p-2 pe-9">
      {u.isImage && u.localUrl ? (
        <img src={u.localUrl} alt="" className="h-11 w-11 shrink-0 rounded-[8px] object-cover" />
      ) : (
        <span
          className="grid h-11 w-11 shrink-0 place-items-center rounded-[8px] bg-primary-fixed text-on-primary-fixed"
          aria-hidden
        >
          <span className="material-symbols-outlined">{look.icon}</span>
        </span>
      )}
      <span className="min-w-0 flex-1">
        <bdi className="block truncate text-sm font-bold" title={u.name}>
          {u.name}
        </bdi>
        {u.status === 'failed' ? (
          <span className="flex items-start gap-2 text-xs">
            <span className="line-clamp-3 min-w-0 text-error" title={u.error} role="alert">
              {u.error ?? t('messages.uploadFailed')}
            </span>
            {u.retryable !== false && (
              <button
                type="button"
                onClick={onRetry}
                className="shrink-0 font-bold text-primary-text"
              >
                {t('messages.retry')}
              </button>
            )}
          </span>
        ) : u.status === 'uploading' ? (
          <span
            className="mt-1 block h-1.5 overflow-hidden rounded-full bg-surface-container-highest"
            role="progressbar"
            aria-valuenow={Math.round(u.progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t('messages.uploading')}
          >
            <span
              className="block h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${Math.max(4, u.progress * 100)}%` }}
            />
          </span>
        ) : (
          <span className="text-xs text-on-surface-variant" dir="ltr">
            {formatBytes(u.attachment?.size ?? u.size, lang)}
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={
          u.status === 'uploading'
            ? t('messages.cancelUpload')
            : t('messages.removeFile', { name: u.name })
        }
        className="absolute end-1 top-1 grid h-7 w-7 place-items-center rounded-full text-on-surface-variant transition hover:bg-surface-container-high"
      >
        <span className="material-symbols-outlined text-[18px]">close</span>
      </button>
    </li>
  );
}

/**
 * The voice recorder shares the composer's row: while a note is being
 * recorded there is nothing to type, and the only two things worth offering
 * are send and discard. Renders `children(start)` when idle.
 */
function Recorder({
  canRecord,
  onVoice,
  onNotice,
  t,
  children,
}: ComposerProps & { children: (start: () => void) => React.ReactNode }) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const elapsedRef = useRef(0);
  const chunksRef = useRef<Blob[]>([]);
  const keepRef = useRef(true);
  const tickRef = useRef<number>();
  const stopTracks = () => recorderRef.current?.stream.getTracks().forEach((tr) => tr.stop());

  useEffect(
    () => () => {
      window.clearInterval(tickRef.current);
      stopTracks();
    },
    [],
  );

  async function start() {
    if (!canRecord) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      onNotice(t('messages.micUnsupported'));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      keepRef.current = true;
      recorder.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      recorder.onstop = () => {
        window.clearInterval(tickRef.current);
        stopTracks();
        const seconds = elapsedRef.current;
        setRecording(false);
        setElapsed(0);
        if (!keepRef.current || seconds < 1) return;
        onVoice(new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' }), seconds);
      };
      recorder.start();
      setRecording(true);
      elapsedRef.current = 0;
      setElapsed(0);
      tickRef.current = window.setInterval(() => {
        elapsedRef.current += 1;
        setElapsed(elapsedRef.current);
        if (elapsedRef.current >= VOICE_MAX_SECONDS) finish(true);
      }, 1000);
    } catch {
      onNotice(t('messages.micDenied'));
    }
  }

  function finish(keep: boolean) {
    keepRef.current = keep;
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    else {
      window.clearInterval(tickRef.current);
      setRecording(false);
    }
  }

  if (!recording) return <>{children(start)}</>;
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => finish(false)}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-error transition hover:bg-error-container"
        aria-label={t('messages.cancelRecording')}
      >
        <span className="material-symbols-outlined">delete</span>
      </button>
      <span className="flex flex-1 items-center gap-2 text-sm font-bold text-error" role="status">
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-error" />
        {t('messages.recording')}
        <span dir="ltr" className="tabular-nums text-on-surface-variant">
          {clock(elapsed)}
        </span>
      </span>
      {/* Stopping keeps the note with the message being written; Send sends it
          together with any text and files, as one message. */}
      <button
        type="button"
        onClick={() => finish(true)}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary text-on-primary"
        aria-label={t('messages.recordDone')}
        title={t('messages.recordDone')}
      >
        <span className="material-symbols-outlined">check</span>
      </button>
    </div>
  );
}
