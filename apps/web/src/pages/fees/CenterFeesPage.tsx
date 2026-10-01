import { useDeferredValue, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorNote, Modal, Skeleton, Spinner, TabRail } from '../../components/ui';
import Pager from '../../components/Pager';
import { useRegistryAcademyId } from '../../lib/centerStudents';
import {
  centsToDecimal,
  downloadFeesCsv,
  fetchReceipt,
  METHODS,
  parseMoney,
  Plan,
  Receipt,
  useFeeGroups,
  useFeesAccess,
  useFeesActions,
  useFeesDay,
  useOutstanding,
  usePlans,
} from '../../lib/centerFees';
import { formatInstant } from '../../lib/classOps';
import { dayLabel, Money, MoneyInput } from './feeParts';
import { ReceiptView } from './ReceiptView';
import StudentFeesPanel from './StudentFeesPanel';

type Tab = 'today' | 'owing' | 'plans';

/**
 * The center's fees workspace (C4): the day's recorded collections, who owes
 * what, and the fee plans. Operational, not a dashboard: every number is a
 * list you can open. The center's own money — Darsly's course payments and
 * wallet are elsewhere.
 */
export default function CenterFeesPage() {
  const { t } = useTranslation();
  const academyId = useRegistryAcademyId();
  const access = useFeesAccess(academyId);
  const a = access.data;
  const [tab, setTab] = useState<Tab>('owing');

  if (!academyId || access.isLoading)
    return (
      <div className="page grid place-items-center py-24">
        <Spinner />
      </div>
    );
  if (!a?.enabled)
    return (
      <div className="page">
        <EmptyState icon="toggle_off" title={t('fees.off')} hint={t('fees.offHint')} />
      </div>
    );
  if (!a.canView)
    return (
      <div className="page">
        <EmptyState icon="lock" title={t('fees.noAccess')} hint={t('fees.noAccessHint')} />
      </div>
    );
  const tabs: Tab[] = ['owing', 'today', 'plans'];
  return (
    <div className="page max-w-5xl">
      <h1 className="mb-1 font-heading text-2xl font-extrabold sm:text-3xl">
        {t('fees.page.title')}
      </h1>
      <p className="mb-4 text-sm text-on-surface-variant">{t('fees.page.sub')}</p>
      <div className="mb-4">
        <TabRail
          tabs={tabs}
          value={tab}
          onChange={setTab}
          labelOf={(k) => t(`fees.page.tab.${k}`)}
        />
      </div>
      {tab === 'owing' && <Owing academyId={academyId} canReport={a.canReport} />}
      {tab === 'today' && (
        <Today academyId={academyId} canReport={a.canReport} canReverse={a.canReverse} />
      )}
      {tab === 'plans' && (
        <Plans academyId={academyId} canManage={a.canManage} currency={a.currency ?? 'EGP'} />
      )}
    </div>
  );
}

