import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AxiosError } from 'axios';
import { api } from '../../lib/api';
import { useOwnedAcademy } from '../../lib/academy';
import { Badge, PageHeader, Spinner } from '../../components/ui';
import FactsForm from './studio/FactsForm';
import MediaManager from './studio/MediaManager';
import type { SiteOverview, SiteStatus } from './studio/types';

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

const TABS = [
  { key: 'facts', label: 'البيانات', icon: 'badge' },
  { key: 'media', label: 'الصور', icon: 'image' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function isFeatureDisabled(err: unknown): boolean {
  return (err as AxiosError)?.response?.status === 404;
}

export default function AcademyStudioPage() {
  const { academy, isLoading } = useOwnedAcademy();
  const [tab, setTab] = useState<TabKey>('facts');

  const overview = useQuery<SiteOverview>({
    queryKey: ['studio-overview'],
    queryFn: async () => (await api.get('/academy/site')).data,
    retry: false,
  });

  if (isLoading) return <div className="mx-auto max-w-container px-6 py-8"><Spinner /></div>;
  if (!academy) {
    return (
      <div className="mx-auto max-w-container px-6 py-8">
        <PageHeader title="استوديو الأكاديمية" subtitle="لا توجد أكاديمية مملوكة لحسابك بعد." />
      </div>
    );
  }
  if (overview.isError && isFeatureDisabled(overview.error)) {
    return (
      <div className="mx-auto max-w-container px-6 py-8">
        <PageHeader title="استوديو الأكاديمية" subtitle="توليد صفحة أكاديميتك بالذكاء الاصطناعي." />
        <div className="card border border-amber-200 bg-amber-50 text-amber-900">
          <p className="font-bold">الميزة غير مُفعّلة بعد</p>
          <p className="mt-1 text-sm">
            استوديو الأكاديمية متوقّف حاليًا. لتفعيله، اضبط <code className="rounded bg-amber-100 px-1">AI_ACADEMY_ENABLED=true</code>{' '}
            و <code className="rounded bg-amber-100 px-1">OPENAI_API_KEY</code> في بيئة الخادم.
          </p>
        </div>
      </div>
    );
  }

  const ov = overview.data;
  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader
        title="استوديو الأكاديمية"
        subtitle="اكتب بياناتك، ودع الذكاء الاصطناعي يبني صفحة أكاديميتك."
        action={
          ov?.status === 'PUBLISHED' ? (
            <Link to={`/a/${academy.slug}`} target="_blank" className="btn-secondary">
              <span className="material-symbols-outlined text-[20px]">open_in_new</span>
              عرض الصفحة المنشورة
            </Link>
          ) : undefined
        }
      />

      {ov && (
        <div className="card mb-6 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-on-surface-variant">حالة الصفحة:</span>
            <Badge tone={STATUS_TONE[ov.status]}>{STATUS_LABEL[ov.status]}</Badge>
          </div>
          {ov.hasDraft && <span className="text-sm text-on-surface-variant">• يوجد مسودة (نسخة {ov.version})</span>}
          {ov.status === 'REJECTED' && ov.moderationReason && (
            <span className="text-sm text-error">• سبب الرفض: {ov.moderationReason}</span>
          )}
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-2">
        {TABS.map((tb) => (
          <button
            key={tb.key}
            onClick={() => setTab(tb.key)}
            className={`flex items-center gap-2 rounded-full px-5 py-2 font-heading text-sm font-semibold transition-colors ${
              tab === tb.key
                ? 'bg-primary text-on-primary'
                : 'border border-outline-variant text-on-surface-variant hover:bg-surface-container-low'
            }`}
          >
            <span className="material-symbols-outlined text-[20px]">{tb.icon}</span>
            {tb.label}
          </button>
        ))}
      </div>

      {tab === 'facts' && <FactsForm />}
      {tab === 'media' && <MediaManager />}
    </div>
  );
}
