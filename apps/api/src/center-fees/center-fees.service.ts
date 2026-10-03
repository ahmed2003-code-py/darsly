import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AcademyContext } from '../academy/academy-context';
import { AuditService } from '../audit/audit.service';
import { ClassScheduleService } from '../class-ops/class-schedule.service';
import { dateValue, localDayBounds, wallClock } from '../class-ops/zoned-time';
import { PrismaService } from '../prisma/prisma.service';
import { AdjustDto, CollectDto, OneTimeChargeDto, OutstandingQuery, PreviewDto } from './dto';
import { allocateOldestFirst, chargeStatus, percentOf } from './money';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;
const PAGE = 25;

interface BalanceRow {
  chargeId: string;
  kind: 'MONTHLY' | 'PER_SESSION' | 'ONE_TIME';
  description: string;
  period: string | null;
  groupSessionId: string | null;
  amountCents: number;
  currency: string;
  dueOn: Date;
  createdAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
  netCents: number;
  paidCents: number;
  outstandingCents: number;
}

/**
 * Center Operations C4 — what a learner owes the center, and what the center
 * received. The center's own money: this service never touches a platform
 * table (Payment, ledger, wallet, payout, Live purchase) — see
 * center-fees.boundary.spec.ts, which fails the build if it ever does.
 *
 * BALANCE has one definition, the CenterChargeBalance view: net = posted
 * amount + adjustments (0 once void), paid = allocations of collections not
 * reversed, outstanding = net − paid. Every screen, report and receipt here
 * reads it through balances(); nothing else adds money up.
 *
 * ONE LOCK. Every write that moves a learner's balance — collect, reverse,
 * adjust, void, a one-time charge — first takes FOR UPDATE on the learner's
 * register row (AcademyStudent). Two desks collecting the last 200, a
 * discount racing a collection, a double click: they queue, and each sees
 * the other's result. The database re-checks at commit (no over-allocation,
 * no negative balance, every collection fully allocated).
 */
