import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { avatarUrl } from '../common/signed-link';
import { PrismaService } from '../prisma/prisma.service';
import { AcademyContext } from './academy-context';
import { AssistantGrantDto } from './dto';
import { assistantGrant, Capability, permissionsFor } from './permissions';

/** A grant after validation: every field decided, every course checked. */
export interface AssistantGrant {
  title: string;
  permissions: Capability[];
  courseScope: 'ALL' | 'SELECTED';
  courseIds: string[];
  directContact: boolean;
}

/**
 * The owner's side of assistants: who they are, what each may do, which
 * courses each works on. Every write here is behind member.manage, which is
 * OWNER_ONLY — so an assistant (or a teacher inside a Center) can never reach
 * it, and on top of that nobody may edit their own membership.
 */
@Injectable()
export class TeamService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validate a grant against this academy. Capabilities outside the
   * assistant ceiling are refused; courses must be this academy's own, live
   * courses — an id from another academy is refused, not ignored, so a
   * crafted request cannot quietly stretch someone's reach.
   */
  async normalizeGrant(academyId: string, dto: AssistantGrantDto): Promise<AssistantGrant> {
    const permissions = assistantGrant(dto.permissions);
    const title = dto.title.trim();
    if (!title)
      throw new BadRequestException({ message: 'Give them a title', code: 'TITLE_REQUIRED' });
    const wanted = [...new Set(dto.courseIds)];
    let courseIds: string[] = [];
    if (dto.courseScope === 'SELECTED' && wanted.length) {
      const found = await this.prisma.course.findMany({
        where: { id: { in: wanted }, academyId, deletedAt: null },
        select: { id: true },
      });
      if (found.length !== wanted.length) {
        throw new BadRequestException({
          message: 'One of these courses is not part of this academy',
          code: 'COURSE_NOT_IN_ACADEMY',
        });
      }
      courseIds = wanted;
    }
    return {
      title,
      permissions,
      courseScope: dto.courseScope,
      courseIds,
      directContact: dto.directContact,
    };
  }

  /**
   * Write a grant onto a membership, courses included, in the caller's
   * transaction. Courses are replaced as a set: the ones no longer listed are
   * deleted, which is what makes "remove Physics" bite on the next request.
   */
  async applyGrant(
    tx: Prisma.TransactionClient,
    membershipId: string,
    academyId: string,
    g: AssistantGrant,
  ) {
    await tx.academyMembership.update({
      where: { id: membershipId },
      data: {
        title: g.title || null,
        permissions: g.permissions,
        courseScope: g.courseScope,
        directContact: g.directContact,
      },
    });
    const keep = g.courseScope === 'SELECTED' ? g.courseIds : [];
    await tx.membershipCourse.deleteMany({
      where: { membershipId, ...(keep.length ? { courseId: { notIn: keep } } : {}) },
    });
    if (keep.length) {
      await tx.membershipCourse.createMany({
        data: keep.map((courseId) => ({ membershipId, courseId, academyId })),
        skipDuplicates: true,
      });
    }
  }

  /**
   * A grant stored on an invitation link, re-checked at redemption: courses
   * deleted since the link was made simply drop out; anything malformed
   * (a hand-edited row) grants nothing rather than something.
   */
  async grantFromLink(
    tx: Prisma.TransactionClient,
    academyId: string,
    raw: unknown,
  ): Promise<AssistantGrant | null> {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const list = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    let permissions: Capability[];
    try {
      permissions = assistantGrant(list(r.permissions));
    } catch {
      return null;
    }
    const courseScope = r.courseScope === 'ALL' ? 'ALL' : 'SELECTED';
    const ids = list(r.courseIds);
    const live = ids.length
      ? await tx.course.findMany({
          where: { id: { in: ids }, academyId, deletedAt: null },
          select: { id: true },
        })
      : [];
    return {
      title:
        typeof r.title === 'string' && r.title.trim() ? r.title.trim().slice(0, 40) : 'Assistant',
      permissions,
      courseScope,
      courseIds: live.map((c) => c.id),
      directContact: r.directContact === true,
    };
  }

  /** What an assistant joining without a stated grant gets: nothing, until the owner decides. */
  static readonly EMPTY_GRANT: AssistantGrant = {
    title: '',
    permissions: [],
    courseScope: 'SELECTED',
    courseIds: [],
    directContact: false,
  };

  /** The assistants of this academy, as the Team screen draws them. */
  async list(academyId: string) {
    const rows = await this.prisma.academyMembership.findMany({
      where: { academyId, role: 'ASSISTANT', status: { in: ['ACTIVE', 'SUSPENDED'] } },
      orderBy: { createdAt: 'asc' },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            avatarUrl: true,
            updatedAt: true,
          },
        },
        courses: { select: { course: { select: { id: true, title: true, deletedAt: true } } } },
      },
    });
    return rows.map((m) => ({
      membershipId: m.id,
      userId: m.userId,
      name: m.user.fullName,
      email: m.user.email,
      phone: m.user.phone,
      avatarUrl: avatarUrl(m.user),
      status: m.status,
      title: m.title,
      // What they actually hold — the stored list after the ceiling and the
      // scope rule, so the screen never shows a box as ticked that does nothing.
      permissions: [...permissionsFor('ASSISTANT', m.permissions, m.courseScope)],
      courseScope: m.courseScope,
      courses: m.courses
        .map((c) => c.course)
        .filter((c) => !c.deletedAt)
        .map((c) => ({ id: c.id, title: c.title })),
      directContact: m.directContact,
      joinedAt: m.joinedAt,
    }));
  }

  /** The academy's courses, for the course picker. */
  courses(academyId: string) {
    return this.prisma.course.findMany({
      where: { academyId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, status: true, thumbnailUrl: true },
    });
  }

  async update(ctx: AcademyContext, membershipId: string, dto: AssistantGrantDto) {
    const m = await this.prisma.academyMembership.findFirst({
      where: { id: membershipId, academyId: ctx.academyId },
      select: { id: true, userId: true, role: true },
    });
    if (!m) throw new NotFoundException('Member not found');
    // Belt and braces: member.manage is owner-only already, but "nobody edits
    // their own access" is a rule of its own and must not hang on that.
    if (m.userId === ctx.userId) {
      throw new ForbiddenException({
        message: 'You cannot change your own access',
        code: 'SELF_EDIT',
      });
    }
    if (m.role !== 'ASSISTANT') {
      throw new BadRequestException({
        message: 'Only an assistant has these settings',
        code: 'NOT_ASSISTANT',
      });
    }
    const grant = await this.normalizeGrant(ctx.academyId, dto);
    await this.prisma.$transaction((tx) => this.applyGrant(tx, m.id, ctx.academyId, grant));
    return grant;
  }
}
