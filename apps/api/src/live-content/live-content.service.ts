import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CourseScope, CoursesService } from '../courses/courses.service';
import { LiveScope, LiveService } from '../live/live.service';
import { ImportScope, PaperImportService, type UploadedPaper } from '../paper-import/paper-import.service';
import { PrismaService } from '../prisma/prisma.service';

/** Everything a teacher's request carries: the three scopes the reused services speak. */
export interface ContentScope {
  course: CourseScope;
  live: LiveScope;
  imports: ImportScope;
}

export interface PublishLessonInput {
  target: 'EXISTING_COURSE' | 'NEW_COURSE';
  courseId?: string;
  unitId?: string;
  newUnitTitle?: string;
  newCourse?: { title: string; description?: string; gradeId: string; subjectId?: string };
  title: string;
  description?: string;
  includeTranscript?: boolean;
  includeSummary?: boolean;
}

/** How long one conversion request may hold a class (it takes a second or two). */
const CLAIM_MS = 60_000;

/**
 * Live class → permanent course content, built only from what Darsly already
 * has: the class's processed recording (the same VideoAsset its replay plays —
 * never downloaded, copied, re-encoded or re-encrypted), its transcript and
 * its grounded summary (copied into the lesson as a frozen snapshot — no STT
 * and no model call), and, for an exam, the existing Exam Studio content
 * pipeline fed with the transcript instead of uploaded files.
 *
 * Nothing here grants anything: a lesson is opened by course enrollment as
 * every lesson is, and the class's replay stays governed by its own purchase.
 */
@Injectable()
export class LiveContentService {
  private readonly logger = new Logger(LiveContentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly courses: CoursesService,
    private readonly imports: PaperImportService,
  ) {}

