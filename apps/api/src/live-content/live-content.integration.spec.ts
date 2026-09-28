import { randomUUID } from 'crypto';
import { Role } from '@darsly/shared-types';
import { AiJobService } from '../academy-site/jobs/ai-job.service';
import { databaseReady } from '../common/testing/db-available';
import { CoursesService } from '../courses/courses.service';
import { LiveService } from '../live/live.service';
import { CloudflareLiveProvider } from '../live/providers/cloudflare-live.provider';
import { CF_STUN } from '../live/providers/cloudflare-realtime.client';
import { LiveProviders } from '../live/providers/live-providers';
import { PaperImportConfig } from '../paper-import/paper-import.config';
import { PaperImportService } from '../paper-import/paper-import.service';
import { PlaybackService } from '../playback/playback.service';
import { PrismaService } from '../prisma/prisma.service';
import { ContentScope, LiveContentService } from './live-content.service';

/**
 * Live class → course content, on a real PostgreSQL. The recording is reused
 * (one VideoAsset, two references), the class's words and notes are copied
 * as a snapshot (no STT, no model call), an exam is an Exam Studio session
 * from the transcript (nothing generated, nothing published), and the Live and
 * Course entitlements stay separate.
 */
const prisma = new PrismaService();
let available = true;

beforeAll(async () => {
  available = await databaseReady(prisma, ['liveSession', 'lesson', 'paperImport']);
  if (!available) return;
  await prisma.onModuleInit();
}, 30_000);
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => {
  if (!available) console.warn('skipping: no database reachable at DATABASE_URL');
  return available;
};

const storage = {
  deleted: [] as string[],
  delete: async (k: string) => void storage.deleted.push(k),
  deletePrefix: async (k: string) => void storage.deleted.push(k),
  put: async () => undefined,
  getBuffer: async () => Buffer.from(''),
};

function build() {
  const courses = new CoursesService(
    prisma,
    {} as never,
    {} as never,
    storage as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { requirePassed: async () => undefined } as never,
  );
  const client = { configured: true, turnConfigured: false, iceServers: jest.fn(async () => [CF_STUN]), closeTracks: jest.fn(async () => ({})), getSession: jest.fn(async () => ({ tracks: [] })) };
  const providers = new LiveProviders([new CloudflareLiveProvider(prisma, client as any)], 'CLOUDFLARE');
  const jobs = new AiJobService(prisma, { enabled: true, monthlyBudgetCents: 0 } as any);
  const live = new LiveService(prisma, { create: jest.fn(async () => ({})) } as any, {} as any, providers, { emitToLive: jest.fn(), emitToUser: jest.fn() } as any, jobs, {} as any);
  const builder = { build: jest.fn() };
  const imports = new PaperImportService(prisma, storage as never, {} as never, new PaperImportConfig(), jobs, builder as never, { log: jest.fn(async () => undefined) } as never, {} as never, courses);
  const content = new LiveContentService(prisma, live, courses, imports);
  const playback = new PlaybackService(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, { requirePassed: async () => undefined } as never);
  return { courses, live, content, imports, builder, playback, jobs };
}

const SEGMENTS = [
  { startSec: 0, durationSec: 180, text: 'طيب يا جماعة النهارده هنتكلم عن الـ supervised learning، يعني الموديل بيتعلم من data فيها labels، وكل مثال معاه الإجابة الصح اللي بنسميها label. خدوا مثال الإيميلات: كل إيميل مكتوب عليه spam ولا not spam، والموديل بيتعلم يفرق بينهم.' },
  { startSec: 180, durationSec: 180, text: 'الفرق بين classification و regression: الـ classification الإجابة فيها فئة زي spam، والـ regression الإجابة فيها رقم زي سعر الشقة. وبنقسم الـ data لجزئين training و test عشان نعرف الموديل فاهم ولا حافظ، ولو حافظ يبقى عنده overfitting.' },
];
const NOTES = {
  schemaVersion: 2,
  title: 'Supervised Learning',
  quickSummary: 'الموديل بيتعلم من data فيها labels.',
  keyPoints: [{ text: 'labels', evidence: 'الموديل بيتعلم من data فيها labels' }],
  concepts: [], examples: [], formulas: [], questions: [], homework: [], corrections: [],
  reviewPoints: [], studyNotes: '...',
};

