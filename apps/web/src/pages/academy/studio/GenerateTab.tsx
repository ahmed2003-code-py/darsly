import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AxiosError } from 'axios';
import { api } from '../../../lib/api';
import { ErrorNote } from '../../../components/ui';

interface Job {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  stage: string | null;
  attempts: number;
  error: string | null;
  costCents: number;
}

/**
 * The four directions, shown rather than described.
 *
 * A teacher choosing between four sentences is guessing. Each card carries the
 * direction's actual palette and sets its name in the typeface that direction
 * uses, so the choice is made by eye — which is how anyone actually picks a
 * look, and the only honest preview of what the generator will build.
 *
 * These swatches mirror `vibe-profiles.ts` on the server. They are a sample of
 * the territory, not the exact palette: the designer composes its own colours
 * inside the direction each time.
 */
const VIBES = [
  {
    key: 'trusted', icon: 'volunteer_activism',
    paper: '#FDFAF5', ink: '#241C16', brand: '#C2592F', accent: '#0F766E',
    face: 'Georgia, "Times New Roman", serif', tracking: '0em', weight: 700, radius: '999px',
  },
  {
    key: 'academic', icon: 'school',
    paper: '#FBFBF9', ink: '#0E1520', brand: '#1D4ED8', accent: '#16457C',
    face: 'Georgia, "Times New Roman", serif', tracking: '0em', weight: 600, radius: '2px',
  },
  {
    key: 'premium', icon: 'diamond',
    paper: '#0B0B10', ink: '#EDEAE3', brand: '#C8A96A', accent: '#B08D57',
    face: 'Georgia, "Times New Roman", serif', tracking: '0.01em', weight: 500, radius: '4px',
  },
  {
    key: 'energetic', icon: 'bolt',
    paper: '#0B0714', ink: '#F2F5FF', brand: '#FB3B6C', accent: '#22D3EE',
    face: '"Arial Narrow", Impact, system-ui, sans-serif', tracking: '-0.03em', weight: 800, radius: '14px',
  },
] as const;

