import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../lib/api';
import { dateShort } from '../../../lib/format';
import { Badge, ErrorNote, Spinner } from '../../../components/ui';
import type { SiteOverview, SiteStatus } from './types';

interface Snapshot {
  id: string;
  version: number;
  reason: string | null;
  createdAt: string;
}

const STATUS_LABEL: Record<SiteStatus, string> = {
  DRAFT: 'مسودة',
  PENDING_MODERATION: 'قيد المراجعة',
  PUBLISHED: 'منشورة',
  REJECTED: 'مرفوضة',
};
const STATUS_TONE: Record<SiteStatus, 'primary' | 'teal' | 'warn' | 'error' | 'neutral'> = {
  DRAFT: 'neutral',
  PENDING_MODERATION: 'warn',
  PUBLISHED: 'teal',
  REJECTED: 'error',
};
const STATUS_HINT: Record<SiteStatus, string> = {
  DRAFT: 'صفحتك جاهزة كمسودة. انشرها لتظهر للطلاب.',
  PENDING_MODERATION: 'صفحتك قيد المراجعة من الإدارة. ستظهر بمجرد الموافقة.',
  PUBLISHED: 'صفحتك منشورة ومتاحة للجمهور.',
  REJECTED: 'تم رفض النشر. عدّل المحتوى وأعد المحاولة.',
};
const REASON_LABEL: Record<string, string> = {
  generate: 'توليد بالذكاء الاصطناعي',
  'manual-save': 'تعديل يدوي',
  rollback: 'استرجاع نسخة',
};

