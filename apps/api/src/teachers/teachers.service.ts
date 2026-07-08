import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface DiscoverTeachersQuery {
  q?: string;
  subjectId?: string;
  gradeId?: string;
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
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Student-facing discovery. Only APPROVED teachers of active users appear.
   * Subject/grade/language/q filter in SQL; price/rating aggregates are
   * computed per-teacher then filtered/sorted in memory (teacher counts are
   * small enough per page of the marketplace to keep this simple for now).
   */
  async discover(query: DiscoverTeachersQuery) {
    const where: Prisma.TeacherProfileWhereInput = {
      status: 'APPROVED',
      user: { isActive: true },
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      ...(query.gradeId ? { grades: { some: { gradeId: query.gradeId } } } : {}),
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
        subject: true,
        grades: { include: { grade: true } },
        courses: {
          where: { status: 'PUBLISHED' },
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
        subject: t.subject,
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
  async publicProfile(slug: string) {
    const teacher = await this.prisma.teacherProfile.findFirst({
      where: { slug, status: 'APPROVED', user: { isActive: true } },
      include: {
        user: { select: { fullName: true, avatarUrl: true } },
        subject: true,
        grades: { include: { grade: true } },
        courses: {
          where: { status: 'PUBLISHED' },
          include: {
            subject: true,
            grade: true,
            units: { include: { lessons: { select: { durationSec: true, isFreePreview: true } } } },
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

    return {
      id: teacher.id,
      slug: teacher.slug,
      fullName: teacher.user.fullName,
      avatarUrl: teacher.user.avatarUrl,
      bio: teacher.bio,
      introVideoUrl: teacher.introVideoUrl,
      language: teacher.language,
      verified: !!teacher.verifiedAt,
      subject: teacher.subject,
      grades: teacher.grades.map((g) => g.grade),
      stats: {
        studentsCount,
        avgRating: rating._avg.rating ? Math.round(rating._avg.rating * 10) / 10 : null,
        reviewsCount: rating._count,
        coursesCount: teacher.courses.length,
      },
      courses: teacher.courses.map((c) => {
        const lessons = c.units.flatMap((u) => u.lessons);
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
          totalDurationSec: lessons.reduce((s, l) => s + l.durationSec, 0),
          freePreviewCount: lessons.filter((l) => l.isFreePreview).length,
          studentsCount: c._count.enrollments,
        };
      }),
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
