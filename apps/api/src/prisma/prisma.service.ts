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
]);

const READ_ACTIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    // Centralised soft delete: `delete`/`deleteMany` on a soft-delete model
    // stamps `deletedAt` instead of removing the row (fast, reversible, keeps
    // FKs intact), and top-level reads transparently hide deleted rows. A
    // query that explicitly sets `deletedAt` (e.g. a restore/trash view) wins.
    // Nested relation reads (include/select) are filtered explicitly where the
    // content tree is loaded; findUnique is intentionally left untouched so
    // compound-unique lookups keep working.
    this.$use(async (params, next) => {
      const model = params.model;
      if (model && SOFT_DELETE_MODELS.has(model)) {
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
