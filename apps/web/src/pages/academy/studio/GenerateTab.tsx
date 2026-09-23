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
 * The one design choice left in the Studio: a brand colour pair.
 *
 * Every academy's page is the same fixed layout — same sections, same
 * animations — so there is nothing left to pick between except colour. These
 * mirror `pipeline/color-palettes.ts` on the server exactly.
 */
const PALETTES = [
  { key: 'royal', primary: '#2f5fe0', accent: '#7c3aed' },
  { key: 'teal', primary: '#0d9488', accent: '#0891b2' },
  { key: 'sunset', primary: '#ea580c', accent: '#db2777' },
  { key: 'forest', primary: '#059669', accent: '#16a34a' },
  { key: 'berry', primary: '#a21caf', accent: '#e11d48' },
  { key: 'amber', primary: '#d97706', accent: '#ca8a04' },
  { key: 'sky', primary: '#2563eb', accent: '#0ea5e9' },
  { key: 'slate', primary: '#475569', accent: '#2563eb' },
] as const;

export default function GenerateTab({ onDone }: { onDone?: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [paletteKey, setPaletteKey] = useState<(typeof PALETTES)[number]['key']>('royal');
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
      (
        await api.post('/academy/site/generate', {
          paletteKey,
          lang: i18n.language === 'en' ? 'en' : 'ar',
        })
      ).data as Job,
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
    job.data?.stage === 'copy'
      ? t('studio.generate.stageCopy')
      : job.data?.stage === 'assemble'
        ? t('studio.generate.stageAssemble')
        : t('studio.generate.working');

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
          <button
            className="btn-secondary"
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
          >
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
          {onDone && (
            <button className="btn-primary" onClick={onDone}>
              {t('studio.generate.previewBtn')}
            </button>
          )}
          <button className="btn-secondary" onClick={() => setJobId(null)}>
            {t('studio.generate.again')}
          </button>
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

      <span className="mb-2 block text-sm font-semibold text-on-surface-variant">
        {t('studio.generate.paletteLabel')}
      </span>
      <div className="mb-6 grid grid-cols-4 gap-3 sm:grid-cols-8">
        {PALETTES.map((p) => {
          const on = paletteKey === p.key;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => setPaletteKey(p.key)}
              aria-pressed={on}
              aria-label={t(`studio.generate.palettes.${p.key}`)}
              title={t(`studio.generate.palettes.${p.key}`)}
              className={`group flex flex-col items-center gap-1.5 rounded-xl border p-2 transition ${
                on
                  ? 'border-primary shadow-glow'
                  : 'border-outline-variant hover:-translate-y-0.5 hover:border-accent-300'
              }`}
            >
              <span
                className="h-10 w-full rounded-lg"
                style={{ background: `linear-gradient(135deg, ${p.primary}, ${p.accent})` }}
              />
              {on && (
                <span className="material-symbols-outlined text-[16px] text-primary">
                  check_circle
                </span>
              )}
            </button>
          );
        })}
      </div>

      {failed && (
        <div className="mb-4 rounded-xl border border-error/30 bg-error-container/30 p-3 text-sm text-error">
          <p className="font-bold">{t('studio.generate.failedTitle')}</p>
          <p className="mt-0.5">{job.data?.error ?? t('studio.generate.failedGeneric')}</p>
        </div>
      )}
      <ErrorNote error={generate.error && !is409 ? generate.error : null} />
      {is409 && <p className="mb-3 text-sm text-amber-600">{t('studio.generate.oneActive')}</p>}

      <button
        className="btn-primary"
        onClick={() => generate.mutate()}
        disabled={generate.isPending}
      >
        <span className="material-symbols-outlined text-[20px]">auto_awesome</span>
        {generate.isPending
          ? t('studio.generate.starting')
          : failed
            ? t('studio.generate.retryBtn')
            : t('studio.generate.generateBtn')}
      </button>
    </div>
  );
}
