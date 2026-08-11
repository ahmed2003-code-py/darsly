import { slugCandidates, slugify, slugShapeError, SLUG_MAX } from './slug';

describe('slugify', () => {
  it('turns a typed name into an address', () => {
    expect(slugify('Ahmed Elsayed')).toBe('ahmed-elsayed');
    expect(slugify('  Ahmed   Elsayed  ')).toBe('ahmed-elsayed');
    expect(slugify('Ahmed_Elsayed!!')).toBe('ahmed-elsayed');
  });

  it('folds accents rather than dropping the letter', () => {
    expect(slugify('Café Noël')).toBe('cafe-noel');
  });

  it('never leaves a hyphen at either end', () => {
    expect(slugify('--ahmed--')).toBe('ahmed');
    expect(slugify('!!ahmed!!')).toBe('ahmed');
  });

  it('collapses runs of separators into one hyphen', () => {
    expect(slugify('ahmed   ---   elsayed')).toBe('ahmed-elsayed');
  });

  it('caps the length without ending on a hyphen', () => {
    const out = slugify('a'.repeat(30) + ' ' + 'b'.repeat(30));
    expect(out.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(out.endsWith('-')).toBe(false);
  });

  it('returns nothing for a name with no Latin characters', () => {
    // Arabic has no ASCII to fall back on, so the caller must offer a
    // suggestion rather than treat this as a valid address.
    expect(slugify('أحمد السيد')).toBe('');
  });
});

describe('slugShapeError', () => {
  it('accepts a well-formed address', () => {
    expect(slugShapeError('ahmed-elsayed')).toBeNull();
    expect(slugShapeError('a1b2')).toBeNull();
  });

  it('rejects anything shorter than three characters', () => {
    expect(slugShapeError('ab')).toBe('INVALID');
    expect(slugShapeError('')).toBe('INVALID');
  });

  it('rejects characters that cannot appear in a URL path', () => {
    expect(slugShapeError('Ahmed Elsayed')).toBe('INVALID');
    expect(slugShapeError('ahmed_elsayed')).toBe('INVALID');
    expect(slugShapeError('ahmed--elsayed')).toBe('INVALID');
    expect(slugShapeError('-ahmed')).toBe('INVALID');
  });

  it('rejects words the platform needs for its own routes', () => {
    expect(slugShapeError('admin')).toBe('RESERVED');
    expect(slugShapeError('login')).toBe('RESERVED');
    expect(slugShapeError('darsly')).toBe('RESERVED');
  });
});

describe('slugCandidates', () => {
  it('offers alternatives built on what was asked for', () => {
    const out = slugCandidates('ahmed', 5);
    expect(out[0]).toBe('ahmed-academy');
    expect(out).toContain('ahmed2');
    expect(out).toHaveLength(5);
  });

  it('only ever offers addresses that would themselves be accepted', () => {
    for (const c of slugCandidates('ahmed-elsayed', 12)) {
      expect(slugShapeError(c)).toBeNull();
    }
  });

  it('pads a base too short to stand on its own', () => {
    for (const c of slugCandidates('ab', 6)) {
      expect(slugShapeError(c)).toBeNull();
    }
  });

  it('never repeats a word the base already ends with', () => {
    // Padding a short base with "-academy" and then suffixing it again used to
    // offer `ab-academy-academy`.
    expect(slugCandidates('ab', 6)).not.toContain('ab-academy-academy');
    expect(slugCandidates('noura-academy', 6)).not.toContain('noura-academy-academy');
  });

  it('offers no duplicates', () => {
    const out = slugCandidates('ahmed', 12);
    expect(new Set(out).size).toBe(out.length);
  });

  it('keeps every suggestion within the length cap', () => {
    for (const c of slugCandidates('x'.repeat(SLUG_MAX), 6)) {
      expect(c.length).toBeLessThanOrEqual(SLUG_MAX);
      expect(slugShapeError(c)).toBeNull();
    }
  });
});
