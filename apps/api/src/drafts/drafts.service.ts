import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ContentDraftKind, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CourseScope } from '../courses/courses.service';

/** Who is drafting, and in which academy. The same shape courses use, plus
 *  the user id — a Center has several people and a draft belongs to one. */
export interface DraftScope extends CourseScope {
  userId: string;
}

/** What a form sends when it autosaves. */
export interface SaveDraftInput {
  kind: ContentDraftKind;
  scopeKey: string;
  courseId?: string | null;
  lessonId?: string | null;
  label?: string;
  step?: string;
  data: Record<string, unknown>;
}

/**
 * One entry on the "you were in the middle of something" list.
 *
 * Deliberately without a URL. Where a draft is resumed is the web app's
 * business, and its route table is checked there; an API that returned
 * `/teacher/courses/x` would be a second, unchecked copy of it that nothing
 * would notice going stale.
 */
export interface DraftSummary {
  id: string;
  /** `EXAM_STUDIO` is not a ContentDraft row — see `list`. */
  kind: ContentDraftKind | 'EXAM_STUDIO';
  label: string;
  step: string;
  courseId: string | null;
  lessonId: string | null;
  updatedAt: Date;
  /** Studio sessions only: what the worker is doing, and how far it has got. */
  status?: string;
  stage?: string;
  progress?: { done: number; total: number };
}

/** Longer than any editing session, short enough that the list stays a list.
 *  A draft nobody has touched in a month is not work in progress. */
const KEEP_DAYS = 30;

/** A draft is a form's state, not a file upload. Anything approaching this is
 *  a bug in the caller, and rejecting it is cheaper than storing it. */
const MAX_DATA_BYTES = 256 * 1024;

/** How long a studio session may sit in UPLOADING before it is taken to be
 *  abandoned rather than arriving. Storing pages takes seconds. */
const UPLOADING_STALE_MS = 10 * 60_000;

/**
 * Work a teacher started and has not finished.
 *
 * Two different things end up on one list. A `ContentDraft` row is an ordinary
 * form that was being filled in — a lesson, an assignment — saved as it was
 * typed. An Exam Studio session is already durable on its own table, because
 * a worker is reading pages into it; it appears here so that "where was I"
 * has one answer instead of two.
 *
 * Nothing here is ever the source of truth for published content. A draft is
 * deleted the moment its form saves for real, so a row existing means there is
 * genuinely something unsaved — which is what makes it safe to put in front of
 * a teacher as "carry on".
 */
