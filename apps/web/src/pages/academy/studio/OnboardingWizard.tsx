import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import type { SiteOverview } from './types';
import { canAdvance } from './studioFlow';
import FactsForm from './FactsForm';
import MediaManager from './MediaManager';
import GenerateTab from './GenerateTab';
import PreviewTab from './PreviewTab';
import PublishTab from './PublishTab';

const STEPS = [
  { key: 'facts', icon: 'badge' },
  { key: 'media', icon: 'image' },
  { key: 'generate', icon: 'auto_awesome' },
  { key: 'preview', icon: 'visibility' },
  { key: 'publish', icon: 'publish' },
] as const;

export default function OnboardingWizard({ slug, onExit }: { slug: string; onExit: () => void }) {
  const { t } = useTranslation();
  const [i, setI] = useState(0);
  const step = STEPS[i];
  const overview = useQuery<SiteOverview>({
    queryKey: ['studio-overview'],
    queryFn: async () => (await api.get('/academy/site')).data,
    retry: false,
  });
  const lastJob = overview.data?.lastJob;
  // Next on the Generate step means "my page is made" — picking a colour is not
  // enough (that is how Preview used to open on "no page to preview yet").
  const gate = canAdvance(step.key, {
    hasDraft: !!overview.data?.hasDraft,
    generating: lastJob?.status === 'QUEUED' || lastJob?.status === 'RUNNING',
  });
  const next = () => setI((x) => Math.min(STEPS.length - 1, x + 1));
  const back = () => setI((x) => Math.max(0, x - 1));

  return (
    <div>
      {/* Stepper */}
      <div className="mb-6 flex items-center">
        {STEPS.map((s, idx) => (
          <div key={s.key} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center">
              <div
                className={`grid h-10 w-10 place-items-center rounded-full border-2 transition ${
                  idx < i
                    ? 'border-primary bg-primary text-on-primary'
                    : idx === i
                      ? 'border-primary text-primary'
                      : 'border-outline-variant text-on-surface-variant'
                }`}
              >
                <span className="material-symbols-outlined text-[20px]">
                  {idx < i ? 'check' : s.icon}
                </span>
              </div>
              <span
                className={`mt-1 text-xs font-semibold ${idx === i ? 'text-primary' : 'text-on-surface-variant'}`}
              >
                {t(`studio.wizard.steps.${s.key}`)}
              </span>
            </div>
            {idx < STEPS.length - 1 && (
              <div
                className={`mx-2 h-0.5 flex-1 ${idx < i ? 'bg-primary' : 'bg-outline-variant'}`}
              />
            )}
          </div>
        ))}
      </div>

      <p className="mb-4 text-center text-on-surface-variant">
        {t(`studio.wizard.steps.${step.key}H`)}
      </p>

      <div className="mb-4">
        {step.key === 'facts' && <FactsForm onSaved={next} />}
        {step.key === 'media' && <MediaManager />}
        {step.key === 'generate' && <GenerateTab academy={slug} onDone={next} />}
        {step.key === 'preview' && <PreviewTab />}
        {step.key === 'publish' && <PublishTab slug={slug} />}
      </div>

      <div className="flex items-center justify-between">
        <button className="btn-secondary" onClick={i === 0 ? onExit : back}>
          <span className="material-symbols-outlined text-[20px] rtl:-scale-x-100">
            {i === 0 ? 'close' : 'arrow_back'}
          </span>
          {i === 0 ? t('studio.wizard.skip') : t('studio.wizard.prev')}
        </button>
        {i < STEPS.length - 1 ? (
          <span className="flex flex-col items-end gap-1">
            {!gate.ok && (
              <span className="text-xs text-on-surface-variant" role="status">
                {t(
                  gate.reason === 'GENERATING'
                    ? 'studio.wizard.waitGenerating'
                    : 'studio.wizard.generateFirst',
                )}
              </span>
            )}
            <button
              className="btn-primary"
              onClick={next}
              disabled={!gate.ok}
              data-action="wizard-next"
            >
              {t('studio.wizard.next')}
              <span className="material-symbols-outlined text-[20px] rtl:-scale-x-100">
                arrow_forward
              </span>
            </button>
          </span>
        ) : (
          <button className="btn-primary" onClick={onExit}>
            <span className="material-symbols-outlined text-[20px]">done_all</span>
            {t('studio.wizard.finish')}
          </button>
        )}
      </div>
    </div>
  );
}
