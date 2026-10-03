import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import Pager from '../../components/Pager';
import { EmptyState, ErrorNote, Modal, Skeleton, Spinner, TabRail } from '../../components/ui';
import { newRequestKey, parseMoney } from '../../lib/centerFees';
import { useRegistryAcademyId } from '../../lib/centerStudents';
import { formatInstant } from '../../lib/classOps';
import { confirmDelete } from '../../lib/confirm';
import {
  Agreement,
  PayMethod,
  TeacherRow,
  usePreview,
  useSettlementAccess,
  useSettlementActions,
  useSettlementGroups,
  useSettlements,
  useTeachers,
} from '../../lib/settlements';
import { dayLabel, Money, MoneyInput } from '../fees/feeParts';

type Tab = 'teachers' | 'settle' | 'settlements';

/**
 * What the center owes and pays its teachers (C8). Agreements say how a
 * teacher is paid from which date; a settlement freezes one period's figures,
 * computed by the server from the classes taught and money collected; payments
 * record that the center paid. Never Darsly's money, never students' fees.
 */
export default function SettlementsPage() {
  const { t } = useTranslation();
  const academyId = useRegistryAcademyId();
  const access = useSettlementAccess(academyId);
  const a = access.data;
  const [tab, setTab] = useState<Tab>('settlements');
  if (!academyId || access.isLoading)
    return (
      <div className="page grid place-items-center py-24">
        <Spinner />
      </div>
    );
  if (!a?.enabled)
    return (
      <div className="page">
        <EmptyState icon="toggle_off" title={t('settle.off')} hint={t('settle.offHint')} />
      </div>
    );
  if (!a.canView)
    return (
      <div className="page">
        <EmptyState icon="lock" title={t('settle.noAccess')} hint={t('settle.noAccessHint')} />
      </div>
    );
  const tabs: Tab[] = ['settlements', 'settle', 'teachers'];
  return (
    <div className="page max-w-5xl">
      <h1 className="mb-1 font-heading text-2xl font-extrabold sm:text-3xl">{t('settle.title')}</h1>
      <p className="mb-4 text-sm text-on-surface-variant">{t('settle.sub')}</p>
      <div className="mb-4">
        <TabRail tabs={tabs} value={tab} onChange={setTab} labelOf={(k) => t(`settle.tab.${k}`)} />
      </div>
      {tab === 'settlements' && <SettlementList academyId={academyId} />}
      {tab === 'settle' && <Settle academyId={academyId} canFinalize={a.canFinalize} />}
      {tab === 'teachers' && <Teachers academyId={academyId} canManage={a.canManage} />}
    </div>
  );
}

const rateText = (a: Agreement, t: (k: string, o?: Record<string, unknown>) => string) =>
  a.method === 'PERCENT_OF_COLLECTIONS'
    ? t('settle.rate.percent', { pct: (a.percentBps ?? 0) / 100 })
    : t(a.method === 'PER_SESSION' ? 'settle.rate.perSession' : 'settle.rate.fixed');

