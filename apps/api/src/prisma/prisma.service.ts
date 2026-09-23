import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// Models that carry a `deletedAt` column and participate in soft delete.
const SOFT_DELETE_MODELS = new Set([
  'Course',
  'CourseUnit',
  'Lesson',
  'Attachment',
  'VideoNote',
  'Coupon',
  'PayoutMethodSaved',
  'LiveSession',
  // Academy carried the column from the start but was never wired in here, so
  // deleting one was a hard delete despite the schema saying otherwise.
  'Academy',
  // Accounts and the records that hang off them. Removing a person from the
  // platform must never destroy what they did — it hides them, reversibly.
  'User',
  'TeacherProfile',
  'StudentProfile',
  'Enrollment',
  'Review',
  'Certificate',
  // Money. Balances aggregate over LedgerEntry, so the entry has to be
  // filtered too or a removed academy would keep its balance.
  'Payment',
  'Invoice',
  'LedgerTransaction',
  'LedgerEntry',
  'WalletTransaction',
  // These three surface in admin queues — a pending top-up or an unmoderated
  // site belonging to a removed academy would otherwise sit there forever.
  'WalletTopup',
  'PayoutRequest',
  'AcademySite',
  'AcademyMembership',
  // Reachable without going through a removed parent, which is the test for
  // whether a row needs to be hideable in its own right: the admin lists every
  // PaymentEvent regardless of who it belongs to, and academy media is served
  // publicly by id. Everything else in the schema is only ever read through a
  // user, academy or lesson that is already hidden.
  'PaymentEvent',
  'AcademyMedia',
  // A thread is listed for the teacher and joins to the student through a
  // nested include, which the read filter does not reach — so removing a
  // student left their conversation sitting in the teacher's inbox.
  'ChatThread',
  'ChatMessage',
  'Notification',
  // The studio's admin overview aggregates every AI job on the platform with
  // no academy filter, so jobs from removed academies kept their cost and
  // their failures in the totals.
  'AiJob',
  'AcademySiteSnapshot',
  'AcademyProfileFacts',
  // Academy Operations (SaaS Evolution Phase 3) — attendance history in
  // particular is reachable directly by studentId, not only through a still-
  // existing Group, so it needs to be hideable in its own right too.
  'Group',
  'GroupMembership',
  'GroupAssignment',
  'AttendanceSession',
  'AttendanceRecord',
  // SaaS Evolution Phase 4 — a cancelled/rescheduled-away session and an
  // archived room both stay readable for history (see Room/GroupSession
  // comments in schema.prisma); this only hides genuinely deleted rows.
  'Room',
  'GroupSession',
]);

/**
 * The reads the soft-delete filter is applied to unconditionally.
 *
 * `findUnique`/`findUniqueOrThrow` are handled separately, by shape — see
 * `filtersUniqueRead` below.
 */
const READ_ACTIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

const UNIQUE_READ_ACTIONS = new Set(['findUnique', 'findUniqueOrThrow']);

/**
 * Should this unique read hide soft-deleted rows?
 *
 * Only when it is a lookup **by primary id**, and that distinction is the
 * whole policy.
 *
 * `findUnique({ where: { id } })` means "fetch this thing". A thing the
 * application has deleted should not come back, and it was coming back:
 * production holds 1,438 soft-deleted rows across 27 models — 205 lessons,
 * 146 enrollments, 74 payments, 41 courses — so an id taken from a URL really
 * did resolve to rows the rest of the system treats as gone. That is the bug
 * this exists to close, and it covers 113 of the call sites.
 *
 * `findUnique({ where: { studentId_courseId: {…} } })` means something
 * different: "does a row already occupy this natural key". Every one of the
 * twenty compound-key lookups in this codebase asks that immediately before a
 * create or an upsert — re-enrolment, coupon re-creation, idempotent
 * certificate issue, review upsert. The unique constraint **counts
 * soft-deleted rows**, so a lookup that hid them would report the key free,
 * the create would hit P2002, and a student re-enrolling after a deleted
 * enrolment would be told "already enrolled". Those lookups must see
 * everything, and they are left alone.
 *
 * This is deliberately not a list of opt-outs. An opt-out list is a list of
 * sites someone has to remember to update, and getting one wrong here means a
 * P2002 in a payment path. The shape of the query already carries the intent.
 *
 * Prisma 5's `extendedWhereUnique` is what makes the id case possible at all —
 * `where: { id, deletedAt: null }` was a type error before it.
 */
function filtersUniqueRead(where: unknown): boolean {
  if (!where || typeof where !== 'object') return false;
  const keys = Object.keys(where as Record<string, unknown>);
  return keys.length === 1 && keys[0] === 'id';
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /**
   * Query logging, off unless asked for.
   *
   * `PRISMA_QUERY_LOG=true` prints one line per statement with its duration.
   * It exists so an N+1 can be counted rather than guessed at: the signal is a
   * single request emitting a query per row, and that is invisible from the
   * outside — the endpoint just feels slow. Left switched off in normal running
   * because it prints a line for every statement the process makes.
   *
   * Deliberately not tied to NODE_ENV: profiling a realistic dataset means
   * doing it against something production-shaped.
   */
  constructor() {
    super(
      process.env.PRISMA_QUERY_LOG === 'true' ? { log: [{ emit: 'event', level: 'query' }] } : {},
    );
    if (process.env.PRISMA_QUERY_LOG === 'true') {
      // `as never` because the event name is only on the generated client type
      // when a log config was passed, and this constructor decides that at runtime.
      (
        this as never as {
          $on: (e: string, cb: (q: { duration: number; query: string }) => void) => void;
        }
      ).$on('query', (q) =>
        console.log(`[sql ${String(q.duration).padStart(4)}ms] ${q.query.slice(0, 160)}`),
      );
    }
  }

  async onModuleInit() {
    // Centralised soft delete: `delete`/`deleteMany` on a soft-delete model
    // stamps `deletedAt` instead of removing the row (fast, reversible, keeps
    // FKs intact), and top-level reads transparently hide deleted rows. A
    // query that explicitly sets `deletedAt` (e.g. a restore/trash view) wins.
    // Nested relation reads (include/select) are filtered explicitly where the
    // content tree is loaded. findUnique IS filtered now — see READ_ACTIONS
    // above for why it was not, and what changed.
    this.$use(async (params, next) => {
      const model = params.model;
      if (model && SOFT_DELETE_MODELS.has(model)) {
        // Unique reads are filtered by the shape of their `where` — see
        // `filtersUniqueRead`.
        if (UNIQUE_READ_ACTIONS.has(params.action) && filtersUniqueRead(params.args?.where)) {
          params.args = params.args ?? {};
          params.args.where = { deletedAt: null, ...(params.args.where ?? {}) };
          return next(params);
        }
        if (params.action === 'delete') {
          params.action = 'update';
          params.args = { ...params.args, data: { deletedAt: new Date() } };
        } else if (params.action === 'deleteMany') {
          params.action = 'updateMany';
          params.args = params.args ?? {};
          params.args.data = { ...(params.args.data ?? {}), deletedAt: new Date() };
        } else if (READ_ACTIONS.has(params.action)) {
          params.args = params.args ?? {};
          params.args.where = { deletedAt: null, ...(params.args.where ?? {}) };
        }
      }
      return next(params);
    });

    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
