import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';
import { dateShort } from '../../lib/format';
import { Badge, ErrorNote, PageHeader, Spinner } from '../../components/ui';

interface QueueItem {
  academyId: string;
  academyName: string;
  slug: string;
  version: number;
  submittedAt: string;
}
interface Usage {
  enabled: boolean;
  month: string;
  spentCents: number;
  budgetCents: number;
  budgetRemainingCents: number | null;
  byStatus: Record<string, number>;
  failedLast24h: number;
  recentJobs: {
    id: string; academyId: string; status: string; stage: string | null;
    attempts: number; costCents: number; error: string | null; createdAt: string;
  }[];
}

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const TABS = [
  { key: 'queue', label: 'قائمة المراجعة', icon: 'rate_review' },
  { key: 'usage', label: 'استهلاك الذكاء الاصطناعي', icon: 'monitoring' },
] as const;

export default function AdminAcademyStudioPage() {
  const [tab, setTab] = useState<'queue' | 'usage'>('queue');
  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title="استوديو الأكاديميات" subtitle="مراجعة الصفحات المُولّدة ومتابعة استهلاك الذكاء الاصطناعي." />
      <div className="mb-6 flex flex-wrap gap-2">
        {TABS.map((tb) => (
          <button key={tb.key} onClick={() => setTab(tb.key)}
            className={`flex items-center gap-2 rounded-full px-5 py-2 font-heading text-sm font-semibold transition-colors ${
              tab === tb.key ? 'bg-primary text-on-primary' : 'border border-outline-variant text-on-surface-variant hover:bg-surface-container-low'
            }`}>
            <span className="material-symbols-outlined text-[20px]">{tb.icon}</span>
            {tb.label}
          </button>
        ))}
      </div>
      {tab === 'queue' ? <ModerationQueue /> : <UsageDashboard />}
    </div>
  );
}