async function world(over: Record<string, unknown> = {}) {
  const k = randomUUID().slice(0, 8);
  const grade = await prisma.gradeLevel.findFirst({ where: { isActive: true } });
  const user = await prisma.user.create({ data: { role: 'TEACHER', fullName: `T ${k}`, email: `lc-${k}@it.test` } });
  const tp = await prisma.teacherProfile.create({ data: { userId: user.id, slug: `lc-${k}`, stages: grade?.stage ? [grade.stage] : [] } });
  await prisma.academy.create({ data: { id: tp.id, slug: `lca-${k}`, name: `A ${k}`, ownerUserId: user.id } });
  await prisma.academyMembership.create({ data: { userId: user.id, academyId: tp.id, role: 'OWNER', status: 'ACTIVE', joinedAt: new Date() } });
  const asset = await prisma.videoAsset.create({
    data: { tenantId: tp.id, originalKey: `source/live-rec/${k}/final.mp4`, hlsMasterKey: `hls/${k}/master.m3u8`, status: 'READY', durationSec: 566 },
  });
  const ls = await prisma.liveSession.create({
    data: {
      tenantId: tp.id,
      academyId: tp.id,
      teacherUserId: user.id,
      title: `حصة Machine Learning ${k}`,
      description: 'شرح الـ supervised learning',
      startsAt: new Date(Date.now() - 3600_000),
      startedAt: new Date(Date.now() - 3600_000),
      endedAt: new Date(Date.now() - 600_000),
      durationMin: 60,
      status: 'ENDED',
      provider: 'CLOUDFLARE',
      roomName: `cf-${k}`,
      transcriptStatus: 'READY',
      transcriptText: SEGMENTS.map((s) => s.text).join('\n\n'),
      transcriptSegments: SEGMENTS,
      transcriptRevision: 1,
      summaryStatus: 'READY',
      summary: NOTES,
      summaryMeta: { model: 'gpt-6-luna', transcriptRevision: 1 },
      ...over,
    },
  });
  const rec = await prisma.liveRecording.create({
    data: { sessionId: ls.id, roomName: ls.roomName!, tenantId: tp.id, requestedBy: user.id, status: 'READY', videoAssetId: asset.id, durationSec: 566, readyAt: new Date() },
  });
  const course = await prisma.course.create({
    data: { tenantId: tp.id, academyId: tp.id, title: `كورس ${k}`, status: 'PUBLISHED', priceCents: 50_000, ...(grade ? { grades: { create: [{ gradeId: grade.id }] } } : {}) },
  });
  const unit = await prisma.courseUnit.create({ data: { courseId: course.id, title: 'الفصل الثاني', sortOrder: 1 } });
  const scope: ContentScope = {
    course: { academyId: tp.id, authorTenantId: tp.id, manageAll: true },
    live: { academyId: tp.id, userId: user.id, manageAll: true, role: 'OWNER' },
    imports: { academyId: tp.id, authorTenantId: tp.id, manageAll: true, userId: user.id },
  };
  return { k, user, tp, asset, ls, rec, course, unit, scope, grade };
}
const publish = (S: ReturnType<typeof build>, w: Awaited<ReturnType<typeof world>>, extra: Record<string, unknown> = {}) =>
  S.content.publishLesson(w.scope, w.ls.id, {
    target: 'EXISTING_COURSE',
    courseId: w.course.id,
    unitId: w.unit.id,
    title: 'مقدمة في Machine Learning',
    includeTranscript: true,
    includeSummary: true,
    ...extra,
  } as never);
async function student(k: string) {
  const u = await prisma.user.create({ data: { role: 'STUDENT', fullName: `S ${k}`, email: `lcs-${k}-${randomUUID().slice(0, 4)}@it.test` } });
  const sp = await prisma.studentProfile.create({ data: { userId: u.id } });
  return { u, sp };
}

