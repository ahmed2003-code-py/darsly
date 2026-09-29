import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import LiveArchive from './LiveArchive';

/**
 * A finished class, for a student: its own page, so the recording, the
 * transcript and the chat can each open in full without stacking dialogs.
 * What the student may see was decided by the server (visibility and seat).
 */
export default function LiveRecordPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  // Shares the archive's own query (same key): the title comes with it.
  const detail = useQuery({
    queryKey: ['live-detail', id],
    queryFn: async () => (await api.get(`/live/${id}/detail`)).data,
  });
  return (
    <div className="page max-w-5xl">
      <Link
        to="/live"
        className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
      >
        <span aria-hidden className="material-symbols-outlined text-base rtl:rotate-180">
          arrow_back
        </span>
        {t('archive.backToLive')}
      </Link>
      <h1 className="mb-3 font-heading text-2xl font-bold" dir="auto">
        {detail.data?.title ?? t('live.sessionRecord')}
      </h1>
      <LiveArchive sessionId={id} />
    </div>
  );
}
