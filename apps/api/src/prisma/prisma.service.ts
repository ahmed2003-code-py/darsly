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
