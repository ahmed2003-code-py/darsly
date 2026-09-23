import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Access gating for Challenges — the same shape as LessonAccessService, but a
 * Challenge is not lesson-bound so the rules are simpler: a teacher owns it
 * outright (tenantId), and a student may reach it once they have any live
 * enrollment with that teacher (or, when the challenge names a course
 * specifically, an enrollment in that exact course).
 */
@Injectable()
export class ChallengesAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async studentIdOf(userId: string): Promise<string> {
    const s = await this.prisma.studentProfile.findUnique({ where: { userId } });
    if (!s) throw new BadRequestException('No student profile for this account');
    return s.id;
  }

  /** Teacher owns this challenge (tenant-scoped; cross-tenant ids 404). */
  async requireTeacherChallenge(tenantId: string, challengeId: string) {
    const challenge = await this.prisma.challenge.findFirst({
      where: { id: challengeId, tenantId, deletedAt: null },
    });
    if (!challenge) throw new NotFoundException('Challenge not found');
    return challenge;
  }

  /**
   * Student can see and play this challenge: published (or already active),
   * not closed, and the student has live access to the teacher behind it — via
   * the named course when the challenge is scoped to one, otherwise via any
   * active enrollment with that same teacher. Mirrors the enrollment check
   * every quiz/assignment already applies, so a Challenge never leaks a
   * teacher's content to a student who never paid for it.
   */
  async requireStudentAccess(userId: string, challengeId: string) {
    const challenge = await this.prisma.challenge.findFirst({
      where: { id: challengeId, deletedAt: null, status: { in: ['PUBLISHED', 'ACTIVE'] } },
    });
    if (!challenge) throw new NotFoundException('Challenge not found');
    if (challenge.closesAt && challenge.closesAt.getTime() <= Date.now()) {
      throw new ForbiddenException('This challenge is closed');
    }

    const studentId = await this.studentIdOf(userId);
    const enrolled = challenge.courseId
      ? await this.prisma.enrollment.findFirst({
          where: { studentId, courseId: challenge.courseId, status: 'ACTIVE' },
          select: { id: true },
        })
      : await this.prisma.enrollment.findFirst({
          where: { studentId, status: 'ACTIVE', course: { tenantId: challenge.tenantId } },
          select: { id: true },
        });
    if (!enrolled) throw new ForbiddenException('Not enrolled with this teacher');

    return { challenge, studentId };
  }
}
