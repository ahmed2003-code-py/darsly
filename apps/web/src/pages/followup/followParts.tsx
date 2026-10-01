import { useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ErrorNote, Modal, Spinner } from '../../components/ui';
import { newRequestKey } from '../../lib/centerFees';
import { isNetworkFailure } from '../../lib/desk';
import {
  CaseReason,
  CaseView,
  Channel,
  OUTCOMES,
  Outcome,
  Party,
  SignalRow,
  StudentFollowUp,
  telUrl,
  useFollowUpActions,
  useFollowUpStaff,
  useStudentFollowUp,
  whatsappUrl,
} from '../../lib/followUp';
import { dayLabel, Money } from '../fees/feeParts';

const REASON_ICON: Record<CaseReason, string> = {
  ABSENT_TODAY: 'event_busy',
  ABSENT_STREAK: 'person_off',
  LATE_STREAK: 'schedule',
  FEES_OVERDUE: 'payments',
  MANUAL: 'edit_note',
};

export function ReasonChip({ reason }: { reason: CaseReason }) {
  const { t } = useTranslation();
  const warn = reason === 'ABSENT_STREAK' || reason === 'FEES_OVERDUE';
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
        warn
          ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300'
          : 'bg-surface-container text-on-surface-variant'
      }`}
    >
      <span className="material-symbols-outlined text-sm" aria-hidden>
        {REASON_ICON[reason]}
      </span>
      {t(`followUp.reason.${reason}`)}
    </span>
  );
}

/** One line saying what the signal is — no notes, nothing beyond the signal itself. */
export function SignalDetail({ row, currency }: { row: SignalRow; currency?: string }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'en' ? 'en' : 'ar';
  switch (row.reason) {
    case 'ABSENT_TODAY':
      return <>{t('followUp.detail.absentToday', { group: row.groupName ?? '' })}</>;
    case 'ABSENT_STREAK':
      return (
        <>
          {t('followUp.detail.absentStreak', {
            count: row.count,
            group: row.groupName ?? '',
            date: dayLabel(row.since, lang),
          })}
        </>
      );
    case 'LATE_STREAK':
      return (
        <>
          {t('followUp.detail.lateStreak', {
            count: row.count,
            group: row.groupName ?? '',
            date: dayLabel(row.since, lang),
          })}
        </>
      );
    case 'FEES_OVERDUE':
      return (
        <>
          {t('followUp.detail.feesOverdue', { count: row.count })}
          {row.overdueCents != null && currency && (
            <>
              {' · '}
              <Money cents={row.overdueCents} currency={currency} />
            </>
          )}
        </>
      );
  }
}

interface PartyOption {
  key: string;
  party: Party;
  guardianLinkId?: string;
  label: string;
  phone: string | null;
}

/** Who can be reached for this learner. A register contact is only a contact. */
function partyOptions(d: StudentFollowUp, t: TFunction): PartyOption[] {
  const out: PartyOption[] = d.parties.guardians
    .filter((g) => g.state !== 'REVOKED')
    .map((g) => ({
      key: `g:${g.linkId}`,
      party: 'GUARDIAN_LINK' as const,
      guardianLinkId: g.linkId,
      label: `${g.name} · ${t(`followUp.relationship.${g.relationship}`)} · ${t(`followUp.state.${g.state}`)}`,
      phone: g.phone,
    }));
  if (d.parties.registerContact && !d.parties.registerContact.invitedAs)
    out.push({
      key: 'reg',
      party: 'REGISTER_GUARDIAN',
      label: `${d.parties.registerContact.name ?? t('followUp.party.registerGuardian')} · ${t('followUp.state.CONTACT_ONLY')}`,
      phone: d.parties.registerContact.phone,
    });
  if (d.parties.studentPhone)
    out.push({
      key: 'stu',
      party: 'STUDENT',
      label: t('followUp.party.STUDENT'),
      phone: d.parties.studentPhone,
    });
  out.push({ key: 'other', party: 'OTHER', label: t('followUp.party.OTHER'), phone: null });
  return out;
}

/**
 * Log one contact with the family. The call or WhatsApp message happens on
 * the staff member's own phone (tel: / wa.me with the privacy-safe template);
 * this records who was contacted, how, and what came of it — once, however
 * many times the button is pressed (one request key per contact).
 */
export function ContactDialog({
  academyId,
  academyStudentId,
  followUpId,
  onClose,
}: {
  academyId: string;
  academyStudentId: string;
  followUpId?: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'en' ? 'en' : 'ar';
  const data = useStudentFollowUp(academyId, academyStudentId);
  const act = useFollowUpActions(academyId);
  const [requestKey] = useState(newRequestKey);
  const [partyKey, setPartyKey] = useState<string>('');
  const [channel, setChannel] = useState<Channel>('PHONE_CALL');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [note, setNote] = useState('');
  const d = data.data;
  const options = d ? partyOptions(d, t) : [];
  const chosen = options.find((o) => o.key === partyKey) ?? options[0];
  const tel = chosen?.phone ? telUrl(chosen.phone) : null;
  const wa = chosen?.phone ? whatsappUrl(chosen.phone, lang) : null;
  const pending = act.logContact.isPending;
  return (
    <Modal open title={t('followUp.contact.title')} onClose={onClose}>
      {!d || !chosen ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!outcome || pending) return;
            act.logContact.mutate(
              {
                academyStudentId,
                requestKey,
                channel,
                outcome,
                party: chosen.party,
                ...(chosen.guardianLinkId ? { guardianLinkId: chosen.guardianLinkId } : {}),
                ...(followUpId ? { followUpId } : {}),
                ...(note.trim() ? { note: note.trim() } : {}),
              },
              { onSuccess: onClose },
            );
          }}
        >
          <p className="mb-3 font-semibold">
            <bdi>{d.student.fullName}</bdi>{' '}
            <span className="font-mono text-xs text-on-surface-variant" dir="ltr">
              {d.student.code}
            </span>
          </p>
          <label className="mb-3 block">
            <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
              {t('followUp.contact.who')}
            </span>
            <select
              className="input min-h-11"
              value={chosen.key}
              onChange={(e) => setPartyKey(e.target.value)}
            >
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {chosen.phone && (
            <div className="mb-3 grid grid-cols-2 gap-2">
              {tel && (
                <a
                  href={tel}
                  className="btn-ghost min-h-11 justify-center"
                  onClick={() => setChannel('PHONE_CALL')}
                >
                  <span className="material-symbols-outlined text-lg" aria-hidden>
                    call
                  </span>
                  {t('followUp.contact.call')}
                </a>
              )}
              {wa && (
                <a
                  href={wa}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-ghost min-h-11 justify-center"
                  onClick={() => setChannel('WHATSAPP')}
                >
                  <span className="material-symbols-outlined text-lg" aria-hidden>
                    chat
                  </span>
                  {t('followUp.contact.whatsapp')}
                </a>
              )}
            </div>
          )}
          <p className="mb-3 text-xs text-on-surface-variant">
            {t('followUp.contact.handoffHint')}
          </p>
          <label className="mb-3 block">
            <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
              {t('followUp.contact.channel')}
            </span>
            <select
              className="input min-h-11"
              value={channel}
              onChange={(e) => setChannel(e.target.value as Channel)}
            >
              {(['PHONE_CALL', 'WHATSAPP', 'IN_PERSON', 'APP_MESSAGE', 'OTHER'] as const).map(
                (c) => (
                  <option key={c} value={c}>
                    {t(`followUp.channel.${c}`)}
                  </option>
                ),
              )}
            </select>
          </label>
          <fieldset className="mb-3">
            <legend className="mb-1.5 text-sm font-semibold text-on-surface-variant">
              {t('followUp.contact.outcome')}
            </legend>
            <div className="flex flex-wrap gap-1.5" role="radiogroup">
              {OUTCOMES.map((o) => (
                <button
                  key={o}
                  type="button"
                  role="radio"
                  aria-checked={outcome === o}
                  onClick={() => setOutcome(o)}
                  className={`min-h-11 rounded-full px-4 text-sm font-semibold ${
                    outcome === o
                      ? 'bg-primary text-on-primary'
                      : 'bg-surface-container text-on-surface-variant'
                  }`}
                >
                  {t(`followUp.outcome.${o}`)}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="mb-1 block">
            <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
              {t('followUp.contact.note')}
            </span>
            <textarea
              className="input min-h-20"
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 500))}
              maxLength={500}
            />
          </label>
          <p className="mb-3 text-xs text-on-surface-variant">{t('followUp.contact.noteHint')}</p>
          <SaveError error={act.logContact.error} />
          <button
            type="submit"
            className="btn-primary mt-2 min-h-12 w-full"
            disabled={!outcome || pending}
            aria-busy={pending}
          >
            {isNetworkFailure(act.logContact.error)
              ? t('followUp.retry')
              : t('followUp.contact.save')}
          </button>
        </form>
      )}
    </Modal>
  );
}

/** Open a case — from a signal (verified on the server) or by hand. */
export function OpenCaseDialog({
  academyId,
  academyStudentId,
  name,
  reason,
  signalKey,
  onClose,
}: {
  academyId: string;
  academyStudentId: string;
  name: string;
  reason: CaseReason;
  signalKey?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const act = useFollowUpActions(academyId);
  const staff = useFollowUpStaff(academyId);
  const [requestKey] = useState(newRequestKey);
  const [note, setNote] = useState('');
  const [assignee, setAssignee] = useState('');
  const [dueOn, setDueOn] = useState('');
  const manual = reason === 'MANUAL';
  const ok = !manual || note.trim().length >= 3;
  const pending = act.open.isPending;
  return (
    <Modal open title={t('followUp.case.openTitle')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok || pending) return;
          act.open.mutate(
            {
              requestKey,
              academyStudentId,
              reason,
              ...(signalKey ? { signalKey } : {}),
              ...(note.trim() ? { note: note.trim() } : {}),
              ...(assignee ? { assignedToUserId: assignee } : {}),
              ...(dueOn ? { dueOn } : {}),
            },
            { onSuccess: onClose },
          );
        }}
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="font-semibold">
            <bdi>{name}</bdi>
          </span>
          <ReasonChip reason={reason} />
        </div>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {manual ? t('followUp.case.why') : t('followUp.case.noteOptional')}
          </span>
          <textarea
            className="input min-h-20"
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 500))}
            maxLength={500}
            required={manual}
          />
        </label>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('followUp.case.assignTo')}
          </span>
          <select
            className="input min-h-11"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="">{t('followUp.case.nobody')}</option>
            {(staff.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('followUp.case.dueOn')}
          </span>
          <input
            type="date"
            className="input min-h-11"
            value={dueOn}
            onChange={(e) => setDueOn(e.target.value)}
          />
        </label>
        <SaveError error={act.open.error} />
        <button
          type="submit"
          className="btn-primary mt-2 min-h-12 w-full"
          disabled={!ok || pending}
          aria-busy={pending}
        >
          {isNetworkFailure(act.open.error) ? t('followUp.retry') : t('followUp.case.open')}
        </button>
      </form>
    </Modal>
  );
}

/** Resolve or dismiss — with why. A case closes once; a closed case is history. */
export function CloseCaseDialog({
  academyId,
  c,
  onClose,
}: {
  academyId: string;
  c: CaseView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const act = useFollowUpActions(academyId);
  const [status, setStatus] = useState<'RESOLVED' | 'DISMISSED'>('RESOLVED');
  const [reason, setReason] = useState('');
  const ok = reason.trim().length >= 3;
  const pending = act.close.isPending;
  return (
    <Modal open title={t('followUp.case.closeTitle')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok || pending) return;
          act.close.mutate({ id: c.id, status, reason: reason.trim() }, { onSuccess: onClose });
        }}
      >
        <div className="mb-3 grid grid-cols-2 gap-2" role="radiogroup">
          {(['RESOLVED', 'DISMISSED'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={status === s}
              onClick={() => setStatus(s)}
              className={`min-h-12 rounded-xl border px-3 text-sm font-semibold ${
                status === s ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/60'
              }`}
            >
              {t(`followUp.case.do.${s}`)}
            </button>
          ))}
        </div>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {status === 'RESOLVED' ? t('followUp.case.how') : t('followUp.case.whyDismiss')}
          </span>
          <textarea
            className="input min-h-20"
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 300))}
            maxLength={300}
            required
            autoFocus
          />
        </label>
        <ErrorNote error={act.close.error} />
        <button
          type="submit"
          className="btn-primary mt-2 min-h-12 w-full"
          disabled={!ok || pending}
          aria-busy={pending}
        >
          {t(`followUp.case.do.${status}`)}
        </button>
      </form>
    </Modal>
  );
}

export function AssignDialog({
  academyId,
  c,
  onClose,
}: {
  academyId: string;
  c: CaseView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const act = useFollowUpActions(academyId);
  const staff = useFollowUpStaff(academyId);
  const [assignee, setAssignee] = useState(c.assignedTo?.id ?? '');
  const [dueOn, setDueOn] = useState(c.dueOn ?? '');
  const pending = act.assign.isPending;
  return (
    <Modal open title={t('followUp.case.assignTitle')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (pending) return;
          act.assign.mutate(
            { id: c.id, assignedToUserId: assignee || null, dueOn: dueOn || null },
            { onSuccess: onClose },
          );
        }}
      >
        <label className="mb-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('followUp.case.assignTo')}
          </span>
          <select
            className="input min-h-11"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="">{t('followUp.case.nobody')}</option>
            {(staff.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('followUp.case.dueOn')}
          </span>
          <input
            type="date"
            className="input min-h-11"
            value={dueOn}
            onChange={(e) => setDueOn(e.target.value)}
          />
        </label>
        <ErrorNote error={act.assign.error} />
        <button
          type="submit"
          className="btn-primary mt-2 min-h-12 w-full"
          disabled={pending}
          aria-busy={pending}
        >
          {t('common.save')}
        </button>
      </form>
    </Modal>
  );
}

/** A case as one row: who, why, state, who has it. */
export function CaseLine({ c, showStudent }: { c: CaseView; showStudent?: boolean }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'en' ? 'en' : 'ar';
  return (
    <span className="min-w-0 flex-1">
      {showStudent && c.student && (
        <span className="block truncate font-semibold">
          <bdi>{c.student.fullName}</bdi>{' '}
          <span className="font-mono text-xs font-normal text-on-surface-variant" dir="ltr">
            {c.student.code}
          </span>
        </span>
      )}
      <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
        <ReasonChip reason={c.reason} />
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
            c.status === 'OPEN'
              ? 'bg-primary-fixed/50 text-on-surface'
              : 'bg-surface-container text-on-surface-variant'
          }`}
        >
          {t(`followUp.status.${c.status}`)}
        </span>
        {c.assignedTo && (
          <span className="text-xs text-on-surface-variant">
            {t('followUp.case.assignedTo', { name: c.assignedTo.name })}
          </span>
        )}
        {c.dueOn && (
          <span className="text-xs text-on-surface-variant">
            {t('followUp.case.dueLabel', { date: dayLabel(c.dueOn, lang) })}
          </span>
        )}
      </span>
      {c.note && <span className="mt-1 block text-sm text-on-surface-variant">{c.note}</span>}
      {c.closeReason && (
        <span className="mt-1 block text-sm text-on-surface-variant">
          {t('followUp.case.closedWith', { by: c.closedBy ?? '', reason: c.closeReason })}
        </span>
      )}
    </span>
  );
}

/**
 * A save that did not reach the server says so plainly — nothing was recorded,
 * and trying again is safe (the same request key: it can only happen once).
 */
function SaveError({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  if (isNetworkFailure(error))
    return (
      <p className="mb-2 rounded-xl bg-amber-500/10 p-3 text-sm" role="alert">
        {t('followUp.offline')}
      </p>
    );
  return <ErrorNote error={error} />;
}
