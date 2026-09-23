import { BadRequestException } from '@nestjs/common';
import { CoursesService } from '../courses/courses.service';
import { QuizzesService } from '../assessments/quizzes.service';
import { PrismaService } from '../prisma/prisma.service';
import { ExamBuilderService } from './exam-builder.service';
import { DraftQuestion, ExamDraft } from './extraction.schema';

const draftQuestion = (over: Partial<DraftQuestion> = {}): DraftQuestion => ({
  id: 'd1',
  number: 1,
  type: 'MCQ',
  text: 'Which organelle makes ATP?',
  options: [
    { id: 'o1', label: 'A', text: 'Mitochondrion', correct: true },
    { id: 'o2', label: 'B', text: 'Ribosome', correct: false },
  ],
  modelAnswer: '',
  marks: 2,
  sourcePages: [1],
  unsupportedKind: '',
  needsReview: false,
  ...over,
});

const draft = (questions: DraftQuestion[], title = 'Biology — Final'): ExamDraft => ({
  title,
  instructions: ['Answer all questions'],
  sections: [{ title: '', questions }],
});

/**
 * What a confirmed draft turns into.
 *
 * The assertion that matters most is not any single field: it is that this
 * service reaches the exam system only through `CoursesService` and
 * `QuizzesService`. If it ever started writing Quiz rows itself, these mocks
 * would stop being called and the tests would fail — which is the point.
 */
