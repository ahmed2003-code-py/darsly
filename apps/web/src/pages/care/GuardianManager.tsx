import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GuardianRelationship } from '@darsly/shared-types';
import { Badge, EmptyState, ErrorNote, Field, Modal, Skeleton } from '../../components/ui';
import { askConfirm } from '../../lib/confirm';
import { splitFormError } from '../../lib/errorMessage';
import { dateShort } from '../../lib/format';
import { guardianAccessUrl, useGuardianActions, useStudentGuardians } from '../../lib/guardian';

const RELATIONS: GuardianRelationship[] = ['FATHER', 'MOTHER', 'GUARDIAN', 'OTHER'];
const FORM_FIELDS = ['name', 'phone'] as const;

/**
 * A student's guardians, for staff holding guardian.manage: add one (name,
 * phone, relationship), resend their access link (the previous one stops
 * working), or remove their access. The link is shown once, to copy or send
 * on WhatsApp — the platform never sends it anywhere by itself.
 */
export default function GuardianManager({
  academyId,
  studentId,
  studentName,
  registerContact,
}: {
  academyId: string;
  studentId: string;
  studentName: string;
  /** C5: the guardian contact the register holds for this learner, if any. */
  registerContact?: { name: string | null; phone: string | null } | null;
}) {
  const { t } = useTranslation();
  const list = useStudentGuardians(academyId, studentId);
  const actions = useGuardianActions(academyId, studentId);
  const [adding, setAdding] = useState<boolean | { name: string; phone: string }>(false);
  const [link, setLink] = useState<{ url: string; name: string } | null>(null);

  const rows = list.data ?? [];
  const digits = (p: string | null | undefined) => (p ?? '').replace(/\D/g, '');
  // The register contact, unless that number is already an active guardian here.
  const contact =
    registerContact?.phone &&
    !rows.some((g) => g.status === 'ACTIVE' && digits(g.phone) === digits(registerContact.phone))
      ? registerContact
      : null;
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-heading text-lg font-bold text-on-surface">{t('care.guardians')}</h2>
        <button className="btn-primary" onClick={() => setAdding(true)}>
          <span className="material-symbols-outlined text-[20px]">person_add</span>
          {t('care.addGuardian')}
        </button>
      </div>
      {list.isLoading ? (
        <Skeleton className="h-20 rounded-2xl" />
      ) : list.error ? (
        <ErrorNote error={list.error} />
      ) : !rows.length ? (
        <EmptyState
          icon="family_restroom"
          title={t('care.noGuardians')}
          hint={t('care.noGuardiansHint')}
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((g) => (
            <li key={g.id} className="card flex flex-wrap items-center gap-3 p-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary-fixed text-on-primary-fixed">
                <span className="material-symbols-outlined text-[20px]">family_restroom</span>
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <bdi className="min-w-0 truncate font-bold text-on-surface">{g.name}</bdi>
                  {/* The name gives way to a long name; the badges never squeeze. */}
                  <span className="flex shrink-0 gap-1.5">
                    <Badge tone="neutral">{t(`guardian.rel.${g.relationship}`)}</Badge>
                    {g.status === 'REVOKED' ? (
                      <Badge tone="error">{t('care.revoked')}</Badge>
                    ) : g.link?.expired ? (
                      <Badge tone="warn">{t('care.linkExpired')}</Badge>
                    ) : null}
                    {g.status === 'ACTIVE' && g.state && (
                      <Badge tone={g.state === 'CONNECTED' ? 'primary' : 'neutral'}>
                        {t(`care.guardianState.${g.state}`)}
                      </Badge>
                    )}
                  </span>
                </div>
                <p className="truncate text-xs text-on-surface-variant" dir="auto">
                  <span dir="ltr">{g.phone}</span>
                  {g.status === 'ACTIVE' &&
                    ` · ${g.link?.lastUsedAt ? t('care.lastUsed', { date: dateShort(g.link.lastUsedAt) }) : t('care.neverUsed')}`}
                </p>
              </div>
              {g.status === 'ACTIVE' && (
                <div className="flex shrink-0 gap-1.5">
                  <button
                    className="btn-secondary"
                    disabled={actions.rotate.isPending}
                    onClick={async () => {
                      // A refusal is shown under the list (ErrorNote below).
                      const r = await actions.rotate.mutateAsync(g.id).catch(() => null);
                      if (r) setLink({ url: guardianAccessUrl(r.token), name: g.name });
                    }}
                  >
                    <span className="material-symbols-outlined text-[18px]">link</span>
                    {t('care.newLink')}
                  </button>
                  <button
                    className="btn-ghost text-error"
                    disabled={actions.revoke.isPending}
                    onClick={async () => {
                      if (
                        await askConfirm(t('care.revokeConfirm', { name: g.name }), {
                          danger: true,
                        })
                      )
                        actions.revoke.mutate(g.id);
                    }}
                  >
                    {t('care.revoke')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {(actions.rotate.error || actions.revoke.error) && (
        <ErrorNote error={actions.rotate.error ?? actions.revoke.error} />
      )}

      {/* C5: the phone typed at registration is a CONTACT — it signs no one in
          and proves nothing. It becomes a guardian only by this explicit invite. */}
      {contact && !list.isLoading && (
        <div className="mt-3 rounded-2xl border border-dashed border-outline-variant p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <bdi className="truncate font-bold">
                  {contact.name || t('care.registerContact')}
                </bdi>
                <Badge tone="neutral">{t('care.guardianState.CONTACT_ONLY')}</Badge>
              </span>
              <span className="block text-xs text-on-surface-variant" dir="ltr">
                {contact.phone}
              </span>
            </span>
            <button
              type="button"
              className="btn-secondary min-h-11"
              onClick={() => setAdding({ name: contact.name ?? '', phone: contact.phone ?? '' })}
            >
              <span className="material-symbols-outlined text-[18px]">person_add</span>
              {t('care.inviteContact')}
            </button>
          </div>
          <p className="mt-2 text-xs text-on-surface-variant">{t('care.registerContactHint')}</p>
        </div>
      )}

      {adding && (
        <AddGuardian
          initial={adding === true ? undefined : adding}
          studentName={studentName}
          onClose={() => setAdding(false)}
          onAdd={async (body) => {
            const r = await actions.add.mutateAsync(body);
            setAdding(false);
            setLink({ url: guardianAccessUrl(r.token), name: body.name });
          }}
          error={actions.add.error}
          busy={actions.add.isPending}
          onEdit={() => actions.add.error && actions.add.reset()}
        />
      )}
      {link && (
        <LinkReady
          url={link.url}
          name={link.name}
          studentName={studentName}
          onClose={() => setLink(null)}
        />
      )}
    </section>
  );
}

function AddGuardian({
  initial,
  studentName,
  onClose,
  onAdd,
  error,
  busy,
  onEdit,
}: {
  /** Pre-filled from the register contact; still edited and confirmed by staff. */
  initial?: { name: string; phone: string };
  studentName: string;
  onClose: () => void;
  /** Called on any edit, so a refusal about the old value does not linger. */
  onEdit: () => void;
  onAdd: (b: { name: string; phone: string; relationship: GuardianRelationship }) => Promise<void>;
  error: unknown;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [relationship, setRelationship] = useState<GuardianRelationship>('FATHER');
  // A refusal about one input goes under that input (PHONE_IN_USE on the
  // phone, a too-short name on the name); the note below says only the rest.
  const { fields } = splitFormError(error, FORM_FIELDS);
  const phoneRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (fields.phone) phoneRef.current?.focus();
    else if (fields.name) nameRef.current?.focus();
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps -- once per new error
  return (
    <Modal open title={t('care.addGuardianFor', { name: studentName })} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onAdd({ name: name.trim(), phone: phone.trim(), relationship }).catch(
            () => undefined,
          );
        }}
      >
        <Field label={t('care.guardianName')} id="g-name" error={fields.name}>
          <input
            ref={nameRef}
            id="g-name"
            className="input"
            aria-invalid={!!fields.name}
            aria-describedby={fields.name ? 'g-name-error' : undefined}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              onEdit();
            }}
            required
            minLength={2}
            maxLength={80}
          />
        </Field>
        <Field
          label={t('care.guardianPhone')}
          id="g-phone"
          hint={t('care.guardianPhoneHint')}
          error={fields.phone}
        >
          <input
            ref={phoneRef}
            id="g-phone"
            className="input"
            aria-invalid={!!fields.phone}
            aria-describedby={fields.phone ? 'g-phone-error' : 'g-phone-hint'}
            dir="ltr"
            inputMode="tel"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              onEdit();
            }}
            required
            placeholder="01xxxxxxxxx"
          />
        </Field>
        <fieldset className="mb-4">
          <legend className="mb-1.5 text-sm font-semibold text-on-surface-variant">
            {t('care.relationship')}
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {RELATIONS.map((r) => (
              <label
                key={r}
                className={`flex cursor-pointer items-center gap-2 rounded-sm border p-2.5 text-sm ${
                  relationship === r
                    ? 'border-primary bg-primary-fixed/40'
                    : 'border-outline-variant/60'
                }`}
              >
                <input
                  type="radio"
                  name="rel"
                  checked={relationship === r}
                  onChange={() => setRelationship(r)}
                />
                {t(`guardian.rel.${r}`)}
              </label>
            ))}
          </div>
        </fieldset>
        {!!error && <ErrorNote error={error} fields={FORM_FIELDS} />}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {t('care.createAccess')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function LinkReady({
  url,
  name,
  studentName,
  onClose,
}: {
  url: string;
  name: string;
  studentName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const message = t('care.shareText', { name, student: studentName, url });
  return (
    <Modal open title={t('care.linkReady')} onClose={onClose}>
      <p className="mb-3 text-sm text-on-surface-variant">{t('care.linkReadyHint')}</p>
      <div className="mb-4 flex items-center gap-2 rounded-sm border border-outline-variant/60 bg-surface-container-low p-2">
        <code className="min-w-0 flex-1 truncate text-xs" dir="ltr">
          {url}
        </code>
        <button
          className="btn-secondary shrink-0"
          onClick={() =>
            void navigator.clipboard?.writeText(url).then(
              () => setCopied(true),
              () => undefined,
            )
          }
        >
          <span className="material-symbols-outlined text-[18px]">
            {copied ? 'check' : 'content_copy'}
          </span>
          {copied ? t('care.copied') : t('care.copy')}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <a
          className="btn-primary"
          href={`https://wa.me/?text=${encodeURIComponent(message)}`}
          target="_blank"
          rel="noreferrer"
        >
          <span className="material-symbols-outlined text-[20px]">share</span>
          {t('care.shareWhatsapp')}
        </a>
        <button className="btn-ghost" onClick={onClose}>
          {t('care.done')}
        </button>
      </div>
    </Modal>
  );
}