function Owing({ academyId, canReport }: { academyId: string; canReport: boolean }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'en' ? 'en' : 'ar';
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim());
  const [status, setStatus] = useState('OWING');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => setPage(1), [query, status]);
  const list = useOutstanding(academyId, { q: query, status, page });
  const d = list.data;
  return (
    <section>
      {d && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Figure
            label={t('fees.owed')}
            value={<Money cents={d.totals.outstandingCents} currency={d.currency} />}
          />
          <Figure
            label={t('fees.overdue')}
            value={<Money cents={d.totals.overdueCents} currency={d.currency} />}
            warn={d.totals.overdueCents > 0}
          />
          <Figure
            label={t('fees.page.studentsOwing')}
            value={<span className="tabular-nums">{d.totals.studentsOwing}</span>}
          />
        </div>
      )}
      <div className="mb-3 flex flex-col gap-2 sm:flex-row">
        <input
          type="search"
          className="input min-h-11 flex-1"
          placeholder={t('fees.page.searchPh')}
          aria-label={t('fees.page.searchPh')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {canReport && (
          <button
            type="button"
            className="btn-ghost min-h-11 px-4"
            onClick={() => void downloadFeesCsv(academyId, 'outstanding')}
          >
            <span className="material-symbols-outlined text-lg" aria-hidden>
              download
            </span>
            {t('fees.page.export')}
          </button>
        )}
      </div>
      <div
        className="mb-3 flex gap-1.5 overflow-x-auto pb-1"
        role="tablist"
        aria-label={t('fees.page.filter')}
      >
        {['OWING', 'OVERDUE', 'PARTIAL', 'PAID', 'ALL'].map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={status === s}
            onClick={() => setStatus(s)}
            className={`min-h-11 shrink-0 rounded-full px-4 text-sm font-semibold ${
              status === s
                ? 'bg-primary text-on-primary'
                : 'bg-surface-container text-on-surface-variant'
            }`}
          >
            {t(`fees.page.status.${s}`)}
          </button>
        ))}
      </div>
      {!d ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : d.items.length === 0 ? (
        <EmptyState icon="task_alt" title={t('fees.page.none')} />
      ) : (
        <ul className="divide-y divide-outline-variant/40 rounded-2xl border border-outline-variant/50">
          {d.items.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-start hover:bg-surface-container-low"
                onClick={() => setOpen({ id: r.id, name: r.fullName })}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">
                    <bdi>{r.fullName}</bdi>
                  </span>
                  <span className="block text-xs text-on-surface-variant">
                    <span className="font-mono" dir="ltr">
                      {r.code}
                    </span>
                    {r.oldestDue && (
                      <> · {t('fees.page.since', { date: dayLabel(r.oldestDue, lang) })}</>
                    )}
                  </span>
                </span>
                <span className="shrink-0 text-end">
                  <Money cents={r.outstanding} currency={d.currency} className="block font-bold" />
                  {r.overdue > 0 && (
                    <span className="block text-xs font-semibold text-amber-700 dark:text-amber-400">
                      {t('fees.overdue')} <Money cents={r.overdue} currency={d.currency} />
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {d && d.total > d.pageSize && (
        <div className="mt-3">
          <Pager page={page} pages={Math.ceil(d.total / d.pageSize)} onGo={setPage} />
        </div>
      )}
      {open && (
        <Modal open title={open.name} onClose={() => setOpen(null)} variant="sheet">
          <StudentFeesPanel academyId={academyId} academyStudentId={open.id} />
        </Modal>
      )}
    </section>
  );
}

function Today({
  academyId,
  canReport,
  canReverse,
}: {
  academyId: string;
  canReport: boolean;
  canReverse: boolean;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'en' ? 'en' : 'ar';
  const [date, setDate] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const day = useFeesDay(academyId, date, page);
  const d = day.data;
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-on-surface-variant">
            {t('fees.page.day')}
          </span>
          <input
            type="date"
            className="input min-h-11"
            value={date ?? d?.today ?? ''}
            max={d?.today}
            onChange={(e) => {
              setDate(e.target.value || undefined);
              setPage(1);
            }}
          />
        </label>
        {canReport && (
          <button
            type="button"
            className="btn-ghost min-h-11 px-4"
            onClick={() => void downloadFeesCsv(academyId, 'collections', date)}
          >
            <span className="material-symbols-outlined text-lg" aria-hidden>
              download
            </span>
            {t('fees.page.export')}
          </button>
        )}
      </div>
      {!d ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : (
        <>
          <p className="mb-2 text-xs text-on-surface-variant">
            {d.scope === 'MINE' ? t('fees.page.mine') : t('fees.page.recorded')}
          </p>
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Figure
              label={t('fees.page.total')}
              value={<Money cents={d.totals.amountCents} currency={d.currency} />}
              strong
            />
            <Figure
              label={t('fees.page.count')}
              value={<span className="tabular-nums">{d.totals.count}</span>}
            />
            {METHODS.map((m) => (
              <Figure
                key={m}
                label={t(`fees.method.${m}`)}
                value={<Money cents={d.totals.byMethod[m].amountCents} currency={d.currency} />}
              />
            ))}
            {d.totals.reversed.count > 0 && (
              <Figure
                label={t('fees.page.reversed')}
                value={<Money cents={d.totals.reversed.amountCents} currency={d.currency} />}
              />
            )}
          </div>
          {d.items.length === 0 ? (
            <EmptyState icon="savings" title={t('fees.page.noCollections')} />
          ) : (
            <ul className="divide-y divide-outline-variant/40 rounded-2xl border border-outline-variant/50">
              {d.items.map((k) => (
                <li key={k.id}>
                  <button
                    type="button"
                    className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-start hover:bg-surface-container-low"
                    onClick={async () => setReceipt(await fetchReceipt(academyId, k.id))}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">
                        <bdi>{k.student.fullName}</bdi>
                      </span>
                      <span className="block text-xs text-on-surface-variant">
                        <span className="font-mono" dir="ltr">
                          {k.receiptNumber}
                        </span>{' '}
                        · {t(`fees.method.${k.method}`)} · <bdi>{k.collector}</bdi>
                        {' · '}
                        {formatInstant(k.receivedAt, d.timezone, lang)}
                      </span>
                    </span>
                    {k.reversedAt && (
                      <span className="text-xs font-bold text-error">
                        {t('fees.receipt.reversedShort')}
                      </span>
                    )}
                    <Money
                      cents={k.amountCents}
                      currency={k.currency}
                      className={`shrink-0 font-bold ${k.reversedAt ? 'line-through opacity-60' : ''}`}
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {d.total > d.pageSize && (
            <div className="mt-3">
              <Pager page={page} pages={Math.ceil(d.total / d.pageSize)} onGo={setPage} />
            </div>
          )}
          <p className="mt-2 text-xs text-outline">{dayLabel(d.date, lang)}</p>
        </>
      )}
      {receipt && (
        <Modal open title={t('fees.receipt.title')} onClose={() => setReceipt(null)}>
          <ReceiptView
            receipt={receipt}
            academyId={academyId}
            canReverse={canReverse}
            onDone={() => setReceipt(null)}
          />
        </Modal>
      )}
    </section>
  );
}

function Plans({
  academyId,
  canManage,
  currency,
}: {
  academyId: string;
  canManage: boolean;
  currency: string;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'en' ? 'en' : 'ar';
  const plans = usePlans(academyId);
  const act = useFeesActions(academyId);
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  return (
    <section>
      <p className="mb-3 text-sm text-on-surface-variant">{t('fees.plan.policy')}</p>
      {canManage && (
        <button
          type="button"
          className="btn-primary mb-3 min-h-11 px-4"
          onClick={() => setEditing('new')}
        >
          <span className="material-symbols-outlined text-lg" aria-hidden>
            add
          </span>
          {t('fees.plan.new')}
        </button>
      )}
      {!plans.data ? (
        <Skeleton className="h-32 rounded-2xl" />
      ) : plans.data.length === 0 ? (
        <EmptyState
          icon="request_quote"
          title={t('fees.plan.none')}
          hint={t('fees.plan.noneHint')}
        />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {plans.data.map((p) => (
            <li key={p.id} className={`card p-4 ${p.status === 'ARCHIVED' ? 'opacity-60' : ''}`}>
              <p className="font-bold [overflow-wrap:anywhere]">
                <bdi>{p.name}</bdi>
              </p>
              <p className="text-sm text-on-surface-variant">
                <bdi>{p.group.name}</bdi> · {t(`fees.plan.type.${p.type}`)}
              </p>
              <p className="mt-2 text-lg font-extrabold">
                <Money cents={p.amountCents} currency={p.currency} />
                <span className="ms-1 text-sm font-normal text-on-surface-variant">
                  {p.type === 'MONTHLY' ? t('fees.plan.perMonth') : t('fees.plan.perClass')}
                </span>
              </p>
              <p className="text-xs text-on-surface-variant">
                {t('fees.plan.from', { date: dayLabel(p.startsOn, lang) })}
                {p.dueDay ? ` · ${t('fees.plan.dueDayIs', { day: p.dueDay })}` : ''} ·{' '}
                {t('fees.plan.charges', { count: p.charges })}
                {p.status === 'ARCHIVED' ? ` · ${t('fees.plan.archived')}` : ''}
              </p>
              {canManage && p.status === 'ACTIVE' && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-ghost min-h-11 px-3 text-sm"
                    onClick={() => setEditing(p)}
                  >
                    {t('fees.plan.edit')}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost min-h-11 px-3 text-sm"
                    disabled={act.generate.isPending}
                    onClick={() => act.generate.mutate(p.id)}
                  >
                    {t('fees.plan.generate')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <PlanDialog
          academyId={academyId}
          currency={currency}
          plan={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function PlanDialog({
  academyId,
  currency,
  plan,
  onClose,
}: {
  academyId: string;
  currency: string;
  plan: Plan | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const groups = useFeeGroups(academyId, !plan);
  const act = useFeesActions(academyId);
  const [name, setName] = useState(plan?.name ?? '');
  const [groupId, setGroupId] = useState('');
  const [type, setType] = useState<Plan['type']>(plan?.type ?? 'MONTHLY');
  const [text, setText] = useState(plan ? centsToDecimal(plan.amountCents) : '');
  const [dueDay, setDueDay] = useState(String(plan?.dueDay ?? 1));
  const [posted, setPosted] = useState<number | null>(null);
  const cents = parseMoney(text);
  const err = plan ? act.updatePlan.error : act.createPlan.error;
  const pending = act.createPlan.isPending || act.updatePlan.isPending;
  const ok = name.trim() && cents && (plan || groupId);
  return (
    <Modal open title={plan ? t('fees.plan.editTitle') : t('fees.plan.new')} onClose={onClose}>
      {posted != null ? (
        <>
          <p className="mb-4 rounded-xl bg-surface-container-low p-3 font-semibold" role="status">
            {t('fees.plan.created', { count: posted })}
          </p>
          <button type="button" className="btn-primary min-h-11 w-full" onClick={onClose}>
            {t('fees.receipt.done')}
          </button>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!ok || pending) return;
            if (plan)
              act.updatePlan.mutate(
                {
                  id: plan.id,
                  name: name.trim(),
                  amountCents: cents,
                  ...(plan.type === 'MONTHLY' ? { dueDay: Number(dueDay) } : {}),
                },
                { onSuccess: onClose },
              );
            else
              act.createPlan.mutate(
                {
                  name: name.trim(),
                  groupId,
                  type,
                  amountCents: cents,
                  ...(type === 'MONTHLY' ? { dueDay: Number(dueDay) } : {}),
                },
                { onSuccess: (r) => setPosted(r.posted) },
              );
          }}
        >
          <label className="mb-3 block">
            <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
              {t('fees.plan.name')}
            </span>
            <input
              className="input min-h-11"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              autoFocus
            />
          </label>
          {!plan && (
            <>
              <label className="mb-3 block">
                <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
                  {t('fees.plan.group')}
                </span>
                <select
                  className="input min-h-11"
                  value={groupId}
                  onChange={(e) => setGroupId(e.target.value)}
                  required
                >
                  <option value="">{t('fees.plan.pickGroup')}</option>
                  {(groups.data ?? []).map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </label>
              <div
                className="mb-3 grid grid-cols-2 gap-2"
                role="radiogroup"
                aria-label={t('fees.plan.typeLabel')}
              >
                {(['MONTHLY', 'PER_SESSION'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={type === k}
                    onClick={() => setType(k)}
                    className={`min-h-12 rounded-xl border px-3 text-sm font-semibold ${type === k ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/60'}`}
                  >
                    {t(`fees.plan.type.${k}`)}
                  </button>
                ))}
              </div>
              <p className="mb-3 text-xs text-on-surface-variant">
                {t(`fees.plan.typeHint.${type}`)}
              </p>
            </>
          )}
          <MoneyInput
            label={type === 'MONTHLY' ? t('fees.plan.amountMonth') : t('fees.plan.amountClass')}
            value={text}
            onChange={setText}
            currency={currency}
          />
          {type === 'MONTHLY' && (
            <label className="mb-3 block">
              <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
                {t('fees.plan.dueDay')}
              </span>
              <select
                className="input min-h-11"
                value={dueDay}
                onChange={(e) => setDueDay(e.target.value)}
              >
                {Array.from({ length: 28 }, (_, i) => String(i + 1)).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="mb-3 text-xs text-on-surface-variant">
            {plan ? t('fees.plan.changeHint') : t('fees.plan.startHint')}
          </p>
          <ErrorNote error={err} />
          <button
            type="submit"
            className="btn-primary mt-2 min-h-12 w-full"
            disabled={!ok || pending}
            aria-busy={pending}
          >
            {plan ? t('common.save') : t('fees.plan.create')}
          </button>
          {plan && (
            <button
              type="button"
              className="btn-ghost mt-2 min-h-11 w-full text-error"
              disabled={pending}
              onClick={() =>
                act.updatePlan.mutate({ id: plan.id, status: 'ARCHIVED' }, { onSuccess: onClose })
              }
            >
              {t('fees.plan.archive')}
            </button>
          )}
        </form>
      )}
    </Modal>
  );
}

function Figure({
  label,
  value,
  warn,
  strong,
}: {
  label: string;
  value: React.ReactNode;
  warn?: boolean;
  strong?: boolean;
}) {
  return (
    <div className={`card min-w-0 p-3 ${warn ? 'border-2 border-amber-500/50' : ''}`}>
      <p className="line-clamp-2 text-xs text-on-surface-variant">{label}</p>
      <p
        className={`${strong ? 'text-lg' : 'text-sm'} overflow-hidden text-ellipsis font-extrabold`}
      >
        {value}
      </p>
    </div>
  );
}
