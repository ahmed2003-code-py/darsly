import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AxiosError } from 'axios';
import { api } from '../../../lib/api';
import { Spinner } from '../../../components/ui';

export default function PreviewTab() {
  const { t } = useTranslation();
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const { data: html, isLoading, isError, error, refetch, isFetching } = useQuery<string>({
    queryKey: ['studio-preview'],
    queryFn: async () => (await api.get('/academy/site/preview', { responseType: 'text' })).data,
    retry: false,
  });

  const noDraft = (error as AxiosError)?.response?.status === 400;

  return (
    <div className="card">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-xl font-bold">{t('studio.preview.title')}</h2>
        <div className="flex items-center gap-2">
          <div className="flex rounded-full border border-outline-variant p-0.5">
            {(['desktop', 'mobile'] as const).map((d) => (
              <button key={d} onClick={() => setDevice(d)}
                className={`grid h-8 w-9 place-items-center rounded-full transition ${
                  device === d ? 'bg-primary text-on-primary' : 'text-on-surface-variant'
                }`} aria-label={d}>
                <span className="material-symbols-outlined text-[18px]">{d === 'desktop' ? 'desktop_windows' : 'smartphone'}</span>
              </button>
            ))}
          </div>
          <button className="btn-secondary" onClick={() => refetch()} disabled={isFetching}>
            <span className="material-symbols-outlined text-[18px]">refresh</span>
            {t('studio.preview.refresh')}
          </button>
        </div>
      </div>

      {isLoading ? (
        <Spinner />
      ) : noDraft ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-outline-variant py-16 text-center">
          <span className="material-symbols-outlined text-4xl text-on-surface-variant">draft</span>
          <p className="mt-2 font-bold">{t('studio.preview.noDraft')}</p>
          <p className="text-sm text-on-surface-variant">{t('studio.preview.noDraftHint')}</p>
        </div>
      ) : isError ? (
        <p className="text-sm text-error">{t('studio.preview.loadError')}</p>
      ) : (
        <div className="flex justify-center">
          <iframe title={t('studio.preview.title')} srcDoc={html}
            className="rounded-2xl border border-outline-variant bg-white transition-all"
            style={{ width: device === 'mobile' ? 390 : '100%', height: '72vh' }} />
        </div>
      )}
    </div>
  );
}
