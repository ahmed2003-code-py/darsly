import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuthStore } from '../../stores/auth';
import { useStaffAcademyStore } from '../../stores/staffAcademy';

/**
 * Where a guardian's access link lands: /g#<token>. The token is in the
 * fragment — which browsers never send to a server — read once, removed from
 * the address bar at once (so it is not left in history or shared by
 * accident), and exchanged for a session.
 */
export default function GuardianAccessPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { setTokens, setUser } = useAuthStore();
  const [failed, setFailed] = useState(false);
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const token = window.location.hash.slice(1);
    window.history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setFailed(true);
      return;
    }
    api
      .post('/auth/guardian/consume', { token })
      .then(({ data }) => {
        useStaffAcademyStore.getState().clear();
        setTokens(data.accessToken, data.refreshToken);
        setUser(data.user);
        navigate(`/guardian?child=${encodeURIComponent(data.linkId)}`, { replace: true });
      })
      .catch(() => setFailed(true));
  }, [navigate, setTokens, setUser]);

  return (
    <div className="grid min-h-screen place-items-center bg-background p-6">
      {failed ? (
        <div className="card max-w-sm p-6 text-center">
          <span className="material-symbols-outlined mb-2 text-5xl text-outline">link_off</span>
          <h1 className="mb-2 font-heading text-lg font-bold text-on-surface">
            {t('guardian.linkInvalid')}
          </h1>
          <p className="text-sm text-on-surface-variant">{t('guardian.linkInvalidHint')}</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 text-on-surface-variant">
          <Spinner />
          <p className="text-sm">{t('guardian.signingIn')}</p>
        </div>
      )}
    </div>
  );
}
