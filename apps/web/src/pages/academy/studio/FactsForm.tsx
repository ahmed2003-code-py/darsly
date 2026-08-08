import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import { ErrorNote, Field, Spinner } from '../../../components/ui';
import type { Facts, Social } from './types';
import i18n from '../../../i18n';

export default function FactsForm({ onSaved }: { onSaved?: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery<Facts>({
    queryKey: ['studio-facts'],
    queryFn: async () => (await api.get('/academy/facts')).data,
    retry: false,
  });
  const [form, setForm] = useState<Facts | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data && !form) {
      setForm({
        fullName: data.fullName ?? '',
        bio: data.bio ?? '',
        subjects: data.subjects ?? [],
        stages: data.stages ?? [],
        achievements: data.achievements ?? [],
        socials: data.socials ?? [],
        rawIntake: data.rawIntake ?? '',
      });
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: async (f: Facts) =>
      (await api.put('/academy/facts', {
        fullName: f.fullName || undefined,
        bio: f.bio || undefined,
        subjects: f.subjects,
        stages: f.stages,
        achievements: f.achievements,
        socials: f.socials.filter((s) => s.platform && s.url),
        rawIntake: f.rawIntake || undefined,
      })).data,
    onSuccess: () => {
      setSaved(true);
      qc.invalidateQueries({ queryKey: ['studio-facts'] });
      setTimeout(() => setSaved(false), 2500);
      // Advance to the next step in the guided flow.
      if (onSaved) setTimeout(onSaved, 500);
    },
  });

  if (isLoading || !form) return isError ? <ErrorNote error={error} /> : <Spinner />;

  const set = (patch: Partial<Facts>) => setForm({ ...form, ...patch });
  const csv = (arr: string[]) => arr.join(i18n.t('common.listSeparator'));
  const parseCsv = (s: string) => s.split(/[,،\n]/).map((x) => x.trim()).filter(Boolean);

  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); save.mutate(form); }}>
      <h2 className="mb-1 font-heading text-xl font-bold">{t('studio.facts.title')}</h2>
      <p className="mb-5 text-sm text-on-surface-variant">{t('studio.facts.hint')}</p>

      <Field label={t('studio.facts.fullName')}>
        <input className="input" value={form.fullName ?? ''} maxLength={120}
          onChange={(e) => set({ fullName: e.target.value })} placeholder={t('studio.facts.fullNamePh')} />
      </Field>

      <Field label={t('studio.facts.bio')} hint={t('studio.facts.bioHint')}>
        <textarea className="input min-h-[120px]" value={form.bio ?? ''} maxLength={2000}
          onChange={(e) => set({ bio: e.target.value })} placeholder={t('studio.facts.bioPh')} />
      </Field>

      <Field label={t('studio.facts.subjects')} hint={t('studio.facts.csvHint')}>
        <input className="input" value={csv(form.subjects)}
          onChange={(e) => set({ subjects: parseCsv(e.target.value) })} placeholder={t('studio.facts.subjectsPh')} />
      </Field>

      <Field label={t('studio.facts.stages')} hint={t('studio.facts.csvHint')}>
        <input className="input" value={csv(form.stages)}
          onChange={(e) => set({ stages: parseCsv(e.target.value) })} placeholder={t('studio.facts.stagesPh')} />
      </Field>

      <Field label={t('studio.facts.achievements')} hint={t('studio.facts.achHint')}>
        <textarea className="input" value={form.achievements.join('\n')}
          onChange={(e) => set({ achievements: parseCsv(e.target.value) })} placeholder={t('studio.facts.achPh')} />
      </Field>

      <SocialsEditor value={form.socials} onChange={(socials) => set({ socials })} />

      <Field label={t('studio.facts.extra')} hint={t('studio.facts.extraHint')}>
        <textarea className="input min-h-[100px]" value={form.rawIntake ?? ''} maxLength={20000}
          onChange={(e) => set({ rawIntake: e.target.value })} />
      </Field>

      <ErrorNote error={save.error} />
      <div className="mt-4 flex items-center gap-3">
        <button type="submit" className="btn-primary" disabled={save.isPending}>
          {save.isPending ? t('studio.facts.saving') : t('studio.facts.save')}
        </button>
        {saved && (
          <span className="flex items-center gap-1 text-sm font-bold text-teal-600">
            <span className="material-symbols-outlined text-[18px]">check_circle</span>
            {t('studio.facts.saved')}
          </span>
        )}
      </div>
    </form>
  );
}

function SocialsEditor({ value, onChange }: { value: Social[]; onChange: (v: Social[]) => void }) {
  const { t } = useTranslation();
  const update = (i: number, patch: Partial<Social>) =>
    onChange(value.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  return (
    <Field label={t('studio.facts.socials')}>
      <div className="space-y-2">
        {value.map((s, i) => (
          <div key={i} className="flex gap-2">
            <input className="input w-40" value={s.platform} maxLength={30}
              onChange={(e) => update(i, { platform: e.target.value })} placeholder={t('studio.facts.platformPh')} />
            <input className="input flex-1" value={s.url}
              onChange={(e) => update(i, { url: e.target.value })} placeholder={t('studio.facts.urlPh')} />
            <button type="button"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-error transition hover:bg-error-container/40"
              aria-label={t('studio.publish.delete')} onClick={() => onChange(value.filter((_, idx) => idx !== i))}>
              <span className="material-symbols-outlined text-[20px]">delete</span>
            </button>
          </div>
        ))}
        {value.length < 10 && (
          <button type="button" className="text-sm font-bold text-primary hover:underline"
            onClick={() => onChange([...value, { platform: '', url: '' }])}>
            {t('studio.facts.addSocial')}
          </button>
        )}
      </div>
    </Field>
  );
}
