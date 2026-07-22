import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AxiosError } from 'axios';
import { api } from '../../lib/api';
import { useOwnedAcademy } from '../../lib/academy';
import { Badge, ErrorNote, Field, PageHeader, Spinner } from '../../components/ui';

// ── Types (mirror the backend Academy Studio DTOs) ──────────────────────────
interface Social {
  platform: string;
  url: string;
}
interface Facts {
  fullName: string | null;
  bio: string | null;
  subjects: string[];
  stages: string[];
  achievements: string[];
  socials: Social[];
  rawIntake: string | null;
}
interface SiteOverview {
  status: 'DRAFT' | 'PENDING_MODERATION' | 'PUBLISHED' | 'REJECTED';
  hasDraft: boolean;
  publishedAt: string | null;
  version: number;
  moderationApproved: boolean;
  moderationReason: string | null;
  lastJob: { id: string; status: string; stage: string | null } | null;
}

const STATUS_LABEL: Record<SiteOverview['status'], string> = {
  DRAFT: 'مسودة',
  PENDING_MODERATION: 'قيد المراجعة',
  PUBLISHED: 'منشورة',
  REJECTED: 'مرفوضة',
};
const STATUS_TONE: Record<SiteOverview['status'], 'primary' | 'teal' | 'warn' | 'error' | 'neutral'> = {
  DRAFT: 'neutral',
  PENDING_MODERATION: 'warn',
  PUBLISHED: 'teal',
  REJECTED: 'error',
};

function isFeatureDisabled(err: unknown): boolean {
  return (err as AxiosError)?.response?.status === 404;
}

export default function AcademyStudioPage() {
  const { academy, isLoading } = useOwnedAcademy();

  const overview = useQuery<SiteOverview>({
    queryKey: ['studio-overview'],
    queryFn: async () => (await api.get('/academy/site')).data,
    retry: false,
  });

  if (isLoading) {
    return <div className="mx-auto max-w-container px-6 py-8"><Spinner /></div>;
  }
  if (!academy) {
    return (
      <div className="mx-auto max-w-container px-6 py-8">
        <PageHeader title="استوديو الأكاديمية" subtitle="لا توجد أكاديمية مملوكة لحسابك بعد." />
      </div>
    );
  }
  if (overview.isError && isFeatureDisabled(overview.error)) {
    return (
      <div className="mx-auto max-w-container px-6 py-8">
        <PageHeader title="استوديو الأكاديمية" subtitle="توليد صفحة أكاديميتك بالذكاء الاصطناعي." />
        <div className="card border border-amber-200 bg-amber-50 text-amber-900">
          <p className="font-bold">الميزة غير مُفعّلة بعد</p>
          <p className="mt-1 text-sm">
            استوديو الأكاديمية متوقّف حاليًا. لتفعيله، اضبط <code className="rounded bg-amber-100 px-1">AI_ACADEMY_ENABLED=true</code>{' '}
            و <code className="rounded bg-amber-100 px-1">OPENAI_API_KEY</code> في بيئة الخادم.
          </p>
        </div>
      </div>
    );
  }

  const ov = overview.data;
  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader
        title="استوديو الأكاديمية"
        subtitle="اكتب بياناتك، ودع الذكاء الاصطناعي يبني صفحة أكاديميتك."
        action={
          ov?.status === 'PUBLISHED' ? (
            <Link to={`/a/${academy.slug}`} target="_blank" className="btn-secondary">
              <span className="material-symbols-outlined text-[20px]">open_in_new</span>
              عرض الصفحة المنشورة
            </Link>
          ) : undefined
        }
      />

      {ov && (
        <div className="card mb-6 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-on-surface-variant">حالة الصفحة:</span>
            <Badge tone={STATUS_TONE[ov.status]}>{STATUS_LABEL[ov.status]}</Badge>
          </div>
          {ov.hasDraft && <span className="text-sm text-on-surface-variant">• يوجد مسودة (نسخة {ov.version})</span>}
          {ov.status === 'REJECTED' && ov.moderationReason && (
            <span className="text-sm text-error">• سبب الرفض: {ov.moderationReason}</span>
          )}
        </div>
      )}

      <FactsForm />
    </div>
  );
}