@Injectable()
export class DraftsService {
  private readonly logger = new Logger(DraftsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Save, or overwrite, one form's draft.
   *
   * An upsert on (tenant, scopeKey): the form autosaves every few seconds and
   * each save has to land on the same row, or a twenty-minute lesson write-up
   * would leave four hundred of them.
   */
  async save(scope: DraftScope, input: SaveDraftInput): Promise<DraftSummary> {
    const tenantId = scope.authorTenantId;
    if (!tenantId) {
      // Platform staff have no tenant to hang a draft on. They can still edit;
      // they just do not get autosave, which is better than writing rows that
      // no drafts list would ever be able to find again.
      throw new BadRequestException('Drafts belong to a teacher account');
    }
    const size = Buffer.byteLength(JSON.stringify(input.data ?? {}));
    if (size > MAX_DATA_BYTES) {
      throw new BadRequestException('Draft is too large to save');
    }

    const common = {
      academyId: scope.academyId,
      createdBy: scope.userId,
      kind: input.kind,
      courseId: input.courseId ?? null,
      lessonId: input.lessonId ?? null,
      label: (input.label ?? '').slice(0, 200),
      step: (input.step ?? '').slice(0, 60),
      data: (input.data ?? {}) as Prisma.InputJsonValue,
    };

    const row = await this.prisma.contentDraft.upsert({
      where: { tenantId_scopeKey: { tenantId, scopeKey: input.scopeKey } },
      create: { ...common, tenantId, scopeKey: input.scopeKey },
      update: common,
    });
    return this.summary(row);
  }

  /** One draft, or null. Null rather than a 404: a form asking "is there
   *  anything saved for me" is not making a mistake when the answer is no. */
  async find(scope: DraftScope, scopeKey: string) {
    const tenantId = scope.authorTenantId;
    if (!tenantId) return null;
    const row = await this.prisma.contentDraft.findUnique({
      where: { tenantId_scopeKey: { tenantId, scopeKey } },
    });
    if (!row || row.academyId !== scope.academyId) return null;
    return { ...this.summary(row), data: row.data };
  }

  /**
   * Everything unfinished, newest first.
   *
   * `courseId` narrows it to one course, which is how the course screen uses
   * it. Without it, the whole academy's — the teacher's dashboard question.
   */
  async list(scope: DraftScope, courseId?: string): Promise<DraftSummary[]> {
    await this.purgeExpired(scope);

    const tenantId = scope.authorTenantId;
    const mine = scope.manageAll ? {} : { tenantId: tenantId ?? '__none__' };

    const [drafts, sessions] = await Promise.all([
      this.prisma.contentDraft.findMany({
        where: { academyId: scope.academyId, ...mine, ...(courseId ? { courseId } : {}) },
        orderBy: { updatedAt: 'desc' },
        take: 50,
      }),
      // A studio session is unfinished until it has produced an exam or been
      // put down. REVIEW is the important one: the reading is finished, the
      // teacher has not looked at it yet, and that is exactly the state this
      // whole feature exists to make findable again.
      this.prisma.paperImport.findMany({
        where: {
          academyId: scope.academyId,
          deletedAt: null,
          ...mine,
          AND: [
            // A session started from "create exam" on the courses screen has
            // no course until the teacher picks one at the end — so inside a
            // course it was invisible, and a teacher who left it and went to
            // their course found nothing. Unassigned sessions show everywhere.
            ...(courseId ? [{ OR: [{ courseId }, { courseId: null }] }] : []),
            {
              OR: [
                { status: { in: ['PROCESSING', 'CONFIGURING', 'REVIEW', 'FAILED'] } },
                // UPLOADING lasts seconds. One older than that was left behind
                // by a refused start (before those were cleaned up) and has
                // nothing in it to resume.
                {
                  status: 'UPLOADING',
                  updatedAt: { gt: new Date(Date.now() - UPLOADING_STALE_MS) },
                },
              ],
            },
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take: 25,
        select: {
          id: true,
          title: true,
          status: true,
          stage: true,
          kind: true,
          courseId: true,
          progressDone: true,
          progressTotal: true,
          updatedAt: true,
        },
      }),
    ]);

    const fromSessions: DraftSummary[] = sessions.map((s) => ({
      id: s.id,
      kind: 'EXAM_STUDIO' as const,
      label: s.title,
      step: s.kind,
      courseId: s.courseId,
      lessonId: null,
      updatedAt: s.updatedAt,
      status: s.status,
      stage: s.stage,
      progress: { done: s.progressDone, total: s.progressTotal },
    }));

    return [...drafts.map((d) => this.summary(d)), ...fromSessions].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
  }

  /**
   * Throw one away.
   *
   * Called on two occasions that look the same from here and are not: the
   * teacher pressed "discard", or the form saved for real and the draft is
   * now a stale copy of something that exists. Either way the row goes.
   */
  async discard(scope: DraftScope, scopeKey: string): Promise<{ removed: number }> {
    const tenantId = scope.authorTenantId;
    if (!tenantId) return { removed: 0 };
    const { count } = await this.prisma.contentDraft.deleteMany({
      where: { tenantId, scopeKey, academyId: scope.academyId },
    });
    return { removed: count };
  }

  /** Old rows, cleaned up as a side effect of listing rather than on a
   *  schedule — there is no scheduler here worth adding one for, and the list
   *  is the only thing that cares. Failure is logged and ignored: a tidy-up
   *  must never be the reason a teacher cannot see their drafts. */
  private async purgeExpired(scope: DraftScope): Promise<void> {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
    try {
      await this.prisma.contentDraft.deleteMany({
        where: { academyId: scope.academyId, updatedAt: { lt: cutoff } },
      });
    } catch (e) {
      this.logger.warn(`Could not purge old drafts: ${(e as Error).message}`);
    }
  }

  private summary(row: {
    id: string;
    kind: ContentDraftKind;
    label: string;
    step: string;
    courseId: string | null;
    lessonId: string | null;
    updatedAt: Date;
  }): DraftSummary {
    return {
      id: row.id,
      kind: row.kind,
      label: row.label,
      step: row.step,
      courseId: row.courseId,
      lessonId: row.lessonId,
      updatedAt: row.updatedAt,
    };
  }
}
