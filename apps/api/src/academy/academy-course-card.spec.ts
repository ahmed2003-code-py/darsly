import { AcademyService } from './academy.service';

/**
 * The academy course card.
 *
 * `courseCardSelect()` asked Prisma for a field called `grade` on Course. There
 * is no such field — a course is offered to a *list* of years through the
 * CourseGrade join — so Prisma rejected the query before it ran, and every
 * caller of that select threw.
 *
 * Two endpoints use it, and both were returning 500:
 *
 *   GET /api/v1/academies/:slug/courses          the PUBLIC storefront listing
 *   GET /api/v1/academies/:slug/manage/courses   the teacher's console
 *
 * The public one is the page that sells courses. Nothing in 1064 passing tests
 * touched either, because nothing exercised this service against a real
 * database — Prisma only rejects an unknown field when the query is actually
 * issued. It took a runtime sweep of every route to find it.
 *
 * These tests assert the two things that were wrong: that the select names a
 * field the schema has, and that a card reports its years in a shape a caller
 * can read.
 */
describe('the course card select', () => {
  /** Reach the private members the way the defect was shaped, not around them. */
  const svc = new AcademyService({} as any) as any;

  it('asks for `grades`, the relation that exists, and never `grade`', () => {
    const select = svc.courseCardSelect();
    expect(select).toHaveProperty('grades');
    // The regression itself: a singular `grade` here is rejected by Prisma at
    // query time, which is a 500 rather than a failing build.
    expect(select).not.toHaveProperty('grade');
  });

  it('reaches through the join row for the year itself', () => {
    // CourseGrade is a join: the year hangs off `.grade`, and selecting the
    // join row without it would return rows with nothing readable in them.
    expect(select_grade_shape(svc)).toEqual({ nameAr: true, nameEn: true });
  });

  it('flattens the join away so a card exposes plain years', () => {
    const card = svc.mapCard({
      id: 'c1', title: 'A course',
      grades: [
        { grade: { nameAr: 'الصف الأول', nameEn: 'Grade 1' } },
        { grade: { nameAr: 'الصف الثاني', nameEn: 'Grade 2' } },
      ],
      units: [{ _count: { lessons: 3 } }, { _count: { lessons: 2 } }],
      teacher: { user: { fullName: 'خالد' } },
    });
    expect(card.grades).toEqual([
      { nameAr: 'الصف الأول', nameEn: 'Grade 1' },
      { nameAr: 'الصف الثاني', nameEn: 'Grade 2' },
    ]);
    expect(card.lessonsCount).toBe(5);
    expect(card.teacherName).toBe('خالد');
  });

  it('survives a course with no years and no teacher', () => {
    // A course that was never narrowed to a year is normal — see the schema's
    // own note that an empty list means "every year", not "no year".
    const card = svc.mapCard({ id: 'c2', title: 'B', grades: [], units: [], teacher: null });
    expect(card.grades).toEqual([]);
    expect(card.lessonsCount).toBe(0);
    expect(card.teacherName).toBeNull();
  });

  it('survives the fields being absent entirely', () => {
    const card = svc.mapCard({ id: 'c3', title: 'C' });
    expect(card.grades).toEqual([]);
    expect(card.lessonsCount).toBe(0);
  });
});

function select_grade_shape(svc: any) {
  return svc.courseCardSelect().grades.select.grade.select;
}
