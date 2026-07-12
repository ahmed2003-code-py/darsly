import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { imageToDataUrl } from '../../lib/image';
import { useOwnedAcademy } from '../../lib/academy';
import { Badge, ErrorNote, Field, PageHeader, Spinner } from '../../components/ui';

const TABS = ['branding', 'members'] as const;

export default function AcademyConsolePage() {
  const { academy, isLoading } = useOwnedAcademy();
  const [tab, setTab] = useState<(typeof TABS)[number]>('branding');

  if (isLoading) return <div className="mx-auto max-w-container px-6 py-8"><Spinner /></div>;
  if (!academy) {
    return (
      <div className="mx-auto max-w-container px-6 py-8">
        <PageHeader title="الأكاديمية" subtitle="لا توجد أكاديمية مملوكة لحسابك." />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader
        title="أكاديميتك"
        subtitle="هوية أكاديميتك وفريقك — كل شيء في مكان واحد."
        action={
          <Link to={`/a/${academy.slug}`} target="_blank" className="btn-secondary">
            <span className="material-symbols-outlined text-[20px]">open_in_new</span>
            عرض صفحة الأكاديمية
          </Link>
        }
      />
      <div className="mb-6 flex gap-2">
        {TABS.map((tb) => (
          <button
            key={tb}
            onClick={() => setTab(tb)}
            className={`rounded-full px-5 py-2 font-heading text-sm font-semibold transition-colors ${
              tab === tb ? 'bg-primary text-on-primary' : 'border border-outline-variant text-on-surface-variant hover:bg-surface-container-low'
            }`}
          >
            {tb === 'branding' ? 'الهوية والإعدادات' : 'الفريق'}
          </button>
        ))}
      </div>
      {tab === 'branding' ? <BrandingTab slug={academy.slug} /> : <MembersTab slug={academy.slug} />}
    </div>
  );
}

// ── Branding & settings ─────────────────────────────────────────────────────
function BrandingTab({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const logoRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLInputElement>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['academy-settings', slug],
    queryFn: async () => (await api.get(`/academies/${slug}/settings`)).data,
  });
  const [form, setForm] = useState<any>(null);
  useEffect(() => { if (data && !form) setForm(data); }, [data]); // eslint-disable-line

  const save = useMutation({
    mutationFn: async () => (await api.patch(`/academies/${slug}/settings`, {
      name: form.name, tagline: form.tagline, logoUrl: form.logoUrl, coverUrl: form.coverUrl,
      colorPrimary: form.colorPrimary, colorAccent: form.colorPrimary,
      language: form.language, requiresEnrollmentApproval: form.requiresEnrollmentApproval,
      maxConcurrentSessions: Number(form.maxConcurrentSessions),
    })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['academy-settings', slug] });
      qc.invalidateQueries({ queryKey: ['academy', slug] });
      qc.invalidateQueries({ queryKey: ['my-academies'] });
    },
  });

  if (isLoading || !form) return <Spinner />;
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  async function pick(ref: 'logoUrl' | 'coverUrl', file: File, opts: any) {
    set(ref, await imageToDataUrl(file, opts));
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="card">
        <Field label="اسم الأكاديمية"><input className="input" value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} maxLength={80} /></Field>
        <Field label="الوصف المختصر"><input className="input" value={form.tagline ?? ''} onChange={(e) => set('tagline', e.target.value)} maxLength={160} placeholder="الرياضيات ببساطة" /></Field>

        <div className="mb-4 grid grid-cols-2 gap-4">
          <Field label="اللون الأساسي">
            <div className="flex items-center gap-2">
              <input type="color" className="h-10 w-12 cursor-pointer rounded-lg border border-outline-variant bg-transparent" value={form.colorPrimary} onChange={(e) => set('colorPrimary', e.target.value)} />
              <input className="input" dir="ltr" value={form.colorPrimary} onChange={(e) => set('colorPrimary', e.target.value)} />
            </div>
          </Field>
          <Field label="لغة الأكاديمية">
            <select className="input" value={form.language} onChange={(e) => set('language', e.target.value)}>
              <option value="ar">العربية</option>
              <option value="en">English</option>
            </select>
          </Field>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-4">
          <div>
            <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">الشعار</span>
            <input ref={logoRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && pick('logoUrl', e.target.files[0], { maxW: 256, maxH: 256, square: true })} />
            <button type="button" onClick={() => logoRef.current?.click()} className="btn-secondary w-full">
              {form.logoUrl ? 'تغيير الشعار' : 'رفع شعار'}
            </button>
          </div>
          <div>
            <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">صورة الغلاف</span>
            <input ref={coverRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && pick('coverUrl', e.target.files[0], { maxW: 1600, maxH: 600, quality: 0.72 })} />
            <button type="button" onClick={() => coverRef.current?.click()} className="btn-secondary w-full">
              {form.coverUrl ? 'تغيير الغلاف' : 'رفع غلاف'}
            </button>
          </div>
        </div>

        <label className="mb-4 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!form.requiresEnrollmentApproval} onChange={(e) => set('requiresEnrollmentApproval', e.target.checked)} />
          يتطلب الالتحاق بالكورسات مراجعة الدفع
        </label>
        <Field label="أقصى عدد أجهزة متزامنة للطالب">
          <input type="number" min={1} max={10} className="input w-28" value={form.maxConcurrentSessions} onChange={(e) => set('maxConcurrentSessions', e.target.value)} />
        </Field>

        <ErrorNote error={save.error} />
        <div className="flex items-center gap-3">
          <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'جارٍ الحفظ…' : 'حفظ التغييرات'}
          </button>
          {save.isSuccess && <span className="text-sm text-primary">تم الحفظ ✓</span>}
        </div>
      </div>

      {/* Live preview */}
      <div className="card h-fit p-0" style={{ ['--academy-primary' as any]: form.colorPrimary }}>
        <div className="relative h-24 overflow-hidden rounded-t-xl" style={{ background: form.colorPrimary }}>
          {form.coverUrl && <img src={form.coverUrl} alt="" className="h-full w-full object-cover opacity-80" />}
        </div>
        <div className="-mt-8 px-5 pb-5">
          <span className="grid h-16 w-16 place-items-center overflow-hidden rounded-xl border-4 border-surface-container-lowest font-heading text-2xl font-bold text-white" style={{ background: form.colorPrimary }}>
            {form.logoUrl ? <img src={form.logoUrl} alt="" className="h-full w-full object-cover" /> : (form.name?.charAt(0) ?? '؟')}
          </span>
          <h3 className="mt-2 font-heading text-lg font-bold tracking-tight">{form.name}</h3>
          {form.tagline && <p className="text-sm text-on-surface-variant">{form.tagline}</p>}
          <p className="mt-2 text-xs text-outline" dir="ltr">/a/{slug}</p>
        </div>
      </div>
    </div>
  );
}