@Injectable()
export class CenterFeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: ClassScheduleService,
    private readonly audit: AuditService,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────

  /** The one balance read: every charge of a learner with its net, paid and outstanding. */
  async balances(db: Db, academyId: string, academyStudentId: string): Promise<BalanceRow[]> {
    return db.$queryRaw<BalanceRow[]>`
      SELECT b."chargeId", c.kind, c.description, c.period, c."groupSessionId", c."amountCents", c.currency,
             c."dueOn", c."createdAt", c."voidedAt", c."voidReason",
             b."netCents", b."paidCents", b."outstandingCents"
      FROM "CenterChargeBalance" b JOIN "CenterCharge" c ON c.id = b."chargeId"
      WHERE b."academyId" = ${academyId} AND b."academyStudentId" = ${academyStudentId}
      ORDER BY c."dueOn", c."createdAt", c.id`;
  }

  /** The compact picture (Desk, Student 360 header): owed, overdue, next due. */
  // ── Reads for other Center Operations phases (C5) ──────────────────────
  //
  // C5 never touches a C4 model (center-fees.boundary.spec.ts): what it needs
  // from the fees it asks here, so the balance has one definition and one
  // owner. All three are reads; none takes a lock or writes.

  /**
   * Every learner in the academy with money still owed on a charge due BEFORE
   * `dueBefore` (a local date), from the balance view: how much, and the
   * oldest such charge. One set-based query — never per learner.
   */
  async overdueLearners(academyId: string, dueBefore: string) {
    return this.prisma.$queryRaw<
      {
        academyStudentId: string;
        overdueCents: number;
        oldestChargeId: string;
        oldestDueOn: string;
      }[]
    >`
      SELECT DISTINCT ON (c."academyStudentId")
             c."academyStudentId",
             (sum(b."outstandingCents") OVER (PARTITION BY c."academyStudentId"))::int AS "overdueCents",
             c.id AS "oldestChargeId",
             c."dueOn"::text AS "oldestDueOn"
      FROM "CenterChargeBalance" b JOIN "CenterCharge" c ON c.id = b."chargeId"
      WHERE b."academyId" = ${academyId} AND c."voidedAt" IS NULL
        AND b."outstandingCents" > 0 AND c."dueOn" < ${dueBefore}::date
      ORDER BY c."academyStudentId", c."dueOn", c."createdAt", c.id`;
  }

  /**
   * What a guardian may be shown when the academy chose to (C5): what is owed,
   * what of it is overdue, and the receipts — number, date, amount, method,
   * whether reversed. Never notes, reasons, who collected, adjustments or any
   * other learner. Null when the learner has no fees here.
   */
  async guardianView(academyId: string, academyStudentId: string) {
    const [rows, clock, currency, receipts] = await Promise.all([
      this.balances(this.prisma, academyId, academyStudentId),
      this.schedule.academyClock(academyId),
      this.currencyOf(academyId),
      this.prisma.centerCollection.findMany({
        where: { academyId, academyStudentId },
        orderBy: { receivedAt: 'desc' },
        take: 20,
        select: {
          receiptNumber: true,
          receivedAt: true,
          amountCents: true,
          currency: true,
          method: true,
          reversedAt: true,
        },
      }),
    ]);
    if (!rows.length && !receipts.length) return null;
    const s = this.summarize(rows, clock.today, currency);
    return {
      currency: s.currency,
      outstandingCents: s.outstandingCents,
      overdueCents: s.overdueCents,
      receipts: receipts.map((k) => ({
        receiptNumber: k.receiptNumber,
        localDate: wallClock(k.receivedAt, clock.timezone).date,
        amountCents: k.amountCents,
        currency: k.currency,
        method: k.method,
        reversed: !!k.reversedAt,
      })),
    };
  }

  /**
   * A learner's fee events before `before`, newest first, at most `limit` —
   * for the Student 360 timeline of a caller who holds fees.view (C5 checks
   * that before it asks). Charges posted and voided, adjustments, collections
   * and reversals; times are instants.
   */
  async timelineEvents(academyId: string, academyStudentId: string, before: Date, limit: number) {
    const [charges, voids, adjustments, collections, reversals] = await Promise.all([
      this.prisma.centerCharge.findMany({
        where: { academyId, academyStudentId, createdAt: { lt: before } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          kind: true,
          description: true,
          period: true,
          amountCents: true,
          currency: true,
          createdAt: true,
        },
      }),
      this.prisma.centerCharge.findMany({
        where: { academyId, academyStudentId, voidedAt: { lt: before } },
        orderBy: { voidedAt: 'desc' },
        take: limit,
        select: {
          id: true,
          description: true,
          amountCents: true,
          currency: true,
          voidedAt: true,
          voidReason: true,
        },
      }),
      this.prisma.centerAdjustment.findMany({
        where: { academyId, charge: { academyStudentId }, createdAt: { lt: before } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          kind: true,
          deltaCents: true,
          reason: true,
          createdAt: true,
          charge: { select: { description: true, currency: true } },
        },
      }),
      this.prisma.centerCollection.findMany({
        where: { academyId, academyStudentId, receivedAt: { lt: before } },
        orderBy: { receivedAt: 'desc' },
        take: limit,
        select: {
          id: true,
          receiptNumber: true,
          amountCents: true,
          currency: true,
          method: true,
          receivedAt: true,
        },
      }),
      this.prisma.centerCollection.findMany({
        where: { academyId, academyStudentId, reversedAt: { lt: before } },
        orderBy: { reversedAt: 'desc' },
        take: limit,
        select: {
          id: true,
          receiptNumber: true,
          amountCents: true,
          currency: true,
          reversedAt: true,
          reversalReason: true,
        },
      }),
    ]);
    return [
      ...charges.map((c) => ({
        at: c.createdAt,
        kind: 'FEE_CHARGE' as const,
        ref: c.id,
        data: {
          chargeKind: c.kind,
          description: c.description,
          period: c.period,
          amountCents: c.amountCents,
          currency: c.currency,
        },
      })),
      ...voids.map((c) => ({
        at: c.voidedAt!,
        kind: 'FEE_VOID' as const,
        ref: c.id,
        data: {
          description: c.description,
          amountCents: c.amountCents,
          currency: c.currency,
          reason: c.voidReason,
        },
      })),
      ...adjustments.map((a) => ({
        at: a.createdAt,
        kind: 'FEE_ADJUSTMENT' as const,
        ref: a.id,
        data: {
          adjustmentKind: a.kind,
          deltaCents: a.deltaCents,
          currency: a.charge.currency,
          description: a.charge.description,
          reason: a.reason,
        },
      })),
      ...collections.map((k) => ({
        at: k.receivedAt,
        kind: 'FEE_COLLECTION' as const,
        ref: k.id,
        data: {
          receiptNumber: k.receiptNumber,
          amountCents: k.amountCents,
          currency: k.currency,
          method: k.method,
        },
      })),
      ...reversals.map((k) => ({
        at: k.reversedAt!,
        kind: 'FEE_REVERSAL' as const,
        ref: k.id,
        data: {
          receiptNumber: k.receiptNumber,
          amountCents: k.amountCents,
          currency: k.currency,
          reason: k.reversalReason,
        },
      })),
    ];
  }

  async summary(ctx: AcademyContext, academyStudentId: string) {
    const s = await this.studentIn(ctx, academyStudentId);
    const [rows, clock, currency] = await Promise.all([
      this.balances(this.prisma, ctx.academyId, s.id),
      this.schedule.academyClock(ctx.academyId),
      this.currencyOf(ctx.academyId),
    ]);
    return this.summarize(rows, clock.today, currency);
  }

  private summarize(rows: BalanceRow[], today: string, currency: string) {
    let outstanding = 0;
    let overdue = 0;
    let next: { dueOn: string; outstandingCents: number; description: string } | null = null;
    let open = 0;
    for (const r of rows) {
      if (r.voidedAt || r.outstandingCents <= 0) continue;
      open++;
      outstanding += r.outstandingCents;
      const due = day(r.dueOn);
      if (due < today) overdue += r.outstandingCents;
      else if (!next || due < next.dueOn)
        next = { dueOn: due, outstandingCents: r.outstandingCents, description: r.description };
    }
    return {
      currency,
      today,
      outstandingCents: outstanding,
      overdueCents: overdue,
      openCharges: open,
      nextDue: next,
    };
  }

  /** Student 360: the summary, every charge with its state, adjustments, collections. */
  async student(ctx: AcademyContext, academyStudentId: string) {
    const s = await this.studentIn(ctx, academyStudentId);
    const [rows, clock, currency] = await Promise.all([
      this.balances(this.prisma, ctx.academyId, s.id),
      this.schedule.academyClock(ctx.academyId),
      this.currencyOf(ctx.academyId),
    ]);
    const ids = rows.map((r) => r.chargeId);
    const [adjustments, collections, sessions] = await Promise.all([
      ids.length
        ? this.prisma.centerAdjustment.findMany({
            where: { chargeId: { in: ids } },
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              chargeId: true,
              kind: true,
              deltaCents: true,
              percentBps: true,
              reason: true,
              createdAt: true,
            },
          })
        : [],
      this.prisma.centerCollection.findMany({
        where: { academyId: ctx.academyId, academyStudentId: s.id },
        orderBy: { receivedAt: 'desc' },
        include: { allocations: { select: { chargeId: true, amountCents: true } } },
      }),
      this.sessionDates(rows, clock.timezone),
    ]);
    return {
      student: { id: s.id, fullName: s.fullName, code: s.code, status: s.status },
      summary: this.summarize(rows, clock.today, currency),
      charges: rows.map((r) => ({
        id: r.chargeId,
        kind: r.kind,
        description: r.description,
        period: r.period,
        sessionDate: r.groupSessionId ? (sessions.get(r.groupSessionId) ?? null) : null,
        amountCents: r.amountCents,
        netCents: r.netCents,
        paidCents: r.paidCents,
        outstandingCents: r.outstandingCents,
        dueOn: day(r.dueOn),
        status: chargeStatus({ ...r, voided: !!r.voidedAt, dueOn: day(r.dueOn) }, clock.today),
        voidReason: r.voidReason,
        adjustments: adjustments.filter((a) => a.chargeId === r.chargeId),
      })),
      collections: collections.map((k) => this.collectionView(k, clock.timezone)),
    };
  }

  /**
   * Chronological statement: charges, adjustments, collections, reversals and
   * voids, with the running balance after each. It ends on the same total as
   * balances() — the same facts, read in time order.
   */
  async statement(ctx: AcademyContext, academyStudentId: string) {
    const view = await this.student(ctx, academyStudentId);
    const events: { at: Date; kind: string; label: string; ref?: string; deltaCents: number }[] =
      [];
    const charges = await this.prisma.centerCharge.findMany({
      where: { academyId: ctx.academyId, academyStudentId },
      select: {
        id: true,
        description: true,
        period: true,
        amountCents: true,
        createdAt: true,
        voidedAt: true,
      },
    });
    for (const c of charges) {
      events.push({
        at: c.createdAt,
        kind: 'CHARGE',
        label: c.description,
        ref: c.period ?? undefined,
        deltaCents: c.amountCents,
      });
      const adj = view.charges.find((x) => x.id === c.id)!;
      for (const a of adj.adjustments)
        events.push({ at: a.createdAt, kind: a.kind, label: a.reason, deltaCents: a.deltaCents });
      if (c.voidedAt)
        events.push({
          at: c.voidedAt,
          kind: 'VOID',
          label: adj.voidReason ?? '',
          deltaCents: -(c.amountCents + adj.adjustments.reduce((s, a) => s + a.deltaCents, 0)),
        });
    }
    for (const k of view.collections) {
      events.push({
        at: new Date(k.receivedAt),
        kind: 'COLLECTION',
        label: k.method,
        ref: k.receiptNumber,
        deltaCents: -k.amountCents,
      });
      if (k.reversedAt)
        events.push({
          at: new Date(k.reversedAt),
          kind: 'REVERSAL',
          label: k.reversalReason ?? '',
          ref: k.receiptNumber,
          deltaCents: k.amountCents,
        });
    }
    events.sort((a, b) => a.at.getTime() - b.at.getTime() || order(a.kind) - order(b.kind));
    let running = 0;
    const tz = (await this.schedule.academyClock(ctx.academyId)).timezone;
    const academy = await this.prisma.academy.findUniqueOrThrow({
      where: { id: ctx.academyId },
      select: { name: true },
    });
    return {
      academy,
      student: view.student,
      summary: view.summary,
      events: events.map((e) => {
        running += e.deltaCents;
        return {
          ...e,
          at: e.at.toISOString(),
          localDate: wallClock(e.at, tz).date,
          balanceCents: running,
        };
      }),
    };
  }

  /** Who owes what — server-side filtered and paged, one row per learner. */
  async outstanding(ctx: AcademyContext, query: OutstandingQuery) {
    const clock = await this.schedule.academyClock(ctx.academyId);
    const page = query.page ?? 1;
    const status = query.status ?? 'OWING';
    const conds: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (status === 'OWING') conds.push(Prisma.sql`per.outstanding > 0`);
    if (status === 'OVERDUE') conds.push(Prisma.sql`per.overdue > 0`);
    if (status === 'PARTIAL') conds.push(Prisma.sql`per.outstanding > 0 AND per.paid > 0`);
    if (status === 'PAID') conds.push(Prisma.sql`per.outstanding = 0`);
    const q = (query.q ?? '').trim();
    if (q) {
      const digits = q.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
      if (/^\d{3,6}$/.test(digits)) conds.push(Prisma.sql`s.code LIKE ${`${digits}%`}`);
      else
        conds.push(
          Prisma.sql`s."nameNormalized" LIKE '%' || academy_student_name_key(${q}) || '%'`,
        );
    }
    if (query.groupId)
      conds.push(Prisma.sql`EXISTS (SELECT 1 FROM "GroupMembership" m WHERE m."groupId" = ${query.groupId}
        AND m."academyId" = s."academyId" AND m."studentId" = s."studentId" AND m."deletedAt" IS NULL)`);
    const where = Prisma.join(conds, ' AND ');
    const today = dateValue(clock.today);
    const per = Prisma.sql`
      SELECT b."academyStudentId" AS id,
             sum(b."outstandingCents")::int AS outstanding,
             COALESCE(sum(b."outstandingCents") FILTER (WHERE b."dueOn" < ${today}::date), 0)::int AS overdue,
             sum(b."paidCents")::int AS paid,
             min(b."dueOn") FILTER (WHERE b."outstandingCents" > 0) AS "oldestDue"
      FROM "CenterChargeBalance" b
      WHERE b."academyId" = ${ctx.academyId} AND b."voidedAt" IS NULL
      GROUP BY 1`;
    // One pass over the balances: the page, how many match, and the academy's totals.
    const rows = await this.prisma.$queryRaw<
      {
        id: string | null;
        fullName: string;
        code: string;
        status: string;
        outstanding: number;
        overdue: number;
        paid: number;
        oldestDue: Date | null;
        n: number;
        totOutstanding: number;
        totOverdue: number;
        owing: number;
      }[]
    >`WITH per AS MATERIALIZED (${per}),
        tot AS (SELECT COALESCE(sum(outstanding), 0)::float8 AS "totOutstanding",
                       COALESCE(sum(overdue), 0)::float8 AS "totOverdue",
                       (count(*) FILTER (WHERE outstanding > 0))::int AS owing FROM per),
        f AS MATERIALIZED (
          SELECT s.id, s."fullName", s.code, s.status::text AS status, s."nameNormalized",
                 per.outstanding, per.overdue, per.paid, per."oldestDue"
          FROM per JOIN "AcademyStudent" s ON s.id = per.id
          WHERE ${where}),
        page AS (SELECT * FROM f ORDER BY overdue DESC, outstanding DESC, "nameNormalized", id
                 LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE})
      SELECT page.id, page."fullName", page.code, page.status, page.outstanding, page.overdue, page.paid,
             page."oldestDue", (SELECT count(*)::int FROM f) AS n, tot.*
      FROM tot LEFT JOIN page ON TRUE
      ORDER BY page.overdue DESC NULLS LAST, page.outstanding DESC, page."nameNormalized", page.id`;
    const head = rows[0];
    return {
      currency: await this.currencyOf(ctx.academyId),
      today: clock.today,
      page,
      pageSize: PAGE,
      total: head?.n ?? 0,
      totals: {
        outstandingCents: Number(head?.totOutstanding ?? 0),
        overdueCents: Number(head?.totOverdue ?? 0),
        studentsOwing: head?.owing ?? 0,
      },
      items: rows
        .filter((r) => r.id)
        .map(({ n: _n, totOutstanding: _o, totOverdue: _d, owing: _w, ...r }) => ({
          ...r,
          id: r.id!,
          oldestDue: r.oldestDue ? day(r.oldestDue) : null,
        })),
    };
  }

  /**
   * Collections recorded on one local day (default today). Everyone's for
   * fees.report; otherwise only the caller's own (a receptionist's drawer).
   * "Recorded collections" — not a bank reconciliation.
   */
  /**
   * C7's money figures for one business day — read here so C4 stays the only
   * reader of its tables. Received on the day (by method, whatever happened to
   * them later) and reversals PERFORMED on the day (whenever the money came
   * in): both are timestamps C4 never changes once set, so a day reproduces
   * exactly. Net = received − reversed that day.
   */
  async dayMovement(academyId: string, date: string, db: Db = this.prisma) {
    const clock = await this.schedule.academyClock(academyId);
    const { start, end } = localDayBounds(date, clock.timezone);
    const s = start.toISOString();
    const e = end.toISOString();
    const [byMethod, reversed, currency] = await Promise.all([
      db.$queryRaw<{ method: string; count: number; amount: bigint | null }[]>`
        SELECT method::text AS method, count(*)::int AS count, sum("amountCents") AS amount
        FROM "CenterCollection"
        WHERE "academyId" = ${academyId}
          AND "receivedAt" >= (${s}::timestamptz AT TIME ZONE 'UTC') AND "receivedAt" < (${e}::timestamptz AT TIME ZONE 'UTC')
        GROUP BY method`,
      db.$queryRaw<{ count: number; amount: bigint | null }[]>`
        SELECT count(*)::int AS count, sum("amountCents") AS amount
        FROM "CenterCollection"
        WHERE "academyId" = ${academyId}
          AND "reversedAt" >= (${s}::timestamptz AT TIME ZONE 'UTC') AND "reversedAt" < (${e}::timestamptz AT TIME ZONE 'UTC')`,
      this.currencyOf(academyId),
    ]);
    const methods = Object.fromEntries(
      ['CASH', 'CARD_EXTERNAL', 'BANK_TRANSFER', 'OTHER'].map((m) => {
        const g = byMethod.find((x) => x.method === m);
        return [m, { count: g?.count ?? 0, amountCents: Number(g?.amount ?? 0) }];
      }),
    );
    const received = {
      count: byMethod.reduce((n, g) => n + g.count, 0),
      amountCents: byMethod.reduce((n, g) => n + Number(g.amount ?? 0), 0),
      byMethod: methods,
    };
    const reversedToday = {
      count: reversed[0]?.count ?? 0,
      amountCents: Number(reversed[0]?.amount ?? 0),
    };
    return {
      currency,
      received,
      reversedToday,
      netCents: received.amountCents - reversedToday.amountCents,
    };
  }

  async day(ctx: AcademyContext, date: string | undefined, page = 1) {
    const clock = await this.schedule.academyClock(ctx.academyId);
    const d = date ?? clock.today;
    const { start, end } = localDayBounds(d, clock.timezone);
    const mine = !ctx.can('fees.report');
    const where: Prisma.CenterCollectionWhereInput = {
      academyId: ctx.academyId,
      receivedAt: { gte: start, lt: end },
      ...(mine ? { receivedBy: ctx.userId } : {}),
    };
    const [items, total, byMethod, reversed] = await Promise.all([
      this.prisma.centerCollection.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        skip: (page - 1) * PAGE,
        take: PAGE,
        include: {
          academyStudent: { select: { id: true, fullName: true, code: true } },
          allocations: { select: { chargeId: true, amountCents: true } },
        },
      }),
      this.prisma.centerCollection.count({ where }),
      this.prisma.centerCollection.groupBy({
        by: ['method'],
        where: { ...where, reversedAt: null },
        _sum: { amountCents: true },
        _count: true,
      }),
      this.prisma.centerCollection.aggregate({
        where: { ...where, reversedAt: { not: null } },
        _sum: { amountCents: true },
        _count: true,
      }),
    ]);
    const methods = Object.fromEntries(
      ['CASH', 'CARD_EXTERNAL', 'BANK_TRANSFER', 'OTHER'].map((m) => {
        const g = byMethod.find((x) => x.method === m);
        return [m, { count: g?._count ?? 0, amountCents: g?._sum.amountCents ?? 0 }];
      }),
    );
    const collectors = await this.names(items.map((i) => i.receivedBy));
    return {
      date: d,
      today: clock.today,
      timezone: clock.timezone,
      currency: await this.currencyOf(ctx.academyId),
      scope: mine ? 'MINE' : 'ALL',
      totals: {
        count: byMethod.reduce((s, g) => s + g._count, 0),
        amountCents: byMethod.reduce((s, g) => s + (g._sum.amountCents ?? 0), 0),
        byMethod: methods,
        reversed: { count: reversed._count, amountCents: reversed._sum.amountCents ?? 0 },
      },
      page,
      pageSize: PAGE,
      total,
      items: items.map((k) => ({
        ...this.collectionView(k, clock.timezone),
        student: k.academyStudent,
        collector: collectors.get(k.receivedBy) ?? '',
      })),
    };
  }

  /** One receipt: everything printed on it, frozen when it was taken. */
  async receipt(ctx: AcademyContext, collectionId: string) {
    const k = await this.prisma.centerCollection.findFirst({
      where: { id: collectionId, academyId: ctx.academyId },
      include: {
        academyStudent: { select: { id: true, fullName: true, code: true } },
        allocations: {
          include: {
            charge: { select: { description: true, period: true, kind: true, dueOn: true } },
          },
        },
      },
    });
    if (!k)
      throw new NotFoundException({ message: 'Receipt not found', code: 'COLLECTION_NOT_FOUND' });
    const [academy, clock, names] = await Promise.all([
      this.prisma.academy.findUniqueOrThrow({
        where: { id: ctx.academyId },
        select: { name: true, logoUrl: true },
      }),
      this.schedule.academyClock(ctx.academyId),
      this.names([k.receivedBy, ...(k.reversedBy ? [k.reversedBy] : [])]),
    ]);
    const local = wallClock(k.receivedAt, clock.timezone);
    return {
      academy,
      receiptNumber: k.receiptNumber,
      receivedAt: k.receivedAt,
      localDate: local.date,
      localMinute: local.minute,
      timezone: clock.timezone,
      student: k.academyStudent,
      collector: names.get(k.receivedBy) ?? '',
      amountCents: k.amountCents,
      currency: k.currency,
      method: k.method,
      note: k.note,
      lines: k.allocations.map((a) => ({
        description: a.charge.description,
        period: a.charge.period,
        kind: a.charge.kind,
        amountCents: a.amountCents,
      })),
      balanceAfterCents: k.balanceAfterCents,
      reversed: k.reversedAt
        ? { at: k.reversedAt, reason: k.reversalReason, by: names.get(k.reversedBy!) ?? '' }
        : null,
      collectionId: k.id,
    };
  }

  // ── Collecting ─────────────────────────────────────────────────────────

  /** What a collection would pay — the confirmation screen. Writes nothing. */
  async preview(ctx: AcademyContext, academyStudentId: string, dto: PreviewDto) {
    const s = await this.studentIn(ctx, academyStudentId);
    const rows = await this.balances(this.prisma, ctx.academyId, s.id);
    const plan = this.plan(rows, dto.amountCents, dto.allocations);
    const owed = rows.reduce((t, r) => t + (r.voidedAt ? 0 : r.outstandingCents), 0);
    return {
      student: { id: s.id, fullName: s.fullName, code: s.code },
      currency: await this.currencyOf(ctx.academyId),
      amountCents: dto.amountCents,
      balanceBeforeCents: owed,
      balanceAfterCents: owed - dto.amountCents,
      allocations: plan.map((a) => {
        const r = rows.find((x) => x.chargeId === a.chargeId)!;
        return {
          ...a,
          description: r.description,
          period: r.period,
          dueOn: day(r.dueOn),
          outstandingCents: r.outstandingCents,
        };
      }),
    };
  }

  /**
   * Record money received. In one transaction under the learner's lock:
   * replay check (the request key), allocation (named, or oldest due first),
   * the next receipt number, the collection and its allocations. A retry or
   * a double click with the same key gets the same receipt back; more money
   * than is owed is refused (no credit balance in C4).
   */
  async collect(ctx: AcademyContext, academyStudentId: string, dto: CollectDto) {
    const s = await this.studentIn(ctx, academyStudentId);
    const currency = await this.currencyOf(ctx.academyId);
    const clock = await this.schedule.academyClock(ctx.academyId);
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockStudent(tx, ctx.academyId, s.id);
      const prior = await tx.centerCollection.findUnique({
        where: { academyId_requestKey: { academyId: ctx.academyId, requestKey: dto.requestKey } },
      });
      if (prior) {
        if (
          prior.academyStudentId !== s.id ||
          prior.amountCents !== dto.amountCents ||
          prior.method !== dto.method
        )
          throw new ConflictException({
            message: 'This request key was already used for a different collection',
            code: 'IDEMPOTENCY_KEY_REUSED',
          });
        return {
          id: prior.id,
          replayed: true,
          allocations: [] as { chargeId: string; amountCents: number }[],
          receiptNumber: prior.receiptNumber,
        };
      }
      const rows = await this.balances(tx, ctx.academyId, s.id);
      const allocations = this.plan(rows, dto.amountCents, dto.allocations);
      const owed = rows.reduce((t, r) => t + (r.voidedAt ? 0 : r.outstandingCents), 0);
      const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
      const year = Number(wallClock(now, clock.timezone).date.slice(0, 4));
      // The next number for this academy and year, atomically (no count + 1).
      const [{ last }] = await tx.$queryRaw<{ last: number }[]>`
        INSERT INTO "CenterReceiptCounter" ("academyId", year, last) VALUES (${ctx.academyId}, ${year}, 1)
        ON CONFLICT ("academyId", year) DO UPDATE SET last = "CenterReceiptCounter".last + 1
        RETURNING last`;
      const receiptNumber = `${year}-${String(last).padStart(6, '0')}`;
      const id = randomUUID();
      await tx.centerCollection.create({
        data: {
          id,
          academyId: ctx.academyId,
          academyStudentId: s.id,
          amountCents: dto.amountCents,
          currency,
          method: dto.method,
          note: dto.note?.trim() || null,
          receivedAt: now,
          receivedBy: ctx.userId,
          receiptNumber,
          balanceAfterCents: owed - dto.amountCents,
          requestKey: dto.requestKey,
        },
      });
      await tx.centerAllocation.createMany({
        data: allocations.map((a) => ({
          id: randomUUID(),
          academyId: ctx.academyId,
          collectionId: id,
          chargeId: a.chargeId,
          amountCents: a.amountCents,
        })),
      });
      return { id, replayed: false, allocations, receiptNumber };
    });
    if (!result.replayed)
      await this.audit.log({
        actorUserId: ctx.userId,
        action: 'fees.collect',
        entity: 'CenterCollection',
        entityId: result.id,
        academyId: ctx.academyId,
        meta: {
          academyStudentId: s.id,
          amountCents: dto.amountCents,
          currency,
          method: dto.method,
          receiptNumber: result.receiptNumber,
          allocations: result.allocations,
        },
      });
    return { replayed: result.replayed, receipt: await this.receipt(ctx, result.id) };
  }

  /**
   * Allocate an amount: as named (each within what that charge still owes,
   * adding up to the amount exactly) or oldest due first. Refuses paying
   * more than is owed — C4 keeps no credit.
   */
  private plan(
    rows: BalanceRow[],
    amountCents: number,
    named?: { chargeId: string; amountCents: number }[],
  ) {
    const open = rows.filter((r) => !r.voidedAt && r.outstandingCents > 0);
    if (!open.length)
      throw new ConflictException({ message: 'Nothing is owed', code: 'NOTHING_OWED' });
    if (!named) {
      const { allocations, leftoverCents } = allocateOldestFirst(amountCents, open);
      if (leftoverCents > 0)
        throw new ConflictException({
          message: 'More than is owed — this center keeps no credit balance',
          code: 'AMOUNT_EXCEEDS_BALANCE',
          owedCents: amountCents - leftoverCents,
        });
      return allocations;
    }
    const seen = new Set<string>();
    let sum = 0;
    for (const a of named) {
      const r = open.find((x) => x.chargeId === a.chargeId);
      if (!r || seen.has(a.chargeId))
        throw new BadRequestException({
          message: 'Not an open charge of this student',
          code: 'ALLOCATION_INVALID',
        });
      if (a.amountCents > r.outstandingCents)
        throw new ConflictException({
          message: 'More than this charge still owes',
          code: 'AMOUNT_EXCEEDS_BALANCE',
        });
      seen.add(a.chargeId);
      sum += a.amountCents;
    }
    if (sum !== amountCents)
      throw new BadRequestException({
        message: 'The parts must add up to the amount',
        code: 'ALLOCATION_MISMATCH',
      });
    return named.map((a) => ({ chargeId: a.chargeId, amountCents: a.amountCents }));
  }

  /** Undo a collection recorded by mistake: kept, marked reversed, its money back on what it paid. */
  async reverse(ctx: AcademyContext, collectionId: string, reason: string) {
    const k = await this.prisma.centerCollection.findFirst({
      where: { id: collectionId, academyId: ctx.academyId },
      select: { id: true, academyStudentId: true },
    });
    if (!k)
      throw new NotFoundException({ message: 'Receipt not found', code: 'COLLECTION_NOT_FOUND' });
    const changed = await this.prisma.$transaction(async (tx) => {
      await this.lockStudent(tx, ctx.academyId, k.academyStudentId);
      const cur = await tx.centerCollection.findUniqueOrThrow({ where: { id: k.id } });
      if (cur.reversedAt) return false;
      const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
      await tx.centerCollection.update({
        where: { id: k.id },
        data: { reversedAt: now, reversedBy: ctx.userId, reversalReason: reason.trim() },
      });
      return true;
    });
    if (changed)
      await this.audit.log({
        actorUserId: ctx.userId,
        action: 'fees.reverse',
        entity: 'CenterCollection',
        entityId: k.id,
        academyId: ctx.academyId,
        meta: { academyStudentId: k.academyStudentId },
      });
    return { changed, receipt: await this.receipt(ctx, k.id) };
  }

  // ── What is owed ───────────────────────────────────────────────────────

  async oneTime(ctx: AcademyContext, academyStudentId: string, dto: OneTimeChargeDto) {
    const s = await this.studentIn(ctx, academyStudentId);
    const currency = await this.currencyOf(ctx.academyId);
    const res = await this.prisma.$transaction(async (tx) => {
      await this.lockStudent(tx, ctx.academyId, s.id);
      const prior = await tx.centerCharge.findUnique({
        where: { academyId_requestKey: { academyId: ctx.academyId, requestKey: dto.requestKey } },
        select: { id: true },
      });
      if (prior) return { id: prior.id, created: false };
      const c = await tx.centerCharge.create({
        data: {
          academyId: ctx.academyId,
          academyStudentId: s.id,
          kind: 'ONE_TIME',
          description: dto.description.trim(),
          amountCents: dto.amountCents,
          currency,
          dueOn: dateValue(dto.dueOn),
          createdBy: ctx.userId,
          requestKey: dto.requestKey,
        },
      });
      return { id: c.id, created: true };
    });
    if (res.created)
      await this.audit.log({
        actorUserId: ctx.userId,
        action: 'fees.charge.create',
        entity: 'CenterCharge',
        entityId: res.id,
        academyId: ctx.academyId,
        meta: {
          academyStudentId: s.id,
          kind: 'ONE_TIME',
          amountCents: dto.amountCents,
          currency,
          dueOn: dto.dueOn,
        },
      });
    return this.student(ctx, s.id);
  }

  /**
   * A discount (always lowers what is owed) or a signed correction, with its
   * reason. Never below what was already paid on the charge, never below 0 —
   * reverse a collection first if it must go lower.
   */
  async adjust(ctx: AcademyContext, chargeId: string, dto: AdjustDto) {
    const c = await this.chargeIn(ctx, chargeId);
    if ((dto.amountCents == null) === (dto.percentBps == null))
      throw new BadRequestException({
        message: 'Give an amount or a percentage',
        code: 'VALIDATION_FAILED',
      });
    if (dto.percentBps != null && dto.kind !== 'DISCOUNT')
      throw new BadRequestException({
        message: 'Only a discount may be a percentage',
        code: 'VALIDATION_FAILED',
      });
    if (dto.kind === 'CORRECTION' && !dto.direction)
      throw new BadRequestException({
        message: 'Say whether the correction raises or lowers it',
        code: 'VALIDATION_FAILED',
      });
    const res = await this.prisma.$transaction(async (tx) => {
      await this.lockStudent(tx, ctx.academyId, c.academyStudentId);
      const prior = await tx.centerAdjustment.findUnique({
        where: { academyId_requestKey: { academyId: ctx.academyId, requestKey: dto.requestKey } },
        select: { id: true },
      });
      if (prior) return { id: prior.id, created: false, delta: 0 };
      const [b] = await tx.$queryRaw<
        { netCents: number; paidCents: number; voidedAt: Date | null }[]
      >`
        SELECT "netCents", "paidCents", "voidedAt" FROM "CenterChargeBalance" WHERE "chargeId" = ${c.id}`;
      if (b.voidedAt)
        throw new ConflictException({ message: 'This charge is void', code: 'CHARGE_VOID' });
      const size =
        dto.percentBps != null ? percentOf(c.amountCents, dto.percentBps) : dto.amountCents!;
      const delta = dto.kind === 'DISCOUNT' || dto.direction === 'DECREASE' ? -size : size;
      if (size === 0)
        throw new BadRequestException({
          message: 'That comes to nothing',
          code: 'VALIDATION_FAILED',
        });
      if (b.netCents + delta < b.paidCents)
        throw new ConflictException({
          message: 'That would owe less than was already paid — reverse a collection first',
          code: 'ADJUSTMENT_BELOW_PAID',
          netCents: b.netCents,
          paidCents: b.paidCents,
        });
      const a = await tx.centerAdjustment.create({
        data: {
          academyId: ctx.academyId,
          chargeId: c.id,
          kind: dto.kind,
          deltaCents: delta,
          percentBps: dto.percentBps ?? null,
          reason: dto.reason.trim(),
          createdBy: ctx.userId,
          requestKey: dto.requestKey,
        },
      });
      return { id: a.id, created: true, delta };
    });
    if (res.created)
      await this.audit.log({
        actorUserId: ctx.userId,
        action: dto.kind === 'DISCOUNT' ? 'fees.discount' : 'fees.adjust',
        entity: 'CenterCharge',
        entityId: c.id,
        academyId: ctx.academyId,
        meta: {
          adjustmentId: res.id,
          academyStudentId: c.academyStudentId,
          deltaCents: res.delta,
          percentBps: dto.percentBps ?? null,
        },
      });
    return this.student(ctx, c.academyStudentId);
  }

  /** A charge posted by mistake: void (kept, owes nothing). Only with no money against it. */
  async voidCharge(ctx: AcademyContext, chargeId: string, reason: string) {
    const c = await this.chargeIn(ctx, chargeId);
    const changed = await this.prisma.$transaction(async (tx) => {
      await this.lockStudent(tx, ctx.academyId, c.academyStudentId);
      const [b] = await tx.$queryRaw<{ paidCents: number; voidedAt: Date | null }[]>`
        SELECT "paidCents", "voidedAt" FROM "CenterChargeBalance" WHERE "chargeId" = ${c.id}`;
      if (b.voidedAt) return false;
      if (b.paidCents > 0)
        throw new ConflictException({
          message: 'Money was collected against this charge — reverse that first',
          code: 'CHARGE_HAS_PAYMENTS',
        });
      const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
      await tx.centerCharge.update({
        where: { id: c.id },
        data: { voidedAt: now, voidedBy: ctx.userId, voidReason: reason.trim() },
      });
      return true;
    });
    if (changed)
      await this.audit.log({
        actorUserId: ctx.userId,
        action: 'fees.charge.void',
        entity: 'CenterCharge',
        entityId: c.id,
        academyId: ctx.academyId,
        meta: { academyStudentId: c.academyStudentId },
      });
    return this.student(ctx, c.academyStudentId);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private collectionView(
    k: {
      id: string;
      amountCents: number;
      currency: string;
      method: string;
      note: string | null;
      receivedAt: Date;
      receivedBy: string;
      receiptNumber: string;
      balanceAfterCents: number;
      reversedAt: Date | null;
      reversalReason: string | null;
      allocations: { chargeId: string; amountCents: number }[];
    },
    timezone: string,
  ) {
    return {
      id: k.id,
      localDate: wallClock(k.receivedAt, timezone).date,
      receiptNumber: k.receiptNumber,
      amountCents: k.amountCents,
      currency: k.currency,
      method: k.method,
      note: k.note,
      receivedAt: k.receivedAt.toISOString(),
      balanceAfterCents: k.balanceAfterCents,
      reversedAt: k.reversedAt?.toISOString() ?? null,
      reversalReason: k.reversalReason,
      allocations: k.allocations,
    };
  }

  private async sessionDates(rows: BalanceRow[], timezone: string) {
    const ids = rows.map((r) => r.groupSessionId).filter((x): x is string => !!x);
    if (!ids.length) return new Map<string, string>();
    const s = await this.prisma.groupSession.findMany({
      where: { id: { in: ids } },
      select: { id: true, startAt: true },
    });
    return new Map(s.map((x) => [x.id, wallClock(x.startAt, timezone).date]));
  }

  private async names(ids: string[]) {
    const uniq = [...new Set(ids)];
    if (!uniq.length) return new Map<string, string>();
    const users = await this.prisma.user.findMany({
      where: { id: { in: uniq } },
      select: { id: true, fullName: true },
    });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  async currencyOf(academyId: string) {
    return (
      await this.prisma.academy.findUniqueOrThrow({
        where: { id: academyId },
        select: { currency: true },
      })
    ).currency;
  }

  private async studentIn(ctx: AcademyContext, academyStudentId: string) {
    const s = await this.prisma.academyStudent.findFirst({
      where: { id: academyStudentId, academyId: ctx.academyId },
      select: { id: true, fullName: true, code: true, status: true, studentId: true },
    });
    if (!s)
      throw new NotFoundException({ message: 'Student not found', code: 'STUDENT_NOT_FOUND' });
    return s;
  }

  private async chargeIn(ctx: AcademyContext, chargeId: string) {
    const c = await this.prisma.centerCharge.findFirst({
      where: { id: chargeId, academyId: ctx.academyId },
      select: { id: true, academyStudentId: true, amountCents: true },
    });
    if (!c) throw new NotFoundException({ message: 'Charge not found', code: 'CHARGE_NOT_FOUND' });
    return c;
  }

  /** The learner's register row, locked: every money write for them queues here. */
  private async lockStudent(tx: Tx, academyId: string, academyStudentId: string) {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "AcademyStudent" WHERE id = ${academyStudentId} AND "academyId" = ${academyId} FOR UPDATE`;
    if (!row)
      throw new NotFoundException({ message: 'Student not found', code: 'STUDENT_NOT_FOUND' });
  }
}

/** A @db.Date as 'YYYY-MM-DD'. */
function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Same-instant events in a sensible order: what was owed before what paid it. */
function order(kind: string) {
  return ['CHARGE', 'CORRECTION', 'DISCOUNT', 'COLLECTION', 'REVERSAL', 'VOID'].indexOf(kind);
}
