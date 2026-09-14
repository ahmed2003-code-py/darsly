import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SubjectExclusivityService } from '../catalog/subject-exclusivity.service';
import { PrismaService } from '../prisma/prisma.service';
import { StudentPriceService } from '../payments/student-price.service';
import { viewerGrade, viewerStage, viewerTrack } from '../catalog/stage.util';
import { trackFilter } from '../catalog/subject-track';

export interface DiscoverTeachersQuery {
  q?: string;
  subjectId?: string;
  gradeId?: string;
  allStages?: boolean;
  language?: string;
  priceMinCents?: number;
  priceMaxCents?: number;
  minRating?: number;
  sort?: 'rating' | 'priceAsc' | 'priceDesc' | 'newest';
  page?: number;
  pageSize?: number;
}

@Injectable()
export class TeachersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studentPrice: StudentPriceService,
    private readonly exclusivity: SubjectExclusivityService,
  ) {}

  /**
   * Student-facing discovery. Only APPROVED teachers of active users appear.
   * Subject/grade/language/q filter in SQL; price/rating aggregates are
   * computed per-teacher then filtered/sorted in memory (teacher counts are
   * small enough per page of the marketplace to keep this simple for now).
   */
  async discover(query: DiscoverTeachersQuery, viewerUserId?: string) {
    // A student already studying a subject is not shown the other teachers of
    // it — see SubjectExclusivityService for why the rule is drawn this way.
    const hidden = await this.exclusivity.hiddenTeacherIds(viewerUserId);
    const stage = await viewerStage(this.prisma, query, viewerUserId);
    // The card counts and prices the same courses the teacher's page will list,
    // which is the student's own year — teachers are matched on the band, but a
    // course is for a year. Counting every published course instead told a
    // third-secondary student a teacher had one course, and then showed them an
    // empty page when they opened it.
    const gradeId = await viewerGrade(this.prisma, query, viewerUserId);
    const forMyYear = gradeId
      ? { OR: [{ grades: { some: { gradeId } } }, { grades: { none: {} } }] }
      : {};
    // A teacher of the other school system teaches a syllabus this student does
    // not sit, so they are not a teacher for them. One who takes both systems
    // has a subject on this side too, and stays.
    const tracks = trackFilter(await viewerTrack(this.prisma, viewerUserId));
    const where: Prisma.TeacherProfileWhereInput = {
      status: 'APPROVED',
      user: { isActive: true },
      ...(hidden.length ? { id: { notIn: hidden } } : {}),
      // Both of these ask about `subjects`, so they go in an AND rather than as
      // two keys of the same object, where the second would silently replace
      // the first and drop whichever filter was written above it.
      AND: [
        ...(query.subjectId ? [{ subjects: { some: { subjectId: query.subjectId } } }] : []),
        ...(tracks ? [{ subjects: { some: { subject: { track: { in: tracks } } } } }] : []),
      ],
      ...(stage ? { stages: { has: stage } } : {}),
      ...(query.language ? { language: query.language } : {}),
      ...(query.q
        ? {
            OR: [
              { user: { fullName: { contains: query.q, mode: 'insensitive' } } },
              { bio: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const teachers = await this.prisma.teacherProfile.findMany({
      where,
      include: {
        user: { select: { fullName: true, avatarUrl: true } },
        subjects: { include: { subject: true } },
        grades: { include: { grade: true } },
        courses: {
          where: { status: 'PUBLISHED', deletedAt: null, ...forMyYear },
          select: { id: true, priceCents: true, pricingModel: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const tenantIds = teachers.map((t) => t.id);
    const [ratings, studentCounts] = await Promise.all([
      this.prisma.review.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: tenantIds } },
        _avg: { rating: true },
        _count: true,
      }),
      this.prisma.enrollment.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: tenantIds }, status: 'ACTIVE' },
        _count: true,
      }),
    ]);
    const ratingByTenant = new Map(ratings.map((r) => [r.tenantId, r]));
    const studentsByTenant = new Map(studentCounts.map((s) => [s.tenantId, s._count]));

    let cards = teachers.map((t) => {
      const prices = t.courses.map((c) => c.priceCents);
      const rating = ratingByTenant.get(t.id);
      return {
        id: t.id,
        slug: t.slug,
        fullName: t.user.fullName,
        avatarUrl: t.user.avatarUrl,
        bio: t.bio,
        language: t.language,
        verified: !!t.verifiedAt,
        subjects: t.subjects.map((s) => s.subject),
        grades: t.grades.map((g) => g.grade),
        coursesCount: t.courses.length,
        minPriceCents: prices.length ? Math.min(...prices) : null,
        avgRating: rating?._avg.rating ? Math.round(rating._avg.rating * 10) / 10 : null,
        reviewsCount: rating?._count ?? 0,
        studentsCount: studentsByTenant.get(t.id) ?? 0,
        createdAt: t.createdAt,
      };
    });

    if (query.priceMinCents != null) {
      cards = cards.filter((c) => c.minPriceCents != null && c.minPriceCents >= query.priceMinCents!);
    }
    if (query.priceMaxCents != null) {
      cards = cards.filter((c) => c.minPriceCents != null && c.minPriceCents <= query.priceMaxCents!);
    }
    if (query.minRating != null) {
      cards = cards.filter((c) => (c.avgRating ?? 0) >= query.minRating!);
    }

    const sorters: Record<string, (a: (typeof cards)[0], b: (typeof cards)[0]) => number> = {
      rating: (a, b) => (b.avgRating ?? 0) - (a.avgRating ?? 0),
      priceAsc: (a, b) => (a.minPriceCents ?? Infinity) - (b.minPriceCents ?? Infinity),
      priceDesc: (a, b) => (b.minPriceCents ?? 0) - (a.minPriceCents ?? 0),
      newest: (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    };
    cards.sort(sorters[query.sort ?? 'rating']);

    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 12));
    return {
      items: cards.slice((page - 1) * pageSize, page * pageSize),
      total: cards.length,
      page,
      pageSize,
    };
  }

  /** Public teacher profile: bio, intro video, stats, published courses, reviews. */
  async publicProfile(slug: string, viewerUserId?: string) {
    // A signed-in student sees this teacher's courses for their own year. The
    // page is a shop window, and a first-year reading three years of listings
    // to find the one that is theirs is the thing the year question exists to
    // stop. A visitor with no year still sees the whole catalogue.
    const gradeId = await viewerGrade(this.prisma, {}, viewerUserId);
    const forMyYear = gradeId
      ? { OR: [{ grades: { some: { gradeId } } }, { grades: { none: {} } }] }
      : {};
    const teacher = await this.prisma.teacherProfile.findFirst({
      where: { slug, status: 'APPROVED', user: { isActive: true } },
      include: {
        user: {
          select: {
            fullName: true,
            avatarUrl: true,
            // The teacher's own public page. Every approved teacher is
            // provisioned an academy at registration, so this is the page they
            // hand out — whether they have composed a site in the Studio or are
            // still on the built-in storefront.
            ownedAcademies: {
              where: { deletedAt: null, status: { not: 'ARCHIVED' } },
              select: { slug: true, name: true, site: { select: { status: true } } },
              orderBy: { createdAt: 'asc' },
              take: 1,
            },
          },
        },
        subjects: { include: { subject: true } },
        grades: { include: { grade: true } },
        courses: {
          where: { status: 'PUBLISHED', deletedAt: null, ...forMyYear },
          include: {
            subject: true,
            grades: { include: { grade: true } },
            units: {
              where: { deletedAt: null },
              include: { lessons: { where: { deletedAt: null }, select: { durationSec: true, isFreePreview: true } } },
            },
            _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!teacher) throw new NotFoundException('Teacher not found');

    const [rating, studentsCount, reviews] = await Promise.all([
      this.prisma.review.aggregate({
        where: { tenantId: teacher.id },
        _avg: { rating: true },
        _count: true,
      }),
      this.prisma.enrollment.count({ where: { tenantId: teacher.id, status: 'ACTIVE' } }),
      this.prisma.review.findMany({
        where: { tenantId: teacher.id },
        include: { student: { include: { user: { select: { fullName: true, avatarUrl: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    // Student-facing page: prices carry the platform fee, so the card and the
    // checkout agree and the academy's own price is not derivable by subtraction.
    const courses = await this.studentPrice.applyToMany(
      teacher.courses.map((c) => {
        const lessons = c.units.flatMap((u) => u.lessons);
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
        };
      }),
      (c) => teacher.id,
    );

    return {
      id: teacher.id,
      slug: teacher.slug,
      fullName: teacher.user.fullName,
      avatarUrl: teacher.user.avatarUrl,
      academy: teacher.user.ownedAcademies[0]
        ? {
            slug: teacher.user.ownedAcademies[0].slug,
            name: teacher.user.ownedAcademies[0].name,
            // Composed in the Studio and live, as opposed to the built-in
            // storefront. Both are a real page; this says which one they get.
            sitePublished: teacher.user.ownedAcademies[0].site?.status === 'PUBLISHED',
          }
        : null,
      bio: teacher.bio,
      introVideoUrl: teacher.introVideoUrl,
      // So the student's page never offers a message button that would be
      // refused the moment it was pressed.
      acceptsStudentMessages: teacher.acceptsStudentMessages,
      language: teacher.language,
      verified: !!teacher.verifiedAt,
      subjects: teacher.subjects.map((s) => s.subject),
      grades: teacher.grades.map((g) => g.grade),
      stats: {
        studentsCount,
        avgRating: rating._avg.rating ? Math.round(rating._avg.rating * 10) / 10 : null,
        reviewsCount: rating._count,
        coursesCount: teacher.courses.length,
      },
      courses,
      reviews: reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt,
        studentName: r.student.user.fullName,
        studentAvatarUrl: r.student.user.avatarUrl,
      })),
    };
  }
}

