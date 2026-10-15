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
    expect(out.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')).toBe(original);
  });

  it("sends the session with the page's own course list, and nothing else", () => {
    const html = '<!doctype html><html><head><title>t</title></head><body></body></html>';
    const out = withSignedInCta(html);
    // In the head, so it is in place before the page's own scripts fetch.
    expect(out.indexOf('darsly-session-fetch')).toBeLessThan(out.indexOf('<title>'));
    const script = /<script data-darsly-session-fetch>([\s\S]*?)<\/script>/.exec(out)![1];
    const calls: { url: string; auth: string | null }[] = [];
    const store: Record<string, string> = {
      'darsly-auth': JSON.stringify({ state: { accessToken: 'tok', user: { id: 'u' } } }),
    };
    const win: any = {
      fetch: (u: string, o?: { headers?: Headers }) => {
        calls.push({ url: u, auth: o?.headers?.get('Authorization') ?? null });
        return Promise.resolve();
      },
    };
    new Function('window', 'localStorage', 'Headers', script)(
      win,
      { getItem: (k: string) => store[k] ?? null },
      Headers,
    );
    win.fetch('/api/v1/a/acad/courses?limit=6');
    win.fetch('/api/v1/a/acad/reviews');
    win.fetch('/api/v1/teacher/wallet');
    win.fetch('https://evil.example/api/v1/a/acad/courses');
    expect(calls.map((c) => c.auth)).toEqual(['Bearer tok', 'Bearer tok', null, null]);
  });

  it('adds the session script once, even when served again', () => {
    const html = '<html><head></head><body></body></html>';
    const once = withSignedInCta(html);
    expect(withSignedInCta(once)).toBe(once);
    expect(once.split('darsly-session-fetch').length - 1).toBe(1);
  });
});
