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

const VIBES = [
  { key: 'trusted', icon: 'volunteer_activism' },
  { key: 'academic', icon: 'school' },
  { key: 'premium', icon: 'diamond' },
  { key: 'energetic', icon: 'bolt' },
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
        {VIBES.map((v) => (
          <button key={v.key} type="button" onClick={() => setVibe(v.key)}
            className={`flex items-start gap-3 rounded-2xl border p-4 text-start transition ${
              vibe === v.key ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant hover:bg-surface-container-low'
            }`}>
            <span className={`material-symbols-outlined ${vibe === v.key ? 'text-primary' : 'text-on-surface-variant'}`}>{v.icon}</span>
            <span>
              <span className="block font-heading font-bold">{t(`studio.generate.vibes.${v.key}`)}</span>
              <span className="block text-sm text-on-surface-variant">{t(`studio.generate.vibes.${v.key}D`)}</span>
            </span>
          </button>
        ))}
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
