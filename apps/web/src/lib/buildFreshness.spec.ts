import { entryScriptOf, isStale, runningEntry } from './buildFreshness';

const page = (entry: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script>` +
  `<meta charset="UTF-8"></head><body><div id="root"></div></body></html>`;

describe('build freshness', () => {
  it('reads the hashed entry script an index.html loads', () => {
    expect(entryScriptOf(page('/assets/index-RPf2cp4e.js'))).toBe('/assets/index-RPf2cp4e.js');
    expect(entryScriptOf('<html><body>maintenance</body></html>')).toBeNull();
  });

  it('knows which entry script this tab runs', () => {
    const doc = (src: string | null) =>
      ({
        baseURI: 'https://example.test/admin/academies/x',
        querySelector: () => (src ? { src: 'https://example.test' + src } : null),
      }) as unknown as Document;
    expect(runningEntry(doc('/assets/index-OLD1.js'))).toBe('/assets/index-OLD1.js');
    expect(runningEntry(doc(null))).toBeNull();
  });

  it('a tab opened before a deploy is stale; an unknown side never is', () => {
    expect(isStale('/assets/index-OLD1.js', '/assets/index-NEW2.js')).toBe(true);
    expect(isStale('/assets/index-NEW2.js', '/assets/index-NEW2.js')).toBe(false);
    expect(isStale(null, '/assets/index-NEW2.js')).toBe(false);
    expect(isStale('/assets/index-OLD1.js', null)).toBe(false);
  });
});