export default function PublishTab({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const overview = useQuery<SiteOverview>({
    queryKey: ['studio-overview'],
    queryFn: async () => (await api.get('/academy/site')).data,
    retry: false,
  });
  const snapshots = useQuery<Snapshot[]>({
    queryKey: ['studio-snapshots'],
    queryFn: async () => (await api.get('/academy/site/snapshots')).data,
    retry: false,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['studio-overview'] });
    qc.invalidateQueries({ queryKey: ['studio-snapshots'] });
    qc.invalidateQueries({ queryKey: ['studio-preview'] });
    qc.invalidateQueries({ queryKey: ['studio-draft'] });
  };

  const publish = useMutation({
    mutationFn: async () => (await api.post('/academy/site/publish')).data,
    onSuccess: refresh,
  });
  const unpublish = useMutation({
    mutationFn: async () => (await api.post('/academy/site/unpublish')).data,
    onSuccess: refresh,
  });
  const rollback = useMutation({
    mutationFn: async (snapshotId: string) => (await api.post('/academy/site/rollback', { snapshotId })).data,
    onSuccess: refresh,
  });
  const removeSnap = useMutation({
    mutationFn: async (snapshotId: string) => (await api.delete(`/academy/site/snapshots/${snapshotId}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['studio-snapshots'] }),
  });

  if (overview.isLoading) return <Spinner />;
  const ov = overview.data;
  const status = ov?.status ?? 'DRAFT';

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="font-heading text-xl font-bold">النشر</h2>
          <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
          {ov?.hasDraft && <span className="text-sm text-on-surface-variant">مسودة نسخة {ov.version}</span>}
        </div>
        <p className="mb-4 text-sm text-on-surface-variant">{STATUS_HINT[status]}</p>
        {status === 'REJECTED' && ov?.moderationReason && (
          <p className="mb-4 text-sm text-error">سبب الرفض: {ov.moderationReason}</p>
        )}

        <ErrorNote error={publish.error || unpublish.error} />

        <div className="flex flex-wrap gap-2">
          {status !== 'PUBLISHED' && (
            <button className="btn-primary" onClick={() => publish.mutate()} disabled={publish.isPending || !ov?.hasDraft}>
              <span className="material-symbols-outlined text-[20px]">publish</span>
              {publish.isPending ? 'جارٍ النشر…' : status === 'PENDING_MODERATION' ? 'إعادة الإرسال' : 'نشر الصفحة'}
            </button>
          )}
          {status === 'PUBLISHED' && (
            <>
              <Link to={`/a/${slug}`} target="_blank" className="btn-secondary">
                <span className="material-symbols-outlined text-[20px]">open_in_new</span>
                عرض الصفحة
              </Link>
              <button className="btn-secondary" onClick={() => unpublish.mutate()} disabled={unpublish.isPending}>
                <span className="material-symbols-outlined text-[20px]">visibility_off</span>
                {unpublish.isPending ? '…' : 'إلغاء النشر'}
              </button>
            </>
          )}
        </div>
        {publish.isSuccess && status === 'PENDING_MODERATION' && (
          <p className="mt-3 text-sm text-amber-600">تم الإرسال للمراجعة. ستظهر الصفحة بعد الموافقة.</p>
        )}
      </div>

      <div className="card">
        <h3 className="mb-3 font-heading font-bold">سجل النسخ</h3>
        <ErrorNote error={rollback.error || removeSnap.error} />
        {snapshots.isLoading ? (
          <Spinner />
        ) : !snapshots.data?.length ? (
          <p className="text-sm text-on-surface-variant">لا توجد نسخ محفوظة بعد.</p>
        ) : (
          <div className="divide-y divide-outline-variant">
            {snapshots.data.map((s, idx) => (
              <SnapshotRow
                key={s.id}
                s={s}
                isCurrent={idx === 0}
                rolling={rollback.isPending}
                deleting={removeSnap.isPending}
                onRollback={() => {
                  if (confirm(`استرجاع النسخة ${s.version}؟ سيحل محتواها محل المسودة الحالية.`)) rollback.mutate(s.id);
                }}
                onDelete={() => { if (confirm(`حذف النسخة ${s.version} من السجل؟`)) removeSnap.mutate(s.id); }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SnapshotRow({ s, isCurrent, rolling, deleting, onRollback, onDelete }: {
  s: Snapshot; isCurrent: boolean; rolling: boolean; deleting: boolean; onRollback: () => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const preview = useQuery<string>({
    queryKey: ['snap-preview', s.id],
    queryFn: async () => (await api.get(`/academy/site/snapshots/${s.id}/preview`, { responseType: 'text' })).data,
    enabled: open,
    retry: false,
  });
  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-semibold">
            نسخة {s.version}
            {isCurrent && <span className="ms-2 text-xs font-bold text-teal-600">(الحالية)</span>}
          </p>
          <p className="text-sm text-on-surface-variant">
            {REASON_LABEL[s.reason ?? ''] ?? s.reason ?? '—'} • {dateShort(s.createdAt)}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={() => setOpen((o) => !o)}>
            <span className="material-symbols-outlined text-[18px]">{open ? 'visibility_off' : 'visibility'}</span>
            {open ? 'إخفاء' : 'معاينة'}
          </button>
          {!isCurrent && (
            <button className="btn-secondary" disabled={rolling} onClick={onRollback}>
              <span className="material-symbols-outlined text-[18px]">history</span>
              استرجاع
            </button>
          )}
          {!isCurrent && (
            <button
              className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-error transition hover:bg-error-container/40"
              aria-label="حذف" disabled={deleting} onClick={onDelete}
            >
              <span className="material-symbols-outlined text-[20px]">delete</span>
            </button>
          )}
        </div>
      </div>
      {open && (
        <div className="mt-3">
          {preview.isLoading ? (
            <Spinner />
          ) : preview.isError ? (
            <p className="text-sm text-error">تعذّر تحميل المعاينة.</p>
          ) : (
            <iframe title={`نسخة ${s.version}`} srcDoc={preview.data}
              className="w-full rounded-xl border border-outline-variant bg-white" style={{ height: '60vh' }} />
          )}
        </div>
      )}
    </div>
  );
}
