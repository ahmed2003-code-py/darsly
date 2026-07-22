import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AxiosError } from 'axios';
import { api } from '../../../lib/api';
import { Spinner } from '../../../components/ui';

export default function PreviewTab() {
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const { data: html, isLoading, isError, error, refetch, isFetching } = useQuery<string>({
    queryKey: ['studio-preview'],
    // responseType text: the endpoint returns raw HTML, not JSON.
    queryFn: async () => (await api.get('/academy/site/preview', { responseType: 'text' })).data,
    retry: false,
  });

  const noDraft = (error as AxiosError)?.response?.status === 400;

  return (
    <div className="card">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-xl font-bold">معاينة الصفحة</h2>
        <div className="flex items-center gap-2">
          <div className="flex rounded-full border border-outline-variant p-0.5">
            {(['desktop', 'mobile'] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDevice(d)}
                className={`grid h-8 w-9 place-items-center rounded-full transition ${
                  device === d ? 'bg-primary text-on-primary' : 'text-on-surface-variant'
                }`}
                aria-label={d}
              >
                <span className="material-symbols-outlined text-[18px]">
                  {d === 'desktop' ? 'desktop_windows' : 'smartphone'}
                </span>
              </button>
            ))}
          </div>
          <button className="btn-secondary" onClick={() => refetch()} disabled={isFetching}>
            <span className="material-symbols-outlined text-[18px]">refresh</span>
            تحديث
          </button>
        </div>
      </div>

      {isLoading ? (
        <Spinner />
      ) : noDraft ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-outline-variant py-16 text-center">
          <span className="material-symbols-outlined text-4xl text-on-surface-variant">draft</span>
          <p className="mt-2 font-bold">لا توجد صفحة للمعاينة بعد</p>
          <p className="text-sm text-on-surface-variant">اذهب إلى تبويب «التوليد» وأنشئ صفحتك أولًا.</p>
        </div>
      ) : isError ? (
        <p className="text-sm text-error">تعذّر تحميل المعاينة.</p>
      ) : (
        <div className="flex justify-center">
          <iframe
            title="معاينة"
            srcDoc={html}
            className="rounded-2xl border border-outline-variant bg-white transition-all"
            style={{ width: device === 'mobile' ? 390 : '100%', height: '72vh' }}
          />
        </div>
      )}
    </div>
  );
}