describe('turning a confirmed draft into an ordinary exam', () => {
  const scope = { academyId: 'acad1', authorTenantId: 'teacher1', manageAll: false };

  let courses: { create: jest.Mock; addLessonDirect: jest.Mock; update: jest.Mock };
  let quizzes: { upsertForTeacher: jest.Mock; setQuestions: jest.Mock };
  let builder: ExamBuilderService;

  beforeEach(() => {
    courses = {
      create: jest.fn().mockResolvedValue({ id: 'course1' }),
      addLessonDirect: jest.fn().mockResolvedValue({ id: 'lesson1' }),
      update: jest.fn().mockResolvedValue({ id: 'course1' }),
    };
    quizzes = {
      upsertForTeacher: jest.fn().mockResolvedValue({ id: 'quiz1' }),
      setQuestions: jest.fn().mockResolvedValue({ id: 'quiz1' }),
    };
    builder = new ExamBuilderService(
      {} as PrismaService,
      courses as unknown as CoursesService,
      quizzes as unknown as QuizzesService,
    );
  });

  it('makes a course whose only content is the exam, and names it as the exam', async () => {
    const built = await builder.build(scope, draft([draftQuestion()]), { target: 'NEW_COURSE' });

    expect(courses.create).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ title: 'Biology — Final' }),
      // Marked as an exam course, so its builder shows the exam rather than
      // "add a section, name a lesson, upload a video".
      { kind: 'EXAM' },
    );
    expect(courses.addLessonDirect).toHaveBeenCalledWith(
      scope,
      'course1',
      expect.objectContaining({ type: 'QUIZ' }),
    );
    expect(courses.update).toHaveBeenCalledWith(
      scope,
      'course1',
      expect.objectContaining({ examLessonId: 'lesson1', examMode: 'FINAL' }),
    );
    expect(built).toMatchObject({ courseId: 'course1', lessonId: 'lesson1', questionCount: 1 });
  });

  it('does not touch the kind of a course the teacher already had', async () => {
    // Adding an exam to a twelve-lesson course does not make it an exam course.
    await builder.build(scope, draft([draftQuestion()]), {
      target: 'EXISTING_COURSE',
      courseId: 'existing9',
    });
    expect(courses.create).not.toHaveBeenCalled();
  });

  it('attaches the exam to a course that already exists without renaming its exam', async () => {
    const built = await builder.build(scope, draft([draftQuestion()]), {
      target: 'EXISTING_COURSE',
      courseId: 'existing9',
    });

    expect(courses.create).not.toHaveBeenCalled();
    expect(courses.addLessonDirect).toHaveBeenCalledWith(scope, 'existing9', expect.anything());
    expect(courses.update).not.toHaveBeenCalled();
    expect(built.courseId).toBe('existing9');
  });

  it('can be told to make the attached exam the course gate', async () => {
    await builder.build(scope, draft([draftQuestion()]), {
      target: 'EXISTING_COURSE',
      courseId: 'existing9',
      setAsCourseExam: true,
      examMode: 'GATE' as never,
    });
    expect(courses.update).toHaveBeenCalledWith(
      scope,
      'existing9',
      expect.objectContaining({ examMode: 'GATE' }),
    );
  });

  it('refuses a course id that was not given', async () => {
    await expect(
      builder.build(scope, draft([draftQuestion()]), { target: 'EXISTING_COURSE' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('carries the printed label, the key and the marks onto the quiz question', async () => {
    await builder.build(scope, draft([draftQuestion()]), { target: 'NEW_COURSE' });

    const [, , dto] = quizzes.setQuestions.mock.calls[0];
    const q = dto.questions[0];
    expect(q.type).toBe('MCQ');
    expect(q.options.map((o: { text: string }) => o.text)).toEqual([
      'A) Mitochondrion',
      'B) Ribosome',
    ]);
    expect(q.correctOptionIds).toEqual(['o1']);
    expect(q.points).toBe(2);
  });

  it('asks for every answer when the paper marked more than one', async () => {
    const multi = draftQuestion({
      options: [
        { id: 'o1', label: 'A', text: 'One', correct: true },
        { id: 'o2', label: 'B', text: 'Two', correct: true },
        { id: 'o3', label: 'C', text: 'Three', correct: false },
      ],
    });
    await builder.build(scope, draft([multi]), { target: 'NEW_COURSE' });
    expect(quizzes.setQuestions.mock.calls[0][2].questions[0].maxSelections).toBe(2);
  });

  it('keeps a written question written, with its model answer and no options', async () => {
    const written = draftQuestion({
      type: 'SHORT_ANSWER',
      options: [],
      modelAnswer: 'Light energy becomes chemical energy.',
      marks: null,
    });
    await builder.build(scope, draft([written]), { target: 'NEW_COURSE' });

    const q = quizzes.setQuestions.mock.calls[0][2].questions[0];
    expect(q.type).toBe('SHORT_ANSWER');
    expect(q.options).toEqual([]);
    expect(q.modelAnswer).toBe('Light energy becomes chemical energy.');
    // A question the paper did not price is still worth a mark.
    expect(q.points).toBe(1);
  });

  it('refuses to silently drop a question type this platform cannot store', async () => {
    const odd = draftQuestion({ type: 'UNSUPPORTED', unsupportedKind: 'matching', options: [] });

    await expect(
      builder.build(scope, draft([draftQuestion(), odd]), { target: 'NEW_COURSE' }),
    ).rejects.toMatchObject({ response: { code: 'UNSUPPORTED_QUESTIONS' } });
    expect(quizzes.setQuestions).not.toHaveBeenCalled();
  });

  it('drops it only when the teacher has said so explicitly', async () => {
    const odd = draftQuestion({ type: 'UNSUPPORTED', unsupportedKind: 'matching', options: [] });

    const built = await builder.build(scope, draft([draftQuestion(), odd]), {
      target: 'NEW_COURSE',
      dropUnsupported: true,
    });

    expect(built.questionCount).toBe(1);
    expect(built.droppedUnsupported).toBe(1);
  });

  it('refuses a draft with nothing in it', async () => {
    await expect(builder.build(scope, draft([]), { target: 'NEW_COURSE' })).rejects.toMatchObject({
      response: { code: 'NO_QUESTIONS' },
    });
  });

  it('keeps the section heading with the question it introduces', async () => {
    const sectioned: ExamDraft = {
      title: 'Mixed',
      instructions: [],
      sections: [
        { title: 'القسم الأول', questions: [draftQuestion({ text: 'ما هي عاصمة مصر؟' })] },
        { title: 'Section B', questions: [draftQuestion({ id: 'd2', text: 'Second section Q' })] },
      ],
    };
    await builder.build(scope, sectioned, { target: 'NEW_COURSE' });

    const prompts = quizzes.setQuestions.mock.calls[0][2].questions.map(
      (q: { prompt: string }) => q.prompt,
    );
    expect(prompts[0]).toBe('القسم الأول\nما هي عاصمة مصر؟');
    expect(prompts[1]).toBe('Section B\nSecond section Q');
  });

  it('builds the quiz through the same service the manual builder uses', async () => {
    await builder.build(scope, draft([draftQuestion()]), { target: 'NEW_COURSE' });
    expect(quizzes.upsertForTeacher).toHaveBeenCalledWith('teacher1', 'lesson1', {});
    expect(quizzes.setQuestions).toHaveBeenCalledWith('teacher1', 'lesson1', expect.anything());
  });

  it('carries the time, shuffle and answer settings chosen in the Studio into the exam', async () => {
    await builder.build(
      scope,
      draft([draftQuestion()]),
      { target: 'NEW_COURSE' },
      { timeLimitMin: 45, shuffle: true, showAnswers: false },
    );
    expect(quizzes.upsertForTeacher).toHaveBeenCalledWith('teacher1', 'lesson1', {
      timeLimitSec: 2700,
      shuffleQuestions: true,
      showAnswers: false,
    });
  });

  it('"no time limit" chosen in the Studio stays no limit', async () => {
    await builder.build(
      scope,
      draft([draftQuestion()]),
      { target: 'NEW_COURSE' },
      { timeLimitMin: null, shuffle: false, showAnswers: true },
    );
    expect(quizzes.upsertForTeacher.mock.calls[0][2]).toMatchObject({ timeLimitSec: null });
  });
});
