import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AxiosError } from 'axios';
import { api } from '../../../lib/api';
import { ErrorNote, Field, Spinner } from '../../../components/ui';

type LT = { ar: string; en: string };
interface Block {
  type: string;
  id: string;
  headline?: LT;
  subheadline?: LT;
  ctaLabel?: LT;
  heading?: LT;
  body?: LT;
  buttonLabel?: LT;
  items?: any[];
  [k: string]: unknown;
}
interface SiteDoc {
  version: number;
  theme: Record<string, unknown>;
  seo?: { title: LT; description: LT };
  blocks: Block[];
}
const EMPTY_LT: LT = { ar: '', en: '' };
const BLOCK_ICON: Record<string, string> = {
  hero: 'wallpaper', about: 'info', stats: 'bar_chart', faq: 'quiz', cta: 'ads_click',
  courses: 'menu_book', reviews: 'reviews', gallery: 'photo_library', contact: 'call',
};

function LocalizedInput({ label, value, multiline, onChange }: {
  label: string; value: LT; multiline?: boolean; onChange: (v: LT) => void;
}) {
  const { t } = useTranslation();
  const Cmp: any = multiline ? 'textarea' : 'input';
  return (
    <Field label={label}>
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <span className="mb-1 block text-xs text-outline">{t('studio.editor.ar')}</span>
          <Cmp className={`input ${multiline ? 'min-h-[80px]' : ''}`} dir="rtl"
            value={value?.ar ?? ''} onChange={(e: any) => onChange({ ...value, ar: e.target.value })} />
        </div>
        <div>
          <span className="mb-1 block text-xs text-outline">{t('studio.editor.en')}</span>
          <Cmp className={`input ${multiline ? 'min-h-[80px]' : ''}`} dir="ltr"
            value={value?.en ?? ''} onChange={(e: any) => onChange({ ...value, en: e.target.value })} />
        </div>
      </div>
    </Field>
  );
}

