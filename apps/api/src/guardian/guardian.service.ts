import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { GuardianRelationship, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { JwtPayload, Role } from '@darsly/shared-types';
import { StaffScope, StaffScopeService } from '../academy/staff-scope.service';
import { normalizeEgyptianPhone } from '../auth/dto/auth.dto';
import { DeviceContext, TokenService } from '../auth/token.service';
import { avatarUrl } from '../common/signed-link';
import { PrismaService } from '../prisma/prisma.service';
import { StaffService } from '../staff/staff.service';

/** How long a shared access link keeps working before staff must resend it. */
const LINK_TTL_DAYS = 30;
const TOKEN_BYTES = 32;
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * Guardians: a parent (or guardian) linked to a student in one academy.
 *
 * Staff side — who may add, resend and revoke: members holding
 * guardian.manage, and only for students inside their scope
 * (StaffScopeService), so a course-limited assistant manages guardians of
 * their own students only.
 *
 * Guardian side — every request resolves through an ACTIVE GuardianLink for
 * exactly the child asked about. Revoking a link closes that child at once;
 * revoking a guardian's last link also ends their sessions.
 *
 * Sign-in is a passwordless link: a high-entropy token, stored only as its
 * sha256, with an expiry; resending rotates it (the old one stops working),
 * and each use is recorded.
 */
@Injectable()
export class GuardianService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: StaffScopeService,
    private readonly tokens: TokenService,
    private readonly staff: StaffService,
  ) {}

  // ── Staff side ────────────────────────────────────────────────────────────

  /** This student's guardians in this academy. */
  async listForStudent(scope: StaffScope, studentId: string) {
    await this.scopes.assertStudent(scope, studentId);
    const links = await this.prisma.guardianLink.findMany({
      where: { studentId, academyId: scope.ctx.academyId },
      orderBy: { createdAt: 'asc' },
      include: {
        guardian: { include: { user: { select: { id: true, fullName: true, phone: true } } } },
        tokens: {
          where: { revokedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { expiresAt: true, lastUsedAt: true, createdAt: true },
        },
      },
    });
    // C5: a link is CONNECTED once one of its links was really opened (the
    // existing sign-in flow is the only proof); INVITED until then.
    const used = links.length
      ? await this.prisma.guardianAccessToken.groupBy({
          by: ['linkId'],
          where: { linkId: { in: links.map((l) => l.id) }, useCount: { gt: 0 } },
          _count: true,
        })
      : [];
    const opened = new Set(used.map((u) => u.linkId));
    return links.map((l) => ({
      id: l.id,
      name: l.guardian.user.fullName,
      phone: l.guardian.user.phone,
      relationship: l.relationship,
      status: l.status,
      state: l.status !== 'ACTIVE' ? 'REVOKED' : opened.has(l.id) ? 'CONNECTED' : 'INVITED',
      createdAt: l.createdAt,
      revokedAt: l.revokedAt,
      link: l.tokens[0]
        ? {
            expiresAt: l.tokens[0].expiresAt,
            lastUsedAt: l.tokens[0].lastUsedAt,
            issuedAt: l.tokens[0].createdAt,
            expired: l.tokens[0].expiresAt <= new Date(),
          }
        : null,
    }));
  }

  /**
   * Add a guardian to a student and issue their access link. A phone number
   * that already belongs to a guardian is the same guardian (one parent,
   * several children, several academies). A phone that belongs to any other
   * account is refused: V1 has one role per account.
   *
   * Every refusal names its own reason (docs/ERRORS.md): the phone is the
   * student's own, belongs to another kind of account, or is already this
   * student's guardian here. The last one used to succeed silently — and
   * rotate the guardian's token, so the link staff had already sent stopped
   * working without anyone being told.
   */
  async add(
    scope: StaffScope,
    studentId: string,
    input: { name: string; phone: string; relationship: GuardianRelationship },
  ) {
    try {
      return await this.addOnce(scope, studentId, input);
    } catch (e) {
      // Two staff adding the same new parent at the same moment: both saw no
      // account, one created it, the other hit the unique phone. Once more
      // finds the account and links to it — the answer the loser should get.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return this.addOnce(scope, studentId, input);
      }
      throw e;
    }
  }

  private async addOnce(
    scope: StaffScope,
    studentId: string,
    input: { name: string; phone: string; relationship: GuardianRelationship },
  ) {
    await this.scopes.assertStudent(scope, studentId);
    const phone = normalizeEgyptianPhone(input.phone);
    const name = input.name.trim();
    if (!name)
      throw new BadRequestException({
        message: 'Name is required',
        code: 'NAME_REQUIRED',
        field: 'name',
      });
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: { user: { select: { phone: true } } },
    });
    if (student?.user.phone === phone) {
      throw new BadRequestException({
        message: 'That is the student’s own number',
        code: 'GUARDIAN_IS_STUDENT',
        field: 'phone',
      });
    }
    const existing = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true, role: true, guardian: { select: { id: true } } },
    });
    if (existing && existing.role !== Role.GUARDIAN) {
      // Which kind of account is deliberately not said: staff could otherwise
      // probe any number for "is this a teacher on Darsly".
      throw new ConflictException({
        message:
          'This phone number already belongs to another Darsly account, which cannot be a guardian account too',
        code: 'PHONE_IN_USE',
        field: 'phone',
      });
    }
    if (existing?.guardian) {
      const current = await this.prisma.guardianLink.findUnique({
        where: {
          guardianId_studentId_academyId: {
            guardianId: existing.guardian.id,
            studentId,
            academyId: scope.ctx.academyId,
          },
        },
        select: { status: true },
      });
      if (current?.status === 'ACTIVE') {
        throw new ConflictException({
          message: 'This guardian is already linked to this student',
          code: 'GUARDIAN_ALREADY_LINKED',
          field: 'phone',
        });
      }
    }
    const { link, raw } = await this.prisma.$transaction(async (tx) => {
      let guardianId = existing?.guardian?.id;
      if (!guardianId) {
        const user =
          existing ??
          (await tx.user.create({
            data: { role: Role.GUARDIAN, fullName: name, phone },
            select: { id: true },
          }));
        guardianId = (await tx.guardian.create({ data: { userId: user.id } })).id;
      }
      const link = await tx.guardianLink.upsert({
        where: {
          guardianId_studentId_academyId: {
            guardianId,
            studentId,
            academyId: scope.ctx.academyId,
          },
        },
        update: {
          status: 'ACTIVE',
          relationship: input.relationship,
          revokedAt: null,
          revokedById: null,
        },
        create: {
          guardianId,
          studentId,
          academyId: scope.ctx.academyId,
          relationship: input.relationship,
          createdByUserId: scope.ctx.userId,
        },
        select: { id: true, relationship: true, status: true },
      });
      const raw = await this.issue(tx, link.id, scope.ctx.userId);
      return { link, raw };
    });
    return { ...link, token: raw, expiresInDays: LINK_TTL_DAYS };
  }

  /** Resend: a fresh link; every earlier one for this guardian+child stops working. */
  async rotate(scope: StaffScope, linkId: string) {
    const link = await this.linkInScope(scope, linkId);
    if (link.status !== 'ACTIVE') {
      throw new BadRequestException({ message: 'This guardian was removed', code: 'LINK_REVOKED' });
    }
    const raw = await this.prisma.$transaction((tx) => this.issue(tx, link.id, scope.ctx.userId));
    return { id: link.id, token: raw, expiresInDays: LINK_TTL_DAYS };
  }

  /**
   * Remove a guardian from this child. Their links stop working, their
   * conversations about this child close (every chat check goes through an
   * ACTIVE link), and if this was their last child anywhere their sessions
   * end — on their very next request.
   */
  async revoke(scope: StaffScope, linkId: string) {
    const link = await this.linkInScope(scope, linkId);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.guardianLink.update({
        where: { id: link.id },
        data: { status: 'REVOKED', revokedAt: now, revokedById: scope.ctx.userId },
      });
      await tx.guardianAccessToken.updateMany({
        where: { linkId: link.id, revokedAt: null },
        data: { revokedAt: now },
      });
      const stillLinked = await tx.guardianLink.count({
        where: { guardianId: link.guardianId, status: 'ACTIVE' },
      });
      if (!stillLinked) {
        await tx.deviceSession.updateMany({
          where: { userId: link.guardian.userId, revokedAt: null },
          data: { revokedAt: now, revokedReason: 'GUARDIAN_REVOKED' },
        });
      }
    });
    return { id: link.id, revoked: true };
  }

  private async linkInScope(scope: StaffScope, linkId: string) {
    const link = await this.prisma.guardianLink.findFirst({
      where: { id: linkId, academyId: scope.ctx.academyId },
      select: {
        id: true,
        status: true,
        studentId: true,
        guardianId: true,
        guardian: { select: { userId: true } },
      },
    });
    if (!link) throw new NotFoundException('Guardian not found');
    // The student must still be one of the caller's — a stale id from a
    // course they lost is a 404 like any other.
    await this.scopes.assertStudent(scope, link.studentId);
    return link;
  }

  /** A new token for a link, revoking every earlier one. Returns the raw token once. */
  private async issue(tx: any, linkId: string, byUserId: string): Promise<string> {
    const now = new Date();
    await tx.guardianAccessToken.updateMany({
      where: { linkId, revokedAt: null },
      data: { revokedAt: now },
    });
    const raw = randomBytes(TOKEN_BYTES).toString('base64url');
    await tx.guardianAccessToken.create({
      data: {
        linkId,
        tokenHash: hash(raw),
        expiresAt: new Date(now.getTime() + LINK_TTL_DAYS * 86_400_000),
        createdByUserId: byUserId,
      },
    });
    return raw;
  }

  // ── Signing in with the link ──────────────────────────────────────────────

  /**
   * Exchange an access link for a session. Refused — all with the same
   * answer, so a token says nothing about why — when it is unknown,
   * tampered, expired, rotated away, revoked, or its link is no longer active.
   */
  async consume(token: string, device: DeviceContext) {
    const refuse = () =>
      new GoneException({
        message: 'This link is no longer valid — ask the academy for a new one',
        code: 'GUARDIAN_LINK_INVALID',
      });
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw refuse();
    const row = await this.prisma.guardianAccessToken.findUnique({
      where: { tokenHash: hash(token) },
      include: {
        link: {
          select: {
            id: true,
            status: true,
            guardian: {
              select: {
                user: {
                  select: {
                    id: true,
                    role: true,
                    isActive: true,
                    fullName: true,
                    phone: true,
                    deletedAt: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!row || row.revokedAt || row.expiresAt <= new Date()) throw refuse();
    const user = row.link.guardian.user;
    if (
      row.link.status !== 'ACTIVE' ||
      !user.isActive ||
      user.deletedAt ||
      user.role !== 'GUARDIAN'
    ) {
      throw refuse();
    }
    await this.prisma.guardianAccessToken.update({
      where: { id: row.id },
      data: { lastUsedAt: new Date(), useCount: { increment: 1 } },
    });
    const tokens = await this.tokens.createSession({ id: user.id, role: Role.GUARDIAN }, device);
    return {
      ...tokens,
      user: { id: user.id, role: user.role, fullName: user.fullName, phone: user.phone },
      linkId: row.link.id,
    };
  }

  // ── Guardian side ─────────────────────────────────────────────────────────

  private assertGuardian(user: JwtPayload) {
    if (user.role !== Role.GUARDIAN) throw new ForbiddenException('Guardians only');
  }

  /** The children an ACTIVE link gives this guardian — one entry per child per academy. */
  async children(user: JwtPayload) {
    this.assertGuardian(user);
    const links = await this.prisma.guardianLink.findMany({
      where: { status: 'ACTIVE', guardian: { userId: user.sub } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        relationship: true,
        academy: { select: { id: true, name: true, logoUrl: true } },
        student: {
          select: {
            id: true,
            user: { select: { id: true, fullName: true, avatarUrl: true, updatedAt: true } },
          },
        },
      },
    });
    return links.map((l) => ({
      linkId: l.id,
      relationship: l.relationship,
      academy: l.academy,
      student: {
        id: l.student.id,
        name: l.student.user.fullName,
        avatarUrl: avatarUrl(l.student.user),
      },
    }));
  }

  /** The link for this guardian and this id, or a 404 that says nothing. */
  private async ownLink(user: JwtPayload, linkId: string) {
    this.assertGuardian(user);
    const link = await this.prisma.guardianLink.findFirst({
      where: { id: linkId, status: 'ACTIVE', guardian: { userId: user.sub } },
      select: {
        id: true,
        studentId: true,
        academyId: true,
        relationship: true,
        academy: { select: { id: true, name: true } },
        student: {
          select: {
            userId: true,
            user: { select: { fullName: true, avatarUrl: true, updatedAt: true, id: true } },
          },
        },
      },
    });
    if (!link) throw new NotFoundException('Not found');
    return link;
  }

  /**
   * One child, in one academy, read only: their courses there with progress,
   * quiz and assignment results, attendance, live classes attended, and what
   * they did recently. Only what the platform records — nothing estimated —
   * and nothing outside this academy: no wallet, no other academy, no staff
   * notes, no other student.
   */
  async overview(user: JwtPayload, linkId: string) {
    const link = await this.ownLink(user, linkId);
    // The academy's slice of this child, expressed as a scope over its courses.
    // The link is the authorization; the "scope" only says which slice to read:
    // the whole academy — every course, and its register (a child registered
    // at the desk has no course and is still this academy's). A complete
    // context with no capabilities, so nothing that asks can() is granted.
    const scope = {
      ctx: {
        academyId: link.academyId,
        userId: user.sub,
        role: 'OWNER',
        status: 'ACTIVE',
        isPlatformAdmin: false,
        can: () => false,
      },
      courses: { academyId: link.academyId, deletedAt: null },
    } as StaffScope;
    const [courses, enrollments, attendance, live] = await Promise.all([
      this.staff.progress(scope, link.studentId),
      this.prisma.enrollment.findMany({
        where: { studentId: link.studentId, course: scope.courses },
        select: {
          status: true,
          createdAt: true,
          expiresAt: true,
          course: { select: { id: true } },
        },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { studentId: link.studentId, academyId: link.academyId },
        orderBy: { markedAt: 'desc' },
        take: 60,
        select: {
          status: true,
          homeGroupId: true,
          session: { select: { date: true, group: { select: { name: true } } } },
        },
      }),
      this.prisma.liveAttendance.findMany({
        where: { userId: link.student.userId, session: { academyId: link.academyId } },
        orderBy: { joinedAt: 'desc' },
        take: 10,
        select: {
          joinedAt: true,
          durationSeconds: true,
          session: { select: { title: true, startsAt: true } },
        },
      }),
    ]);
    const statusOf = (courseId: string) => enrollments.find((e) => e.course.id === courseId);
    const counts = { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 } as Record<string, number>;
    for (const a of attendance) counts[a.status] = (counts[a.status] ?? 0) + 1;

    // Recent activity: things that happened, each with its time.
    const activity = [
      ...courses.flatMap((c) =>
        c.quizzes
          .filter((q) => q.submittedAt)
          .map((q) => ({
            kind: 'QUIZ' as const,
            at: q.submittedAt!,
            course: c.course.title,
            title: q.lessonTitle,
            scorePct: q.needsManualGrading ? null : q.scorePct,
          })),
      ),
      ...courses.flatMap((c) =>
        c.assignments.map((a) => ({
          kind: 'ASSIGNMENT' as const,
          at: a.submittedAt,
          course: c.course.title,
          title: a.lessonTitle,
          score: a.gradedAt ? `${a.score}/${a.maxScore}` : null,
        })),
      ),
      ...attendance.slice(0, 10).map((a) => ({
        kind: 'ATTENDANCE' as const,
        at: a.session.date,
        course: a.session.group.name,
        title: a.status,
      })),
      ...live.map((l) => ({
        kind: 'LIVE' as const,
        at: l.joinedAt,
        course: null,
        title: l.session.title,
        minutes: Math.round(l.durationSeconds / 60),
      })),
    ]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 15);

    return {
      linkId: link.id,
      relationship: link.relationship,
      academy: link.academy,
      student: {
        id: link.studentId,
        name: link.student.user.fullName,
        avatarUrl: avatarUrl(link.student.user),
      },
      courses: courses.map((c) => ({
        ...c,
        enrollment: statusOf(c.course.id)
          ? {
              status: statusOf(c.course.id)!.status,
              since: statusOf(c.course.id)!.createdAt,
              expiresAt: statusOf(c.course.id)!.expiresAt,
            }
          : null,
      })),
      attendance: attendance.length
        ? {
            total: attendance.length,
            ...counts,
            recent: attendance.slice(0, 8).map((a) => ({
              date: a.session.date,
              group: a.session.group.name,
              status: a.status,
              // A makeup visit to another group's class (C2).
              makeup: !!a.homeGroupId,
            })),
          }
        : null,
      live: live.map((l) => ({
        title: l.session.title,
        startsAt: l.session.startsAt,
        minutes: Math.round(l.durationSeconds / 60),
      })),
      activity,
    };
  }
}
