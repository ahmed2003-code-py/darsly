import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
    id: string;
    academyId: string;
    status: string;
    stage: string | null;
    attempts: number;
    costCents: number;
    error: string | null;
    createdAt: string;
  }[];
}

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export default function AdminAcademyStudioPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'queue' | 'usage'>('queue');
  const TABS = [
    { key: 'queue', label: t('adminStudio.tabQueue'), icon: 'rate_review' },
    { key: 'usage', label: t('adminStudio.tabUsage'), icon: 'monitoring' },
  ] as const;
  return (
    <div className="page">
      <PageHeader title={t('adminStudio.title')} subtitle={t('adminStudio.subtitle')} />
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
      {tab === 'queue' ? <ModerationQueue /> : <UsageDashboard />}
    </div>
  );
}

function ModerationQueue() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery<QueueItem[]>({
    queryKey: ['admin-moderation-queue'],
    queryFn: async () => (await api.get('/admin/academy-studio/moderation-queue')).data,
  });
  const moderate = useMutation({
    mutationFn: async ({
      academyId,
      decision,
      reason,
    }: {
      academyId: string;
      decision: 'approve' | 'reject';
      reason?: string;
    }) =>
      (await api.post(`/admin/academy-studio/sites/${academyId}/moderate`, { decision, reason }))
        .data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-moderation-queue'] }),
  });

  if (q.isLoading) return <Spinner />;
  if (q.isError)
    return (
      <div className="card">
        <ErrorNote error={q.error} />
      </div>
    );
  if (!q.data?.length) {
    return (
      <div className="card grid place-items-center py-16 text-center">
        <span className="material-symbols-outlined text-4xl text-teal-500">task_alt</span>
        <p className="mt-2 font-bold">{t('adminStudio.emptyQueue')}</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <ErrorNote error={moderate.error} />
      {q.data.map((it) => (
        <QueueRow
          key={it.academyId}
          it={it}
          pending={moderate.isPending}
          onApprove={() => moderate.mutate({ academyId: it.academyId, decision: 'approve' })}
          onReject={() => {
            const reason = prompt(t('adminStudio.rejectPrompt')) ?? undefined;
            moderate.mutate({ academyId: it.academyId, decision: 'reject', reason });
          }}
        />
      ))}
    </div>
  );
}

