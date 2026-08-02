import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AxiosError } from 'axios';
import { api } from '../../lib/api';
import { useOwnedAcademy } from '../../lib/academy';
import { Badge, PageHeader, Spinner } from '../../components/ui';
import FactsForm from './studio/FactsForm';
import MediaManager from './studio/MediaManager';
import GenerateTab from './studio/GenerateTab';
import EditorTab from './studio/EditorTab';
import PreviewTab from './studio/PreviewTab';
import PublishTab from './studio/PublishTab';
import OnboardingWizard from './studio/OnboardingWizard';
import { BrandingTab, MembersTab } from './AcademyConsolePage';
import type { SiteOverview, SiteStatus } from './studio/types';

const STATUS_TONE: Record<SiteStatus, 'primary' | 'teal' | 'warn' | 'error' | 'neutral'> = {
  DRAFT: 'neutral',
  PENDING_MODERATION: 'warn',
  PUBLISHED: 'teal',
  REJECTED: 'error',
};

// Important, ordered tabs: the build flow + a combined settings tab.
const TABS = [
  { key: 'facts', icon: 'badge' },
  { key: 'media', icon: 'image' },
  { key: 'generate', icon: 'auto_awesome' },
  { key: 'editor', icon: 'edit' },
  { key: 'preview', icon: 'visibility' },
  { key: 'publish', icon: 'publish' },
  { key: 'settings', icon: 'storefront' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function isFeatureDisabled(err: unknown): boolean {
  return (err as AxiosError)?.response?.status === 404;
}

export default function AcademyStudioPage() {
  const { t } = useTranslation();
  const { academy, isLoading } = useOwnedAcademy();
  const [tab, setTab] = useState<TabKey>('facts');
  const [settingsSub, setSettingsSub] = useState<'branding' | 'team'>('branding');
  const [mode, setMode] = useState<'wizard' | 'tabs' | null>(null);

  const overview = useQuery<SiteOverview>({
    queryKey: ['studio-overview'],
    queryFn: async () => (await api.get('/academy/site')).data,
    retry: false,
  });

  useEffect(() => {
    if (mode === null && overview.data) setMode(overview.data.hasDraft ? 'tabs' : 'wizard');
  }, [overview.data, mode]);

  if (isLoading) return <div className="mx-auto max-w-container px-6 py-8"><Spinner /></div>;
  if (!academy) {
    return (
      <div className="mx-auto max-w-container px-6 py-8">
        <PageHeader title={t('studio.title')} subtitle={t('studio.noAcademy')} />
      </div>
    );
  }
  if (overview.isError && isFeatureDisabled(overview.error)) {
    return (
      <div className="mx-auto max-w-container px-6 py-8">
        <PageHeader title={t('studio.title')} subtitle={t('studio.subtitle')} />
        <div className="card border border-amber-200 bg-amber-50 text-amber-900">
          <p className="font-bold">{t('studio.disabledTitle')}</p>
          <p className="mt-1 text-sm">{t('studio.disabledHint')}</p>
        </div>
      </div>
    );
  }

  const ov = overview.data;
  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader
        title={t('studio.title')}
        subtitle={t('studio.subtitle')}
        action={
          ov?.status === 'PUBLISHED' ? (
            <Link to={`/a/${academy.slug}`} target="_blank" className="btn-secondary">
              <span className="material-symbols-outlined text-[20px]">open_in_new</span>
              {t('studio.viewPublished')}
            </Link>
          ) : undefined
        }
      />

      {ov && (
        <div className="card mb-6 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-on-surface-variant">{t('studio.pageStatus')}</span>
            <Badge tone={STATUS_TONE[ov.status]}>{t(`studio.status.${ov.status}`)}</Badge>
          </div>
          {ov.hasDraft && <span className="text-sm text-on-surface-variant">• {t('studio.draftV', { v: ov.version })}</span>}
          {ov.status === 'REJECTED' && ov.moderationReason && (
            <span className="text-sm text-error">• {t('studio.rejectedReason', { reason: ov.moderationReason })}</span>
          )}
        </div>
      )}

      {mode === 'wizard' ? (
        <OnboardingWizard slug={academy.slug} onExit={() => setMode('tabs')} />
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center gap-2">
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
                {t(`studio.tabs.${tb.key}`)}
              </button>
            ))}
            <button
              onClick={() => setMode('wizard')}
              className="ms-auto flex items-center gap-1 rounded-full px-4 py-2 text-sm font-semibold text-primary hover:bg-surface-container-low"
            >
              <span className="material-symbols-outlined text-[20px]">assistant_direction</span>
              {t('studio.guided')}
            </button>
          </div>

          {tab === 'facts' && <FactsForm />}
          {tab === 'media' && <MediaManager />}
          {tab === 'generate' && <GenerateTab onDone={() => setTab('editor')} />}
          {tab === 'editor' && <EditorTab />}
          {tab === 'preview' && <PreviewTab />}
          {tab === 'publish' && <PublishTab slug={academy.slug} />}
          {tab === 'settings' && (
            <div className="space-y-4">
              <div className="flex gap-2">
                {(['branding', 'team'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSettingsSub(s)}
                    className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
                      settingsSub === s ? 'bg-primary text-on-primary' : 'border border-outline-variant text-on-surface-variant'
                    }`}
                  >
                    {s === 'branding' ? t('studio.tabs.settings') : t('studio.tabs.team')}
                  </button>
                ))}
              </div>
              {settingsSub === 'branding' ? <BrandingTab slug={academy.slug} /> : <MembersTab slug={academy.slug} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}