function Teachers({ academyId, canManage }: { academyId: string; canManage: boolean }) {
  const { t, i18n } = useTranslation();
  const q = useTeachers(academyId);
  const groups = useSettlementGroups(academyId);
  const act = useSettlementActions(academyId);
  const [adding, setAdding] = useState<TeacherRow | null>(null);
  const groupName = (id: string) => groups.data?.find((g) => g.id === id)?.name ?? '';
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Skeleton className="h-48 rounded-2xl" />;
  if (!q.data.length) return <EmptyState icon="person_off" title={t('settle.noTeachers')} />;
  return (
    <section className="space-y-3">
      {q.data.map((row) => (
        <article key={row.userId} className="card p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-heading text-lg font-bold">{row.name}</h2>
            {canManage && (
              <button
                type="button"
                className="btn-ghost min-h-11 px-4"
                onClick={() => setAdding(row)}
              >
                {t('settle.agreement.add')}
              </button>
            )}
          </div>
          {!row.agreements.length ? (
            <p className="text-sm text-on-surface-variant">{t('settle.agreement.none')}</p>
          ) : (
            <ul className="divide-y divide-outline-variant/40 text-sm">
              {row.agreements.map((ag) => (
                <li key={ag.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="min-w-0 flex-1 basis-48">
                    <span className="block font-semibold">
                      {t(`settle.method.${ag.method}`)} · {rateText(ag, t)}{' '}
                      {ag.rateCents != null && (
                        <Money cents={ag.rateCents} currency={ag.currency} />
                      )}
                    </span>
                    <span className="block text-xs text-on-surface-variant">
                      {t('settle.agreement.from', {
                        date: dayLabel(ag.effectiveFrom, i18n.language),
                      })}
                      {ag.effectiveTo
                        ? ` · ${t('settle.agreement.to', { date: dayLabel(ag.effectiveTo, i18n.language) })}`
                        : ` · ${t('settle.agreement.open')}`}
                      {ag.groupIds.length > 0 && ` · ${ag.groupIds.map(groupName).join('، ')}`}
                    </span>
                  </span>
                  {canManage && !ag.ended && (
                    <EndAgreement
                      academyId={academyId}
                      agreement={ag}
                      pending={act.endAgreement.isPending}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
      {adding && (
        <AgreementDialog academyId={academyId} teacher={adding} onClose={() => setAdding(null)} />
      )}
    </section>
  );
}

function EndAgreement({
  academyId,
  agreement,
  pending,
}: {
  academyId: string;
  agreement: Agreement;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const act = useSettlementActions(academyId);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  return (
    <>
      <button
        type="button"
        className="btn-ghost min-h-11 px-3 text-sm"
        disabled={pending}
        onClick={() => setOpen(true)}
      >
        {t('settle.agreement.end')}
      </button>
      {open && (
        <Modal open title={t('settle.agreement.endTitle')} onClose={() => setOpen(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                !date ||
                !(await confirmDelete({
                  kind: 'cancel',
                  message: t('settle.agreement.endConfirm', { date }),
                }))
              )
                return;
              act.endAgreement.mutate(
                { id: agreement.id, effectiveTo: date },
                { onSuccess: () => setOpen(false) },
              );
            }}
          >
            <label className="mb-3 block">
              <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
                {t('settle.agreement.lastDay')}
              </span>
              <input
                type="date"
                className="input min-h-11"
                value={date}
                min={agreement.effectiveFrom}
                onChange={(e) => setDate(e.target.value)}
                required
              />
              <span className="mt-1 block text-xs text-on-surface-variant">
                {t('settle.agreement.endHint')}
              </span>
            </label>
            <ErrorNote error={act.endAgreement.error} />
            <button
              type="submit"
              className="btn-primary mt-2 min-h-12 w-full"
              disabled={!date || act.endAgreement.isPending}
            >
              {t('settle.agreement.end')}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}

function AgreementDialog({
  academyId,
  teacher,
  onClose,
}: {
  academyId: string;
  teacher: TeacherRow;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const act = useSettlementActions(academyId);
  const groups = useSettlementGroups(academyId);
  const [method, setMethod] = useState<PayMethod>('PER_SESSION');
  const [rate, setRate] = useState('');
  const [pct, setPct] = useState('');
  const [scope, setScope] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const [requestKey] = useState(newRequestKey);
  const cents = parseMoney(rate);
  const bps = /^\d{1,3}(\.\d{1,2})?$/.test(pct.trim()) ? Math.round(Number(pct) * 100) : null;
  const ok =
    !!from &&
    (method === 'PERCENT_OF_COLLECTIONS'
      ? !!bps && bps >= 1 && bps <= 10_000 && scope.length > 0
      : !!cents);
  const currency = teacher.agreements[0]?.currency ?? 'EGP';
  return (
    <Modal open title={t('settle.agreement.addTitle', { name: teacher.name })} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok || act.createAgreement.isPending) return;
          act.createAgreement.mutate(
            {
              requestKey,
              teacherUserId: teacher.userId,
              method,
              effectiveFrom: from,
              ...(method === 'PERCENT_OF_COLLECTIONS'
                ? { percentBps: bps!, groupIds: scope }
                : {
                    rateCents: cents!,
                    ...(method === 'PER_SESSION' && scope.length ? { groupIds: scope } : {}),
                  }),
            },
            { onSuccess: onClose },
          );
        }}
      >
        <div className="mb-3 grid gap-2 sm:grid-cols-3" role="radiogroup">
          {(['PER_SESSION', 'PERCENT_OF_COLLECTIONS', 'FIXED_PERIOD'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={method === m}
              onClick={() => setMethod(m)}
              className={`min-h-12 rounded-xl border px-3 text-sm font-semibold ${method === m ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/60'}`}
            >
              {t(`settle.method.${m}`)}
            </button>
          ))}
        </div>
        <p className="mb-3 text-xs text-on-surface-variant">{t(`settle.methodHint.${method}`)}</p>
        {method === 'PERCENT_OF_COLLECTIONS' ? (
          <label className="mb-3 block">
            <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
              {t('settle.agreement.percent')}
            </span>
            <input
              className="input min-h-11"
              inputMode="decimal"
              dir="ltr"
              value={pct}
              onChange={(e) => setPct(e.target.value)}
              required
            />
          </label>
        ) : (
          <div className="mb-3">
            <MoneyInput
              label={t(
                method === 'PER_SESSION'
                  ? 'settle.agreement.perClass'
                  : 'settle.agreement.perMonth',
              )}
              value={rate}
              onChange={setRate}
              currency={currency}
            />
          </div>
        )}
        {method !== 'FIXED_PERIOD' && (
          <fieldset className="mb-3">
            <legend className="mb-1.5 text-sm font-semibold text-on-surface-variant">
              {t(
                method === 'PERCENT_OF_COLLECTIONS'
                  ? 'settle.agreement.groupsRequired'
                  : 'settle.agreement.groupsOptional',
              )}
            </legend>
            <div className="max-h-44 overflow-y-auto rounded-xl border border-outline-variant/60 p-2">
              {(groups.data ?? []).map((g) => (
                <label key={g.id} className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-5"
                    checked={scope.includes(g.id)}
                    onChange={(e) =>
                      setScope((s) =>
                        e.target.checked ? [...s, g.id] : s.filter((x) => x !== g.id),
                      )
                    }
                  />
                  {g.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <label className="mb-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('settle.agreement.effectiveFrom')}
          </span>
          <input
            type="date"
            className="input min-h-11"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            required
          />
          <span className="mt-1 block text-xs text-on-surface-variant">
            {t('settle.agreement.fromHint')}
          </span>
        </label>
        <ErrorNote error={act.createAgreement.error} />
        <button
          type="submit"
          className="btn-primary mt-2 min-h-12 w-full"
          disabled={!ok || act.createAgreement.isPending}
          aria-busy={act.createAgreement.isPending}
        >
          {t('settle.agreement.save')}
        </button>
      </form>
    </Modal>
  );
}

function Settle({ academyId, canFinalize }: { academyId: string; canFinalize: boolean }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const teachers = useTeachers(academyId);
  const act = useSettlementActions(academyId);
  const [teacherUserId, setTeacher] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const p = usePreview(academyId, {
    teacherUserId: teacherUserId || undefined,
    from: from || undefined,
    to: to || undefined,
  });
  const d = p.data;
  return (
    <section>
      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('settle.teacher')}
          </span>
          <select
            className="input min-h-11"
            value={teacherUserId}
            onChange={(e) => setTeacher(e.target.value)}
          >
            <option value="">{t('settle.pickTeacher')}</option>
            {(teachers.data ?? []).map((x) => (
              <option key={x.userId} value={x.userId}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('settle.from')}
          </span>
          <input
            type="date"
            className="input min-h-11"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('settle.to')}
          </span>
          <input
            type="date"
            className="input min-h-11"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
      </div>
      {!teacherUserId || !from || !to ? (
        <p className="text-sm text-on-surface-variant">{t('settle.pickPeriod')}</p>
      ) : p.error ? (
        <ErrorNote error={p.error} />
      ) : !d ? (
        <Skeleton className="h-48 rounded-2xl" />
      ) : (
        <>
          <div className="card mb-4 flex flex-wrap items-center justify-between gap-3 p-4">
            <span>
              <span className="block text-sm text-on-surface-variant">{t('settle.gross')}</span>
              <Money
                cents={d.grossCents}
                currency={d.currency}
                className="text-xl font-extrabold"
              />
            </span>
            {canFinalize && (
              <button
                type="button"
                className="btn-primary min-h-12 px-5"
                disabled={!d.lines.length || !!d.overlapsSettlement || act.finalize.isPending}
                aria-busy={act.finalize.isPending}
                onClick={() =>
                  act.finalize.mutate(
                    { requestKey, teacherUserId, from, to, expectedGrossCents: d.grossCents },
                    {
                      onSuccess: (r) =>
                        navigate(`/center/settlements/${r.settlement.id}?academy=${academyId}`),
                      onError: () => setRequestKey(newRequestKey()),
                    },
                  )
                }
              >
                {t('settle.finalize')}
              </button>
            )}
          </div>
          <ErrorNote error={act.finalize.error} />
          {d.overlapsSettlement && (
            <p className="mb-3 rounded-xl bg-amber-500/10 p-3 text-sm" role="status">
              <Link
                className="inline-flex min-h-11 items-center font-semibold text-primary"
                to={`/center/settlements/${d.overlapsSettlement.id}?academy=${academyId}`}
              >
                {t('settle.overlaps', {
                  from: d.overlapsSettlement.from,
                  to: d.overlapsSettlement.to,
                })}
              </Link>
            </p>
          )}
          {d.pending.length > 0 && (
            <section className="card mb-4 p-4">
              <h2 className="mb-1 font-heading text-lg font-bold">{t('settle.pending')}</h2>
              <p className="mb-2 text-xs text-on-surface-variant">{t('settle.pendingHint')}</p>
              <ul className="space-y-1 text-sm">
                {d.pending.map((x) => (
                  <li key={x.sessionId}>
                    <Link
                      className="flex min-h-11 items-center font-semibold text-primary"
                      to={`/classes/${x.sessionId}?academy=${academyId}`}
                    >
                      {x.groupName} · {dayLabel(x.startAt.slice(0, 10), i18n.language)} ·{' '}
                      {t(`settle.why.${x.why}`)}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Lines lines={d.lines} currency={d.currency} timezone={d.timezone} />
        </>
      )}
    </section>
  );
}

export function Lines({
  lines,
  currency,
  timezone,
}: {
  lines: { kind: string; sourceId: string; amountCents: number; detail: Record<string, unknown> }[];
  currency: string;
  timezone: string;
}) {
  const { t, i18n } = useTranslation();
  if (!lines.length)
    return <p className="text-sm text-on-surface-variant">{t('settle.noLines')}</p>;
  return (
    <section className="card p-4">
      <h2 className="mb-2 font-heading text-lg font-bold">
        {t('settle.lines', { count: lines.length })}
      </h2>
      <ul className="divide-y divide-outline-variant/40 text-sm">
        {lines.map((l) => (
          <li
            key={`${l.kind}-${l.sourceId}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
          >
            <span className="min-w-0 flex-1 basis-48">
              <span className="block font-semibold">{t(`settle.kind.${l.kind}`)}</span>
              <span className="block text-xs text-on-surface-variant">
                {l.kind === 'SESSION' &&
                  `${String(l.detail.groupName ?? '')} · ${dayLabel(String(l.detail.startAt).slice(0, 10), i18n.language)} · ${formatInstant(String(l.detail.startAt), timezone, i18n.language)}`}
                {l.kind === 'COLLECTION' &&
                  t('settle.collectionLine', {
                    receipt: String(l.detail.receiptNumber ?? ''),
                    code: String(l.detail.studentCode ?? ''),
                    pct: Number(l.detail.percentBps) / 100,
                  })}
                {l.kind === 'FIXED' &&
                  t('settle.fixedLine', {
                    month: String(l.detail.month),
                    days: Number(l.detail.coveredDays),
                    of: Number(l.detail.daysInMonth),
                  })}
              </span>
            </span>
            <Money cents={l.amountCents} currency={currency} className="shrink-0 font-bold" />
          </li>
        ))}
      </ul>
    </section>
  );
}

function SettlementList({ academyId }: { academyId: string }) {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState(1);
  const q = useSettlements(academyId, { page });
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Skeleton className="h-48 rounded-2xl" />;
  if (!q.data.items.length)
    return <EmptyState icon="request_quote" title={t('settle.none')} hint={t('settle.noneHint')} />;
  return (
    <>
      <ul className="space-y-2">
        {q.data.items.map((s) => (
          <li key={s.id}>
            <Link
              to={`/center/settlements/${s.id}?academy=${academyId}`}
              className="card flex min-h-16 flex-wrap items-center gap-x-3 gap-y-1 p-3 hover:border-primary"
            >
              <span className="min-w-0 flex-1 basis-48">
                <span className="block truncate font-bold">{s.teacherName}</span>
                <span className="block text-xs text-on-surface-variant">
                  {dayLabel(s.periodFrom, i18n.language)} → {dayLabel(s.periodTo, i18n.language)}
                </span>
              </span>
              <span className="shrink-0 text-end text-sm">
                <Money cents={s.payableCents} currency={s.currency} className="block font-bold" />
                <span className="block text-xs text-on-surface-variant">
                  {t(`settle.status.${s.status}`)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <Pager page={page} pages={Math.ceil(q.data.total / q.data.pageSize)} onGo={setPage} />
    </>
  );
}