export default function EditorTab({ onNext }: { onNext?: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery<{ doc: SiteDoc | null }>({
    queryKey: ['studio-draft'],
    queryFn: async () => (await api.get('/academy/site/draft')).data,
    retry: false,
  });
  const [doc, setDoc] = useState<SiteDoc | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data?.doc && !doc) setDoc(structuredClone(data.doc));
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: async (d: SiteDoc) => (await api.put('/academy/site/draft', d)).data,
    onSuccess: () => {
      setSaved(true);
      qc.invalidateQueries({ queryKey: ['studio-preview'] });
      qc.invalidateQueries({ queryKey: ['studio-overview'] });
      setTimeout(() => setSaved(false), 2500);
    },
  });

  if (isLoading) return <Spinner />;
  if ((error as AxiosError)?.response?.status === 400 || (data && !data.doc)) {
    return (
      <div className="card grid place-items-center py-16 text-center">
        <span className="material-symbols-outlined text-4xl text-on-surface-variant">draft</span>
        <p className="mt-2 font-bold">{t('studio.editor.noDraft')}</p>
        <p className="text-sm text-on-surface-variant">{t('studio.editor.noDraftHint')}</p>
      </div>
    );
  }
  if (isError) return <div className="card"><ErrorNote error={error} /></div>;
  if (!doc) return <Spinner />;

  const patchSeo = (field: 'title' | 'description', v: LT) => {
    const next = structuredClone(doc);
    next.seo = { title: EMPTY_LT, description: EMPTY_LT, ...(next.seo ?? {}), [field]: v };
    setDoc(next);
  };
  const patchBlock = (i: number, patch: Partial<Block>) => {
    const next = structuredClone(doc);
    next.blocks[i] = { ...next.blocks[i], ...patch };
    setDoc(next);
  };
  const patchItem = (bi: number, ii: number, patch: any) => {
    const next = structuredClone(doc);
    (next.blocks[bi].items as any[])[ii] = { ...(next.blocks[bi].items as any[])[ii], ...patch };
    setDoc(next);
  };

  return (
    <div className="space-y-4">
      <div className="card flex items-center justify-between">
        <div>
          <h2 className="font-heading text-xl font-bold">{t('studio.editor.title')}</h2>
          <p className="text-sm text-on-surface-variant">{t('studio.editor.hint')}</p>
        </div>
        <div className="flex items-center gap-3">
          {saved && <span className="flex items-center gap-1 text-sm font-bold text-teal-600"><span className="material-symbols-outlined text-[18px]">check_circle</span>{t('studio.editor.saved')}</span>}
          <button className="btn-secondary" onClick={() => save.mutate(doc)} disabled={save.isPending}>
            {save.isPending ? t('studio.editor.saving') : t('studio.editor.save')}
          </button>
          {onNext && <button className="btn-primary" onClick={onNext}>{t('studio.continue')}</button>}
        </div>
      </div>
      <ErrorNote error={save.error} />

      <div className="card">
        <div className="mb-4 flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">travel_explore</span>
          <h3 className="font-heading font-bold">{t('studio.editor.seo')}</h3>
        </div>
        <LocalizedInput label={t('studio.editor.metaTitle')} value={doc.seo?.title ?? EMPTY_LT} onChange={(v) => patchSeo('title', v)} />
        <LocalizedInput label={t('studio.editor.metaDesc')} value={doc.seo?.description ?? EMPTY_LT} multiline onChange={(v) => patchSeo('description', v)} />
      </div>

      {doc.blocks.map((b, i) => (
        <div key={b.id} className="card">
          <div className="mb-4 flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">{BLOCK_ICON[b.type] ?? 'widgets'}</span>
            <h3 className="font-heading font-bold">{t(`studio.editor.blocks.${b.type}`, { defaultValue: b.type })}</h3>
          </div>

          {b.headline && <LocalizedInput label={t('studio.editor.heading')} value={b.headline} onChange={(v) => patchBlock(i, { headline: v })} />}
          {b.heading && <LocalizedInput label={t('studio.editor.heading')} value={b.heading} onChange={(v) => patchBlock(i, { heading: v })} />}
          {b.subheadline && <LocalizedInput label={t('studio.editor.subheading')} value={b.subheadline} multiline onChange={(v) => patchBlock(i, { subheadline: v })} />}
          {b.body && <LocalizedInput label={t('studio.editor.body')} value={b.body} multiline onChange={(v) => patchBlock(i, { body: v })} />}
          {b.ctaLabel && <LocalizedInput label={t('studio.editor.ctaBtn')} value={b.ctaLabel} onChange={(v) => patchBlock(i, { ctaLabel: v })} />}
          {b.buttonLabel && <LocalizedInput label={t('studio.editor.btn')} value={b.buttonLabel} onChange={(v) => patchBlock(i, { buttonLabel: v })} />}

          {b.type === 'faq' && Array.isArray(b.items) && (
            <div className="space-y-4">
              {b.items.map((it: any, ii: number) => (
                <div key={ii} className="rounded-xl border border-outline-variant p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-semibold text-on-surface-variant">{t('studio.editor.question', { n: ii + 1 })}</span>
                    <button type="button" className="text-error" aria-label={t('studio.publish.delete')}
                      onClick={() => patchBlock(i, { items: b.items!.filter((_, x) => x !== ii) })}>
                      <span className="material-symbols-outlined text-[20px]">delete</span>
                    </button>
                  </div>
                  <LocalizedInput label={t('studio.editor.q')} value={it.q} onChange={(v) => patchItem(i, ii, { q: v })} />
                  <LocalizedInput label={t('studio.editor.a')} value={it.a} multiline onChange={(v) => patchItem(i, ii, { a: v })} />
                </div>
              ))}
              {b.items.length < 8 && (
                <button type="button" className="text-sm font-bold text-primary hover:underline"
                  onClick={() => patchBlock(i, { items: [...b.items!, { q: { ar: '', en: '' }, a: { ar: '', en: '' } }] })}>
                  {t('studio.editor.addQ')}
                </button>
              )}
            </div>
          )}

          {b.type === 'stats' && Array.isArray(b.items) && (
            <div className="space-y-3">
              {b.items.map((it: any, ii: number) => (
                <div key={ii} className="flex items-end gap-2">
                  <div className="flex-1"><LocalizedInput label={t('studio.editor.label')} value={it.label} onChange={(v) => patchItem(i, ii, { label: v })} /></div>
                  <div className="w-28"><Field label={t('studio.editor.value')}><input className="input" value={it.value ?? ''} onChange={(e) => patchItem(i, ii, { value: e.target.value })} /></Field></div>
                </div>
              ))}
            </div>
          )}

          {(b.type === 'courses' || b.type === 'reviews') && (
            <p className="text-sm text-on-surface-variant">{t('studio.editor.auto')}</p>
          )}
        </div>
      ))}
    </div>
  );
}