function ModerationQueue() {
  const qc = useQueryClient();
  const q = useQuery<QueueItem[]>({
    queryKey: ['admin-moderation-queue'],
    queryFn: async () => (await api.get('/admin/academy-studio/moderation-queue')).data,
  });
  const moderate = useMutation({
    mutationFn: async ({ academyId, decision, reason }: { academyId: string; decision: 'approve' | 'reject'; reason?: string }) =>
      (await api.post(`/admin/academy-studio/sites/${academyId}/moderate`, { decision, reason })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-moderation-queue'] }),
  });

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <div className="card"><ErrorNote error={q.error} /></div>;
  if (!q.data?.length) {
    return (
      <div className="card grid place-items-center py-16 text-center">
        <span className="material-symbols-outlined text-4xl text-teal-500">task_alt</span>
        <p className="mt-2 font-bold">لا توجد صفحات بانتظار المراجعة</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <ErrorNote error={moderate.error} />
      {q.data.map((it) => (
        <QueueRow key={it.academyId} it={it} pending={moderate.isPending}
          onApprove={() => moderate.mutate({ academyId: it.academyId, decision: 'approve' })}
          onReject={() => {
            const reason = prompt('سبب الرفض (اختياري):') ?? undefined;
            moderate.mutate({ academyId: it.academyId, decision: 'reject', reason });
          }} />
      ))}
    </div>
  );
}

function QueueRow({ it, pending, onApprove, onReject }: {
  it: QueueItem; pending: boolean; onApprove: () => void; onReject: () => void;
}) {
  const [open, setOpen] = useState(false);
  const preview = useQuery<string>({
    queryKey: ['admin-site-preview', it.academyId],
    queryFn: async () => (await api.get(`/admin/academy-studio/sites/${it.academyId}/preview`, { responseType: 'text' })).data,
    enabled: open,
    retry: false,
  });
  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-heading font-bold">{it.academyName}</p>
          <p className="text-sm text-on-surface-variant">/{it.slug} • نسخة {it.version} • أُرسلت {dateShort(it.submittedAt)}</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={() => setOpen((o) => !o)}>
            <span className="material-symbols-outlined text-[20px]">{open ? 'visibility_off' : 'visibility'}</span>
            {open ? 'إخفاء' : 'معاينة'}
          </button>
          <button className="btn-primary" disabled={pending} onClick={onApprove}>
            <span className="material-symbols-outlined text-[20px]">check</span>موافقة ونشر
          </button>
          <button className="btn-secondary" disabled={pending} onClick={onReject}>
            <span className="material-symbols-outlined text-[20px]">close</span>رفض
          </button>
        </div>
      </div>
      {open && (
        <div className="mt-4">
          {preview.isLoading ? <Spinner /> : preview.isError ? (
            <p className="text-sm text-error">تعذّر تحميل المعاينة.</p>
          ) : (
            <iframe title={`معاينة ${it.slug}`} srcDoc={preview.data}
              className="w-full rounded-xl border border-outline-variant bg-white" style={{ height: '70vh' }} />
          )}
        </div>
      )}
    </div>
  );
}

function UsageDashboard() {
  const qc = useQueryClient();
  const q = useQuery<Usage>({
    queryKey: ['admin-ai-usage'],
    queryFn: async () => (await api.get('/admin/academy-studio/ai/usage')).data,
    refetchInterval: 15000,
  });
  const rerun = useMutation({
    mutationFn: async (id: string) => (await api.post(`/admin/academy-studio/ai/jobs/${id}/rerun`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-ai-usage'] }),
  });

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <div className="card"><ErrorNote error={q.error} /></div>;
  const u = q.data!;
  const pct = u.budgetCents > 0 ? Math.min(100, Math.round((u.spentCents / u.budgetCents) * 100)) : 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card">
          <p className="text-sm text-on-surface-variant">الإنفاق هذا الشهر ({u.month})</p>
          <p className="font-heading text-3xl font-bold tabular-nums">{usd(u.spentCents)}</p>
          {u.budgetCents > 0 && (
            <>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-container-high">
                <div className={`h-full ${pct >= 90 ? 'bg-error' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
              </div>
              <p className="mt-1 text-xs text-on-surface-variant">
                من ميزانية {usd(u.budgetCents)} • متبقٍّ {usd(u.budgetRemainingCents ?? 0)}
              </p>
            </>
          )}
        </div>
        <div className="card">
          <p className="text-sm text-on-surface-variant">فشل آخر 24 ساعة</p>
          <p className={`font-heading text-3xl font-bold tabular-nums ${u.failedLast24h ? 'text-error' : ''}`}>{u.failedLast24h}</p>
        </div>
        <div className="card">
          <p className="mb-2 text-sm text-on-surface-variant">حالة المهام</p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(u.byStatus).map(([s, n]) => (
              <Badge key={s} tone={s === 'FAILED' ? 'error' : s === 'SUCCEEDED' ? 'teal' : 'neutral'}>{s}: {n}</Badge>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <h3 className="mb-3 font-heading font-bold">أحدث المهام</h3>
        <ErrorNote error={rerun.error} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-start text-on-surface-variant">
                <th className="p-2 text-start">التاريخ</th>
                <th className="p-2 text-start">الحالة</th>
                <th className="p-2 text-start">المحاولات</th>
                <th className="p-2 text-start">التكلفة</th>
                <th className="p-2 text-start"></th>
              </tr>
            </thead>
            <tbody>
              {u.recentJobs.map((j) => (
                <tr key={j.id} className="border-t border-outline-variant">
                  <td className="p-2 whitespace-nowrap">{dateShort(j.createdAt)}</td>
                  <td className="p-2">
                    <Badge tone={j.status === 'FAILED' ? 'error' : j.status === 'SUCCEEDED' ? 'teal' : 'neutral'}>{j.status}</Badge>
                    {j.error && <span className="ms-2 text-xs text-error">{j.error}</span>}
                  </td>
                  <td className="p-2 tabular-nums">{j.attempts}</td>
                  <td className="p-2 tabular-nums">{usd(j.costCents)}</td>
                  <td className="p-2">
                    {j.status === 'FAILED' && (
                      <button className="text-sm font-bold text-primary hover:underline" disabled={rerun.isPending}
                        onClick={() => rerun.mutate(j.id)}>إعادة تشغيل</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
