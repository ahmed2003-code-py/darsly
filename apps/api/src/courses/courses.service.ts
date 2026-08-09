import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { JwtPayload, Role } from '@darsly/shared-types';
import { validateThumbnailUrl } from '../common/image.util';
import { PrismaService } from '../prisma/prisma.service';
import { DiscoverCoursesDto as DiscoverCoursesQuery } from './dto/discover-courses.dto';
import { StudentPriceService } from '../payments/student-price.service';
import {
  CreateCourseDto,
  CreateLessonDto,
  ReorderDto,
  SetBundleItemsDto,
  UpdateCourseDto,
  UpdateLessonDto,
  UpsertUnitDto,
} from './dto/course.dto';

// Decoded-bytes cap for a thumbnail data-URL. Sized just above the DTO's
// 900_000-char limit (~675 KB decoded) so validation never rejects a payload the
// controller already accepted; the point here is type/protocol safety, not size.
const THUMBNAIL_MAX_BYTES = 700 * 1024;

@Injectable()
export class CoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studentPrice: StudentPriceService,
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
  async discover(query: DiscoverCoursesQuery) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(24, Math.max(1, query.pageSize ?? 10));

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
      ...(query.teacherId ? { tenantId: query.teacherId } : {}),
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      ...(query.gradeId ? { gradeId: query.gradeId } : {}),
      ...(Object.keys(priceFilter).length ? { priceCents: priceFilter } : {}),
      ...(query.hasPreview
        ? { units: { some: { deletedAt: null, lessons: { some: { deletedAt: null, isFreePreview: true } } } } }
        : {}),
      ...(query.q?.trim()
        ? {
            OR: [
              { title: { contains: query.q.trim(), mode: 'insensitive' } },
              { description: { contains: query.q.trim(), mode: 'insensitive' } },
              { teacher: { user: { fullName: { contains: query.q.trim(), mode: 'insensitive' } } } },
            ],
          }
        : {}),
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
          grade: true,
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
          grade: c.grade,
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

  // ── Tenant isolation helpers ─────────────────────────────────────────────
  // Every teacher mutation resolves the row through tenantId; a cross-tenant
  // id therefore 404s (we don't reveal other tenants' resources exist).

  private async assertCourse(tenantId: string, courseId: string) {
    const course = await this.prisma.course.findFirst({ where: { id: courseId, tenantId } });
    if (!course) throw new NotFoundException('Course not found');
    return course;
  }

  private async assertUnit(tenantId: string, unitId: string) {
    const unit = await this.prisma.courseUnit.findFirst({
      where: { id: unitId, course: { tenantId } },
      include: { course: true },
    });
    if (!unit) throw new NotFoundException('Unit not found');
    return unit;
  }

  private async assertLesson(tenantId: string, lessonId: string) {
    const lesson = await this.prisma.lesson.findFirst({
      where: { id: lessonId, unit: { course: { tenantId } } },
      include: { unit: { include: { course: true } } },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    return lesson;
  }

  // ── Teacher CRUD ─────────────────────────────────────────────────────────

  listMine(tenantId: string) {
    return this.prisma.course.findMany({
      where: { tenantId },
      include: {
        subject: true,
        grade: true,
        units: { where: { deletedAt: null }, select: { _count: { select: { lessons: { where: { deletedAt: null } } } } } },
        _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getMine(tenantId: string, courseId: string) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, tenantId },
      include: {
        subject: true,
        grade: true,
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
      JSON.stringify(course, (_, v) => (typeof v === 'bigint' ? Number(v) : v)),
    );
  }

  create(tenantId: string, dto: CreateCourseDto) {
    if (dto.thumbnailUrl) validateThumbnailUrl(dto.thumbnailUrl, THUMBNAIL_MAX_BYTES);
    return this.prisma.course.create({
      data: { ...dto, tenantId },
      include: { subject: true, grade: true },
    });
  }

  async update(tenantId: string, courseId: string, dto: UpdateCourseDto) {
    await this.assertCourse(tenantId, courseId);
    if (dto.thumbnailUrl) validateThumbnailUrl(dto.thumbnailUrl, THUMBNAIL_MAX_BYTES);

    if (dto.status === 'PUBLISHED') {
      const lessons = await this.prisma.lesson.count({
        where: { unit: { courseId } },
      });
      if (lessons === 0) {
        throw new BadRequestException('Cannot publish a course with no lessons');
      }
    }

    return this.prisma.course.update({
      where: { id: courseId },
      data: dto,
      include: { subject: true, grade: true },
    });
  }

  /** Hard-delete only when nobody ever enrolled; otherwise archive. */
  async remove(tenantId: string, courseId: string) {
    await this.assertCourse(tenantId, courseId);
    const enrollments = await this.prisma.enrollment.count({ where: { courseId } });
    if (enrollments > 0) {
      const course = await this.prisma.course.update({
        where: { id: courseId },
        data: { status: 'ARCHIVED' },
      });
      return { ...course, archived: true, deleted: false };
    }
    await this.prisma.course.delete({ where: { id: courseId } });
    return { id: courseId, archived: false, deleted: true };
  }

  async setBundleItems(tenantId: string, bundleId: string, dto: SetBundleItemsDto) {
    const bundle = await this.assertCourse(tenantId, bundleId);
    if (bundle.pricingModel !== 'BUNDLE') {
      throw new BadRequestException('Course pricing model is not BUNDLE');
    }
    if (dto.courseIds.includes(bundleId)) {
      throw new BadRequestException('A bundle cannot contain itself');
    }
    const children = await this.prisma.course.findMany({
      where: { id: { in: dto.courseIds }, tenantId },
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
    return this.getMine(tenantId, bundleId);
  }

  // ── Units ────────────────────────────────────────────────────────────────

  async createUnit(tenantId: string, courseId: string, dto: UpsertUnitDto) {
    await this.assertCourse(tenantId, courseId);
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

  async updateUnit(tenantId: string, unitId: string, dto: UpsertUnitDto) {
    await this.assertUnit(tenantId, unitId);
    return this.prisma.courseUnit.update({ where: { id: unitId }, data: dto });
  }

  async removeUnit(tenantId: string, unitId: string) {
    await this.assertUnit(tenantId, unitId);
    await this.prisma.courseUnit.delete({ where: { id: unitId } });
    return { id: unitId, deleted: true };
  }

  async reorderUnits(tenantId: string, courseId: string, dto: ReorderDto) {
    await this.assertCourse(tenantId, courseId);
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

  async createLesson(tenantId: string, unitId: string, dto: CreateLessonDto) {
    await this.assertUnit(tenantId, unitId);
    if (dto.videoAssetId) await this.assertVideoAssetOwned(tenantId, dto.videoAssetId);
    const last = await this.prisma.lesson.aggregate({
      where: { unitId },
      _max: { sortOrder: true },
    });
    return this.prisma.lesson.create({
      data: {
        unitId,
        title: dto.title,
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

  async updateLesson(tenantId: string, lessonId: string, dto: UpdateLessonDto) {
    await this.assertLesson(tenantId, lessonId);
    if (dto.videoAssetId) await this.assertVideoAssetOwned(tenantId, dto.videoAssetId);
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

  async removeLesson(tenantId: string, lessonId: string) {
    await this.assertLesson(tenantId, lessonId);
    await this.prisma.lesson.delete({ where: { id: lessonId } });
    return { id: lessonId, deleted: true };
  }

  async reorderLessons(tenantId: string, unitId: string, dto: ReorderDto) {
    await this.assertUnit(tenantId, unitId);
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
        grade: true,
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
    if (viewer?.role === Role.STUDENT) {
      const student = await this.prisma.studentProfile.findUnique({
        where: { userId: viewer.sub },
      });
      if (student) {
        enrollment = await this.prisma.enrollment.findUnique({
          where: { studentId_courseId: { studentId: student.id, courseId } },
        });
      }
    }
    const isOwner = viewer?.tenantId === course.tenantId;
    const activeEnrollment =
      enrollment?.status === 'ACTIVE' &&
      (!enrollment.expiresAt || enrollment.expiresAt > new Date());

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
      status: course.status,
      subject: course.subject,
      grade: course.grade,
      pricingModel: course.pricingModel,
      // Fee-inclusive: this is a student-facing payload, and the student pays one
      // number. The academy sees its own price through the teacher endpoints.
      priceCents: await this.studentPrice.displayPrice(course.tenantId, course.priceCents),
      currency: course.currency,
      requiresEnrollmentApproval: course.requiresEnrollmentApproval,
      studentsCount: course._count.enrollments,
      avgRating: rating._avg.rating ? Math.round(rating._avg.rating * 10) / 10 : null,
      reviewsCount: rating._count,
      teacher: {
        id: course.teacher.id,
        slug: course.teacher.slug,
        fullName: course.teacher.user.fullName,
        avatarUrl: course.teacher.user.avatarUrl,
      },
      bundleCourses: course.bundleItems.map((b) => b.course),
      viewer: {
        enrollmentStatus: enrollment?.status ?? null,
        enrollmentExpiresAt: enrollment?.expiresAt ?? null,
        hasAccess: isOwner || !!activeEnrollment,
      },
      units: course.units.map((u) => ({
        id: u.id,
        title: u.title,
        lessons: u.lessons.map((l) => {
          const open =
            isOwner || l.isFreePreview || (!!activeEnrollment && unlockedByDrip(l));
          return {
            id: l.id,
            title: l.title,
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
