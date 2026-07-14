import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Spinner } from '../components/ui';
import { dateShort } from '../lib/format';

/**
 * Printable / shareable certificate. Reads the PUBLIC verify endpoint so the
 * same URL works for the owner and for anyone verifying its authenticity.
 */
export default function CertificateViewPage() {
  const { t } = useTranslation();
  const { token } = useParams();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['certificate', token],
    queryFn: async () => (await api.get(`/certificates/verify/${token}`)).data,
    retry: false,
  });

  if (isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;
  if (isError || !data) {
    return (
      <div className="mx-auto max-w-lg px-6 py-24 text-center">
        <span className="material-symbols-outlined mb-2 text-5xl text-error">gpp_bad</span>
        <h1 className="font-heading text-xl font-bold">{t('cert.notFound')}</h1>
        <Link to="/" className="mt-4 inline-block text-primary hover:underline">{t('common.backHome')}</Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-container px-4 py-10 print:bg-white">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-center justify-between print:hidden">
          <Link to="/my-certificates" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <span className="material-symbols-outlined text-base">arrow_forward</span>{t('cert.myTitle')}
          </Link>
          <button className="btn-ghost" onClick={() => window.print()}>
            <span className="material-symbols-outlined text-base">print</span>{t('cert.print')}
          </button>
        </div>

        {/* The certificate itself */}
        <div className="relative overflow-hidden rounded-3xl border-4 border-primary/30 bg-surface-container-lowest p-10 text-center shadow-modal sm:p-16"
          style={{ boxShadow: 'inset 0 0 0 2px rgba(74,50,201,0.15)' }}>
          <div className="pointer-events-none absolute -end-16 -top-16 h-48 w-48 rounded-full bg-primary-fixed/40" />
          <div className="pointer-events-none absolute -bottom-16 -start-16 h-48 w-48 rounded-full bg-secondary-container/40" />

          <p className="mb-1 font-heading text-lg font-extrabold tracking-wide text-primary">درسلي · Darsly</p>
          <span className="material-symbols-outlined my-4 text-6xl text-primary">workspace_premium</span>
          <p className="text-sm uppercase tracking-widest text-outline">{t('cert.certificateOf')}</p>
          <h1 className="mt-2 font-heading text-3xl font-extrabold sm:text-4xl">{data.studentName}</h1>
          <p className="mx-auto mt-4 max-w-md text-on-surface-variant">{t('cert.hasCompleted')}</p>
          <h2 className="mt-2 font-heading text-2xl font-bold text-primary">{data.courseTitle}</h2>

          <div className="mt-10 flex items-end justify-between gap-4 text-start">
            <div>
              <p className="border-t border-outline pt-1 text-sm font-bold">{data.teacherName}</p>
              <p className="text-xs text-outline">{t('cert.instructor')}</p>
            </div>
            <div className="text-end">
              <p className="border-t border-outline pt-1 font-mono text-sm" dir="ltr">{data.serial}</p>
              <p className="text-xs text-outline">{dateShort(data.issuedAt)}</p>
            </div>
          </div>
        </div>
        <p className="mt-3 text-center text-xs text-outline print:hidden">{t('cert.verifyNote')}</p>
      </div>
    </div>
  );
}
