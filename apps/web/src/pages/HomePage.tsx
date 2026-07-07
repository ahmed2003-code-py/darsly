import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuthStore } from '../stores/auth';

/**
 * Post-login landing. Phase 1 placeholder proving the authenticated loop:
 * fetches /auth/me, greets by name/role in the dashboard's visual language.
 * Replaced by the full role dashboards in later phases.
 */
export default function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, clear } = useAuthStore();

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get('/auth/me')).data,
  });

  const display = me ?? user;

  async function logout() {
    try {
      await api.post('/auth/logout');
    } finally {
      clear();
      navigate('/login');
    }
  }

  return (
    <div className="mx-auto max-w-container px-10 py-10">
      <header className="card flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-primary">
            {t('dashboard.welcome', { name: display?.fullName ?? '…' })}
          </h1>
          <p className="mt-1 text-on-surface-variant">
            {display?.role ? t(`dashboard.role.${display.role}`) : t('common.loading')}
          </p>
        </div>
        <button className="btn-ghost" onClick={logout}>
          {t('dashboard.logout')}
        </button>
      </header>

      <div className="card mt-6 border-s-4 border-accent">
        <p className="text-on-surface-variant">{t('dashboard.phase1Note')}</p>
      </div>
    </div>
  );
}
