import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { JwtPayload, Role } from '@darsly/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateCourseDto,
  CreateLessonDto,
  ReorderDto,
  SetBundleItemsDto,
  UpdateCourseDto,
  UpdateLessonDto,
  UpsertUnitDto,
} from './dto/course.dto';

@Injectable()
export class CoursesService {
  constructor(private readonly prisma: PrismaService) {}

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
        units: { select: { _count: { select: { lessons: true } } } },
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
          orderBy: { sortOrder: 'asc' },
          include: {
            lessons: {
              orderBy: { sortOrder: 'asc' },
              include: {
                attachments: true,
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
    return this.prisma.course.create({
      data: { ...dto, tenantId },
      include: { subject: true, grade: true },
    });
  }

  async update(tenantId: string, courseId: string, dto: UpdateCourseDto) {
    await this.assertCourse(tenantId, courseId);

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
          orderBy: { sortOrder: 'asc' },
          include: {
            lessons: {
              orderBy: { sortOrder: 'asc' },
              include: { attachments: { select: { id: true, fileName: true, sizeBytes: true } } },
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
      priceCents: course.priceCents,
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
