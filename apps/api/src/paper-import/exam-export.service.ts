import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { buildDocx, ExamDocument, looksRtl } from './docx-writer';

interface StoredOption {
  id: string;
  text: string;
}

/**
 * An exam, as a document.
 *
 * Built from the structured question set, never from the uploaded pages: the
 * point of exporting is to get a clean paper out, and a PDF of the photographs
 * is the thing the teacher already had. It is also not import-specific —
 * `lessonId` is any QUIZ lesson, so an exam typed in by hand exports exactly
 * the same way. Tying the export to imports would have meant a teacher's other
 * exams could not be printed, for no reason anybody could defend.
 *
 * Two formats, two mechanisms, for one reason each:
 *
 *  - **DOCX** is built here, because "editable in Word" is a file format and
 *    there is no other way to produce one.
 *  - **PDF** is not built here. It is `document()` handed to the browser,
 *    which lays it out with `@media print` and prints it — the same route
 *    `CertificateViewPage` already takes. A server-side PDF library would have
 *    to shape and bidi Arabic itself, which is the one thing every browser
 *    already does correctly and no small PDF library does at all.
 */
@Injectable()
export class ExamExportService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The exam as a document model, scoped to the teacher who owns it.
   *
   * `tenantId` is matched through the lesson's course, which is the same
   * ownership path `LessonAccessService.requireTeacherLesson` walks — so an
   * export cannot reach a lesson its caller could not otherwise open. An owner
   * of a Center passes `manageAll` and sees every course offered there.
   */
  async document(
    scope: { academyId: string; authorTenantId?: string; manageAll?: boolean },
    lessonId: string,
  ): Promise<ExamDocument> {
    const lesson = await this.prisma.lesson.findFirst({
      where: {
        id: lessonId,
        deletedAt: null,
        unit: {
          deletedAt: null,
          course: {
            deletedAt: null,
            academyId: scope.academyId,
            ...(scope.manageAll ? {} : { tenantId: scope.authorTenantId ?? '__none__' }),
          },
        },
      },
      include: {
        quiz: { include: { questions: { orderBy: { sortOrder: 'asc' } } } },
        unit: {
          include: {
            course: {
              select: {
                title: true,
                teacher: { select: { user: { select: { fullName: true } } } },
                academy: { select: { name: true, kind: true } },
                subject: { select: { nameAr: true, nameEn: true } },
                grades: {
                  select: { grade: { select: { nameAr: true, nameEn: true, sortOrder: true } } },
                },
              },
            },
          },
        },
      },
    });
    if (!lesson?.quiz) throw new NotFoundException('Exam not found');

    const course = lesson.unit.course;
    const total = lesson.quiz.questions.reduce((n, q) => n + q.points, 0);

    const sections: ExamDocument['sections'] = [
      {
        title: '',
        questions: lesson.quiz.questions.map((q, i) => ({
          number: i + 1,
          text: q.prompt,
          options: (Array.isArray(q.options) ? (q.options as unknown as StoredOption[]) : []).map(
            (o) => o?.text ?? '',
          ),
          marks: q.points,
          writtenAnswer: q.type === 'SHORT_ANSWER',
        })),
      },
    ];

    // Only the teacher's own words. The time and the total are numbers here
    // and become sentences where the paper's language is known — an Arabic
    // exam printing "Total marks: 8" in English was this service writing
    // English prose for a document it could not read.
    const instructions: string[] = lesson.description ? [lesson.description] : [];

    const meta = [course.title, course.teacher?.user?.fullName ?? ''].filter(Boolean);

    const rtl = looksRtl(`${lesson.title} ${lesson.quiz.questions.map((q) => q.prompt).join(' ')}`);
    const grades = [...course.grades]
      .map((g) => g.grade)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((g) => (rtl ? g.nameAr : g.nameEn));

    return {
      title: lesson.title,
      meta,
      // The facts a printed paper carries at the top, in the paper's language.
      header: {
        // A teacher's personal academy is named after them; printing both says
        // the same thing twice. A Center's name is worth printing.
        academy: course.academy?.kind === 'CENTER' ? course.academy.name : null,
        teacher: course.teacher?.user?.fullName ?? null,
        course: course.title,
        subject: course.subject ? (rtl ? course.subject.nameAr : course.subject.nameEn) : null,
        grade: grades.length ? grades.join(rtl ? '، ' : ', ') : null,
        questionCount: lesson.quiz.questions.length,
        passingScore: lesson.quiz.passingScore ?? null,
      },
      instructions,
      timeLimitMin: lesson.quiz.timeLimitSec ? Math.round(lesson.quiz.timeLimitSec / 60) : null,
      totalMarks: total,
      sections,
      // Decided from the paper's own text, so an Arabic exam prints
      // right-to-left whoever asked for it.
      rtl,
    };
  }

  /** The same document, as a Word file. */
  async docx(
    scope: { academyId: string; authorTenantId?: string; manageAll?: boolean },
    lessonId: string,
  ): Promise<{ filename: string; body: Buffer }> {
    const doc = await this.document(scope, lessonId);
    return {
      // Only characters that survive a Content-Disposition round trip and a
      // Windows filesystem; the header encodes the rest as UTF-8 anyway.
      filename: `${doc.title.replace(/[\\/:*?"<>|]/g, ' ').trim() || 'exam'}.docx`,
      body: buildDocx(doc),
    };
  }
}
