import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { dateShort, egp } from '../../lib/format';
import { Badge, EmptyState, ErrorNote, Spinner } from '../../components/ui';

const TABS = ['PENDING_APPROVAL', 'ACTIVE', 'ALL'] as const;

const STATUS_TONE: Record<string, 'teal' | 'warn' | 'error' | 'neutral'> = {
  ACTIVE: 'teal',
  PENDING_APPROVAL: 'warn',
  REJECTED: 'error',
  REVOKED: 'error',
  EXPIRED: 'neutral',
};

/** Teacher approval queue (teacher_approvals design): tabs by status,
 *  approve/reject pending requests, revoke active access. */
export default function TeacherEnrollmentsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<(typeof TABS)[number]>('PENDING_APPROVAL');

  const { data, isLoading } = useQuery({
    queryKey: ['teacher-enrollments', tab],
    queryFn: async () =>
      (
        await api.get('/teacher/enrollments', {
          params: tab === 'ALL' ? {} : { status: tab },
        })
      ).data,
  });

  const act = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'approve' | 'reject' | 'revoke' }) =>
      (await api.patch(`/teacher/enrollments/${id}/${action}`, {})).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teacher-enrollments'] }),
  });

  return (
    <div className="mx-auto max-w-container px-8 py-8">
      <h1 className="font-heading text-4xl font-extrabold">{t('teacher.students.title')}</h1>
      <p className="mb-6 mt-2 text-on-surface-variant">{t('teacher.students.subtitle')}</p>

      <div className="mb-6 flex gap-2">
        {TABS.map((tb) => (
          <button
            key={tb}
            className={`rounded-full px-5 py-2 font-heading text-sm font-bold transition ${
              tab === tb
                ? 'bg-primary text-on-primary'
                : 'bg-surface-container-lowest text-on-surface-variant shadow-card hover:bg-surface-container-low'
            }`}
            onClick={() => setTab(tb)}
          >
            {t(`teacher.students.tabs.${tb}`)}
          </button>
        ))}
      </div>

      {isLoading ? (
        <Spinner />
      ) : !data?.length ? (
        <EmptyState icon="group_off" title={t('teacher.students.empty')} />
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-outline-variant/40 text-start text-on-surface-variant">
                <th className="px-6 py-4 text-start font-bold">{t('teacher.students.colStudent')}</th>
                <th className="px-6 py-4 text-start font-bold">{t('teacher.students.colCourse')}</th>
                <th className="px-6 py-4 text-start font-bold">{t('teacher.students.colDate')}</th>
                <th className="px-6 py-4 text-start font-bold">{t('teacher.students.colAmount')}</th>
                <th className="px-6 py-4 text-start font-bold">{t('teacher.students.colStatus')}</th>
                <th className="px-6 py-4 text-start font-bold">{t('teacher.students.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((e: any) => (
                <tr key={e.id} className="border-b border-outline-variant/30 last:border-0 hover:bg-surface-container-low/50">
                  <td className="px-6 py-4">
                    <p className="font-bold">{e.student.user.fullName}</p>
                    <p className="text-xs text-outline" dir="ltr">{e.student.user.phone}</p>
                  </td>
                  <td className="px-6 py-4">{e.course.title}</td>
                  <td className="px-6 py-4 text-outline">{dateShort(e.createdAt)}</td>
                  <td className="px-6 py-4 font-bold">
                    {e.payments?.[0] ? egp(e.payments[0].amountCents) : egp(e.course.priceCents)}
                  </td>
                  <td className="px-6 py-4">
                    <Badge tone={STATUS_TONE[e.status] ?? 'neutral'}>{t(`myCourses.status.${e.status}`)}</Badge>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex gap-2">
                      {e.status === 'PENDING_APPROVAL' && (
                        <>
                          <button
                            className="btn-secondary px-3 py-1.5 text-xs"
                            disabled={act.isPending}
                            onClick={() => act.mutate({ id: e.id, action: 'approve' })}
                          >
                            {t('teacher.students.approve')}
                          </button>
                          <button
                            className="rounded-lg border border-error/40 px-3 py-1.5 text-xs font-bold text-error hover:bg-error-container/40"
                            disabled={act.isPending}
                            onClick={() => act.mutate({ id: e.id, action: 'reject' })}
                          >
                            {t('teacher.students.reject')}
                          </button>
                        </>
                      )}
                      {e.status === 'ACTIVE' && (
                        <button
                          className="rounded-lg border border-error/40 px-3 py-1.5 text-xs font-bold text-error hover:bg-error-container/40"
                          disabled={act.isPending}
                          onClick={() =>
                            window.confirm(t('teacher.students.revokeConfirm')) &&
                            act.mutate({ id: e.id, action: 'revoke' })
                          }
                        >
                          {t('teacher.students.revoke')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorNote error={act.error} />
    </div>
  );
}