// ── Facts form ──────────────────────────────────────────────────────────────
function FactsForm() {
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
    },
  });

  if (isLoading || !form) {
    return isError ? <ErrorNote error={error} /> : <Spinner />;
  }

  const set = (patch: Partial<Facts>) => setForm({ ...form, ...patch });
  const csv = (arr: string[]) => arr.join('، ');
  const parseCsv = (s: string) => s.split(/[,،\n]/).map((x) => x.trim()).filter(Boolean);

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(form);
      }}
    >
      <h2 className="mb-1 font-heading text-xl font-bold">بيانات الأكاديمية</h2>
      <p className="mb-5 text-sm text-on-surface-variant">
        هذه هي المادة الخام التي يكتب منها الذكاء الاصطناعي محتوى صفحتك. كلما كانت أدق، كانت الصفحة أفضل.
      </p>

      <Field label="اسم المدرّس / الأكاديمية">
        <input
          className="input"
          value={form.fullName ?? ''}
          maxLength={120}
          onChange={(e) => set({ fullName: e.target.value })}
          placeholder="مثال: أ. خالد عبدالرحمن"
        />
      </Field>

      <Field label="نبذة تعريفية" hint="خبرتك، أسلوبك، ما يميّزك — بضع جُمل.">
        <textarea
          className="input min-h-[120px]"
          value={form.bio ?? ''}
          maxLength={2000}
          onChange={(e) => set({ bio: e.target.value })}
          placeholder="مدرّس رياضيات للثانوية العامة بخبرة 12 عامًا…"
        />
      </Field>

      <Field label="المواد" hint="افصل بينها بفاصلة.">
        <input
          className="input"
          value={csv(form.subjects)}
          onChange={(e) => set({ subjects: parseCsv(e.target.value) })}
          placeholder="الجبر، التفاضل، الهندسة"
        />
      </Field>

      <Field label="المراحل الدراسية" hint="افصل بينها بفاصلة.">
        <input
          className="input"
          value={csv(form.stages)}
          onChange={(e) => set({ stages: parseCsv(e.target.value) })}
          placeholder="الصف الثالث الثانوي"
        />
      </Field>

      <Field label="الإنجازات" hint="افصل بينها بفاصلة أو سطر جديد.">
        <textarea
          className="input"
          value={form.achievements.join('\n')}
          onChange={(e) => set({ achievements: parseCsv(e.target.value) })}
          placeholder={'أكثر من 3000 طالب\nنسبة نجاح 95%'}
        />
      </Field>

      <SocialsEditor value={form.socials} onChange={(socials) => set({ socials })} />

      <Field label="أي تفاصيل إضافية (اختياري)" hint="الصق أي نص حر يساعد الذكاء الاصطناعي.">
        <textarea
          className="input min-h-[100px]"
          value={form.rawIntake ?? ''}
          maxLength={20000}
          onChange={(e) => set({ rawIntake: e.target.value })}
        />
      </Field>

      <ErrorNote error={save.error} />
      <div className="mt-4 flex items-center gap-3">
        <button type="submit" className="btn-primary" disabled={save.isPending}>
          {save.isPending ? 'جارٍ الحفظ…' : 'حفظ البيانات'}
        </button>
        {saved && (
          <span className="flex items-center gap-1 text-sm font-bold text-teal-600">
            <span className="material-symbols-outlined text-[18px]">check_circle</span>
            تم الحفظ
          </span>
        )}
      </div>
    </form>
  );
}

function SocialsEditor({ value, onChange }: { value: Social[]; onChange: (v: Social[]) => void }) {
  const update = (i: number, patch: Partial<Social>) =>
    onChange(value.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  return (
    <Field label="روابط التواصل">
      <div className="space-y-2">
        {value.map((s, i) => (
          <div key={i} className="flex gap-2">
            <input
              className="input w-40"
              value={s.platform}
              maxLength={30}
              onChange={(e) => update(i, { platform: e.target.value })}
              placeholder="youtube"
            />
            <input
              className="input flex-1"
              value={s.url}
              onChange={(e) => update(i, { url: e.target.value })}
              placeholder="https://youtube.com/@..."
            />
            <button
              type="button"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-error transition hover:bg-error-container/40"
              aria-label="حذف"
              onClick={() => onChange(value.filter((_, idx) => idx !== i))}
            >
              <span className="material-symbols-outlined text-[20px]">delete</span>
            </button>
          </div>
        ))}
        {value.length < 10 && (
          <button
            type="button"
            className="text-sm font-bold text-primary hover:underline"
            onClick={() => onChange([...value, { platform: '', url: '' }])}
          >
            + إضافة رابط
          </button>
        )}
      </div>
    </Field>
  );
}
