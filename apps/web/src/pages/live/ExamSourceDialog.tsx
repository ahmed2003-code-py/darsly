import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNote, Modal } from '../../components/ui';
import { api } from '../../lib/api';

/** What the Exam Studio reads (the server checks the bytes again). */
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp';
const ACCEPTED = /^(image\/(png|jpe?g|webp)|application\/pdf)$/;
const MAX_FILES = 30;

export interface ExamTranscriptSource {
  status: string;
  usable: boolean;
  partial: boolean;
  durationSec?: number | null;
}

/**
 * «اختر محتوى الامتحان» — what an exam from this class is written from: the
 * class transcript, material the teacher uploads now, or both. Then straight
 * to the Exam Studio, where the teacher sets the exam up, it is written, and
 * nothing is published before they have reviewed it.
 */
export default function ExamSourceDialog({
  sessionId,
  transcript,
  onClose,
  onCreated,
}: {
  sessionId: string;
  transcript: ExamTranscriptSource;
  onClose: () => void;
  onCreated: (importId: string) => void;
}) {
  const { t } = useTranslation();
  const [useTranscript, setUseTranscript] = useState(transcript.usable);
  const [useFiles, setUseFiles] = useState(!transcript.usable);
  const [files, setFiles] = useState<File[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [ack, setAck] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);

  const create = useMutation({
    mutationFn: async () => {
      const chosen = useFiles ? files : [];
      const flags = { transcript: useTranscript, acknowledgePartial: useTranscript && transcript.partial && ack };
      if (!chosen.length) {
        return (await api.post(`/teacher/live/${sessionId}/content/exam`, flags)).data as { id: string };
      }
      const form = new FormData();
      form.append('transcript', String(flags.transcript));
      form.append('acknowledgePartial', String(flags.acknowledgePartial));
      for (const f of chosen) form.append('files', f);
      return (await api.post(`/teacher/live/${sessionId}/content/exam`, form)).data as { id: string };
    },
    onSuccess: (r) => onCreated(r.id),
    onSettled: () => {
      busy.current = false;
    },
  });

  const add = (list: FileList | null) => {
    const picked = Array.from(list ?? []);
    const ok = picked.filter((f) => ACCEPTED.test(f.type));
    setRejected(picked.filter((f) => !ACCEPTED.test(f.type)).map((f) => f.name));
    setFiles((cur) => {
      const seen = new Set(cur.map((f) => `${f.name}:${f.size}`));
      return [...cur, ...ok.filter((f) => !seen.has(`${f.name}:${f.size}`))].slice(0, MAX_FILES);
    });
    if (input.current) input.current.value = '';
  };

  const filesChosen = useFiles && files.length > 0;
  const needsAck = useTranscript && transcript.partial;
  const valid = (useTranscript || filesChosen) && (!useFiles || filesChosen) && (!needsAck || ack);
  const minutes = transcript.durationSec ? Math.max(1, Math.round(transcript.durationSec / 60)) : null;
  const transcriptState = !transcript.usable
    ? t('liveContent.src.transcriptUnavailable')
    : transcript.partial
      ? t('liveContent.src.transcriptPartial')
      : t('liveContent.src.transcriptReady');

  const submit = () => {
    if (!valid || busy.current) return;
    busy.current = true;
    create.mutate();
  };

  return (
    <Modal open onClose={onClose} title={t('liveContent.src.title')}>
      <div className="space-y-3">
        <p className="text-sm text-on-surface-variant">{t('liveContent.src.hint')}</p>

        <label
          className={`flex items-start gap-3 rounded-xl border p-3 ${
            transcript.usable ? 'cursor-pointer border-outline-variant/70' : 'border-outline-variant/40 opacity-70'
          } ${useTranscript ? 'border-primary bg-primary/5' : ''}`}
        >
          <input
            type="checkbox"
            className="mt-1 h-5 w-5 shrink-0 accent-primary"
            checked={useTranscript}
            disabled={!transcript.usable || create.isPending}
            onChange={(e) => setUseTranscript(e.target.checked)}
          />
          <span className="min-w-0">
            <span className="block font-semibold">{t('liveContent.src.transcript')}</span>
            <span className="block text-xs text-on-surface-variant">
              {transcriptState}
              {minutes && transcript.usable ? ` · ${t('liveContent.src.minutes', { count: minutes })}` : ''}
            </span>
            {!transcript.usable && (
              <span className="mt-1 block text-xs text-on-surface-variant">{t('liveContent.src.transcriptUnavailableHint')}</span>
            )}
          </span>
        </label>

        {needsAck && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm" role="alert">
            <p className="font-semibold">{t('liveContent.src.partialWarning')}</p>
            <label className="mt-2 flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                className="h-5 w-5 accent-primary"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              {t('liveContent.src.partialAck')}
            </label>
          </div>
        )}

        <div className={`rounded-xl border p-3 ${useFiles ? 'border-primary bg-primary/5' : 'border-outline-variant/70'}`}>
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 h-5 w-5 shrink-0 accent-primary"
              checked={useFiles}
              disabled={create.isPending}
              onChange={(e) => setUseFiles(e.target.checked)}
            />
            <span className="min-w-0">
              <span className="block font-semibold">{t('liveContent.src.files')}</span>
              <span className="block text-xs text-on-surface-variant">{t('liveContent.src.formats')}</span>
            </span>
          </label>
          {useFiles && (
            <div className="mt-3 space-y-2">
              <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => add(e.target.files)} />
              <button
                type="button"
                className="btn-secondary w-full justify-center !py-2 text-sm sm:w-auto"
                disabled={create.isPending || files.length >= MAX_FILES}
                onClick={() => input.current?.click()}
              >
                <span aria-hidden className="material-symbols-outlined text-[18px]">upload_file</span>
                {t('liveContent.src.pick')}
              </button>
              {rejected.length > 0 && (
                <p className="text-xs text-error" role="alert">
                  {t('liveContent.src.rejected', { names: rejected.join('، ') })}
                </p>
              )}
              {files.length > 0 && (
                <ul className="space-y-1">
                  {files.map((f) => (
                    <li key={`${f.name}:${f.size}`} className="flex items-center gap-2 rounded-lg bg-surface-container-low px-2 py-1.5 text-sm">
                      <span aria-hidden className="material-symbols-outlined text-[18px] text-outline">
                        {f.type === 'application/pdf' ? 'picture_as_pdf' : 'image'}
                      </span>
                      <span className="min-w-0 flex-1 truncate" dir="auto">
                        {f.name}
                      </span>
                      <span className="shrink-0 text-xs text-outline">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                      <button
                        type="button"
                        className="btn-ghost shrink-0 !p-1"
                        aria-label={t('liveContent.src.remove', { name: f.name })}
                        disabled={create.isPending}
                        onClick={() => setFiles((cur) => cur.filter((x) => x !== f))}
                      >
                        <span aria-hidden className="material-symbols-outlined text-[18px]">close</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <p className="text-xs text-on-surface-variant">{t('liveContent.src.next')}</p>
        <ErrorNote error={create.error} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn-ghost justify-center" onClick={onClose} disabled={create.isPending}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn-primary justify-center" disabled={!valid || create.isPending} onClick={submit}>
            {create.isPending
              ? filesChosen
                ? t('liveContent.src.uploading')
                : t('liveContent.src.preparing')
              : t('liveContent.src.continue')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
