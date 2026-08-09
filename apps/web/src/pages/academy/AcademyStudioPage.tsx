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

// Ordered build flow: each step advances to the next.
const FLOW: TabKey[] = ['facts', 'media', 'generate', 'editor', 'preview', 'publish'];

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

  const goNext = (cur: TabKey) => {
    const i = FLOW.indexOf(cur);
    if (i >= 0 && i < FLOW.length - 1) setTab(FLOW[i + 1]);
  };

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
      {/* One header band rather than a title, a subtitle and a thin status strip
          stacked on top of each other. The state of the page is the first thing
          a teacher needs and it belongs beside the name, not under it. */}
      <header className="mb-8 border-b border-outline-variant pb-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="display">{t('studio.title')}</h1>
            <p className="mt-2 max-w-prose text-on-surface-variant">{t('studio.subtitle')}</p>
          </div>
          {ov?.status === 'PUBLISHED' && (
            <Link to={`/a/${academy.slug}`} target="_blank" className="btn-secondary shrink-0">
              <span className="material-symbols-outlined text-[20px]">open_in_new</span>
              {t('studio.viewPublished')}
            </Link>
          )}
        </div>
        {ov && (
          <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <span className="text-on-surface-variant">{t('studio.pageStatus')}</span>
            <Badge tone={STATUS_TONE[ov.status]}>{t(`studio.status.${ov.status}`)}</Badge>
            {ov.hasDraft && (
              <span className="text-on-surface-variant">
                <span className="mx-1 text-outline-variant">·</span>
                {t('studio.draftV', { v: ov.version })}
              </span>
            )}
            {ov.status === 'REJECTED' && ov.moderationReason && (
              <span className="text-error">
                <span className="mx-1 text-outline-variant">·</span>
                {t('studio.rejectedReason', { reason: ov.moderationReason })}
              </span>
            )}
          </div>
        )}
      </header>

      {mode === 'wizard' ? (
        <OnboardingWizard slug={academy.slug} onExit={() => setMode('tabs')} />
      ) : (
        <>
          {/* The build flow is a sequence, so it is drawn as one: a numbered
              track you move along, not seven loose pills of equal weight. The
              settings tab sits outside it, because it is not a step. */}
          <nav className="mb-8 flex flex-wrap items-stretch gap-y-3">
            <div className="flex min-w-0 flex-1 flex-wrap items-stretch overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest">
              {FLOW.map((key, i) => {
                const meta = TABS.find((x) => x.key === key)!;
                const on = tab === key;
                const done = FLOW.indexOf(tab) > i;
                return (
                  <button
                    key={key}
                    onClick={() => setTab(key)}
                    aria-current={on ? 'step' : undefined}
                    className={`relative flex flex-1 items-center justify-center gap-2 px-4 py-3 font-heading text-sm font-semibold transition-colors ${
                      on
                        ? 'bg-primary text-on-primary'
                        : done
                          ? 'text-on-surface hover:bg-surface-container-low'
                          : 'text-on-surface-variant hover:bg-surface-container-low'
                    } ${i > 0 ? 'border-s border-outline-variant' : ''}`}
                  >
                    <span
                      className={`material-symbols-outlined text-[19px] ${on ? '' : done ? 'text-primary' : 'text-outline'}`}
                    >
                      {done ? 'check_circle' : meta.icon}
                    </span>
                    <span className="whitespace-nowrap">{t(`studio.tabs.${key}`)}</span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2 ps-3">
              <button
                onClick={() => setTab('settings')}
                title={t('studio.tabs.settings')}
                aria-pressed={tab === 'settings'}
                className={`flex h-full items-center gap-2 rounded-xl border px-4 font-heading text-sm font-semibold transition-colors ${
                  tab === 'settings'
                    ? 'border-primary bg-primary-fixed text-on-primary-fixed-variant'
                    : 'border-outline-variant text-on-surface-variant hover:bg-surface-container-low'
                }`}
              >
                <span className="material-symbols-outlined text-[19px]">storefront</span>
                <span className="hidden sm:inline">{t('studio.tabs.settings')}</span>
              </button>
              <button
                onClick={() => setMode('wizard')}
                className="flex h-full items-center gap-2 rounded-xl px-4 font-heading text-sm font-semibold text-primary transition-colors hover:bg-primary-fixed"
              >
                <span className="material-symbols-outlined text-[19px]">assistant_direction</span>
                <span className="hidden md:inline">{t('studio.guided')}</span>
              </button>
            </div>
          </nav>

          {tab === 'facts' && <FactsForm onSaved={() => goNext('facts')} />}
          {tab === 'media' && <MediaManager onNext={() => goNext('media')} />}
          {tab === 'generate' && <GenerateTab onDone={() => goNext('generate')} />}
          {tab === 'editor' && <EditorTab onNext={() => goNext('editor')} />}
          {tab === 'preview' && <PreviewTab onNext={() => goNext('preview')} />}
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