  /** What this class has become, and what it can still become. */
  async status(scope: ContentScope, sessionId: string) {
    const { session: s, recording } = await this.live.contentSource(scope.live, sessionId);
    const lessons = await this.prisma.lesson.findMany({
      where: {
        sourceLiveSessionId: sessionId,
        unit: { deletedAt: null, course: { deletedAt: null } },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        title: true,
        type: true,
        videoAssetId: true,
        unit: { select: { id: true, title: true, isDefault: true, course: { select: { id: true, title: true, status: true } } } },
        quiz: { select: { _count: { select: { questions: true } } } },
      },
    });
    const exam = await this.prisma.paperImport.findFirst({
      where: { sourceLiveSessionId: sessionId, status: { notIn: ['CANCELED'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, stage: true, lessonId: true, sourceMeta: true },
    });
    const transcript = this.transcriptOf(s);
    return {
      eligible: s.status === 'ENDED' && !!recording,
      ended: s.status === 'ENDED',
      recordingReady: !!recording,
      transcript: {
        status: s.transcriptStatus,
        usable: transcript.usable,
        partial: transcript.partial,
        // How much class the transcript covers — for "نص الحصة (١٢ دقيقة)".
        durationSec: ((s.transcriptMeta ?? null) as { audioSeconds?: number } | null)?.audioSeconds ?? null,
      },
      summaryReady: s.summaryStatus === 'READY' && !!s.summary,
      lessons: lessons.map((l) => ({
        id: l.id,
        title: l.title,
        type: l.type,
        isRecording: !!recording && l.videoAssetId === recording.videoAssetId,
        course: l.unit.course,
        unit: { id: l.unit.id, title: l.unit.title, isDefault: l.unit.isDefault },
        questionCount: l.quiz?._count.questions ?? null,
      })),
      examSession: exam
        ? { id: exam.id, status: exam.status, stage: exam.stage, lessonId: exam.lessonId, partial: !!(exam.sourceMeta as { partial?: boolean } | null)?.partial }
        : null,
    };
  }

  /**
   * The recording as a lesson — in an existing course (a chosen section, a
   * new section, or none), or as the first lesson of a new DRAFT course the
   * teacher then finishes in the ordinary course editor (price, years,
   * publication). Idempotent: one recording becomes one lesson; asking again
   * answers with that lesson.
   */
  async publishLesson(scope: ContentScope, sessionId: string, dto: PublishLessonInput) {
    return this.claimed(sessionId, async () => {
      const { session: s, recording } = await this.live.contentSource(scope.live, sessionId);
      if (s.status !== 'ENDED') {
        throw new ConflictException({ message: 'The class has not ended', code: 'CLASS_NOT_ENDED' });
      }
      if (!recording) {
        throw new ConflictException({ message: 'The recording is not ready', code: 'RECORDING_NOT_READY' });
      }
      const holder = await this.courses.videoHolder(recording.videoAssetId);
      if (holder && !holder.deleted) {
        return { created: false, ...(await this.lessonView(holder.id)) };
      }

      const transcript = this.transcriptOf(s);
      if (dto.includeTranscript && !transcript.usable) {
        throw new ConflictException({ message: 'There is no transcript to include', code: 'TRANSCRIPT_NOT_AVAILABLE' });
      }
      const summaryReady = s.summaryStatus === 'READY' && !!s.summary;
      if (dto.includeSummary && !summaryReady) {
        throw new ConflictException({ message: 'There is no summary to include', code: 'SUMMARY_NOT_AVAILABLE' });
      }
      // A frozen copy, not a pointer: regenerating the class's summary later
      // must never change what a published lesson shows.
      const liveContent = {
        includeTranscript: !!dto.includeTranscript,
        includeSummary: !!dto.includeSummary,
        summary: dto.includeSummary ? s.summary : null,
        summaryMeta: dto.includeSummary ? s.summaryMeta : null,
        transcriptSegments: dto.includeTranscript ? transcript.segments : null,
        transcriptPartial: dto.includeTranscript ? transcript.partial : false,
        transcriptRevision: s.transcriptRevision,
        snapshotAt: new Date().toISOString(),
      } as unknown as Prisma.InputJsonValue;

      let courseId: string;
      if (dto.target === 'NEW_COURSE') {
        if (!dto.newCourse?.title?.trim() || !dto.newCourse.gradeId) {
          throw new BadRequestException({ message: 'Name the course and choose its school year', code: 'NEW_COURSE_INCOMPLETE' });
        }
        // The ordinary course creation: DRAFT, free until the teacher prices
        // it, years and subject checked as for a course made by hand.
        const course = await this.courses.create(scope.course, {
          title: dto.newCourse.title.trim().slice(0, 200),
          description: (dto.newCourse.description ?? s.description ?? '').slice(0, 5_000),
          gradeIds: [dto.newCourse.gradeId],
          ...(dto.newCourse.subjectId ? { subjectId: dto.newCourse.subjectId } : {}),
        } as never);
        courseId = course.id;
      } else {
        if (!dto.courseId) throw new BadRequestException({ message: 'Choose a course', code: 'COURSE_REQUIRED' });
        courseId = dto.courseId;
      }

      const lesson = await this.courses.addRecordedLesson(
        scope.course,
        courseId,
        { unitId: dto.target === 'EXISTING_COURSE' ? dto.unitId : undefined, newUnitTitle: dto.newUnitTitle },
        {
          title: dto.title?.trim() || s.title,
          description: dto.description ?? (s.description || undefined),
          videoAssetId: recording.videoAssetId,
          durationSec: recording.durationSec,
          sourceLiveSessionId: sessionId,
          liveContent,
        },
      );
      this.logger.log(
        `live.content.lesson liveSession=${sessionId} lesson=${lesson.id} course=${courseId} target=${dto.target} ` +
          `asset=${recording.videoAssetId} transcript=${!!dto.includeTranscript} summary=${!!dto.includeSummary}`,
      );
      return { created: true, ...(await this.lessonView(lesson.id)) };
    });
  }

  /**
   * An exam written from this class — through the existing Exam Studio: a
   * content session whose material is the class's COMPLETE transcript, left
   * at CONFIGURING. Nothing is generated (or paid for) until the teacher sets
   * the exam there; the result is a draft they review before confirming.
   * One open session per class: asking again answers with it.
   */
  /**
   * An Exam Studio session from this class: its transcript, material the
   * teacher uploads now (a lecture PDF, slides saved as PDF, photos of
   * pages), or both. Nothing is generated until the teacher asks, in the
   * studio.
   *
   *  - transcript only: already text, so the session opens at the settings;
   *  - with files: the ordinary upload → read path; the transcript (when
   *    chosen) is laid beside the files' text once they are read;
   *  - an incomplete transcript needs the teacher's explicit go-ahead; a
   *    failed one cannot be chosen, and files alone still can.
   *
   * One session per class at a time: asking again reopens the one there is.
   */
  async createExam(
    scope: ContentScope,
    sessionId: string,
    dto: { acknowledgePartial?: boolean; title?: string; transcript?: boolean; files?: UploadedPaper[] },
  ) {
    const files = dto.files ?? [];
    const withTranscript = dto.transcript !== false;
    if (!withTranscript && !files.length) {
      throw new BadRequestException({ message: 'Choose the transcript, a file, or both', code: 'NO_SOURCE' });
    }
    return this.claimed(sessionId, async () => {
      const { session: s } = await this.live.contentSource(scope.live, sessionId);
      if (s.status !== 'ENDED') {
        throw new ConflictException({ message: 'The class has not ended', code: 'CLASS_NOT_ENDED' });
      }
      const existing = await this.prisma.paperImport.findFirst({
        where: { sourceLiveSessionId: sessionId, deletedAt: null, status: { notIn: ['CANCELED', 'FAILED'] } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, stage: true, title: true },
      });
      if (existing) return { created: false, ...existing };
      const transcript = this.transcriptOf(s);
      if (withTranscript && !transcript.usable) {
        throw new ConflictException({
          message: 'There is no transcript to write an exam from',
          code: 'TRANSCRIPT_NOT_AVAILABLE',
          transcriptStatus: s.transcriptStatus,
        });
      }
      if (withTranscript && transcript.partial && !dto.acknowledgePartial) {
        throw new ConflictException({
          message: 'The transcript is incomplete; the exam may not cover the whole class',
          code: 'PARTIAL_TRANSCRIPT',
        });
      }
      const title = (dto.title?.trim() || `امتحان: ${s.title}`).slice(0, 200);
      const created = files.length
        ? await this.imports.create(scope.imports, files, {
            kind: 'CONTENT',
            title,
            live: {
              liveSessionId: sessionId,
              segments: withTranscript ? transcript.segments : [],
              transcriptRevision: s.transcriptRevision,
              partial: withTranscript && transcript.partial,
            },
          })
        : await this.imports.createFromTranscript(scope.imports, {
            title,
            segments: transcript.segments,
            liveSessionId: sessionId,
            transcriptRevision: s.transcriptRevision,
            partial: transcript.partial,
          });
      this.logger.log(
        `live.content.exam liveSession=${sessionId} import=${created.id} transcript=${withTranscript} ` +
          `files=${files.length} partial=${withTranscript && transcript.partial}`,
      );
      return { created: true, id: created.id, status: created.status, stage: created.stage, title: created.title };
    });
  }

  /**
   * An exam the teacher already has, placed right after this class's lesson
   * in the same course (the curriculum order is the course's own "watch, then
   * take" relationship). Moved, never copied.
   */
  async linkExam(scope: ContentScope, sessionId: string, examLessonId: string) {
    await this.live.contentSource(scope.live, sessionId);
    const video = await this.recordingLesson(sessionId);
    if (!video) {
      throw new ConflictException({ message: 'Add the recording to a course first', code: 'LESSON_REQUIRED' });
    }
    await this.courses.placeExamAfter(scope.course, examLessonId, video.id, sessionId);
    return this.status(scope, sessionId);
  }

  /** Exams the teacher may link: exam lessons of the course the recording went into. */
  async examCandidates(
    scope: ContentScope,
    sessionId: string,
  ): Promise<{ courseId: string | null; exams: { id: string; title: string; unitTitle: string }[] }> {
    await this.live.contentSource(scope.live, sessionId);
    const video = await this.recordingLesson(sessionId);
    if (!video) return { courseId: null, exams: [] };
    const course = await this.courses.getMine(scope.course, video.unit.courseId);
    const exams = (course.units ?? []).flatMap((u: { title: string; lessons?: { id: string; title: string; type: string }[] }) =>
      (u.lessons ?? []).filter((l) => l.type === 'QUIZ').map((l) => ({ id: l.id, title: l.title, unitTitle: u.title })),
    );
    return { courseId: video.unit.courseId, exams };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private recordingLesson(sessionId: string) {
    return this.prisma.lesson.findFirst({
      where: { sourceLiveSessionId: sessionId, type: 'VIDEO', videoAssetId: { not: null }, unit: { deletedAt: null, course: { deletedAt: null } } },
      select: { id: true, unit: { select: { courseId: true } } },
    });
  }

  private transcriptOf(s: { transcriptStatus: string; transcriptText: string | null; transcriptSegments: unknown }) {
    const segments = (Array.isArray(s.transcriptSegments) ? s.transcriptSegments : []) as {
      startSec: number | null;
      durationSec: number | null;
      text: string;
    }[];
    const usable = (s.transcriptStatus === 'READY' || s.transcriptStatus === 'PARTIAL') && !!s.transcriptText?.trim();
    return {
      usable,
      partial: s.transcriptStatus === 'PARTIAL',
      segments: segments.length ? segments : s.transcriptText ? [{ startSec: null, durationSec: null, text: s.transcriptText }] : [],
    };
  }

  private async lessonView(lessonId: string) {
    const l = await this.prisma.lesson.findUniqueOrThrow({
      where: { id: lessonId },
      select: {
        id: true,
        title: true,
        unit: { select: { id: true, title: true, isDefault: true, course: { select: { id: true, title: true, status: true } } } },
      },
    });
    return { lesson: { id: l.id, title: l.title }, unit: { id: l.unit.id, title: l.unit.title, isDefault: l.unit.isDefault }, course: l.unit.course };
  }

  /**
   * One conversion at a time per class: a second click, a second tab or a
   * retried request is told it is in progress, instead of doing it twice.
   */
  private async claimed<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const now = new Date();
    const got = await this.prisma.liveSession.updateMany({
      where: { id: sessionId, OR: [{ contentClaimUntil: null }, { contentClaimUntil: { lt: now } }] },
      data: { contentClaimUntil: new Date(now.getTime() + CLAIM_MS) },
    });
    if (got.count === 0) {
      throw new ConflictException({ message: 'This class is already being converted — a moment', code: 'CONVERSION_IN_PROGRESS' });
    }
    try {
      return await fn();
    } finally {
      await this.prisma.liveSession
        .updateMany({ where: { id: sessionId }, data: { contentClaimUntil: null } })
        .catch(() => undefined);
    }
  }
}