// ── Members ─────────────────────────────────────────────────────────────────
const ROLE_LABEL: Record<string, string> = { OWNER: 'المالك', TEACHER: 'مدرّس', ASSISTANT: 'مساعد', STUDENT: 'طالب' };

function MembersTab({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('TEACHER');
  const { data: members, isLoading } = useQuery({
    queryKey: ['academy-members', slug],
    queryFn: async () => (await api.get(`/academies/${slug}/members`)).data,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['academy-members', slug] });

  const add = useMutation({
    mutationFn: async () => (await api.post(`/academies/${slug}/members`, { email: email.trim(), role })).data,
    onSuccess: () => { setEmail(''); invalidate(); },
  });
  const change = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: any }) => (await api.patch(`/academies/${slug}/members/${id}`, body)).data,
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/academies/${slug}/members/${id}`)).data,
    onSuccess: invalidate,
  });

  const staff = (members ?? []).filter((m: any) => m.role !== 'STUDENT' || m.status !== 'LEFT');

  return (
    <div className="space-y-6">
      <div className="card">
        <h3 className="mb-3 font-heading font-bold">دعوة عضو للفريق</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1">
            <Field label="بريد العضو (لازم يكون مسجّل)"><input className="input" dir="ltr" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teacher@example.com" /></Field>
          </div>
          <div className="w-40">
            <Field label="الدور">
              <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="TEACHER">مدرّس</option>
                <option value="ASSISTANT">مساعد</option>
              </select>
            </Field>
          </div>
          <button className="btn-primary mb-4" disabled={add.isPending || !email.trim()} onClick={() => add.mutate()}>إضافة</button>
        </div>
        <ErrorNote error={add.error} />
      </div>

      <div className="card p-0">
        {isLoading ? <Spinner /> : (
          <ul className="divide-y divide-outline-variant">
            {staff.map((m: any) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 p-4">
                <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed font-heading font-bold text-primary">
                  {m.avatarUrl ? <img src={m.avatarUrl} alt="" className="h-full w-full object-cover" /> : (m.fullName?.charAt(0) ?? '؟')}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold">{m.fullName}</p>
                  <p className="truncate text-xs text-outline" dir="ltr">{m.email}</p>
                </div>
                <Badge tone={m.role === 'OWNER' ? 'primary' : m.role === 'STUDENT' ? 'neutral' : 'teal'}>{ROLE_LABEL[m.role]}</Badge>
                {m.role !== 'OWNER' && m.role !== 'STUDENT' && (
                  <div className="flex items-center gap-2">
                    <select className="input w-28 py-1.5 text-sm" value={m.role} onChange={(e) => change.mutate({ id: m.id, body: { role: e.target.value } })}>
                      <option value="TEACHER">مدرّس</option>
                      <option value="ASSISTANT">مساعد</option>
                    </select>
                    <button className="rounded-lg border border-error/40 px-3 py-1.5 text-xs font-bold text-error hover:bg-error-container/40" onClick={() => remove.mutate(m.id)}>إزالة</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
