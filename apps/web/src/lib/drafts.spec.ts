import { agoLabel, draftKey, isWorthKeeping, resumeHref, DraftSummary } from './drafts';

const summary = (over: Partial<DraftSummary> = {}): DraftSummary => ({
  id: 'd1',
  kind: 'LESSON',
  label: 'الدرس الثالث',
  step: 'settings',
  courseId: 'c1',
  lessonId: 'l1',
  updatedAt: '2026-09-23T10:00:00.000Z',
  ...over,
});

/**
 * The decisions the drafts banner makes, without rendering it.
 *
 * Two of them matter more than the rest: whether a draft is worth offering at
 * all, and where pressing "carry on" goes. The first decides whether a teacher
 * learns to read the banner or to dismiss it; the second is the whole feature.
 */
describe('offering unfinished work back', () => {
  describe('deciding there is something to offer', () => {
    it('ignores a form that was opened and never typed in', () => {
      // An empty draft offered back teaches a teacher that the banner is
      // noise, and the next one — the real one — gets dismissed with it.
      expect(isWorthKeeping({})).toBe(false);
      expect(isWorthKeeping({ description: '', drip: '', dripDate: '' })).toBe(false);
      expect(isWorthKeeping({ notes: '   ' })).toBe(false);
      expect(isWorthKeeping({ isFreePreview: false })).toBe(false);
    });

    it('keeps anything actually written', () => {
      expect(isWorthKeeping({ description: 'المشتقات' })).toBe(true);
      expect(isWorthKeeping({ maxScore: 100 })).toBe(true);
      expect(isWorthKeeping({ isFreePreview: true })).toBe(true);
      expect(isWorthKeeping({ questions: ['a'] })).toBe(true);
    });

    it('looks inside nested state, because forms nest', () => {
      expect(isWorthKeeping({ settings: { drip: 'date' } })).toBe(true);
      expect(isWorthKeeping({ settings: { drip: '' } })).toBe(false);
    });

    it('treats nothing at all as nothing', () => {
      expect(isWorthKeeping(null)).toBe(false);
      expect(isWorthKeeping(undefined)).toBe(false);
      expect(isWorthKeeping('typed')).toBe(false);
    });
  });

  describe('where "carry on" goes', () => {
    it('opens a studio session in the studio, still attached to its course', () => {
      expect(resumeHref(summary({ kind: 'EXAM_STUDIO', id: 'imp1' }))).toBe(
        '/teacher/exam-studio/imp1?course=c1',
      );
    });

    it('opens a studio session that belongs to no course on its own', () => {
      expect(resumeHref(summary({ kind: 'EXAM_STUDIO', id: 'imp1', courseId: null }))).toBe(
        '/teacher/exam-studio/imp1',
      );
    });

    it('opens a lesson draft in the course that holds it', () => {
      expect(resumeHref(summary())).toBe('/teacher/courses/c1');
    });

    it('opens an assignment on its own screen', () => {
      expect(resumeHref(summary({ kind: 'ASSIGNMENT' }))).toBe('/teacher/lessons/l1/assignment');
      expect(resumeHref(summary({ kind: 'QUIZ' }))).toBe('/teacher/lessons/l1/quiz');
    });

    it('falls back to the courses list rather than to a broken link', () => {
      // A draft can outlive what it pointed at — that is the price of not
      // cascading deletes onto somebody's unsaved work. It must not become a
      // link to `/teacher/lessons/null/assignment`.
      expect(resumeHref(summary({ kind: 'ASSIGNMENT', lessonId: null }))).toBe('/teacher/courses');
      expect(resumeHref(summary({ courseId: null }))).toBe('/teacher/courses');
    });
  });

  describe('the key a form knows its draft by', () => {
    it('is one string, built in one place', () => {
      expect(draftKey.lesson('l1')).toBe('lesson:l1');
      expect(draftKey.assignment('l1')).toBe('assignment:l1');
      expect(draftKey.quiz('l1')).toBe('quiz:l1');
      expect(draftKey.course('c1')).toBe('course:c1');
      expect(draftKey.newLesson('c1')).toBe('lesson:new:c1');
    });
  });

  describe('how long ago', () => {
    const now = Date.parse('2026-09-23T12:00:00.000Z');

    it('says minutes, hours and days as a person would', () => {
      expect(agoLabel('2026-09-23T11:58:00.000Z', 'en', now)).toContain('2 minutes ago');
      expect(agoLabel('2026-09-23T09:00:00.000Z', 'en', now)).toContain('3 hours ago');
      expect(agoLabel('2026-09-21T12:00:00.000Z', 'en', now)).toContain('2 days ago');
    });

    it('never says "in 0 seconds" for something just saved', () => {
      expect(agoLabel('2026-09-23T12:00:00.000Z', 'en', now)).not.toContain('in ');
    });

    it('says nothing rather than "Invalid Date"', () => {
      expect(agoLabel('not a date', 'en', now)).toBe('');
    });
  });
});
