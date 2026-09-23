import { m } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import AuthShell, { rise } from '../components/AuthShell';
import {
  useAcceptInvitationLink,
  useDeclineInvitationLink,
  useInvitationPreview,
  type InvitationPreview,
} from '../lib/invitationLinks';
import { useMyAcademies } from '../lib/academy';
import { withRedirect } from '../lib/redirect';
import { useAuthStore } from '../stores/auth';
import { Badge, ErrorNote, PageHeader, Skeleton } from '../components/ui';

/**
 * Where a shared Center invitation link lands — for everyone, signed in or
 * not. The token stays in the URL the whole way: a visitor with no account is
 * sent to sign in or sign up *with this destination*, and comes back here to
 * the same link. Nothing joins until the invitee explicitly presses Accept;
 * opening the link is not consent, and Decline is a real answer the owner
 * sees.
 */
export default function JoinCenterPage() {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const signedIn = useAuthStore((s) => !!s.accessToken);
  const { data: preview, isLoading, isError } = useInvitationPreview(token);

  if (!signedIn)
    return (
      <SignedOutLanding token={token!} preview={preview} loading={isLoading} invalid={isError} />
    );

  return (
    <div className="page mx-auto max-w-md">
      <PageHeader title={t('joinCenter.title')} />
      {isLoading ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : isError || !preview ? (
        <InvalidCard />
      ) : (
        <DecisionCard token={token!} preview={preview} />
      )}
    </div>
  );
}

function roleLabel(t: (k: string) => string, role: InvitationPreview['role']) {
  return t(role === 'TEACHER' ? 'academy.roleTeacher' : 'academy.roleAssistant');
}

function InvalidCard() {
  const { t } = useTranslation();
  return (
    <div className="card p-6 text-center">
      <span className="material-symbols-outlined mb-2 text-5xl text-error">link_off</span>
      <p className="font-heading font-bold">{t('joinCenter.invalid')}</p>
      <p className="mt-1 text-sm text-on-surface-variant">{t('joinCenter.invalidHint')}</p>
    </div>
  );
}

/** Signed in: the one real decision — accept into this exact Center, or decline. */
function DecisionCard({ token, preview }: { token: string; preview: InvitationPreview }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const accept = useAcceptInvitationLink();
  const decline = useDeclineInvitationLink();
  const { refetch: refetchAcademies } = useMyAcademies();
  const busy = accept.isPending || decline.isPending;

  const doAccept = () =>
    accept.mutate(token, {
      onSuccess: async () => {
        await refetchAcademies();
        navigate('/teacher', { replace: true });
      },
    });
  const doDecline = () =>
    decline.mutate(token, { onSuccess: () => navigate('/', { replace: true }) });

  return (
    <div className="card p-6 text-center">
      <span className="material-symbols-outlined mb-3 text-5xl text-primary">apartment</span>
      <p className="mb-1 font-heading text-lg font-bold">{preview.academyName}</p>
      <p className="mb-4 text-sm text-on-surface-variant">
        {t('joinCenter.invitedAs')} <Badge tone="teal">{roleLabel(t, preview.role)}</Badge>
      </p>
      <p className="mb-4 text-xs text-outline">{t('joinCenter.decisionHint')}</p>
      <ErrorNote error={accept.error ?? decline.error} />
      <div className="flex justify-center gap-3">
        <button className="btn-secondary px-5 py-2.5" disabled={busy} onClick={doDecline}>
          {decline.isPending ? t('common.saving') : t('joinCenter.decline')}
        </button>
        <button className="btn-primary px-5 py-2.5" disabled={busy} onClick={doAccept}>
          {accept.isPending ? t('common.saving') : t('joinCenter.accept')}
        </button>
      </div>
    </div>
  );
}

/**
 * Not signed in: say who is asking and for what, then offer the two doors.
 * Both carry this page as the redirect, so the token survives either journey.
 * The role is shown, never chosen — the link already decided it.
 */
function SignedOutLanding({
  token,
  preview,
  loading,
  invalid,
}: {
  token: string;
  preview?: InvitationPreview;
  loading: boolean;
  invalid: boolean;
}) {
  const { t } = useTranslation();
  const here = `/join/${encodeURIComponent(token)}`;
  const title = preview
    ? t('joinCenter.landingTitle', { name: preview.academyName })
    : t('joinCenter.title');
  const subtitle = preview
    ? t('joinCenter.landingSubtitle', { role: roleLabel(t, preview.role) })
    : undefined;

  return (
    <AuthShell title={title} subtitle={subtitle} brandName={preview?.academyName}>
      {loading ? (
        <Skeleton className="h-32 rounded-2xl" />
      ) : invalid || !preview ? (
        <m.div variants={rise}>
          <InvalidCard />
          <Link to="/login" className="btn-secondary mt-4 block w-full py-3 text-center">
            {t('auth.loginLink')}
          </Link>
        </m.div>
      ) : (
        <m.div variants={rise} className="space-y-3">
          <Link
            to={withRedirect('/register', here)}
            className="btn-primary block w-full py-3 text-center"
          >
            {t('joinCenter.createAccount')}
          </Link>
          <Link
            to={withRedirect('/login', here)}
            className="btn-secondary block w-full py-3 text-center"
          >
            {t('joinCenter.signInToAccept')}
          </Link>
        </m.div>
      )}
    </AuthShell>
  );
}
