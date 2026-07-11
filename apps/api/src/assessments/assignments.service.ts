import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LessonAccessService } from './lesson-access.service';
import { CertificatesService } from './certificates.service';
import {
  GradeSubmissionDto,
  SubmitAssignmentDto,
  UpsertAssignmentDto,
} from './dto/assignment.dto';

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LessonAccessService,
    private readonly notifications: NotificationsService,
    private readonly certificates: CertificatesService,
  ) {}

  // ── Teacher authoring ──────────────────────────────────────────────────────

  async upsertForTeacher(tenantId: string, lessonId: string, dto: UpsertAssignmentDto) {
    await this.access.requireTeacherLesson(tenantId, lessonId);
    await this.prisma.lesson.update({ where: { id: lessonId }, data: { type: 'ASSIGNMENT' } });
    return this.prisma.assignment.upsert({
      where: { lessonId },
      create: {
        lessonId,
        prompt: dto.prompt,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        maxScore: dto.maxScore ?? 100,
      },
      update: {
        prompt: dto.prompt,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : dto.dueAt === null ? null : undefined,
        ...(dto.maxScore != null ? { maxScore: dto.maxScore } : {}),
      },
    });
  }

  async getForTeacher(tenantId: string, lessonId: string) {
    await this.access.requireTeacherLesson(tenantId, lessonId);
    const assignment = await this.prisma.assignment.findUnique({
      where: { lessonId },
      include: {
        submissions: {
          orderBy: { createdAt: 'desc' },
          include: { student: { select: { user: { select: { fullName: true } } } } },
        },
      },
    });
    if (!assignment) return null;
    const pendingGrading = assignment.submissions.filter((s) => s.gradedAt == null).length;
    return { ...assignment, pendingGrading };
  }

  async gradeSubmission(tenantId: string, submissionId: string, dto: GradeSubmissionDto) {
    const submission = await this.prisma.assignmentSubmission.findFirst({
      where: { id: submissionId, assignment: { lesson: { unit: { course: { tenantId } } } } },
      include: { assignment: { include: { lesson: true } } },
    });
    if (!submission) throw new NotFoundException('Submission not found');
    if (dto.score > submission.assignment.maxScore) {
      throw new BadRequestException('Score exceeds the assignment maximum');
    }

    const updated = await this.prisma.assignmentSubmission.update({
      where: { id: submissionId },
      data: { score: dto.score, feedback: dto.feedback ?? '', gradedAt: new Date() },
    });

    const student = await this.prisma.studentProfile.findUnique({
      where: { id: submission.studentId },
      select: { userId: true },
    });
    if (student) {
      await this.notifications.create({
        userId: student.userId,
        type: 'QUIZ_GRADED',
        title: 'تم تصحيح واجبك 📝',
        body: `«${submission.assignment.lesson.title}»: ${dto.score}/${submission.assignment.maxScore}`,
        meta: { score: dto.score, maxScore: submission.assignment.maxScore },
      });
    }
    return updated;
  }

  // ── Student ────────────────────────────────────────────────────────────────

  async getForStudent(userId: string, lessonId: string) {
    const { studentId } = await this.access.requireStudentAccess(userId, lessonId);
    const assignment = await this.prisma.assignment.findUnique({ where: { lessonId } });
    if (!assignment) throw new NotFoundException('This lesson has no assignment');
    const mine = await this.prisma.assignmentSubmission.findUnique({
      where: { assignmentId_studentId: { assignmentId: assignment.id, studentId } },
    });
    return { assignment, mySubmission: mine };
  }

  async submit(userId: string, lessonId: string, dto: SubmitAssignmentDto) {
    const { studentId } = await this.access.requireStudentAccess(userId, lessonId);
    const assignment = await this.prisma.assignment.findUnique({ where: { lessonId } });
    if (!assignment) throw new NotFoundException('This lesson has no assignment');
    if (!dto.body?.trim() && !dto.fileKey) {
      throw new BadRequestException('Submit text or a file');
    }

    const existing = await this.prisma.assignmentSubmission.findUnique({
      where: { assignmentId_studentId: { assignmentId: assignment.id, studentId } },
    });
    if (existing?.gradedAt) {
      throw new BadRequestException('This assignment is already graded and cannot be resubmitted');
    }

    const submission = await this.prisma.assignmentSubmission.upsert({
      where: { assignmentId_studentId: { assignmentId: assignment.id, studentId } },
      create: { assignmentId: assignment.id, studentId, body: dto.body ?? '', fileKey: dto.fileKey ?? null },
      update: { body: dto.body ?? '', fileKey: dto.fileKey ?? null },
    });

    // Submitting the assignment counts the lesson as completed for progress.
    await this.prisma.lessonProgress.upsert({
      where: { studentId_lessonId: { studentId, lessonId } },
      create: { studentId, lessonId, watchedPct: 100, completedAt: new Date() },
      update: { watchedPct: 100, completedAt: new Date() },
    });
    await this.certificates.checkByLesson(studentId, lessonId);
    return submission;
  }
}
