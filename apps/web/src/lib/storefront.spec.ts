import { courseYearsLabel, storefrontView, studentLookSuspended } from './storefront';

describe('/a/:slug', () => {
  it('a published academy shows its site; the student look stands down for it only', () => {
    expect(storefrontView({ published: true, signedIn: true })).toBe('SITE');
    expect(storefrontView({ published: true, signedIn: false })).toBe('SITE');
    expect(studentLookSuspended('SITE')).toBe(true);
  });

  it('an unpublished academy is the current app for a signed-in person — their look kept', () => {
    expect(storefrontView({ published: false, signedIn: true })).toBe('APP');
    expect(studentLookSuspended('APP')).toBe(false);
  });

  it('an unpublished academy is the current public page for a visitor', () => {
    expect(storefrontView({ published: false, signedIn: false })).toBe('PUBLIC');
    expect(studentLookSuspended('PUBLIC')).toBe(false);
    // Not decided yet (still loading): nothing is suspended.
    expect(studentLookSuspended(null)).toBe(false);
  });

  it("a course card names the course's years from grades[], in the reader's language", () => {
    const grades = [
      { nameAr: 'أولى بكالوريا', nameEn: 'Baccalaureate 1' },
      { nameAr: 'تانية بكالوريا', nameEn: 'Baccalaureate 2' },
    ];
    expect(courseYearsLabel(grades, 'ar')).toBe('أولى بكالوريا، تانية بكالوريا');
    expect(courseYearsLabel(grades, 'en')).toBe('Baccalaureate 1, Baccalaureate 2');
    expect(courseYearsLabel([], 'ar')).toBe('');
    expect(courseYearsLabel(undefined, 'en')).toBe('');
  });
});
