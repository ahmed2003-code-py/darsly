import { FormEvent, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useCreateCenter } from '../../lib/adminCommandCenter';
import { fieldErrors } from '../../lib/errorMessage';
import { ErrorNote, Field, PageHeader } from '../../components/ui';
import { CenterThemeGrantPicker } from './CenterThemeGrantPicker';

type FormKey = 'name' | 'slug' | 'adminName' | 'adminEmail' | 'adminPhone';
const ORDER: FormKey[] = ['name', 'slug', 'adminName', 'adminEmail', 'adminPhone'];

/**
 * The address rules, restated from `apps/api/src/academy/slug.ts` so the admin
 * sees what the address will be — and whether it can be one — while typing,
 * rather than after a round trip. The server still decides; this only saves
 * the admin a submit that was always going to be refused.
 */
const SLUG_MIN = 3;
const SLUG_MAX = 40;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function slugify(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}
const slugUsable = (s: string) => s.length >= SLUG_MIN && SLUG_PATTERN.test(s);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Same as the API's EGY_PHONE_REGEX. */
const EGY_PHONE = /^(\+20|0020|20|0)?1[0125][0-9]{8}$/;

export default function AdminCreateCenterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const create = useCreateCenter();
  const [form, setForm] = useState<Record<FormKey, string>>({
    name: '',
    slug: '',
    adminName: '',
    adminEmail: '',
    adminPhone: '',
  });
  const [themeIds, setThemeIds] = useState<string[]>([]);
  /** Problems found before sending — shown only after a submit attempt. */
  const [local, setLocal] = useState<Partial<Record<FormKey, string>>>({});
  /** Fields edited since the server last refused them: their refusal is stale. */
  const [edited, setEdited] = useState<Set<FormKey>>(new Set());
  const inputs = useRef<Partial<Record<FormKey, HTMLInputElement | null>>>({});

  const set = (k: FormKey) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [k]: value }));
    setLocal((l) => (l[k] ? { ...l, [k]: undefined } : l));
    setEdited((s) => (s.has(k) ? s : new Set(s).add(k)));
  };

  // What the address will be saved as — typed, or made from the name.
  const slugPreview = form.slug.trim() ? slugify(form.slug) : slugify(form.name);

  const server = useMemo(() => fieldErrors(create.error), [create.error]);
  const errorOf = (k: FormKey): string | undefined =>
    local[k] ?? (edited.has(k) ? undefined : server[k]?.message);

  const validate = (): Partial<Record<FormKey, string>> => {
    const out: Partial<Record<FormKey, string>> = {};
    if (form.name.trim().length < 2) out.name = t('admin.v.name');
    if (form.slug.trim()) {
      if (!slugUsable(slugify(form.slug)))
        out.slug = t('err.eCenterSlugInvalid', {
          slug: slugify(form.slug) || form.slug.trim(),
          min: SLUG_MIN,
          max: SLUG_MAX,
        });
    } else if (form.name.trim().length >= 2 && !slugUsable(slugify(form.name))) {
      out.slug = t('err.eCenterNameNoSlug', { min: SLUG_MIN });
    }
    if (form.adminName.trim().length < 2) out.adminName = t('admin.v.adminName');
    if (!EMAIL.test(form.adminEmail.trim())) out.adminEmail = t('admin.v.email');
    if (form.adminPhone.trim() && !EGY_PHONE.test(form.adminPhone.trim().replace(/[\s-]/g, '')))
      out.adminPhone = t('admin.v.phone');
    return out;
  };

  const focusFirst = (keys: string[]) => {
    const first = ORDER.find((k) => keys.includes(k));
    const el = first ? inputs.current[first] : null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus({ preventScroll: true });
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problems = validate();
    setLocal(problems);
    if (Object.keys(problems).length) {
      focusFirst(Object.keys(problems));
      return;
    }
    setEdited(new Set());
    create.mutate(
      {
        name: form.name.trim(),
        ...(form.slug.trim() ? { slug: form.slug.trim() } : {}),
        adminName: form.adminName.trim(),
        adminEmail: form.adminEmail.trim(),
        ...(form.adminPhone.trim()
          ? { adminPhone: form.adminPhone.trim().replace(/[\s-]/g, '') }
          : {}),
        ...(themeIds.length ? { themeIds } : {}),
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
        onError: (err) => focusFirst(Object.keys(fieldErrors(err))),
      },
    );
  };

  const ref = (k: FormKey) => (el: HTMLInputElement | null) => {
    inputs.current[k] = el;
  };

  const slugRefusal = edited.has('slug') ? undefined : server.slug;
  const suggestions = Array.isArray(slugRefusal?.params.suggestions)
    ? (slugRefusal.params.suggestions as unknown[]).filter(
        (s): s is string => typeof s === 'string',
      )
    : [];
  const emailRefusal = edited.has('adminEmail') ? undefined : server.adminEmail;
  const pendingCenterId =
    emailRefusal?.code === 'CENTER_ADMIN_PENDING_ELSEWHERE' &&
    typeof emailRefusal.params.centerId === 'string'
      ? emailRefusal.params.centerId
      : null;

  const noResponse = !!create.error && !(create.error as { response?: unknown }).response;
  const hasFieldProblems = ORDER.some((k) => errorOf(k));

  return (
    <div className="page max-w-2xl">
      <PageHeader
        title={t('admin.createCenter')}
        subtitle={t('admin.createCenterSub')}
        action={
          <Link to="/admin/academies" className="btn-secondary px-4 py-2 text-sm">
            {t('common.back')}
          </Link>
        }
      />
      <form onSubmit={submit} noValidate className="card p-6">
        <h3 className="mb-3 font-heading font-bold">{t('admin.centerSection')}</h3>
        <Field label={t('admin.centerName')} error={errorOf('name')}>
          <input
            ref={ref('name')}
            className="input"
            maxLength={120}
            value={form.name}
            onChange={set('name')}
            aria-invalid={!!errorOf('name')}
          />
        </Field>
        <Field
          label={t('admin.centerSlug')}
          error={
            errorOf('slug') && (
              <>
                {errorOf('slug')}
                {suggestions.length > 0 && (
                  <span className="mt-2 flex flex-wrap items-center gap-2 text-on-surface-variant">
                    {t('admin.slugSuggestions')}
                    {suggestions.map((s) => (
                      <button
                        key={s}
                        type="button"
                        dir="ltr"
                        className="rounded-full border border-outline-variant px-3 py-0.5 text-xs font-bold text-on-surface transition hover:border-primary"
                        onClick={() => {
                          setForm((f) => ({ ...f, slug: s }));
                          setEdited((prev) => new Set(prev).add('slug'));
                        }}
                      >
                        {s}
                      </button>
                    ))}
                  </span>
                )}
              </>
            )
          }
          hint={
            <>
              {t('admin.centerSlugHint')}
              {slugPreview && (
                <span className="mt-1 flex items-center gap-1.5">
                  {t('admin.centerSlugPreview')}
                  <code dir="ltr" className="rounded bg-surface-container px-1.5 text-on-surface">
                    /a/{slugPreview}
                  </code>
                </span>
              )}
            </>
          }
        >
          <input
            ref={ref('slug')}
            className="input"
            dir="ltr"
            maxLength={120}
            placeholder="elnour-center"
            value={form.slug}
            onChange={set('slug')}
            aria-invalid={!!errorOf('slug')}
          />
        </Field>

        <h3 className="mb-3 mt-6 font-heading font-bold">{t('admin.centerAdminSection')}</h3>
        <p className="mb-4 text-sm text-on-surface-variant">{t('admin.centerAdminHint')}</p>
        <Field label={t('admin.adminName')} error={errorOf('adminName')}>
          <input
            ref={ref('adminName')}
            className="input"
            maxLength={120}
            value={form.adminName}
            onChange={set('adminName')}
            aria-invalid={!!errorOf('adminName')}
          />
        </Field>
        <Field
          label={t('admin.adminEmail')}
          error={
            errorOf('adminEmail') && (
              <>
                {errorOf('adminEmail')}
                {pendingCenterId && (
                  <Link
                    to={`/admin/academies/${pendingCenterId}`}
                    className="ms-1 font-bold underline"
                  >
                    {t('admin.openPendingCenter')}
                  </Link>
                )}
              </>
            )
          }
        >
          <input
            ref={ref('adminEmail')}
            className="input"
            dir="ltr"
            type="email"
            value={form.adminEmail}
            onChange={set('adminEmail')}
            aria-invalid={!!errorOf('adminEmail')}
          />
        </Field>
        <Field label={t('admin.adminPhone')} error={errorOf('adminPhone')}>
          <input
            ref={ref('adminPhone')}
            className="input"
            dir="ltr"
            inputMode="tel"
            value={form.adminPhone}
            onChange={set('adminPhone')}
            aria-invalid={!!errorOf('adminPhone')}
          />
        </Field>

        <div className="mt-6 border-t border-outline-variant/50 pt-6">
          <CenterThemeGrantPicker selected={themeIds} onChange={setThemeIds} />
        </div>

        {hasFieldProblems ? (
          <p className="mt-3 rounded-xl border border-error/15 bg-error-container px-4 py-2 text-sm text-on-error-container">
            {t('admin.fixFields')}
          </p>
        ) : noResponse ? (
          <p className="mt-3 rounded-xl border border-error/15 bg-error-container px-4 py-2 text-sm text-on-error-container">
            {t('admin.networkMaybeCreated')}{' '}
            <Link to="/admin/academies" className="font-bold underline">
              {t('admin.openCenters')}
            </Link>
          </p>
        ) : (
          <ErrorNote error={create.error} />
        )}
        <div className="mt-4 flex justify-end">
          <button className="btn-primary px-6 py-2.5" disabled={create.isPending}>
            {create.isPending ? t('common.saving') : t('admin.createCenter')}
          </button>
        </div>
      </form>
    </div>
  );
}
