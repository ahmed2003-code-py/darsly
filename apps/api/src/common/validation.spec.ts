import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RegisterStudentDto, normalizeEgyptianPhone } from '../auth/dto/auth.dto';
import { CreateCourseDto, PaginationDto, ReorderDto } from '../courses/dto/course.dto';
import { SetQuizQuestionsDto, SubmitAttemptDto } from '../assessments/dto/quiz.dto';
import { LIMITS } from './validation';

/** The set of property names that failed validation, for terse assertions. */
function failures<T extends object>(cls: new () => T, payload: Record<string, unknown>): string[] {
  const instance = plainToInstance(cls, payload);
  return validateSync(instance as object, { whitelist: true }).map((e) => e.property);
}

describe('student registration', () => {
  const valid = {
    email: 'ahmed@example.com',
    fullName: 'أحمد محمود',
    password: 'Passw0rd1',
    phone: '01012345678',
  };

  it('accepts a complete signup', () => {
    expect(failures(RegisterStudentDto, valid)).toEqual([]);
  });

  it('rejects a signup with no phone — the number is now mandatory', () => {
    const { phone: _omitted, ...withoutPhone } = valid;
    expect(failures(RegisterStudentDto, withoutPhone)).toContain('phone');
  });

  // 010/011/012/015 are the live Egyptian prefixes; 013/014 are not.
  it.each(['0123456789', '+201312345678', '01412345678', 'not-a-number'])(
    'rejects %s as a non-Egyptian mobile number',
    (phone) => {
      expect(failures(RegisterStudentDto, { ...valid, phone })).toContain('phone');
    },
  );

  it.each(['01012345678', '+201012345678', '00201112345678', '201212345678'])(
    'accepts %s and normalizes it to E.164',
    (phone) => {
      expect(failures(RegisterStudentDto, { ...valid, phone })).toEqual([]);
      expect(normalizeEgyptianPhone(phone)).toMatch(/^\+201[0125][0-9]{8}$/);
    },
  );

  it('rejects a password with no digit', () => {
    expect(failures(RegisterStudentDto, { ...valid, password: 'passwordonly' })).toContain('password');
  });

  it('reports a bad phone as a 400, not an unhandled error', () => {
    expect(() => normalizeEgyptianPhone('12345')).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});

describe('length and size caps', () => {
  it('rejects a course title longer than the cap', () => {
    const payload = { title: 'x'.repeat(LIMITS.TITLE + 1) };
    expect(failures(CreateCourseDto, payload)).toContain('title');
  });

  it('rejects a course description longer than the cap', () => {
    const payload = { title: 'A valid title', description: 'x'.repeat(LIMITS.PROSE + 1) };
    expect(failures(CreateCourseDto, payload)).toContain('description');
  });

  it('rejects an id-shaped field carrying an essay', () => {
    const payload = { title: 'A valid title', subjectId: 'x'.repeat(LIMITS.ID + 1) };
    expect(failures(CreateCourseDto, payload)).toContain('subjectId');
  });

  it('rejects a reorder request with an unbounded id list', () => {
    const ids = Array.from({ length: LIMITS.ARRAY + 1 }, (_, i) => `id-${i}`);
    expect(failures(ReorderDto, { ids })).toContain('ids');
  });

  it('accepts a reorder request at the limit', () => {
    const ids = Array.from({ length: LIMITS.ARRAY }, (_, i) => `id-${i}`);
    expect(failures(ReorderDto, { ids })).toEqual([]);
  });

  it('caps page size so one request cannot ask for the whole table', () => {
    expect(failures(PaginationDto, { page: 1, pageSize: 100_000 })).toContain('pageSize');
    expect(failures(PaginationDto, { page: 1, pageSize: 50 })).toEqual([]);
  });

  it('rejects a quiz with more questions than the ceiling', () => {
    const questions = Array.from({ length: 201 }, () => ({ prompt: 'Q' }));
    expect(failures(SetQuizQuestionsDto, { questions })).toContain('questions');
  });

  it('rejects an unknown question type that the enum does not name', () => {
    const questions = [{ prompt: 'Q', type: 'TELEPATHY' }];
    expect(failures(SetQuizQuestionsDto, { questions })).toContain('questions');
  });
});

describe('bounded record', () => {
  it('accepts a normal answer map', () => {
    expect(failures(SubmitAttemptDto, { answers: { q1: 'a', q2: 'b' } })).toEqual([]);
  });

  it('rejects a map with more keys than the question ceiling', () => {
    const answers = Object.fromEntries(
      Array.from({ length: 201 }, (_, i) => [`q${i}`, 'a']),
    );
    expect(failures(SubmitAttemptDto, { answers })).toContain('answers');
  });

  it('rejects a key long enough to be a payload of its own', () => {
    const answers = { ['q'.repeat(LIMITS.ID + 1)]: 'a' };
    expect(failures(SubmitAttemptDto, { answers })).toContain('answers');
  });

  it('rejects an answer value past the prose cap', () => {
    expect(failures(SubmitAttemptDto, { answers: { q1: 'x'.repeat(LIMITS.PROSE + 1) } })).toContain(
      'answers',
    );
  });

  it('rejects an array or a null in place of a map', () => {
    expect(failures(SubmitAttemptDto, { answers: ['a', 'b'] })).toContain('answers');
    expect(failures(SubmitAttemptDto, { answers: null })).toContain('answers');
  });
});