function QueueRow({
  it,
  pending,
  onApprove,
  onReject,
}: {
  it: QueueItem;
  pending: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const preview = useQuery<string>({
    queryKey: ['admin-site-preview', it.academyId],
    queryFn: async () =>
      (
        await api.get(`/admin/academy-studio/sites/${it.academyId}/preview`, {
          responseType: 'text',
        })
      ).data,
    enabled: open,
    retry: false,
  });
  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-heading font-bold">{it.academyName}</p>
          <p className="text-sm text-on-surface-variant">
            /{it.slug} • {t('adminStudio.version', { n: it.version })} •{' '}
            {t('adminStudio.sentAt', { date: dateShort(it.submittedAt) })}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={() => setOpen((o) => !o)}>
            <span className="material-symbols-outlined text-[20px]">
              {open ? 'visibility_off' : 'visibility'}
            </span>
            {open ? t('adminStudio.hide') : t('adminStudio.preview')}
          </button>
          <button className="btn-primary" disabled={pending} onClick={onApprove}>
            <span className="material-symbols-outlined text-[20px]">check</span>
            {t('adminStudio.approve')}
          </button>
          <button className="btn-secondary" disabled={pending} onClick={onReject}>
            <span className="material-symbols-outlined text-[20px]">close</span>
            {t('adminStudio.reject')}
          </button>
        </div>
      </div>
      {open && (
        <div className="mt-4">
          {preview.isLoading ? (
            <Spinner />
          ) : preview.isError ? (
            <p className="text-sm text-error">{t('adminStudio.loadError')}</p>
          ) : (
            <iframe
              title={it.slug}
              srcDoc={preview.data}
              className="w-full rounded-xl border border-outline-variant bg-white"
              style={{ height: '70vh' }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function UsageDashboard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery<Usage>({
    queryKey: ['admin-ai-usage'],
    queryFn: async () => (await api.get('/admin/academy-studio/ai/usage')).data,
    refetchInterval: 15000,
  });
  const rerun = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/admin/academy-studio/ai/jobs/${id}/rerun`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-ai-usage'] }),
  });

  if (q.isLoading) return <Spinner />;
  if (q.isError)
    return (
      <div className="card">
        <ErrorNote error={q.error} />
      </div>
    );
  const u = q.data!;
  const pct =
    u.budgetCents > 0 ? Math.min(100, Math.round((u.spentCents / u.budgetCents) * 100)) : 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card">
          <p className="text-sm text-on-surface-variant">
            {t('adminStudio.spend', { month: u.month })}
          </p>
          <p className="font-heading text-3xl font-bold tabular-nums">{usd(u.spentCents)}</p>
          {u.budgetCents > 0 && (
            <>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-container-high">
                <div
                  className={`h-full ${pct >= 90 ? 'bg-error' : 'bg-primary'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-on-surface-variant">
                {t('adminStudio.ofBudget', {
                  budget: usd(u.budgetCents),
                  rem: usd(u.budgetRemainingCents ?? 0),
                })}
              </p>
            </>
          )}
        </div>
        <div className="card">
          <p className="text-sm text-on-surface-variant">{t('adminStudio.failed24')}</p>
          <p
            className={`font-heading text-3xl font-bold tabular-nums ${u.failedLast24h ? 'text-error' : ''}`}
          >
            {u.failedLast24h}
          </p>
        </div>
        <div className="card">
          <p className="mb-2 text-sm text-on-surface-variant">{t('adminStudio.byStatus')}</p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(u.byStatus).map(([s, n]) => (
              <Badge
                key={s}
                tone={s === 'FAILED' ? 'error' : s === 'SUCCEEDED' ? 'teal' : 'neutral'}
              >
                {t([`adminStudio.jobStatus.${s}`, s])}: {n}
              </Badge>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <h3 className="mb-3 font-heading font-bold">{t('adminStudio.recent')}</h3>
        <ErrorNote error={rerun.error} />
        {/* Five columns scan well on a desktop and not at all on a phone: the
            two that matter — what it cost and the button that retries it —
            are the ones that fall off the edge. So the phone gets the same
            facts stacked, and the table starts at `sm`. */}
        <ul className="divide-y divide-outline-variant sm:hidden">
          {u.recentJobs.map((j) => (
            <li key={j.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  tone={
                    j.status === 'FAILED' ? 'error' : j.status === 'SUCCEEDED' ? 'teal' : 'neutral'
                  }
                >
                  {t([`adminStudio.jobStatus.${j.status}`, j.status])}
                </Badge>
                <span className="text-sm text-on-surface-variant">{dateShort(j.createdAt)}</span>
              </div>
              {j.error && <JobError error={j.error} />}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-on-surface-variant">
                <span className="tabular-nums">
                  {t('adminStudio.attempts')}: {j.attempts}
                </span>
                <span className="tabular-nums" dir="ltr">
                  {usd(j.costCents)}
                </span>
                {j.status === 'FAILED' && <RerunButton id={j.id} rerun={rerun} />}
              </div>
            </li>
          ))}
        </ul>
        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-start text-on-surface-variant">
                <th className="whitespace-nowrap p-2 text-start">{t('adminStudio.date')}</th>
                <th className="whitespace-nowrap p-2 text-start">{t('adminStudio.statusH')}</th>
                <th className="whitespace-nowrap p-2 text-start">{t('adminStudio.attempts')}</th>
                <th className="whitespace-nowrap p-2 text-start">{t('adminStudio.cost')}</th>
                <th className="p-2 text-start"></th>
              </tr>
            </thead>
            <tbody>
              {u.recentJobs.map((j) => (
                <tr key={j.id} className="border-t border-outline-variant align-top">
                  <td className="whitespace-nowrap p-2">{dateShort(j.createdAt)}</td>
                  <td className="p-2">
                    <Badge
                      tone={
                        j.status === 'FAILED'
                          ? 'error'
                          : j.status === 'SUCCEEDED'
                            ? 'teal'
                            : 'neutral'
                      }
                    >
                      {t([`adminStudio.jobStatus.${j.status}`, j.status])}
                    </Badge>
                    {/* On its own line: an English failure reason set beside an
                        Arabic badge wraps into the next column and reads as
                        neither language. */}
                    {j.error && <JobError error={j.error} />}
                  </td>
                  <td className="whitespace-nowrap p-2 tabular-nums">{j.attempts}</td>
                  {/* A dollar amount is Latin script inside an RTL row; without
                      an explicit direction the "$" drifts and the number clips. */}
                  <td
                    className="whitespace-nowrap p-2 tabular-nums"
                    dir="ltr"
                    style={{ textAlign: 'start' }}
                  >
                    {usd(j.costCents)}
                  </td>
                  <td className="p-2">
                    {j.status === 'FAILED' && <RerunButton id={j.id} rerun={rerun} />}
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

/** Shared by the phone list and the table so a retry behaves the same in both. */
function RerunButton({
  id,
  rerun,
}: {
  id: string;
  rerun: { mutate: (id: string) => void; isPending: boolean };
}) {
  const { t } = useTranslation();
  return (
    <button
      className="whitespace-nowrap text-sm font-bold text-primary hover:underline"
      disabled={rerun.isPending}
      onClick={() => rerun.mutate(id)}
    >
      {t('adminStudio.rerun')}
    </button>
  );
}

/**
 * Why a generation failed, in the reader's language where we know it.
 *
 * The generator's terminal errors are a closed set; the retryable ones carry a
 * validation detail appended to them and are matched by prefix. Anything
 * unrecognised still renders — left-to-right so an English sentence reads as
 * one rather than wrapping backwards out of an Arabic cell.
 */
const JOB_ERROR_KEY: Record<string, string> = {
  'Not enough profile facts to generate a site': 'noFacts',
  'No profile facts to regenerate from': 'noFacts',
  'Academy not found': 'academyMissing',
  'AI feature is disabled (AI_ACADEMY_ENABLED)': 'disabled',
  'OPENAI_API_KEY is not configured': 'noKey',
  'AI returned empty output': 'emptyOutput',
  'AI response was truncated (token budget)': 'truncated',
  'Structured output was not valid JSON': 'badJson',
  'There is no draft to edit': 'noDraft',
  'Current draft is no longer valid': 'draftInvalid',
  'Section not found in the current draft': 'sectionMissing',
  'This section cannot be regenerated': 'sectionLocked',
};
const JOB_ERROR_PREFIX: [string, string][] = [
  ['AI output failed validation', 'validation'],
  ['AI composition failed validation', 'validation'],
  ['AI plan failed validation', 'validation'],
  ['Assembled document invalid', 'validation'],
  ['Regenerated section invalid', 'validation'],
  ['AI refused the request', 'refused'],
];

function JobError({ error }: { error: string }) {
  const { t } = useTranslation();
  const trimmed = error.trim();
  // The upstream failure is the one an admin actually acts on, and the action
  // depends entirely on the status: 429 means wait, 5xx means their outage,
  // anything else means our request was wrong. So the sentence is translated
  // but the code is kept rather than flattened into "something went wrong".
  const upstream = /^OpenAI request failed(?: \((\d{3})\))?/.exec(trimmed);
  if (upstream) {
    const status = Number(upstream[1] ?? 0);
    const kind = status === 429 ? 'rate' : status >= 500 ? 'down' : 'request';
    return (
      <p className="mt-1 text-xs leading-relaxed text-error">
        {t(`adminStudio.jobError.upstream.${kind}`, { status: upstream[1] ?? '—' })}
      </p>
    );
  }
  const exact = JOB_ERROR_KEY[trimmed];
  const prefixed = exact ? null : JOB_ERROR_PREFIX.find(([p]) => trimmed.startsWith(p))?.[1];
  const key = exact ?? prefixed;
  if (key)
    return (
      <p className="mt-1 text-xs leading-relaxed text-error">{t(`adminStudio.jobError.${key}`)}</p>
    );
  return (
    <p className="mt-1 text-xs leading-relaxed text-error" dir="ltr" style={{ textAlign: 'start' }}>
      {error}
    </p>
  );
}
