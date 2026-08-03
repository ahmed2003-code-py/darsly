import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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

const STATUS_TONE: Record<SiteStatus, 'primary' | 'teal' | 'warn' | 'error' | 'neutral'> = {
  DRAFT: 'neutral',
  PENDING_MODERATION: 'warn',
  PUBLISHED: 'teal',
  REJECTED: 'error',
};

const STATUS_ICON: Record<SiteStatus, string> = {
  DRAFT: 'draft',
  PENDING_MODERATION: 'hourglass_top',
  PUBLISHED: 'public',
  REJECTED: 'block',
};

// Static classes (Tailwind JIT can't see interpolated names).
const STATUS_CIRCLE: Record<SiteStatus, string> = {
  DRAFT: 'bg-surface-container-high text-on-surface-variant',
  PENDING_MODERATION: 'bg-amber-50 text-amber-700',
  PUBLISHED: 'bg-primary-fixed text-on-primary-fixed-variant',
  REJECTED: 'bg-error-container text-on-error-container',
};

export default function PublishTab({ slug }: { slug: string }) {
  const { t } = useTranslation();
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

  const publish = useMutation({ mutationFn: async () => (await api.post('/academy/site/publish')).data, onSuccess: refresh });
  const unpublish = useMutation({ mutationFn: async () => (await api.post('/academy/site/unpublish')).data, onSuccess: refresh });
  const publishSnap = useMutation({
    mutationFn: async (snapshotId: string) => (await api.post(`/academy/site/snapshots/${snapshotId}/publish`)).data,
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
  const isPublished = status === 'PUBLISHED';
  const canPublish = !!ov?.hasDraft;
  const primaryLabel = isPublished
    ? t('studio.publish.updateLive')
    : status === 'PENDING_MODERATION'
      ? t('studio.publish.resubmit')
      : t('studio.publish.publishBtn');

  return (
    <div className="space-y-6">
      {/* Status hero */}
      <div className="card">
        <div className="flex flex-wrap items-start gap-4">
          <div className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${STATUS_CIRCLE[status]}`}>
            <span className="material-symbols-outlined">{STATUS_ICON[status]}</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-3">
              <h2 className="font-heading text-xl font-bold">{t('studio.publish.title')}</h2>
              <Badge tone={STATUS_TONE[status]}>{t(`studio.status.${status}`)}</Badge>
              {ov?.hasDraft && <span className="text-sm text-on-surface-variant">{t('studio.publish.draftV', { v: ov.version })}</span>}
            </div>
            <p className="text-sm text-on-surface-variant">{t(`studio.publish.hints.${status}`)}</p>

            {isPublished && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-on-surface-variant">{t('studio.publish.liveAt')}:</span>
                <Link to={`/a/${slug}`} target="_blank"
                  className="inline-flex items-center gap-1 rounded-lg bg-surface-container px-2.5 py-1 font-mono text-xs font-semibold text-primary hover:underline">
                  /a/{slug}<span className="material-symbols-outlined text-[14px]">open_in_new</span>
                </Link>
                {ov?.publishedAt && <span className="text-on-surface-variant">· {dateShort(ov.publishedAt)}</span>}
              </div>
            )}
            {isPublished && <p className="mt-2 text-xs text-on-surface-variant">{t('studio.publish.hasNewerDraft')}</p>}
            {status === 'REJECTED' && ov?.moderationReason && (
              <p className="mt-3 text-sm text-error">{t('studio.publish.reason', { reason: ov.moderationReason })}</p>
            )}
          </div>
        </div>

        <ErrorNote error={publish.error || unpublish.error} />

        <div className="mt-4 flex flex-wrap gap-2">
          {canPublish && (
            <button className="btn-primary" onClick={() => publish.mutate()} disabled={publish.isPending}>
              <span className="material-symbols-outlined text-[20px]">{isPublished ? 'sync' : 'publish'}</span>
              {publish.isPending ? t('studio.publish.publishing') : primaryLabel}
            </button>
          )}
          {isPublished && (
            <>
              <Link to={`/a/${slug}`} target="_blank" className="btn-secondary">
                <span className="material-symbols-outlined text-[20px]">open_in_new</span>
                {t('studio.publish.viewPage')}
              </Link>
              <button className="btn-secondary" onClick={() => unpublish.mutate()} disabled={unpublish.isPending}>
                <span className="material-symbols-outlined text-[20px]">visibility_off</span>
                {t('studio.publish.unpublish')}
              </button>
            </>
          )}
        </div>
        {publish.isSuccess && status === 'PENDING_MODERATION' && (
          <p className="mt-3 text-sm text-amber-600">{t('studio.publish.pendingMsg')}</p>
        )}
      </div>

      {/* Version history */}
      <div className="card">
        <h3 className="mb-1 font-heading font-bold">{t('studio.publish.history')}</h3>
        <ErrorNote error={rollback.error || removeSnap.error || publishSnap.error} />
        {snapshots.isLoading ? (
          <Spinner />
        ) : !snapshots.data?.length ? (
          <p className="text-sm text-on-surface-variant">{t('studio.publish.noVersions')}</p>
        ) : (
          <div className="mt-2 divide-y divide-outline-variant">
            {snapshots.data.map((s, idx) => (
              <SnapshotRow key={s.id} s={s} isCurrent={idx === 0}
                rolling={rollback.isPending} deleting={removeSnap.isPending}
                publishing={publishSnap.isPending && publishSnap.variables === s.id}
                onPublish={() => { if (confirm(t('studio.publish.confirmPublish', { n: s.version }))) publishSnap.mutate(s.id); }}
                onRollback={() => { if (confirm(t('studio.publish.confirmRestore', { n: s.version }))) rollback.mutate(s.id); }}
                onDelete={() => { if (confirm(t('studio.publish.confirmDelete', { n: s.version }))) removeSnap.mutate(s.id); }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SnapshotRow({ s, isCurrent, rolling, deleting, publishing, onPublish, onRollback, onDelete }: {
  s: Snapshot; isCurrent: boolean; rolling: boolean; deleting: boolean; publishing: boolean;
  onPublish: () => void; onRollback: () => void; onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const preview = useQuery<string>({
    queryKey: ['snap-preview', s.id],
    queryFn: async () => (await api.get(`/academy/site/snapshots/${s.id}/preview`, { responseType: 'text' })).data,
    enabled: open,
    retry: false,
  });
  const reason = s.reason ? t(`studio.publish.reasons.${s.reason}`, { defaultValue: s.reason }) : '—';
  return (
    <div className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-semibold">
            {t('studio.publish.version', { n: s.version })}
            {isCurrent && <span className="ms-2 text-xs font-bold text-teal-600">{t('studio.publish.current')}</span>}
          </p>
          <p className="text-sm text-on-surface-variant">{reason} • {dateShort(s.createdAt)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" onClick={() => setOpen((o) => !o)}>
            <span className="material-symbols-outlined text-[18px]">{open ? 'visibility_off' : 'visibility'}</span>
            {open ? t('studio.publish.hide') : t('studio.publish.preview')}
          </button>
          <button className="btn-primary" disabled={publishing} onClick={onPublish}>
            <span className="material-symbols-outlined text-[18px]">publish</span>
            {publishing ? t('studio.publish.publishing') : t('studio.publish.publishThis')}
          </button>
          {!isCurrent && (
            <button className="btn-secondary" disabled={rolling} onClick={onRollback}>
              <span className="material-symbols-outlined text-[18px]">history</span>
              {t('studio.publish.restore')}
            </button>
          )}
          {!isCurrent && (
            <button className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-error transition hover:bg-error-container/40"
              aria-label={t('studio.publish.delete')} disabled={deleting} onClick={onDelete}>
              <span className="material-symbols-outlined text-[20px]">delete</span>
            </button>
          )}
        </div>
      </div>
      {open && (
        <div className="mt-3">
          {preview.isLoading ? <Spinner /> : preview.isError ? (
            <p className="text-sm text-error">{t('studio.preview.loadError')}</p>
          ) : (
            <iframe title={t('studio.publish.version', { n: s.version })} srcDoc={preview.data}
              className="w-full rounded-xl border border-outline-variant bg-white" style={{ height: '60vh' }} />
          )}
        </div>
      )}
    </div>
  );
}
