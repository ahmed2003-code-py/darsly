import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as fs from 'fs';
import { JwtPayload, Role } from '@darsly/shared-types';
import { SubjectExclusivityService } from '../catalog/subject-exclusivity.service';
import { validateThumbnailUrl } from '../common/image.util';
import { PrismaService } from '../prisma/prisma.service';
import { EntryExamService } from './entry-exam.service';
import { AcademyMediaService } from '../academy-site/media/academy-media.service';
import { StorageProvider } from '../storage/storage.provider';
import { VideoProcessingService } from '../video/video-processing.service';
import { LessonDescriptionService } from '../video/lesson-description.service';
import { VideoSource, YoutubeImportService } from '../video/youtube-import.service';
import { DiscoverCoursesDto as DiscoverCoursesQuery } from './dto/discover-courses.dto';
import { StudentPriceService } from '../payments/student-price.service';
import { yearAdmits } from '../catalog/course-year';
import { viewerGrade, viewerTrack } from '../catalog/stage.util';
import { trackFilter } from '../catalog/subject-track';
import { assertSplitConfigured } from '../payments/revenue-split';
import {
  CreateCourseDto,
  CreateLessonDto,
  ImportYoutubeDto,
  ReorderDto,
  SetBundleItemsDto,
  UpdateCourseDto,
  UpdateLessonDto,
  UpsertUnitDto,
} from './dto/course.dto';

/** Every read of a course answers with the same shape for where it is aimed. */
const COURSE_REACH = { subject: true, grades: { include: { grade: true } } } as const;

// Decoded-bytes cap for a thumbnail data-URL. Sized just above the DTO's
// 900_000-char limit (~675 KB decoded) so validation never rejects a payload the
// controller already accepted; the point here is type/protocol safety, not size.
const THUMBNAIL_MAX_BYTES = 700 * 1024;

/**
 * How the caller relates to the courses they're touching. Built by the
 * controller from the validated AcademyContext (organisation) and the JWT
 * tenantId (authorship); never from the request body.
 */
export interface CourseScope {
  /** The organisation the caller is acting in. */
  academyId: string;
  /** The caller's own TeacherProfile.id. Undefined for STAFF / platform admin. */
  authorTenantId?: string;
  /** OWNER / platform admin: every course offered in the academy, not only their own. */
  manageAll: boolean;
}

@Injectable()
export class CoursesService {
  private readonly logger = new Logger(CoursesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly studentPrice: StudentPriceService,
    private readonly exclusivity: SubjectExclusivityService,
    private readonly storage: StorageProvider,
    private readonly videoProcessing: VideoProcessingService,
    private readonly youtubeImport: YoutubeImportService,
    private readonly lessonDescription: LessonDescriptionService,
    private readonly media: AcademyMediaService,
    private readonly entryExam: EntryExamService,
  ) {}

  /**
   * Student-facing course discovery.
   *
   * A published course used to be reachable only by knowing its teacher: the
   * catalogue had a detail endpoint and no listing, so the whole of a teacher's
   * work was invisible to anyone who had not already found them.
   *
   * Every filter resolves in SQL and the page is taken with skip/take, because
   * this is the one list on the platform that grows without bound. The teacher
   * directory filters price and rating in memory over the whole table; doing
   * that here would load the entire catalogue to show ten rows.
   */
  async discover(query: DiscoverCoursesQuery, viewerUserId?: string) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(24, Math.max(1, query.pageSize ?? 10));

    // A student already studying a subject is not shown the other teachers of
    // it. Empty for everyone else, and the clause is only added when it has
    // something in it — `notIn: []` is not a filter worth generating.
    // Three independent lookups — none reads another's result — so they run
    // together rather than as three sequential round-trips per request. Under
    // concurrency this is where the extra latency was: each request held a
    // connection through three serial queries before its main query even began.
    const [hidden, gradeId, track] = await Promise.all([
      this.exclusivity.hiddenTeacherIds(viewerUserId),
      viewerGrade(this.prisma, query, viewerUserId),
      viewerTrack(this.prisma, viewerUserId),
    ]);
    const tracks = trackFilter(track);

    const priceFilter: Prisma.IntFilter = {};
    if (query.free) priceFilter.equals = 0;
    else {
      if (query.priceMinCents != null) priceFilter.gte = query.priceMinCents;
      if (query.priceMaxCents != null) priceFilter.lte = query.priceMaxCents;
    }

    const where: Prisma.CourseWhereInput = {
      status: 'PUBLISHED',
      deletedAt: null,
      // A course is only as visible as the teacher behind it. Suspending a
      // teacher must take their catalogue with them.
      teacher: {
        status: 'APPROVED',
        user: { isActive: true },
        ...(query.language ? { language: query.language } : {}),
      },
      // Both conditions land on `tenantId`, so when both apply they are merged
      // rather than spread — two spreads of the same key silently drop the
      // first, which would have turned "this teacher's courses" into "everyone
      // but the rivals" the moment a student filtered by teacher. With nobody
      // to hide the clause stays exactly as it was, which is every anonymous
      // request and every request from a student who has not enrolled yet.
      ...(hidden.length
        ? { tenantId: { ...(query.teacherId ? { equals: query.teacherId } : {}), notIn: hidden } }
        : query.teacherId
          ? { tenantId: query.teacherId }
          : {}),
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      ...(Object.keys(priceFilter).length ? { priceCents: priceFilter } : {}),
      ...(query.hasPreview
        ? { units: { some: { deletedAt: null, lessons: { some: { deletedAt: null, isFreePreview: true } } } } }
        : {}),
      // The year and the search text are both a set of alternatives, so they
      // are collected here rather than spread: as two `OR` keys on one object
      // the second silently replaced the first, and typing anything into the
      // search box dropped the year filter — a third-secondary student who
      // searched was shown every year's courses again. Inside `AND` the two
      // narrow together, and a third such filter will too.
      AND: [
        // The whole point of asking a student their year: a course names the
        // years it is for, and a second-baccalaureate student is shown those
        // and not the rest of the band. A course that named no year is still
        // shown — it was never narrowed, which is not the same as being for
        // nobody.
        ...(gradeId
          ? [{ OR: [{ grades: { some: { gradeId } } }, { grades: { none: {} } }] }]
          : []),
        // And the other half of the same question: a language-school student
        // sits a different syllabus, so the national system's courses are not
        // theirs to take. A course with no subject was never filed under either
        // system, so it stays — same reasoning as a course with no year.
        ...(tracks
          ? [{ OR: [{ subject: { track: { in: tracks } } }, { subjectId: null }] }]
          : []),
        ...(query.q?.trim()
          ? [
              {
                OR: [
                  { title: { contains: query.q.trim(), mode: 'insensitive' as const } },
                  { description: { contains: query.q.trim(), mode: 'insensitive' as const } },
                  { teacher: { user: { fullName: { contains: query.q.trim(), mode: 'insensitive' as const } } } },
                ],
              },
            ]
          : []),
      ],
    };

