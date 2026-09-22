import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useCreateCenter } from '../../lib/adminCommandCenter';
import { ErrorNote, Field, PageHeader } from '../../components/ui';

export default function AdminCreateCenterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const create = useCreateCenter();
  const [form, setForm] = useState({ name: '', slug: '', adminName: '', adminEmail: '', adminPhone: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      {
        name: form.name.trim(),
        ...(form.slug.trim() ? { slug: form.slug.trim() } : {}),
        adminName: form.adminName.trim(),
        adminEmail: form.adminEmail.trim(),
        ...(form.adminPhone.trim() ? { adminPhone: form.adminPhone.trim() } : {}),
      },
      {
        onSuccess: (res) => {
          const params = new URLSearchParams();
          if (res.delivery?.delivered === false) params.set('activationEmail', 'failed');
          // Carried through the URL (never persisted, never a second retrieval
          // endpoint) so the detail page can show it once, right after creation
          // — the same token, still single-use, still normal /auth/activation.
          if (res.activationUrl) params.set('activationLink', res.activationUrl);
          const qs = params.toString();
          navigate(`/admin/academies/${res.id}${qs ? `?${qs}` : ''}`);
        },
      },
    );
  };

  return (
    <div className="page max-w-2xl">
      <PageHeader
        title={t('admin.createCenter')}
        subtitle={t('admin.createCenterSub')}
        action={<Link to="/admin/academies" className="btn-secondary px-4 py-2 text-sm">{t('common.back')}</Link>}
      />
      <form onSubmit={submit} className="card p-6">
        <h3 className="mb-3 font-heading font-bold">{t('admin.centerSection')}</h3>
        <Field label={t('admin.centerName')}>
          <input className="input" required minLength={2} maxLength={120} value={form.name} onChange={set('name')} />
        </Field>
        <Field label={t('admin.centerSlug')} hint={t('admin.centerSlugHint')}>
          <input className="input" dir="ltr" maxLength={120} value={form.slug} onChange={set('slug')} />
        </Field>

        <h3 className="mb-3 mt-6 font-heading font-bold">{t('admin.centerAdminSection')}</h3>
        <p className="mb-4 text-sm text-on-surface-variant">{t('admin.centerAdminHint')}</p>
        <Field label={t('admin.adminName')}>
          <input className="input" required minLength={2} maxLength={120} value={form.adminName} onChange={set('adminName')} />
        </Field>
        <Field label={t('admin.adminEmail')}>
          <input className="input" dir="ltr" type="email" required value={form.adminEmail} onChange={set('adminEmail')} />
        </Field>
        <Field label={t('admin.adminPhone')}>
          <input className="input" dir="ltr" inputMode="tel" value={form.adminPhone} onChange={set('adminPhone')} />
        </Field>

        <ErrorNote error={create.error} />
        <div className="mt-4 flex justify-end">
          <button className="btn-primary px-6 py-2.5" disabled={create.isPending}>
            {create.isPending ? t('common.saving') : t('admin.createCenter')}
          </button>
        </div>
      </form>
    </div>
  );
}
