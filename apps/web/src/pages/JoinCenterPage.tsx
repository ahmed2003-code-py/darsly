import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAcceptInvitationLink, useInvitationPreview } from '../lib/invitationLinks';
import { useMyAcademies } from '../lib/academy';
import { Badge, ErrorNote, PageHeader, Skeleton } from '../components/ui';

/**
 * Where a shared invitation link lands. Preview only — nothing joins until
 * the invitee explicitly presses Accept; opening the link is not consent.
 */
export default function JoinCenterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token } = useParams<{ token: string }>();
  const { data: preview, isLoading, isError } = useInvitationPreview(token);
  const accept = useAcceptInvitationLink();
  const { refetch: refetchAcademies } = useMyAcademies();

  const doAccept = () => {
    if (!token) return;
    accept.mutate(token, {
      onSuccess: async () => {
        await refetchAcademies();
        navigate('/teacher');
      },
    });
  };

  return (
    <div className="page mx-auto max-w-md">
      <PageHeader title={t('joinCenter.title')} />
      {isLoading ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : isError || !preview ? (
        <div className="card p-6 text-center">
          <span className="material-symbols-outlined mb-2 text-5xl text-error">link_off</span>
          <p className="font-heading font-bold">{t('joinCenter.invalid')}</p>
        </div>
      ) : (
        <div className="card p-6 text-center">
          <span className="material-symbols-outlined mb-3 text-5xl text-primary">apartment</span>
          <p className="mb-1 font-heading text-lg font-bold">{preview.academyName}</p>
          <p className="mb-4 text-sm text-on-surface-variant">
            {t('joinCenter.invitedAs')} <Badge tone="teal">{t(`academy.role${preview.role === 'TEACHER' ? 'Teacher' : 'Assistant'}`)}</Badge>
          </p>
          <ErrorNote error={accept.error} />
          <div className="flex justify-center gap-3">
            <Link to="/" className="btn-secondary px-5 py-2.5">{t('common.cancel')}</Link>
            <button className="btn-primary px-5 py-2.5" disabled={accept.isPending} onClick={doAccept}>
              {accept.isPending ? t('common.saving') : t('joinCenter.accept')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
