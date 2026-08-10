import { deriveAppTheme } from './app-theme';
import { academySlugFromUrl, injectTheme } from './academy-theme.html';

/**
 * Serving the app with the academy's colours already in the document.
 *
 * Two jobs, both narrow: work out which academy a page load is about, and write
 * a theme into the head without ever writing anything else into it. The second
 * is the one that matters — these tokens come out of a database column written
 * by a model, and this is the point where they become live CSS in a visitor's
 * browser.
 */

describe('working out which academy a page load is about', () => {
  it('reads the academy from its own pages', () => {
    expect(academySlugFromUrl('/a/ae0011w')).toBe('ae0011w');
    expect(academySlugFromUrl('/t/ae0011w')).toBe('ae0011w');
    expect(academySlugFromUrl('/t/ae0011w/anything?x=1')).toBe('ae0011w');
  });

  it('reads it out of the redirect an auth page is carrying', () => {
    // The flash a visitor actually sees is on /login, and by then the slug
    // survives nowhere else.
    expect(academySlugFromUrl('/login?redirect=%2Ft%2Fae0011w')).toBe('ae0011w');
    expect(academySlugFromUrl('/register?redirect=%2Fa%2Fae0011w')).toBe('ae0011w');
    expect(academySlugFromUrl('/login?foo=1&redirect=%2Ft%2Fae0011w&bar=2')).toBe('ae0011w');
  });

  it('finds nothing on the pages that are nobody in particular', () => {
    for (const url of ['/', '/discover', '/login', '/courses?page=2', '/assets/index.css']) {
      expect(academySlugFromUrl(url)).toBeNull();
    }
  });

  it('refuses a redirect that points somewhere else entirely', () => {
    expect(academySlugFromUrl('/login?redirect=%2Fdashboard')).toBeNull();
    expect(academySlugFromUrl('/login?redirect=https%3A%2F%2Fevil.example%2Ft%2Fx')).toBeNull();
  });

  it('refuses anything that is not shaped like a slug', () => {
    // It goes straight into a database lookup, and a path segment can hold
    // whatever a visitor types.
    expect(academySlugFromUrl('/t/..%2F..%2Fetc')).toBeNull();
    expect(academySlugFromUrl('/t/' + encodeURIComponent('a b'))).toBeNull();
    expect(academySlugFromUrl('/t/' + 'x'.repeat(200))).toBeNull();
  });
});

describe('writing the theme into the document', () => {
  const shell = '<!doctype html><html dir="rtl" lang="ar"><head><title>Darsly</title></head><body></body></html>';
  const theme = deriveAppTheme({ background: '#14110C', ink: '#F0EADC', primary: '#C9A227' });

  it('puts the tokens in the head, so the first paint is already right', () => {
    const out = injectTheme(shell, theme);
    expect(out).toContain('<style id="academy-theme">:root{--c-');
    expect(out.indexOf('academy-theme')).toBeLessThan(out.indexOf('</head>'));
  });

  it('marks the document with the derived mode', () => {
    expect(injectTheme(shell, theme)).toContain('data-theme="dark"');
  });

  it('leaves an existing mode alone rather than declaring it twice', () => {
    const already = shell.replace('<html', '<html data-theme="light"');
    const out = injectTheme(already, theme);
    expect(out.match(/data-theme=/g)).toHaveLength(1);
  });

  it('keeps the rest of the document intact', () => {
    const out = injectTheme(shell, theme);
    expect(out).toContain('<title>Darsly</title>');
    expect(out).toContain('dir="rtl"');
    expect(out).toContain('<body></body>');
  });

  it('drops any token that is not a name and three numbers', () => {
    // The tokens are stored JSON, so this is where a hostile value would become
    // CSS. Anything unexpected is discarded rather than escaped — no legitimate
    // token needs escaping.
    const out = injectTheme(shell, {
      mode: 'light',
      tokens: {
        '--c-primary': '74 50 201',
        '--c-evil': '0 0 0}</style><script>alert(1)</script><style>',
        'background': 'red',
        '--c-also-evil': 'url(https://evil.example)',
      },
    });
    expect(out).toContain('--c-primary:74 50 201');
    expect(out).not.toContain('script');
    expect(out).not.toContain('evil');
    expect(out).not.toContain('background:red');
  });

  it('changes nothing when no token survives', () => {
    expect(injectTheme(shell, { mode: 'dark', tokens: { bad: 'x' } })).toBe(shell);
  });

  it('still produces a themed document when the shell has no head', () => {
    const out = injectTheme('<html><body>hi</body></html>', theme);
    expect(out).toContain('academy-theme');
  });
});
