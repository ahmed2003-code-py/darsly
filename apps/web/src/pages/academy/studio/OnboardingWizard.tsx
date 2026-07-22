import { useState } from 'react';
import FactsForm from './FactsForm';
import MediaManager from './MediaManager';
import GenerateTab from './GenerateTab';
import PreviewTab from './PreviewTab';
import PublishTab from './PublishTab';

const STEPS = [
  { key: 'facts', label: 'البيانات', icon: 'badge', hint: 'عرّفنا بأكاديميتك.' },
  { key: 'media', label: 'الصور', icon: 'image', hint: 'ارفع شعارك وغلافك (اختياري).' },
  { key: 'generate', label: 'التوليد', icon: 'auto_awesome', hint: 'دع الذكاء الاصطناعي يكتب صفحتك.' },
  { key: 'preview', label: 'المعاينة', icon: 'visibility', hint: 'راجِع النتيجة.' },
  { key: 'publish', label: 'النشر', icon: 'publish', hint: 'انشر صفحتك.' },
] as const;

export default function OnboardingWizard({ slug, onExit }: { slug: string; onExit: () => void }) {
  const [i, setI] = useState(0);
  const step = STEPS[i];
  const next = () => setI((x) => Math.min(STEPS.length - 1, x + 1));
  const back = () => setI((x) => Math.max(0, x - 1));

  return (
    <div>
      {/* Stepper */}
      <div className="mb-6 flex items-center">
        {STEPS.map((s, idx) => (
          <div key={s.key} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center">
              <div className={`grid h-10 w-10 place-items-center rounded-full border-2 transition ${
                idx < i ? 'border-primary bg-primary text-on-primary'
                : idx === i ? 'border-primary text-primary'
                : 'border-outline-variant text-on-surface-variant'
              }`}>
                {idx < i ? <span className="material-symbols-outlined text-[20px]">check</span>
                  : <span className="material-symbols-outlined text-[20px]">{s.icon}</span>}
              </div>
              <span className={`mt-1 text-xs font-semibold ${idx === i ? 'text-primary' : 'text-on-surface-variant'}`}>{s.label}</span>
            </div>
            {idx < STEPS.length - 1 && <div className={`mx-2 h-0.5 flex-1 ${idx < i ? 'bg-primary' : 'bg-outline-variant'}`} />}
          </div>
        ))}
      </div>

      <p className="mb-4 text-center text-on-surface-variant">{step.hint}</p>

      <div className="mb-4">
        {step.key === 'facts' && <FactsForm />}
        {step.key === 'media' && <MediaManager />}
        {step.key === 'generate' && <GenerateTab onDone={next} />}
        {step.key === 'preview' && <PreviewTab />}
        {step.key === 'publish' && <PublishTab slug={slug} />}
      </div>

      <div className="flex items-center justify-between">
        <button className="btn-secondary" onClick={i === 0 ? onExit : back}>
          <span className="material-symbols-outlined text-[20px]">{i === 0 ? 'close' : 'arrow_forward'}</span>
          {i === 0 ? 'تخطّي' : 'السابق'}
        </button>
        {i < STEPS.length - 1 ? (
          <button className="btn-primary" onClick={next}>
            التالي
            <span className="material-symbols-outlined text-[20px]">arrow_back</span>
          </button>
        ) : (
          <button className="btn-primary" onClick={onExit}>
            <span className="material-symbols-outlined text-[20px]">done_all</span>
            إنهاء
          </button>
        )}
      </div>
    </div>
  );
}