export default function GenerateTab({ onDone }: { onDone?: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [vibe, setVibe] = useState<(typeof VIBES)[number]['key']>('trusted');
  const [stylePrompt, setStylePrompt] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);

  const job = useQuery<Job>({
    queryKey: ['studio-job', jobId],
    queryFn: async () => (await api.get(`/academy/site/jobs/${jobId}`)).data,
    enabled: !!jobId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'QUEUED' || s === 'RUNNING' ? 1500 : false;
    },
  });

  const status = job.data?.status;
  useEffect(() => {
    if (status && ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(status)) {
      qc.invalidateQueries({ queryKey: ['studio-overview'] });
      qc.invalidateQueries({ queryKey: ['studio-draft'] });
    }
  }, [status, qc]);

  const generate = useMutation({
    mutationFn: async () =>
      (await api.post('/academy/site/generate', {
        vibe,
        stylePrompt: stylePrompt.trim() || undefined,
        lang: i18n.language === 'en' ? 'en' : 'ar',
      })).data as Job,
    onSuccess: (j) => setJobId(j.id),
    onError: (e: AxiosError) => {
      if (e.response?.status === 409) qc.invalidateQueries({ queryKey: ['studio-overview'] });
    },
  });
  const cancel = useMutation({
    mutationFn: async () => (await api.post(`/academy/site/jobs/${jobId}/cancel`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['studio-job', jobId] }),
  });

  const active = job.data && (job.data.status === 'QUEUED' || job.data.status === 'RUNNING');
  const stageLabel =
    job.data?.stage === 'copy' ? t('studio.generate.stageCopy') : job.data?.stage === 'assemble' ? t('studio.generate.stageAssemble') : t('studio.generate.working');

  if (active) {
    return (
      <div className="card flex flex-col items-center gap-4 py-12 text-center">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-primary-fixed border-t-primary" />
        <div>
          <p className="font-heading text-lg font-bold">{t('studio.generate.generating')}</p>
          <p className="mt-1 text-sm text-on-surface-variant">
            {job.data?.status === 'QUEUED' ? t('studio.generate.queued') : stageLabel}
          </p>
        </div>
        {job.data?.status === 'QUEUED' && (
          <button className="btn-secondary" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            {t('studio.generate.cancel')}
          </button>
        )}
      </div>
    );
  }

  if (job.data?.status === 'SUCCEEDED') {
    return (
      <div className="card flex flex-col items-center gap-4 py-12 text-center">
        <span className="material-symbols-outlined text-5xl text-teal-500">check_circle</span>
        <div>
          <p className="font-heading text-lg font-bold">{t('studio.generate.successTitle')}</p>
          <p className="mt-1 text-sm text-on-surface-variant">{t('studio.generate.successHint')}</p>
        </div>
        <div className="flex gap-2">
          {onDone && <button className="btn-primary" onClick={onDone}>{t('studio.generate.previewBtn')}</button>}
          <button className="btn-secondary" onClick={() => setJobId(null)}>{t('studio.generate.again')}</button>
        </div>
      </div>
    );
  }

  const failed = job.data?.status === 'FAILED';
  const is409 = (generate.error as AxiosError)?.response?.status === 409;
  return (
    <div className="card">
      <h2 className="mb-1 font-heading text-xl font-bold">{t('studio.generate.title')}</h2>
      <p className="mb-5 text-sm text-on-surface-variant">{t('studio.generate.hint')}</p>

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        {VIBES.map((v) => {
          const on = vibe === v.key;
          return (
            <button
              key={v.key}
              type="button"
              onClick={() => setVibe(v.key)}
              aria-pressed={on}
              className={`group overflow-hidden rounded-xl border text-start transition-[border-color,box-shadow,transform] duration-200 ease-premium ${
                on
                  ? 'border-primary shadow-glow'
                  : 'border-outline-variant hover:-translate-y-0.5 hover:border-accent-300'
              }`}
            >
              {/* The direction, drawn in its own colours and its own typeface. */}
              <span
                className="relative flex h-24 items-center justify-between gap-3 px-5"
                style={{ background: v.paper }}
              >
                <span
                  className="text-xl leading-tight"
                  style={{ color: v.ink, fontFamily: v.face, fontWeight: v.weight, letterSpacing: v.tracking }}
                >
                  {t(`studio.generate.vibes.${v.key}`)}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <i className="block h-7 w-7" style={{ background: v.brand, borderRadius: v.radius }} />
                  <i className="block h-7 w-7" style={{ background: v.accent, borderRadius: v.radius }} />
                </span>
                {on && (
                  <span
                    className="absolute bottom-0 inset-x-0 h-1"
                    style={{ background: `linear-gradient(90deg, ${v.brand}, ${v.accent})` }}
                  />
                )}
              </span>
              <span className="flex items-start gap-2.5 bg-surface-container-lowest p-4">
                <span className={`material-symbols-outlined text-[20px] ${on ? 'text-primary' : 'text-outline'}`}>
                  {on ? 'check_circle' : v.icon}
                </span>
                <span className="text-sm leading-relaxed text-on-surface-variant">
                  {t(`studio.generate.vibes.${v.key}D`)}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <label className="mb-5 block">
        <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">{t('studio.generate.styleLabel')}</span>
        <textarea className="input min-h-[80px]" value={stylePrompt} maxLength={600}
          onChange={(e) => setStylePrompt(e.target.value)} placeholder={t('studio.generate.stylePh')} />
        <span className="mt-1 block text-xs text-outline">{t('studio.generate.styleHint')}</span>
      </label>

      {failed && (
        <div className="mb-4 rounded-xl border border-error/30 bg-error-container/30 p-3 text-sm text-error">
          <p className="font-bold">{t('studio.generate.failedTitle')}</p>
          <p className="mt-0.5">{job.data?.error ?? t('studio.generate.failedGeneric')}</p>
        </div>
      )}
      <ErrorNote error={generate.error && !is409 ? generate.error : null} />
      {is409 && <p className="mb-3 text-sm text-amber-600">{t('studio.generate.oneActive')}</p>}

      <button className="btn-primary" onClick={() => generate.mutate()} disabled={generate.isPending}>
        <span className="material-symbols-outlined text-[20px]">auto_awesome</span>
        {generate.isPending ? t('studio.generate.starting') : failed ? t('studio.generate.retryBtn') : t('studio.generate.generateBtn')}
      </button>
    </div>
  );
}