    // `popular` and `rating` are aggregates, so they cannot be an ORDER BY on
    // this query. They are ordered after the page is fetched, which means the
    // ordering is within-page only — an honest limitation, and the reason
    // `newest` is the default rather than something that looks smarter.
    const orderBy: Prisma.CourseOrderByWithRelationInput =
      query.sort === 'priceAsc' ? { priceCents: 'asc' }
      : query.sort === 'priceDesc' ? { priceCents: 'desc' }
      : query.sort === 'popular' ? { enrollments: { _count: 'desc' } }
      : { createdAt: 'desc' };

    const [total, rows] = await Promise.all([
      this.prisma.course.count({ where }),
      this.prisma.course.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          subject: true,
          grades: { include: { grade: true } },
          teacher: {
            select: {
              id: true, slug: true, language: true, verifiedAt: true,
              user: { select: { fullName: true, avatarUrl: true } },
            },
          },
          units: {
            where: { deletedAt: null },
            select: { lessons: { where: { deletedAt: null }, select: { durationSec: true, isFreePreview: true } } },
          },
          _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } },
        },
      }),
    ]);

    // One grouped query for the whole page rather than one per card.
    const ids = rows.map((c) => c.id);
    const ratings = ids.length
      ? await this.prisma.review.groupBy({
          by: ['courseId'],
          where: { courseId: { in: ids } },
          _avg: { rating: true },
          _count: true,
        })
      : [];
    const ratingByCourse = new Map(ratings.map((r) => [r.courseId, r]));

    const items = await this.studentPrice.applyToMany(
      rows.map((c) => {
        const lessons = c.units.flatMap((u) => u.lessons);
        const rating = ratingByCourse.get(c.id);
        return {
          id: c.id,
          title: c.title,
          description: c.description,
          thumbnailUrl: c.thumbnailUrl,
          subject: c.subject,
          grades: c.grades.map((g) => g.grade),
          pricingModel: c.pricingModel,
          priceCents: c.priceCents,
          currency: c.currency,
          lessonsCount: lessons.length,
          totalDurationSec: lessons.reduce((sum, l) => sum + l.durationSec, 0),
          freePreviewCount: lessons.filter((l) => l.isFreePreview).length,
          studentsCount: c._count.enrollments,
          avgRating: rating?._avg.rating ? Math.round(rating._avg.rating * 10) / 10 : null,
          reviewsCount: rating?._count ?? 0,
          createdAt: c.createdAt,
          teacher: {
            id: c.teacher.id,
            slug: c.teacher.slug,
            fullName: c.teacher.user.fullName,
            avatarUrl: c.teacher.user.avatarUrl,
            verified: !!c.teacher.verifiedAt,
            language: c.teacher.language,
          },
          tenantId: c.tenantId,
        };
      }),
      (c) => c.tenantId,
    );

    if (query.sort === 'rating') {
      items.sort((a, b) => (b.avgRating ?? 0) - (a.avgRating ?? 0));
    }

    return {
      items: items.map(({ tenantId: _t, ...rest }) => rest),
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  // ── Scope helpers ─────────────────────────────────────────────────────────
  // Two different questions, never conflated:
  //   academyId  — which organisation the caller is acting in (validated
  //                AcademyContext). Every row must belong to it.
  //   tenantId   — who authored the row (the caller's own TeacherProfile).
  // OWNER (and a platform admin) may manage every course offered in the
  // academy; a TEACHER member only the ones they authored. Anything outside
  // the scope 404s (we never reveal other academies' resources exist).

  private scopeWhere(scope: CourseScope): Prisma.CourseWhereInput {
    if (scope.manageAll) return { academyId: scope.academyId };
    // A non-owner without an author identity can match nothing.
    return { academyId: scope.academyId, tenantId: scope.authorTenantId ?? '' };
  }

  /** The caller's own TeacherProfile — required wherever content is authored or media is owned. */
  private author(scope: CourseScope): string {
    if (!scope.authorTenantId) {
      throw new ForbiddenException({ message: 'Only a teacher can author content', code: 'NOT_AN_AUTHOR' });
    }
    return scope.authorTenantId;
  }

  private async academyKind(academyId: string): Promise<'PERSONAL' | 'CENTER'> {
    const a = await this.prisma.academy.findUnique({ where: { id: academyId }, select: { kind: true } });
    if (!a) throw new NotFoundException('Academy not found');
    return a.kind;
  }

  /**
   * Phase 7: a Center course may carry a price only once the Center has agreed
   * a revenue share with its author — the split is what turns a price into
   * money that can be booked. No default percentage is assumed.
   */
  private async assertCenterPricing(kind: 'PERSONAL' | 'CENTER', academyId: string, tenantId: string, priceCents: number | undefined) {
    if (kind === 'CENTER' && (priceCents ?? 0) > 0) {
      await assertSplitConfigured(this.prisma, { tenantId, academyId, priceCents: priceCents ?? 0 });
    }
  }

  /** A Center may only offer subjects it has switched on (opt-in; PERSONAL is never gated). */
  private async assertSubjectOffered(academyId: string, subjectId: string) {
    const row = await this.prisma.academySubject.findUnique({ where: { academyId_subjectId: { academyId, subjectId } }, select: { isActive: true } });
    if (!row?.isActive) {
      throw new BadRequestException({ message: 'This Center does not offer that subject', code: 'SUBJECT_NOT_OFFERED', subjectId });
    }
  }

  /**
   * Oversight is not authorship.
   *
   * `manageAll` answers "may I see this course" — a Center's OWNER and the
   * platform admin must be able to look at everything offered under them, for
   * free and in full. It never answered "may I rewrite it", and treating the
   * two as one question meant the desk that administers a Center, and the
   * platform itself, could silently edit a teacher's lessons. The course
   * belongs to the person who wrote it; the only authority an overseer holds
   * over it is to stop it being sold (see `update`, which lets a non-author
   * send `status` and nothing else).
   */
  private assertAuthored(scope: CourseScope, course: { tenantId: string }): void {
    if (scope.authorTenantId && course.tenantId === scope.authorTenantId) return;
    throw new ForbiddenException({
      message: 'Only the teacher who wrote this course can change its content',
      code: 'NOT_THE_AUTHOR',
    });
  }

  /** `oversight: true` skips the authorship check — for the read-and-unpublish paths only. */
  private async assertCourse(scope: CourseScope, courseId: string, opts: { oversight?: boolean } = {}) {
    const course = await this.prisma.course.findFirst({ where: { id: courseId, ...this.scopeWhere(scope) } });
    if (!course) throw new NotFoundException('Course not found');
    if (!opts.oversight) this.assertAuthored(scope, course);
    return course;
  }

  private async assertUnit(scope: CourseScope, unitId: string) {
    const unit = await this.prisma.courseUnit.findFirst({
      where: { id: unitId, course: this.scopeWhere(scope) },
      include: { course: true },
    });
    if (!unit) throw new NotFoundException('Unit not found');
    this.assertAuthored(scope, unit.course);
    return unit;
  }

  private async assertLesson(scope: CourseScope, lessonId: string) {
    const lesson = await this.prisma.lesson.findFirst({
      where: { id: lessonId, unit: { course: this.scopeWhere(scope) } },
      include: { unit: { include: { course: true } } },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    this.assertAuthored(scope, lesson.unit.course);
    return lesson;
  }

  // ── Teacher CRUD ─────────────────────────────────────────────────────────

  /**
   * A course's years, in the one shape the app is written for.
   *
   * Prisma returns the join rows — `{ courseId, gradeId, grade }` — and the
   * screens all read `grade.id` / `grade.nameAr` straight off the list, so a
   * course carrying raw rows came back with every year named `undefined`.
   * Worse, the edit form seeds itself from that list: reopening a course sent
   * `gradeIds: [undefined]` and the save was refused with "each value in
   * gradeIds must be a string", which is a true sentence about a value the
   * teacher never typed. Flattened once here, for every read.
   */
  private static flattenGrades<G, T extends { grades?: { grade: G }[] }>(
    row: T,
  ): Omit<T, 'grades'> & { grades: G[] } {
    const rows = row?.grades;
    return {
      ...row,
      grades: Array.isArray(rows) ? rows.map((g) => (g?.grade ?? g) as G) : ([] as G[]),
    };
  }

  async listMine(scope: CourseScope) {
    const rows = await this.prisma.course.findMany({
      where: this.scopeWhere(scope),
      include: {
        subject: true,
        grades: { include: { grade: true } },
        units: { where: { deletedAt: null }, select: { _count: { select: { lessons: { where: { deletedAt: null } } } } } },
        _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
    // `canEdit` is the same question `assertAuthored` answers, told to the
    // screen so it can draw an overseer's list without edit affordances that
    // would 403 on click.
    return rows.map((r) => ({ ...CoursesService.flattenGrades(r), canEdit: this.canEdit(scope, r) }));
  }

  /** Whether this caller authored the row — oversight reads, authorship writes. */
  private canEdit(scope: CourseScope, course: { tenantId: string }): boolean {
    return !!scope.authorTenantId && course.tenantId === scope.authorTenantId;
  }

  async getMine(scope: CourseScope, courseId: string) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, ...this.scopeWhere(scope) },
      include: {
        subject: true,
        grades: { include: { grade: true } },
        units: {
          where: { deletedAt: null },
          orderBy: { sortOrder: 'asc' },
          include: {
            lessons: {
              where: { deletedAt: null },
              orderBy: { sortOrder: 'asc' },
              include: {
                attachments: { where: { deletedAt: null } },
                videoAsset: { select: { id: true, status: true, durationSec: true, sizeBytes: true } },
              },
            },
          },
        },
        bundleItems: { include: { course: { select: { id: true, title: true, priceCents: true } } } },
        _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } },
      },
    });
    if (!course) throw new NotFoundException('Course not found');
    // BigInt (sizeBytes) doesn't survive JSON.stringify — stringify it here.
    return JSON.parse(
      JSON.stringify(
        { ...CoursesService.flattenGrades(course), canEdit: this.canEdit(scope, course) },
        (_, v) => (typeof v === 'bigint' ? Number(v) : v),
      ),
    );
  }

  /**
   * What this teacher is allowed to aim a course at.
   *
   * The subject has to be one of theirs — they chose them when they signed up
   * and a course is not the place to add a new one — but which of them is the
   * course's is now a real question, because a teacher who takes both school
   * systems has more than one. Teaching exactly one subject answers it without
   * being asked, which is what every teacher on the platform before this did.
   *
   * The stages are the ones they signed up for, and a course left unnarrowed
   * goes to all of them rather than to none, because an empty list in the form
   * means "I didn't pick", not "nobody".
   */
  private async reachOf(scope: CourseScope, wanted?: string[], wantedSubject?: string) {
    const tenantId = this.author(scope);
    const teacher = await this.prisma.teacherProfile.findUniqueOrThrow({
      where: { id: tenantId },
      select: { stages: true, subjects: { select: { subjectId: true } } },
    });
    const ownSubjects = teacher.subjects.map((s) => s.subjectId);
    if (wantedSubject && !ownSubjects.includes(wantedSubject)) {
      throw new BadRequestException({
        message: 'You did not sign up to teach that subject',
        code: 'SUBJECT_NOT_YOURS',
        subjectId: wantedSubject,
      });
    }
    const subjectId = wantedSubject ?? (ownSubjects.length === 1 ? ownSubjects[0] : null);
    if (!subjectId && ownSubjects.length > 1) {
      throw new BadRequestException({
        message: 'Say which of your subjects this course is',
        code: 'SUBJECT_REQUIRED',
        subjectIds: ownSubjects,
      });
    }
    // The years inside the stages this teacher signed up for. Asked for once
    // and used both to default and to check, so the form's options and the
    // rule behind them can never drift apart.
    const mine = teacher.stages.length
      ? await this.prisma.gradeLevel.findMany({
          where: { isActive: true, stage: { in: teacher.stages } },
          select: { id: true },
        })
      : [];
    const allowed = new Set(mine.map((g) => g.id));
    const asked = wanted?.length ? wanted : [...allowed];
    const outside = asked.filter((id) => !allowed.has(id));
    if (outside.length) {
      throw new BadRequestException({
        message: 'You did not sign up to teach that year',
        code: 'GRADE_NOT_YOURS',
        gradeIds: outside,
      });
    }
    return { subjectId, gradeIds: asked };
  }

  async create(scope: CourseScope, dto: CreateCourseDto) {
    const tenantId = this.author(scope);
    if (dto.thumbnailUrl) validateThumbnailUrl(dto.thumbnailUrl, THUMBNAIL_MAX_BYTES);
    const kind = await this.academyKind(scope.academyId);
    await this.assertCenterPricing(kind, scope.academyId, tenantId, dto.priceCents);
    const { gradeIds, subjectId: wantedSubject, ...rest } = dto;
    const { subjectId, gradeIds: years } = await this.reachOf(scope, gradeIds, wantedSubject);
    if (kind === 'CENTER' && subjectId) await this.assertSubjectOffered(scope.academyId, subjectId);
    return this.prisma.course.create({
      data: {
        ...rest,
        subjectId,
        tenantId,
        academyId: scope.academyId,
        grades: { create: years.map((gradeId) => ({ gradeId })) },
      },
      include: COURSE_REACH,
    });
  }

  /**
   * The clip a teacher records to sell the course.
   *
   * This is marketing, so it is stored the way the cover image is — a plain
   * public MP4 anyone can watch, including a visitor who is not signed in.
   * Lesson video goes the other way, through encrypted HLS with a per-session
   * key, and the two must never be confused: what is uploaded here is meant to
   * be seen by people who have not paid.
   */
  async setIntroVideo(
    scope: CourseScope,
    courseId: string,
    file: { buffer: Buffer; mimetype: string },
  ) {
    const owned = await this.assertCourse(scope, courseId);
    const media = await this.media.upload(owned.tenantId, 'COURSE_INTRO', file);
    const course = await this.prisma.course.findUniqueOrThrow({
      where: { id: courseId },
      select: { introVideoMediaId: true },
    });
    const updated = await this.prisma.course.update({
      where: { id: courseId },
      data: { introVideoUrl: media.url, introVideoMediaId: media.id },
      select: { id: true, introVideoUrl: true, introVideoMediaId: true },
    });
    // Re-recording replaces the clip; the old file has no other reader, so it
    // goes rather than sitting in storage forever.
    await this.dropIntroMedia(owned.tenantId, course.introVideoMediaId, media.id);
    return updated;
  }

  async removeIntroVideo(scope: CourseScope, courseId: string) {
    const owned = await this.assertCourse(scope, courseId);
    const course = await this.prisma.course.findUniqueOrThrow({
      where: { id: courseId },
      select: { introVideoMediaId: true },
    });
    const updated = await this.prisma.course.update({
      where: { id: courseId },
      data: { introVideoUrl: null, introVideoMediaId: null },
      select: { id: true, introVideoUrl: true, introVideoMediaId: true },
    });
    await this.dropIntroMedia(owned.tenantId, course.introVideoMediaId, null);
    return updated;
  }

  /**
   * Delete the media row a course has stopped pointing at.
   *
   * Identical uploads are deduplicated into one row, so two courses can share a
   * clip; the check keeps a delete from pulling the video out from under the
   * other course. Best-effort: the course field is already cleared, and failing
   * to tidy storage must not fail the request.
   */
  private async dropIntroMedia(tenantId: string, mediaId: string | null, keep: string | null) {
    if (!mediaId || mediaId === keep) return;
    try {
      const stillUsed = await this.prisma.course.count({
        where: { introVideoMediaId: mediaId },
      });
      if (stillUsed > 0) return;
      await this.media.remove(tenantId, mediaId);
    } catch (err) {
      this.logger.warn(`could not remove intro clip ${mediaId}: ${String(err)}`);
    }
  }

  async update(scope: CourseScope, courseId: string, dto: UpdateCourseDto) {
    const existing = await this.assertCourse(scope, courseId, { oversight: true });
    // An overseer — a Center's OWNER, the platform admin — may take a course
    // off sale and nothing else. Anything beyond `status` in the same payload
    // is refused outright rather than quietly dropped, so a caller is never
    // told a change was saved that was not.
    if (!scope.authorTenantId || existing.tenantId !== scope.authorTenantId) {
      const touched = Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined);
      if (touched.some((k) => k !== 'status')) this.assertAuthored(scope, existing);
    }
    if (dto.thumbnailUrl) validateThumbnailUrl(dto.thumbnailUrl, THUMBNAIL_MAX_BYTES);
    if (dto.priceCents !== undefined || dto.status === 'PUBLISHED') {
      await this.assertCenterPricing(await this.academyKind(scope.academyId), scope.academyId, existing.tenantId, dto.priceCents ?? existing.priceCents);
    }

    if (dto.status === 'PUBLISHED') {
      const lessons = await this.prisma.lesson.count({
        where: { unit: { courseId } },
      });
      if (lessons === 0) {
        throw new BadRequestException({
          message: 'Cannot publish a course with no lessons',
          code: 'NO_LESSONS',
        });
      }
    }

    // A lesson named as the exam or the assignment has to be in this course and
    // of the matching type. The id comes from a browser, so pointing the gate at
    // somebody else's lesson — or at a video — is refused rather than stored.
    for (const [field, want] of [
      ['examLessonId', 'QUIZ'],
      ['assignmentLessonId', 'ASSIGNMENT'],
    ] as const) {
      const id = dto[field];
      if (id == null || id === '') continue;
      const ok = await this.prisma.lesson.findFirst({
        where: { id: String(id), deletedAt: null, type: want, unit: { courseId } },
        select: { id: true },
      });
      if (!ok) {
        throw new BadRequestException({
          message: `That lesson cannot be this course's ${want === 'QUIZ' ? 'exam' : 'assignment'}`,
          code: 'BAD_ASSESSMENT_LESSON',
        });
      }
    }

    // A placement test needs a test to place with. GATE is harmless without one
    // — the gate reads both fields and opens when either is missing — but it is
    // a state the teacher cannot see or act on, so it is refused now rather than
    // stored to surprise them later, when naming an exam would silently shut the
    // course behind it.
    if (dto.examMode === 'GATE') {
      const named =
        dto.examLessonId ??
        (await this.prisma.course.findUnique({
          where: { id: courseId },
          select: { examLessonId: true },
        }))?.examLessonId;
      if (!named) {
        throw new BadRequestException({
          message: 'Name the exam lesson before making it a gate',
          code: 'NO_EXAM_TO_GATE',
        });
      }
    }

    const { gradeIds, subjectId: sentSubject, ...rest } = dto;
    /**
     * A subject is only checked when it is actually being changed.
     *
     * The comment here used to claim that and the code did not do it: the edit
     * form restates every field it loaded, so a teacher changing nothing but
     * the price still sent the course's existing subject, and that went through
     * the "did you sign up to teach this?" gate every time. A teacher whose
     * subject list has since moved — an admin edited it, or the catalogue
     * changed underneath them — was then locked out of their own course
     * entirely, refused with a sentence about a subject they had not touched.
     *
     * Re-aiming a course at a subject that is not theirs is still refused; it
     * is only leaving it where it already is that stopped counting as a change.
     */
    const current =
      sentSubject || gradeIds
        ? await this.prisma.course.findUnique({
            where: { id: courseId },
            select: { subjectId: true, grades: { select: { gradeId: true } } },
          })
        : null;
    const wantedSubject = sentSubject && sentSubject !== current?.subjectId ? sentSubject : undefined;

    // The years get the same treatment, and for the same reason: the form
    // restates the ones the course already has, and re-validating those locked
    // a teacher out whenever the stages they teach had moved. Compared as sets
    // — the order a teacher ticks boxes in is not a change.
    const sameYears =
      !!gradeIds &&
      !!current &&
      gradeIds.length === current.grades.length &&
      new Set(gradeIds).size === new Set(current.grades.map((g) => g.gradeId)).size &&
      gradeIds.every((id) => current.grades.some((g) => g.gradeId === id));
    const wantedYears = sameYears ? undefined : gradeIds;

    const reach = wantedYears || wantedSubject ? await this.reachOf(scope, wantedYears, wantedSubject) : null;
    if (reach?.subjectId && (await this.academyKind(scope.academyId)) === 'CENTER') {
      await this.assertSubjectOffered(scope.academyId, reach.subjectId);
    }
    return this.prisma.course.update({
      where: { id: courseId },
      data: {
        ...rest,
        ...(reach?.subjectId ? { subjectId: reach.subjectId } : {}),
        // Replaced wholesale, and only when the teacher actually sent a list:
        // moving a course to another subject must not silently re-aim it at
        // every year they teach.
        ...(reach && wantedYears
          ? { grades: { deleteMany: {}, create: reach.gradeIds.map((gradeId) => ({ gradeId })) } }
          : {}),
      },
      include: COURSE_REACH,
    });
  }

  /** Hard-delete only when nobody ever enrolled; otherwise archive. */
  /**
   * Delete means delete.
   *
   * This used to archive anything with an enrolment, which left the course
   * sitting in the teacher's list wearing an "archived" badge after they had
   * asked for it to be gone — a refusal dressed as a result. The row is still
   * recoverable: `delete` on this model stamps `deletedAt` rather than
   * destroying anything, so a course removed by mistake comes back with one
   * UPDATE. What it does not do is stay on screen.
   *
   * The enrolments are answered too. A student who paid for this keeps the
   * payment and the record; what they lose is a course the teacher withdrew,
   * which is the teacher's call to make about their own catalogue.
   */
  async remove(scope: CourseScope, courseId: string) {
    await this.assertCourse(scope, courseId);
    const students = await this.prisma.enrollment.count({
      where: { courseId, status: 'ACTIVE' },
    });
    await this.prisma.course.delete({ where: { id: courseId } });
    return { id: courseId, deleted: true, studentsAffected: students };
  }

  async setBundleItems(scope: CourseScope, bundleId: string, dto: SetBundleItemsDto) {
    const bundle = await this.assertCourse(scope, bundleId);
    if (bundle.pricingModel !== 'BUNDLE') {
      throw new BadRequestException('Course pricing model is not BUNDLE');
    }
    if (dto.courseIds.includes(bundleId)) {
      throw new BadRequestException('A bundle cannot contain itself');
    }
    const children = await this.prisma.course.findMany({
      where: { id: { in: dto.courseIds }, ...this.scopeWhere(scope) },
      select: { id: true },
    });
    if (children.length !== dto.courseIds.length) {
      throw new NotFoundException('One or more courses not found');
    }
    await this.prisma.$transaction([
      this.prisma.bundleItem.deleteMany({ where: { bundleId } }),
      this.prisma.bundleItem.createMany({
        data: dto.courseIds.map((courseId) => ({ bundleId, courseId })),
      }),
    ]);
    return this.getMine(scope, bundleId);
  }

  // ── Units ────────────────────────────────────────────────────────────────

  async createUnit(scope: CourseScope, courseId: string, dto: UpsertUnitDto) {
    await this.assertCourse(scope, courseId);
    const last = await this.prisma.courseUnit.aggregate({
      where: { courseId },
      _max: { sortOrder: true },
    });
    return this.prisma.courseUnit.create({
      data: {
        courseId,
        title: dto.title,
        sortOrder: dto.sortOrder ?? (last._max.sortOrder ?? -1) + 1,
      },
    });
  }

  async updateUnit(scope: CourseScope, unitId: string, dto: UpsertUnitDto) {
    await this.assertUnit(scope, unitId);
    return this.prisma.courseUnit.update({ where: { id: unitId }, data: dto });
  }

  async removeUnit(scope: CourseScope, unitId: string) {
    await this.assertUnit(scope, unitId);
    await this.prisma.courseUnit.delete({ where: { id: unitId } });
    return { id: unitId, deleted: true };
  }

  async reorderUnits(scope: CourseScope, courseId: string, dto: ReorderDto) {
    await this.assertCourse(scope, courseId);
    await this.prisma.$transaction(
      dto.ids.map((id, i) =>
        this.prisma.courseUnit.updateMany({
          where: { id, courseId },
          data: { sortOrder: i },
        }),
      ),
    );
    return { ok: true };
  }

  // ── Lessons ──────────────────────────────────────────────────────────────

  private async assertVideoAssetOwned(tenantId: string, videoAssetId: string) {
    const asset = await this.prisma.videoAsset.findFirst({
      where: { id: videoAssetId, tenantId },
    });
    if (!asset) throw new NotFoundException('Video asset not found');
    return asset;
  }

  async createLesson(scope: CourseScope, unitId: string, dto: CreateLessonDto) {
    await this.assertUnit(scope, unitId);
    if (dto.videoAssetId) await this.assertVideoAssetOwned(this.author(scope), dto.videoAssetId);
    return this.insertLesson(unitId, dto);
  }

  /**
   * Add a lesson straight to the course — no section required. A short
   * course that is really just a playlist of lessons shouldn't need a
   * container invented for it first.
   *
   * Lands in one hidden "default" unit, created the first time this is
   * called. It never appears as a section in the curriculum tree — the
   * builder renders its lessons as a flat list above the named sections —
   * but underneath it is an ordinary CourseUnit, so nothing else in the
   * lesson/quiz/assignment/progress pipeline needs to know it's different.
   */
  async addLessonDirect(scope: CourseScope, courseId: string, dto: CreateLessonDto) {
    await this.assertCourse(scope, courseId);
    if (dto.videoAssetId) await this.assertVideoAssetOwned(this.author(scope), dto.videoAssetId);
    const unit = await this.getOrCreateDefaultUnit(courseId);
    return this.insertLesson(unit.id, dto);
  }

  /**
   * Bulk-create lessons from YouTube links in one request. Metadata (title,
   * description) is fetched synchronously per link — a few seconds each, but
   * worth it so the lessons come back named, not as placeholders — while the
   * actual download and transcode run in the background through the exact
   * same VideoProcessingService pipeline a manual upload goes through, so an
   * imported lesson is neither special-cased nor less protected than any other.
   */
  async importYoutube(scope: CourseScope, courseId: string, dto: ImportYoutubeDto) {
    await this.assertCourse(scope, courseId);

    let unitId: string;
    if (dto.unitId) {
      const unit = await this.assertUnit(scope, dto.unitId);
      if (unit.courseId !== courseId) {
        throw new BadRequestException('That section does not belong to this course');
      }
      unitId = unit.id;
    } else {
      unitId = (await this.getOrCreateDefaultUnit(courseId)).id;
    }

    const results: Array<{
      url: string;
      lesson?: unknown;
      error?: 'INVALID_URL' | 'METADATA_FAILED';
      detail?: string;
      retried?: boolean;
    }> = [];
    for (const url of dto.urls) {
      const source = this.youtubeImport.resolveSource(url);
      if (!source) {
        results.push({ url, error: 'INVALID_URL' });
        continue;
      }

      let meta;
      try {
        meta = await this.youtubeImport.fetchMetadata(source);
      } catch (err: any) {
        this.logger.warn(`${source.platform} metadata fetch failed for ${source.id}: ${err.message}`);
        // Surfaced to the caller (truncated) rather than logged only — yt-dlp's
        // own message usually says WHY (age-restricted, region-locked, a bot
        // check), which is worth more to whoever is looking at this than a
        // bare "failed".
        results.push({ url, error: 'METADATA_FAILED', detail: String(err.message ?? '').slice(0, 300) });
        continue;
      }

      // What YouTube calls a description is written for a feed, not for a
      // lesson: an episode number, a plea to subscribe, a row of hashtags. The
      // rule pass took the links and the credits out; this turns what is left
      // into the two sentences a student wants before pressing play — and
      // returns nothing at all when the source never said what the video
      // teaches. An empty field a teacher fills in beats a full one nobody
      // wrote.
      meta = { ...meta, description: await this.lessonDescription.write({ title: meta.title, cleaned: meta.description }) };

      // A teacher who retries the same link after a failed download (there's
      // no way to tell them apart from a genuinely new video — nothing here
      // stores the source video id) would otherwise get a second lesson every
      // time instead of the existing one just trying again. YouTube's title
      // is stable per video, so a same-title lesson already in this section
      // is treated as the same import: a FAILED one is retried in place, a
      // still-good one is left untouched, and neither spawns a duplicate.
      const existing = await this.prisma.lesson.findFirst({
        where: { unitId, title: meta.title, deletedAt: null, videoAssetId: { not: null } },
        include: { videoAsset: true },
      });
      if (existing?.videoAsset) {
        // VideoAsset.sizeBytes is a BigInt — fine for Prisma, fatal for
        // JSON.stringify, so the lesson goes out without the nested relation
        // exactly like the plain-create path below already returns it.
        const { videoAsset, ...lessonOnly } = existing;
        if (videoAsset.status === 'FAILED') {
          await this.prisma.videoAsset.update({
            where: { id: videoAsset.id },
            data: { status: 'UPLOADING' },
          });
          results.push({ url, lesson: lessonOnly, retried: true });
          void this.downloadAndProcessYoutube(videoAsset.id, source).catch((err) =>
            this.logger.error(`${source.platform} import retry ${source.id} (asset ${videoAsset.id}) failed: ${err.message}`),
          );
        } else {
          results.push({ url, lesson: lessonOnly });
        }
        continue;
      }

      const asset = await this.prisma.videoAsset.create({
        data: { tenantId: this.author(scope), originalKey: '', status: 'UPLOADING' },
      });
      const lesson = await this.insertLesson(unitId, {
        title: meta.title,
        description: meta.description || undefined,
        isFreePreview: dto.isFreePreview,
        dripUnlockAt: dto.dripUnlockAt,
        dripAfterEnrollDays: dto.dripAfterEnrollDays,
        videoAssetId: asset.id,
      } as CreateLessonDto);
      results.push({ url, lesson });

      // Off the request thread — the caller doesn't wait for a download.
      void this.downloadAndProcessYoutube(asset.id, source).catch((err) =>
        this.logger.error(`${source.platform} import ${source.id} (asset ${asset.id}) failed: ${err.message}`),
      );
    }
    return { results };
  }

  private async downloadAndProcessYoutube(assetId: string, source: VideoSource): Promise<void> {
    const tmp = this.youtubeImport.tempPath(assetId);
    try {
      await this.youtubeImport.download(source, tmp);
      const sourceKey = `source/${assetId}.mp4`;
      const stat = await fs.promises.stat(tmp);
      await this.storage.put(sourceKey, fs.createReadStream(tmp), { contentType: 'video/mp4' });
      // Source key and packaging promise, committed together — see the same
      // pairing in uploads.controller.ts.
      await this.prisma.$transaction(async (tx) => {
        const asset = await tx.videoAsset.update({
          where: { id: assetId },
          data: { originalKey: sourceKey, sizeBytes: BigInt(stat.size) },
        });
        await this.videoProcessing.enqueue(assetId, asset.tenantId, tx);
      });
    } catch (err) {
      await this.prisma.videoAsset
        .update({ where: { id: assetId }, data: { status: 'FAILED' } })
        .catch(() => undefined);
      throw err;
    } finally {
      await this.youtubeImport.cleanup(tmp);
    }
  }

  /** The one unit a course may have for lessons added with no section at all. */
  private async getOrCreateDefaultUnit(courseId: string) {
    const existing = await this.prisma.courseUnit.findFirst({ where: { courseId, isDefault: true } });
    if (existing) return existing;
    // Sorted before every named section, so "just add lessons" lessons read
    // first — the closest thing to "no sections at all" the schema allows.
    return this.prisma.courseUnit.create({
      data: { courseId, title: '', isDefault: true, sortOrder: -1 },
    });
  }

  private async insertLesson(unitId: string, dto: CreateLessonDto) {
    const last = await this.prisma.lesson.aggregate({
      where: { unitId },
      _max: { sortOrder: true },
    });
    return this.prisma.lesson.create({
      data: {
        unitId,
        title: dto.title,
        description: dto.description,
        type: dto.type,
        sortOrder: dto.sortOrder ?? (last._max.sortOrder ?? -1) + 1,
        durationSec: dto.durationSec,
        isFreePreview: dto.isFreePreview,
        dripUnlockAt: dto.dripUnlockAt ? new Date(dto.dripUnlockAt) : undefined,
        dripAfterEnrollDays: dto.dripAfterEnrollDays,
        viewsCap: dto.viewsCap,
        accessWindowDays: dto.accessWindowDays,
        videoAssetId: dto.videoAssetId,
      },
      include: { attachments: true },
    });
  }

  async updateLesson(scope: CourseScope, lessonId: string, dto: UpdateLessonDto) {
    await this.assertLesson(scope, lessonId);
    if (dto.videoAssetId) await this.assertVideoAssetOwned(this.author(scope), dto.videoAssetId);
    const { clearDrip, dripUnlockAt, ...rest } = dto;
    return this.prisma.lesson.update({
      where: { id: lessonId },
      data: {
        // clearDrip resets the schedule first; explicit values in the same
        // request then win (lets the client switch date-mode ↔ days-mode).
        ...(clearDrip ? { dripUnlockAt: null, dripAfterEnrollDays: null } : {}),
        ...rest,
        ...(dripUnlockAt !== undefined ? { dripUnlockAt: new Date(dripUnlockAt) } : {}),
      },
      include: {
        attachments: true,
        videoAsset: { select: { id: true, status: true, durationSec: true } },
      },
    });
  }

  /**
   * Detach a lesson's video and clean up its storage entirely, rather than
   * leaving an orphaned `VideoAsset` (and its HLS files) behind every time a
   * teacher swaps in a better take.
   */
  async removeLessonVideo(scope: CourseScope, lessonId: string) {
    const lesson = await this.assertLesson(scope, lessonId);
    if (!lesson.videoAssetId) return { id: lessonId, videoRemoved: false };
    const asset = await this.assertVideoAssetOwned(this.author(scope), lesson.videoAssetId);

    // The relation has no cascade, so the FK must be cleared before the row
    // it points at can be deleted. The duration goes with it — it was probed
    // from this video, and a lesson with no video has no length to report.
    await this.prisma.$transaction([
      this.prisma.lesson.update({ where: { id: lessonId }, data: { videoAssetId: null, durationSec: 0 } }),
      this.prisma.videoAsset.delete({ where: { id: asset.id } }),
    ]);

    await this.storage.deletePrefix(`hls/${asset.id}`).catch(() => undefined);
    await this.storage.delete(asset.originalKey).catch(() => undefined);
    if (asset.encryptionKeyId) {
      await this.prisma.hlsEncryptionKey.delete({ where: { id: asset.encryptionKeyId } }).catch(() => undefined);
    }
    return { id: lessonId, videoRemoved: true };
  }

  async removeLesson(scope: CourseScope, lessonId: string) {
    await this.assertLesson(scope, lessonId);
    await this.prisma.lesson.delete({ where: { id: lessonId } });
    return { id: lessonId, deleted: true };
  }

  async reorderLessons(scope: CourseScope, unitId: string, dto: ReorderDto) {
    await this.assertUnit(scope, unitId);
    await this.prisma.$transaction(
      dto.ids.map((id, i) =>
        this.prisma.lesson.updateMany({
          where: { id, unitId },
          data: { sortOrder: i },
        }),
      ),
    );
    return { ok: true };
  }

  // ── Public course detail (viewer-aware) ─────────────────────────────────

  /**
   * PUBLISHED course page for students/visitors. Lessons carry a `locked`
   * flag: free previews are always open; enrolled students unlock lessons
   * according to the course drip schedule; the owner teacher sees all.
   */
  async publicDetail(courseId: string, viewer?: JwtPayload) {
    const course = await this.prisma.course.findFirst({
      where: {
        id: courseId,
        // The owner (and super admin) can also preview drafts.
        ...(viewer?.tenantId || viewer?.role === Role.SUPER_ADMIN
          ? { OR: [{ status: 'PUBLISHED' }, { tenantId: viewer.tenantId ?? '' }] }
          : { status: 'PUBLISHED' }),
      },
      include: {
        subject: true,
        grades: { include: { grade: true } },
        teacher: {
          include: { user: { select: { fullName: true, avatarUrl: true } } },
        },
        units: {
          where: { deletedAt: null },
          orderBy: { sortOrder: 'asc' },
          include: {
            lessons: {
              where: { deletedAt: null },
              orderBy: { sortOrder: 'asc' },
              include: {
                attachments: { where: { deletedAt: null }, select: { id: true, fileName: true, sizeBytes: true } },
              },
            },
          },
        },
        bundleItems: {
          include: { course: { select: { id: true, title: true, priceCents: true } } },
        },
        _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } },
      },
    });
    if (!course) throw new NotFoundException('Course not found');

    let enrollment = null;
    let studentId: string | null = null;
    let studentGrade: string | null = null;
    if (viewer?.role === Role.STUDENT) {
      const student = await this.prisma.studentProfile.findUnique({
        where: { userId: viewer.sub },
      });
      if (student) {
        studentId = student.id;
        studentGrade = student.gradeId;
        enrollment = await this.prisma.enrollment.findUnique({
          where: { studentId_courseId: { studentId: student.id, courseId } },
        });
      }
    }
    const isOwner = viewer?.tenantId === course.tenantId;
    const activeEnrollment =
      enrollment?.status === 'ACTIVE' &&
      (!enrollment.expiresAt || enrollment.expiresAt > new Date());
    /**
     * Whether this course's years are the student's own.
     *
     * The page is reachable without going through discovery — from the
     * teacher's public landing page, or a link a friend sent — so it is where a
     * student first learns a course is not for their year. Sent with the page so
     * the enrol button can say so instead of being pressed and refused.
     *
     * A course they have already held stays theirs: the same carve-out the
     * enrolment gate makes, so the two never disagree on one course.
     */
    const forMyYear =
      yearAdmits(course.grades.map((g) => g.gradeId), studentGrade) ||
      enrollment?.status === 'ACTIVE' ||
      enrollment?.status === 'EXPIRED';

    const now = Date.now();
    const unlockedByDrip = (lesson: { dripUnlockAt: Date | null; dripAfterEnrollDays: number | null }) => {
      if (lesson.dripUnlockAt && lesson.dripUnlockAt.getTime() > now) return false;
      if (
        lesson.dripAfterEnrollDays != null &&
        enrollment?.approvedAt &&
        enrollment.approvedAt.getTime() + lesson.dripAfterEnrollDays * 86_400_000 > now
      ) {
        return false;
      }
      return true;
    };

    const rating = await this.prisma.review.aggregate({
      where: { courseId },
      _avg: { rating: true },
      _count: true,
    });

    return {
      id: course.id,
      title: course.title,
      description: course.description,
      thumbnailUrl: course.thumbnailUrl,
      introVideoUrl: course.introVideoUrl,
      status: course.status,
      /**
       * The exam standing between this student and the course, if there is one.
       *
       * Sent with the page rather than fetched after it, so the exam is the
       * first thing on screen instead of something that appears a moment later
       * once a second request lands.
       */
      entryExam: await this.entryExam.stateFor(course.id, studentId),
      assignmentLessonId: course.assignmentLessonId,
      subject: course.subject,
      grades: course.grades.map((g) => g.grade),
      pricingModel: course.pricingModel,
      // Fee-inclusive: this is a student-facing payload, and the student pays one
      // number. The academy sees its own price through the teacher endpoints.
      priceCents: await this.studentPrice.displayPrice(course.tenantId, course.priceCents),
      currency: course.currency,
      studentsCount: course._count.enrollments,
      avgRating: rating._avg.rating ? Math.round(rating._avg.rating * 10) / 10 : null,
      reviewsCount: rating._count,
      teacher: {
        id: course.teacher.id,
        slug: course.teacher.slug,
        fullName: course.teacher.user.fullName,
        avatarUrl: course.teacher.user.avatarUrl,
        // The lesson player offers "ask the teacher" from here; it must not
        // offer it to a teacher who has closed messaging.
        acceptsStudentMessages: course.teacher.acceptsStudentMessages,
      },
      bundleCourses: course.bundleItems.map((b) => b.course),
      viewer: {
        enrollmentStatus: enrollment?.status ?? null,
        enrollmentExpiresAt: enrollment?.expiresAt ?? null,
        hasAccess: isOwner || !!activeEnrollment,
        /** False only when the course names years and none of them is theirs. */
        forMyYear: isOwner || forMyYear,
      },
      units: course.units.map((u) => ({
        id: u.id,
        title: u.title,
        isDefault: u.isDefault,
        lessons: u.lessons.map((l) => {
          const open =
            isOwner || l.isFreePreview || (!!activeEnrollment && unlockedByDrip(l));
          return {
            id: l.id,
            title: l.title,
            description: l.description,
            type: l.type,
            durationSec: l.durationSec,
            isFreePreview: l.isFreePreview,
            locked: !open,
            dripUnlockAt: l.dripUnlockAt,
            dripAfterEnrollDays: l.dripAfterEnrollDays,
            attachments: open ? l.attachments : [],
          };
        }),
      })),
    };
  }
}
