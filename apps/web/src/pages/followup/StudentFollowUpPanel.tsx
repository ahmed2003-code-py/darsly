import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorNote, Skeleton, Spinner } from '../../components/ui';
import { formatInstant } from '../../lib/classOps';
import {
  CaseView,
  fetchTimeline,
  telUrl,
  TimelineItem,
  useStudentFollowUp,
  whatsappUrl,
} from '../../lib/followUp';
import { dayLabel, Money } from '../fees/feeParts';
import {
  AssignDialog,
  CaseLine,
  CloseCaseDialog,
  ContactDialog,
  OpenCaseDialog,
} from './followParts';

/**
 * Student 360 → Follow-up: who can be reached (guardians with their state —
 * invited or connected — and the register's contact, which is only a
 * contact), the learner's cases and contact history, and the timeline the
 * server composes from the phases that own each fact. Money appears in the
 * timeline only when the server sent it (fees.view).
 */
export default function StudentFollowUpPanel({
  academyId,
  academyStudentId,
  canManage,
  onGoGuardians,
}: {
  academyId: string;
  academyStudentId: string;
  canManage: boolean;
  onGoGuardians?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'en' ? 'en' : 'ar';
  const q = useStudentFollowUp(academyId, academyStudentId);
  const [contact, setContact] = useState<{ followUpId?: string } | null>(null);
  const [manual, setManual] = useState(false);
  const [closing, setClosing] = useState<CaseView | null>(null);
  const [assigning, setAssigning] = useState<CaseView | null>(null);
  const d = q.data;
  if (q.isLoading) return <Skeleton className="h-48 rounded-2xl" />;
  if (!d) return <ErrorNote error={q.error} />;
  const open = d.cases.filter((c) => c.status === 'OPEN');
  const closed = d.cases.filter((c) => c.status !== 'OPEN');
  const reachable = [
    ...d.parties.guardians.map((g) => ({
      key: g.linkId,
      name: g.name,
      sub: `${t(`followUp.relationship.${g.relationship}`)}`,
      state: g.state,
      phone: g.phone,
    })),
    ...(d.parties.registerContact && !d.parties.registerContact.invitedAs
      ? [
          {
            key: 'reg',
            name: d.parties.registerContact.name ?? t('followUp.party.registerGuardian'),
            // Named → say where the number came from; unnamed → the name already says it.
            sub: d.parties.registerContact.name ? t('followUp.party.registerGuardian') : '',
            state: 'CONTACT_ONLY' as const,
            phone: d.parties.registerContact.phone,
          },
        ]
      : []),
    ...(d.parties.studentPhone
      ? [
          {
            key: 'stu',
            name: t('followUp.party.STUDENT'),
            sub: '',
            state: null,
            phone: d.parties.studentPhone,
          },
        ]
      : []),
  ];
  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-2 font-heading text-base font-bold">{t('followUp.panel.reach')}</h3>
        {reachable.length === 0 ? (
          <p className="text-sm text-on-surface-variant">{t('followUp.panel.noOne')}</p>
        ) : (
          <ul className="divide-y divide-outline-variant/40 rounded-2xl border border-outline-variant/50">
            {reachable.map((r) => (
              <li key={r.key} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">
                    <bdi>{r.name}</bdi>
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5 text-xs text-on-surface-variant">
                    {r.sub && <span>{r.sub}</span>}
                    {r.state && (
                      <span
                        className={`rounded-full px-2 py-0.5 font-semibold ${
                          r.state === 'CONNECTED'
                            ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300'
                            : r.state === 'REVOKED'
                              ? 'bg-error/10 text-error'
                              : 'bg-surface-container'
                        }`}
                      >
                        {t(`followUp.state.${r.state}`)}
                      </span>
                    )}
                    {r.phone && (
                      <span className="font-mono" dir="ltr">
                        {r.phone}
                      </span>
                    )}
                  </span>
                </span>
                {canManage && r.phone && r.state !== 'REVOKED' && (
                  <span className="flex shrink-0 gap-1.5">
                    <a
                      href={telUrl(r.phone) ?? undefined}
                      className="btn-ghost grid size-11 place-items-center p-0"
                      aria-label={t('followUp.contact.call')}
                      title={t('followUp.contact.call')}
                    >
                      <span className="material-symbols-outlined text-lg" aria-hidden>
                        call
                      </span>
                    </a>
                    <a
                      href={whatsappUrl(r.phone, lang) ?? undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-ghost grid size-11 place-items-center p-0"
                      aria-label={t('followUp.contact.whatsapp')}
                      title={t('followUp.contact.whatsapp')}
                    >
                      <span className="material-symbols-outlined text-lg" aria-hidden>
                        chat
                      </span>
                    </a>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {d.parties.registerContact && !d.parties.registerContact.invitedAs && (
          <div className="mt-2">
            <p className="text-xs text-on-surface-variant">{t('followUp.panel.contactOnlyHint')}</p>
            {onGoGuardians && (
              <button
                type="button"
                className="btn-ghost mt-1 min-h-11 px-3"
                onClick={onGoGuardians}
              >
                <span className="material-symbols-outlined text-lg" aria-hidden>
                  person_add
                </span>
                {t('followUp.panel.goGuardians')}
              </button>
            )}
          </div>
        )}
        {canManage && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" className="btn-primary min-h-11" onClick={() => setContact({})}>
              {t('followUp.contact.log')}
            </button>
            <button type="button" className="btn-ghost min-h-11" onClick={() => setManual(true)}>
              {t('followUp.case.newManual')}
            </button>
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 font-heading text-base font-bold">{t('followUp.panel.openCases')}</h3>
        {open.length === 0 ? (
          <p className="text-sm text-on-surface-variant">{t('followUp.panel.noOpen')}</p>
        ) : (
          <ul className="space-y-2">
            {open.map((c) => (
              <li key={c.id} className="rounded-2xl border border-outline-variant/50 p-3">
                <CaseLine c={c} />
                {canManage && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-ghost min-h-11 px-3"
                      onClick={() => setContact({ followUpId: c.id })}
                    >
                      {t('followUp.contact.log')}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost min-h-11 px-3"
                      onClick={() => setAssigning(c)}
                    >
                      {t('followUp.case.assign')}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost min-h-11 px-3"
                      onClick={() => setClosing(c)}
                    >
                      {t('followUp.case.close')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-2 font-heading text-base font-bold">{t('followUp.panel.contacts')}</h3>
        {d.contacts.length === 0 ? (
          <p className="text-sm text-on-surface-variant">{t('followUp.panel.noContacts')}</p>
        ) : (
          <ul className="divide-y divide-outline-variant/40 rounded-2xl border border-outline-variant/50">
            {d.contacts.map((k) => (
              <li key={k.id} className="px-3 py-2 text-sm">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold">{t(`followUp.channel.${k.channel}`)}</span>
                  <span>·</span>
                  <span>{t(`followUp.outcome.${k.outcome}`)}</span>
                  <span>·</span>
                  <span className="text-on-surface-variant">{t(`followUp.party.${k.party}`)}</span>
                </span>
                <span className="block text-xs text-on-surface-variant">
                  {k.contactedBy} · {formatInstant(k.contactedAt, d.timezone, lang)}
                </span>
                {k.note && <span className="mt-1 block whitespace-pre-line">{k.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {closed.length > 0 && (
        <section>
          <h3 className="mb-2 font-heading text-base font-bold">
            {t('followUp.panel.closedCases')}
          </h3>
          <ul className="space-y-2">
            {closed.map((c) => (
              <li
                key={c.id}
                className="rounded-2xl border border-outline-variant/40 p-3 opacity-90"
              >
                <CaseLine c={c} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <Timeline academyId={academyId} academyStudentId={academyStudentId} />

      {contact && (
        <ContactDialog
          academyId={academyId}
          academyStudentId={academyStudentId}
          followUpId={contact.followUpId}
          onClose={() => setContact(null)}
        />
      )}
      {manual && (
        <OpenCaseDialog
          academyId={academyId}
          academyStudentId={academyStudentId}
          name={d.student.fullName}
          reason="MANUAL"
          onClose={() => setManual(false)}
        />
      )}
      {closing && (
        <CloseCaseDialog academyId={academyId} c={closing} onClose={() => setClosing(null)} />
      )}
      {assigning && (
        <AssignDialog academyId={academyId} c={assigning} onClose={() => setAssigning(null)} />
      )}
    </div>
  );
}

const TL_ICON: Record<string, string> = {
  REGISTERED: 'person_add',
  WITHDRAWN: 'logout',
  REACTIVATED: 'login',
  JOINED_GROUP: 'group_add',
  LEFT_GROUP: 'group_remove',
  TRANSFERRED: 'swap_horiz',
  ATTENDANCE: 'how_to_reg',
  CARD_ISSUED: 'badge',
  CARD_REVOKED: 'credit_card_off',
  GUARDIAN_LINKED: 'family_restroom',
  GUARDIAN_REMOVED: 'person_remove',
  CASE_OPENED: 'flag',
  CASE_RESOLVED: 'task_alt',
  CASE_DISMISSED: 'do_not_disturb_on',
  CONTACT: 'call',
  FEE_CHARGE: 'receipt_long',
  FEE_VOID: 'block',
  FEE_ADJUSTMENT: 'percent',
  FEE_COLLECTION: 'payments',
  FEE_REVERSAL: 'undo',
};

/** The learner's history, newest first — exactly what the server chose to send. */
function Timeline({
  academyId,
  academyStudentId,
}: {
  academyId: string;
  academyStudentId: string;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'en' ? 'en' : 'ar';
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [tz, setTz] = useState('Africa/Cairo');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const load = async (before?: string) => {
    setLoading(true);
    try {
      const r = await fetchTimeline(academyId, academyStudentId, before);
      setItems((prev) => (before ? [...prev, ...r.items] : r.items));
      setNext(r.nextBefore);
      setTz(r.timezone);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [academyId, academyStudentId]);
  return (
    <section>
      <h3 className="mb-2 font-heading text-base font-bold">{t('followUp.timeline.title')}</h3>
      <ErrorNote error={error} />
      {!items.length && !loading ? (
        <EmptyState icon="history" title={t('followUp.timeline.empty')} />
      ) : (
        <ol className="space-y-1">
          {items.map((e) => (
            <li
              key={`${e.kind}:${e.ref}`}
              className="flex gap-2 rounded-xl px-2 py-1.5 hover:bg-surface-container-low"
            >
              <span
                className="material-symbols-outlined mt-0.5 text-lg text-on-surface-variant"
                aria-hidden
              >
                {TL_ICON[e.kind] ?? 'circle'}
              </span>
              <span className="min-w-0 flex-1 text-sm">
                <TimelineText item={e} />
                <span className="block text-xs text-on-surface-variant">
                  {dayLabel(e.localDate, lang)} · {formatInstant(e.at, tz, lang)}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {loading && (
        <div className="grid place-items-center py-4">
          <Spinner />
        </div>
      )}
      {next && !loading && (
        <button
          type="button"
          className="btn-ghost mt-2 min-h-11 w-full"
          onClick={() => void load(next)}
        >
          {t('followUp.timeline.more')}
        </button>
      )}
    </section>
  );
}

function TimelineText({ item }: { item: TimelineItem }) {
  const { t } = useTranslation();
  const d = item.data as Record<string, string | number | boolean | null>;
  const money =
    typeof d.amountCents === 'number' && typeof d.currency === 'string' ? (
      <>
        {' · '}
        <Money cents={d.amountCents} currency={d.currency} />
      </>
    ) : typeof d.deltaCents === 'number' && typeof d.currency === 'string' ? (
      <>
        {' · '}
        <Money cents={d.deltaCents} currency={d.currency} />
      </>
    ) : null;
  const extra =
    item.kind === 'ATTENDANCE'
      ? t(`followUp.attendance.${String(d.status)}`) +
        (d.makeup ? ` · ${t('followUp.timeline.makeup')}` : '')
      : item.kind === 'CONTACT'
        ? `${t(`followUp.channel.${String(d.channel)}`)} · ${t(`followUp.outcome.${String(d.outcome)}`)}`
        : item.kind.startsWith('CASE_')
          ? t(`followUp.reason.${String(d.reason)}`)
          : '';
  return (
    <span className="block">
      <span className="font-semibold">
        {t(`followUp.tl.${item.kind}`, {
          group: d.group ?? '',
          from: d.from ?? '',
          to: d.to ?? '',
          name: d.name ?? '',
          description: d.description ?? '',
          receipt: d.receiptNumber ?? '',
        })}
      </span>
      {extra && <span className="text-on-surface-variant"> · {extra}</span>}
      {money}
      {item.kind.startsWith('FEE_') && typeof d.reason === 'string' && (
        <span className="block text-xs text-on-surface-variant">{d.reason}</span>
      )}
      {(d.note || d.closeReason) && (
        <span className="block text-xs text-on-surface-variant">
          {String(d.note || d.closeReason)}
        </span>
      )}
    </span>
  );
}
