import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GuardianRelationship } from '@darsly/shared-types';
import { Badge, EmptyState, ErrorNote, Field, Modal, Skeleton } from '../../components/ui';
import { askConfirm } from '../../lib/confirm';
import { dateShort } from '../../lib/format';
import { guardianAccessUrl, useGuardianActions, useStudentGuardians } from '../../lib/guardian';

const RELATIONS: GuardianRelationship[] = ['FATHER', 'MOTHER', 'GUARDIAN', 'OTHER'];

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
}: {
  academyId: string;
  studentId: string;
  studentName: string;
}) {
  const { t } = useTranslation();
  const list = useStudentGuardians(academyId, studentId);
  const actions = useGuardianActions(academyId, studentId);
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState<{ url: string; name: string } | null>(null);

  const rows = list.data ?? [];
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
                      const r = await actions.rotate.mutateAsync(g.id);
                      setLink({ url: guardianAccessUrl(r.token), name: g.name });
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

      {adding && (
        <AddGuardian
          studentName={studentName}
          onClose={() => setAdding(false)}
          onAdd={async (body) => {
            const r = await actions.add.mutateAsync(body);
            setAdding(false);
            setLink({ url: guardianAccessUrl(r.token), name: body.name });
          }}
          error={actions.add.error}
          busy={actions.add.isPending}
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
  studentName,
  onClose,
  onAdd,
  error,
  busy,
}: {
  studentName: string;
  onClose: () => void;
  onAdd: (b: { name: string; phone: string; relationship: GuardianRelationship }) => Promise<void>;
  error: unknown;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [relationship, setRelationship] = useState<GuardianRelationship>('FATHER');
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
        <Field label={t('care.guardianName')} id="g-name">
          <input
            id="g-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
            maxLength={80}
          />
        </Field>
        <Field label={t('care.guardianPhone')} id="g-phone" hint={t('care.guardianPhoneHint')}>
          <input
            id="g-phone"
            className="input"
            dir="ltr"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
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
        {!!error && <ErrorNote error={error} />}
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