describe('Live recording → course lesson (same video)', () => {
  it('adds the recording to an existing course section, reusing the VideoAsset — nothing new stored, nothing processed', async () => {
    if (!guard()) return;
    const S = build();
    const w = await world();
    const assetsBefore = await prisma.videoAsset.count();
    const jobsBefore = await prisma.videoJob.count();
    const r = await publish(S, w);
    expect(r.created).toBe(true);
    expect(r.course.id).toBe(w.course.id);
    expect(r.unit.id).toBe(w.unit.id);
    const lesson = await prisma.lesson.findUniqueOrThrow({ where: { id: r.lesson.id } });
    expect(lesson).toMatchObject({ type: 'VIDEO', videoAssetId: w.asset.id, durationSec: 566, sourceLiveSessionId: w.ls.id, title: 'مقدمة في Machine Learning' });
    expect(await prisma.videoAsset.count()).toBe(assetsBefore);
    expect(await prisma.videoJob.count()).toBe(jobsBefore);
    // The class's replay still points at the same video.
    expect((await prisma.liveRecording.findUniqueOrThrow({ where: { id: w.rec.id } })).videoAssetId).toBe(w.asset.id);
  });

  it('copies the transcript and notes as a frozen snapshot — no STT, no summary job; a later regeneration does not change the lesson', async () => {
    if (!guard()) return;
    const S = build();
    const w = await world();
    const aiJobsBefore = await prisma.aiJob.count({ where: { type: { in: ['LIVE_TRANSCRIBE', 'LIVE_SUMMARY'] } } });
    const r = await publish(S, w);
    expect(await prisma.aiJob.count({ where: { type: { in: ['LIVE_TRANSCRIBE', 'LIVE_SUMMARY'] } } })).toBe(aiJobsBefore);
    expect(await prisma.aiCallLog.count({ where: { liveSessionId: w.ls.id } })).toBe(0);
    // The class's summary is regenerated later.
    await prisma.liveSession.update({ where: { id: w.ls.id }, data: { summary: { ...NOTES, quickSummary: 'نسخة جديدة' } } });
    const lesson = await prisma.lesson.findUniqueOrThrow({ where: { id: r.lesson.id } });
    expect((lesson.liveContent as any).summary.quickSummary).toBe('الموديل بيتعلم من data فيها labels.');
    expect((lesson.liveContent as any).transcriptSegments).toHaveLength(2);
  });

  it('asking again (double click, retry, second tab) answers with the same lesson — never a second one', async () => {
    if (!guard()) return;
    const S = build();
    const w = await world();
    const first = await publish(S, w);
    const again = await publish(S, w);
    expect(again.created).toBe(false);
    expect(again.lesson.id).toBe(first.lesson.id);
    const racing = await Promise.allSettled([publish(S, w), publish(S, w), publish(S, w)]);
    for (const r of racing) {
      if (r.status === 'fulfilled') expect(r.value.lesson.id).toBe(first.lesson.id);
      else expect((r.reason as any)?.response?.code).toBe('CONVERSION_IN_PROGRESS');
    }
    expect(await prisma.lesson.count({ where: { videoAssetId: w.asset.id } })).toBe(1);
  });

  it('two brand-new requests at once make exactly one lesson', async () => {
    if (!guard()) return;
    const S = build();
    const w = await world();
    const r = await Promise.allSettled([publish(S, w), publish(S, w)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.lesson.count({ where: { sourceLiveSessionId: w.ls.id } })).toBe(1);
  });

  it('a new section can be created on the way; with no section the lesson goes to the course list', async () => {
    if (!guard()) return;
    const S = build();
    const w = await world();
    const r = await publish(S, w, { unitId: undefined, newUnitTitle: 'حصص مسجلة' });
    expect(r.unit.title).toBe('حصص مسجلة');
  });

  it('creates a new DRAFT course with the recording as its first lesson — never published or priced automatically', async () => {
    if (!guard()) return;
    const S = build();
    const w = await world();
    if (!w.grade) return console.warn('no grade level seeded: new-course case skipped');
    const r = await S.content.publishLesson(w.scope, w.ls.id, {
      target: 'NEW_COURSE',
      newCourse: { title: 'Machine Learning من الصفر', gradeId: w.grade.id },
      title: 'الحصة الأولى',
    } as never);
    const course = await prisma.course.findUniqueOrThrow({ where: { id: r.course.id } });
    expect(course).toMatchObject({ status: 'DRAFT', priceCents: 0, tenantId: w.tp.id, academyId: w.tp.id });
    expect((await prisma.lesson.findUniqueOrThrow({ where: { id: r.lesson.id } })).videoAssetId).toBe(w.asset.id);
  });

  it('refuses before the recording is ready, and for an archived course; the transcript is not required for a video lesson', async () => {
    if (!guard()) return;
    const S = build();
    const w = await world({ transcriptStatus: 'FAILED', transcriptText: null, transcriptSegments: null, summaryStatus: 'NOT_STARTED', summary: null });
    await prisma.liveRecording.update({ where: { id: w.rec.id }, data: { status: 'PROCESSING' } });
    await expect(publish(S, w, { includeTranscript: false, includeSummary: false })).rejects.toMatchObject({ response: { code: 'RECORDING_NOT_READY' } });
    await prisma.liveRecording.update({ where: { id: w.rec.id }, data: { status: 'READY' } });
    await expect(publish(S, w, { includeTranscript: true })).rejects.toMatchObject({ response: { code: 'TRANSCRIPT_NOT_AVAILABLE' } });
    await prisma.course.update({ where: { id: w.course.id }, data: { status: 'ARCHIVED' } });
    await expect(publish(S, w, { includeTranscript: false, includeSummary: false })).rejects.toMatchObject({ response: { code: 'COURSE_ARCHIVED' } });
    await prisma.course.update({ where: { id: w.course.id }, data: { status: 'PUBLISHED' } });
    const ok = await publish(S, w, { includeTranscript: false, includeSummary: false });
    expect(ok.created).toBe(true);
  });

  it("someone else's class or course is not reachable", async () => {
    if (!guard()) return;
    const S = build();
    const a = await world();
    const b = await world();
    await expect(S.content.publishLesson(b.scope, a.ls.id, { target: 'EXISTING_COURSE', courseId: b.course.id, title: 'x' } as never)).rejects.toThrow();
    await expect(S.content.publishLesson(a.scope, a.ls.id, { target: 'EXISTING_COURSE', courseId: b.course.id, title: 'x' } as never)).rejects.toThrow();
    expect(await prisma.lesson.count({ where: { sourceLiveSessionId: a.ls.id } })).toBe(0);
  });
});

describe('one video, two references: deleting either side never destroys the other', () => {
  it("removing the lesson's video (or the lesson) keeps the class replay's video, HLS and key", async () => {
    if (!guard()) return;
    const S = build();
    const w = await world();
    const r = await publish(S, w);
    storage.deleted.length = 0;
    const out = await S.courses.removeLessonVideo(w.scope.course, r.lesson.id);
    expect(out).toMatchObject({ videoRemoved: true, videoKept: true });
    expect(await prisma.videoAsset.findUnique({ where: { id: w.asset.id } })).not.toBeNull();
    expect(storage.deleted).toEqual([]);
    expect((await prisma.lesson.findUniqueOrThrow({ where: { id: r.lesson.id } })).videoAssetId).toBeNull();
  });

  it('a deleted lesson (or course) frees the recording to be published again — the video itself untouched', async () => {
    if (!guard()) return;
    const S = build();
    const w = await world();
    const first = await publish(S, w);
    await S.courses.removeLesson(w.scope.course, first.lesson.id);
    expect(await prisma.videoAsset.findUnique({ where: { id: w.asset.id } })).not.toBeNull();
    const again = await publish(S, w);
    expect(again.created).toBe(true);
    expect(again.lesson.id).not.toBe(first.lesson.id);
    // And deleting the whole course keeps it too.
    await prisma.course.update({ where: { id: w.course.id }, data: { deletedAt: new Date() } });
    expect(await prisma.videoAsset.findUnique({ where: { id: w.asset.id } })).not.toBeNull();
    expect((await prisma.liveRecording.findUniqueOrThrow({ where: { id: w.rec.id } })).videoAssetId).toBe(w.asset.id);
  });

  it('archiving or deleting the Live class keeps the published lesson and its video', async () => {
    if (!guard()) return;
    const S = build();
    const w = await world();
    const r = await publish(S, w);
    await prisma.liveSession.update({ where: { id: w.ls.id }, data: { deletedAt: new Date() } });
    const lesson = await prisma.lesson.findUniqueOrThrow({ where: { id: r.lesson.id } });
    expect(lesson.videoAssetId).toBe(w.asset.id);
    expect((await prisma.videoAsset.findUniqueOrThrow({ where: { id: w.asset.id } })).status).toBe('READY');
  });
});

describe('Live and Course entitlements stay separate', () => {
  it('a Live buyer does not get the course lesson; a course student gets it without any Live purchase — and not the Live class', async () => {
    if (!guard()) return;
    const S = build();
    const w = await world();
    const r = await publish(S, w);
    // A Live attendee (booking on the class) — no course enrollment.
    const liveBuyer = await student(w.k);
    await prisma.liveBooking.create({ data: { sessionId: w.ls.id, studentId: liveBuyer.sp.id } });
    await expect(S.playback.lessonClassNotes({ sub: liveBuyer.u.id, role: Role.STUDENT } as never, r.lesson.id)).rejects.toThrow(/Not enrolled/);
    await expect(S.live.assertInSession(liveBuyer.u.id, w.ls.id)).resolves.toMatchObject({ role: 'STUDENT' });
    // A course student — no Live booking.
    const courseStudent = await student(w.k);
    await prisma.enrollment.create({ data: { tenantId: w.tp.id, studentId: courseStudent.sp.id, courseId: w.course.id, status: 'ACTIVE', approvedAt: new Date() } });
    const notes = await S.playback.lessonClassNotes({ sub: courseStudent.u.id, role: Role.STUDENT } as never, r.lesson.id);
    expect(notes.fromLive).toBe(true);
    expect(notes.summary).toMatchObject({ title: 'Supervised Learning' });
    expect(JSON.stringify(notes)).not.toContain('evidence');
    expect(notes.transcript).toHaveLength(2);
    await expect(S.live.assertInSession(courseStudent.u.id, w.ls.id)).rejects.toThrow();
  });
});

describe('an exam from the class — through Exam Studio, never published by itself', () => {
  it('a session from the COMPLETE transcript, at CONFIGURING: chunks built, nothing generated, no exam lesson yet', async () => {
    if (!guard()) return;
    const S = build();
    const w = await world();
    const lessonsBefore = await prisma.lesson.count({ where: { type: 'QUIZ' } });
    const r = await S.content.createExam(w.scope, w.ls.id, {});
    expect(r).toMatchObject({ created: true, status: 'CONFIGURING', stage: 'READY' });
    const imp = await prisma.paperImport.findUniqueOrThrow({ where: { id: r.id }, include: { chunks: true } });
    expect(imp).toMatchObject({ kind: 'CONTENT', sourceKind: 'TRANSCRIPT', sourceLiveSessionId: w.ls.id });
    expect(imp.chunks.map((c) => c.text).join(' ')).toContain('overfitting'); // the end of the class is in it
    expect(await prisma.aiJob.count({ where: { type: 'PAPER_IMPORT', input: { path: ['importId'], equals: r.id } } })).toBe(0);
    expect(await prisma.lesson.count({ where: { type: 'QUIZ' } })).toBe(lessonsBefore);
    // Asking again answers with the same session.
    const again = await S.content.createExam(w.scope, w.ls.id, {});
    expect(again).toMatchObject({ created: false, id: r.id });
  });

  it('PARTIAL transcript: refused until the teacher acknowledges; then recorded on the session with a warning', async () => {
    if (!guard()) return;
    const S = build();
    const w = await world({ transcriptStatus: 'PARTIAL' });
    await expect(S.content.createExam(w.scope, w.ls.id, {})).rejects.toMatchObject({ response: { code: 'PARTIAL_TRANSCRIPT' } });
    const r = await S.content.createExam(w.scope, w.ls.id, { acknowledgePartial: true });
    const imp = await prisma.paperImport.findUniqueOrThrow({ where: { id: r.id } });
    expect(imp.sourceMeta).toMatchObject({ partial: true });
    expect((imp.warnings as any[]).map((x) => x.code)).toContain('PARTIAL_TRANSCRIPT');
  });

  it('FAILED transcript: AI exam refused (the video lesson is still possible)', async () => {
    if (!guard()) return;
    const S = build();
    const w = await world({ transcriptStatus: 'FAILED', transcriptText: null, transcriptSegments: null });
    await expect(S.content.createExam(w.scope, w.ls.id, {})).rejects.toMatchObject({ response: { code: 'TRANSCRIPT_NOT_AVAILABLE' } });
    expect((await publish(S, w, { includeTranscript: false, includeSummary: false })).created).toBe(true);
  });

  it('confirming the reviewed draft marks the exam lesson as written from this class, placed after the class lesson', async () => {
    if (!guard()) return;
    const S = build();
    const w = await world();
    const r = await S.content.createExam(w.scope, w.ls.id, {});
    const quizLesson = await prisma.lesson.create({ data: { unitId: w.unit.id, title: 'امتحان', type: 'QUIZ', sortOrder: 9 } });
    S.builder.build.mockResolvedValueOnce({ lessonId: quizLesson.id, courseId: w.course.id, questionCount: 5, droppedUnsupported: 0 });
    await prisma.paperImport.update({ where: { id: r.id }, data: { status: 'REVIEW', draft: { title: 'x', instructions: [], sections: [{ questions: [{}] }] } } });
    const video = await publish(S, w, { unitId: undefined, newUnitTitle: 'الحصص' });
    await S.imports.confirm(w.scope.imports, r.id, { target: 'EXISTING_COURSE', courseId: w.course.id } as never);
    const q = await prisma.lesson.findUniqueOrThrow({ where: { id: quizLesson.id } });
    expect(q.sourceLiveSessionId).toBe(w.ls.id);
    // …and it is placed right after the class lesson of the same course.
    const v = await prisma.lesson.findUniqueOrThrow({ where: { id: video.lesson.id } });
    expect(q).toMatchObject({ unitId: v.unitId, sortOrder: v.sortOrder + 1 });
  });
});

describe('linking an existing exam', () => {
  it('moves an exam of the same course right after the class lesson — no copy; another course’s exam is refused', async () => {
    if (!guard()) return;
    const S = build();
    const w = await world();
    const video = await publish(S, w);
    const other = await prisma.courseUnit.create({ data: { courseId: w.course.id, title: 'امتحانات', sortOrder: 5 } });
    const exam = await prisma.lesson.create({ data: { unitId: other.id, title: 'امتحان الفصل', type: 'QUIZ', sortOrder: 0 } });
    await prisma.quiz.create({ data: { lessonId: exam.id, questions: { create: [{ prompt: 'س', options: [], sortOrder: 0 }] } } });
    const cand = await S.content.examCandidates(w.scope, w.ls.id);
    expect(cand.exams.map((e) => e.id)).toContain(exam.id);
    const quizzesBefore = await prisma.quiz.count();
    const st = await S.content.linkExam(w.scope, w.ls.id, exam.id);
    const moved = await prisma.lesson.findUniqueOrThrow({ where: { id: exam.id } });
    const v = await prisma.lesson.findUniqueOrThrow({ where: { id: video.lesson.id } });
    expect(moved).toMatchObject({ unitId: v.unitId, sortOrder: v.sortOrder + 1, sourceLiveSessionId: w.ls.id });
    expect(await prisma.quiz.count()).toBe(quizzesBefore);
    expect(st.lessons.find((l) => l.id === exam.id)).toMatchObject({ type: 'QUIZ', questionCount: 1 });
    // An exam from another course is not linked.
    const b = await world();
    const foreign = await prisma.lesson.create({ data: { unitId: b.unit.id, title: 'x', type: 'QUIZ' } });
    await expect(S.content.linkExam(w.scope, w.ls.id, foreign.id)).rejects.toThrow();
  });
});
