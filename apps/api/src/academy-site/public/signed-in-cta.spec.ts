import { withSignedInCta } from './signed-in-cta';

const page = (body: string) => `<!doctype html><html lang="ar"><body>${body}</body></html>`;

describe('giving a signed-in visitor a way into the app', () => {
  it('adds the behaviour just before the body closes', () => {
    const out = withSignedInCta(page('<a href="/register?academy=x">ابدأ</a>'));
    expect(out).toContain('darsly-auth');
    expect(out.indexOf('<script>')).toBeLessThan(out.indexOf('</body>'));
  });

  it('adds it to a page with no body tag rather than dropping it', () => {
    expect(withSignedInCta('<h1>hi</h1>')).toContain('darsly-auth');
  });

  it('never adds it twice', () => {
    const once = withSignedInCta(page('<a href="/register">x</a>'));
    const twice = withSignedInCta(once);
    expect(twice).toBe(once);
  });

  it('leaves an empty page alone', () => {
    expect(withSignedInCta('')).toBe('');
  });

  it('keeps the page it was given otherwise byte for byte', () => {
    const original = page('<a href="/register?academy=x">ابدأ</a>');
    const out = withSignedInCta(original);
    expect(out.replace(/<script>[\s\S]*?<\/script>/, '')).toBe(original);
  });
});
