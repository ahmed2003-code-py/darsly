import {
  canAdvance,
  GENERATION_ERROR_CODES,
  generationErrorKey,
  initialPalette,
  rememberPalette,
  retryHelps,
  stepOpen,
} from './studioFlow';

const ar = require('../../../i18n/ar.json');
const en = require('../../../i18n/en.json');

/** sessionStorage, for a Node test. */
function withStorage() {
  const m = new Map<string, string>();
  (globalThis as any).sessionStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
  return m;
}
afterEach(() => {
  delete (globalThis as any).sessionStorage;
});

describe('the Studio wizard: Preview only once a page exists', () => {
  const none = { hasDraft: false, generating: false };
  const made = { hasDraft: true, generating: false };
  const busy = { hasDraft: false, generating: true };

  it('the original bug: a colour picked and Next pressed does not reach an empty Preview', () => {
    // On the Generate step, with only a colour chosen (no generation run).
    expect(canAdvance('generate', none)).toEqual({ ok: false, reason: 'GENERATE_FIRST' });
    // Preview, the editor and Publish cannot be opened at all.
    for (const step of ['preview', 'editor', 'publish'] as const) {
      expect(stepOpen(step, none)).toBe(false);
    }
  });

  it('waits while the page is being made', () => {
    expect(canAdvance('generate', busy)).toEqual({ ok: false, reason: 'GENERATING' });
  });

  it('moves on once the page is made — the successful flow is unchanged', () => {
    expect(canAdvance('generate', made)).toEqual({ ok: true });
    for (const step of ['preview', 'editor', 'publish'] as const) {
      expect(stepOpen(step, made)).toBe(true);
    }
  });

  it('the steps before generating are always open', () => {
    for (const step of ['facts', 'media', 'generate', 'settings'] as const) {
      expect(stepOpen(step, none)).toBe(true);
      expect(canAdvance(step === 'generate' ? 'facts' : step, none)).toEqual({ ok: true });
    }
  });
});

describe('the colour is kept', () => {
  it('across steps (the tab remounts) and reloads, per academy', () => {
    withStorage();
    expect(initialPalette('a1')).toBe('royal');
    rememberPalette('a1', 'forest');
    expect(initialPalette('a1')).toBe('forest');
    // Another academy keeps its own.
    expect(initialPalette('a2')).toBe('royal');
  });

  it("a returning teacher starts from their last generation's colour", () => {
    withStorage();
    expect(initialPalette('a1', 'sunset')).toBe('sunset');
    // This session's pick wins over the last job's.
    rememberPalette('a1', 'sky');
    expect(initialPalette('a1', 'sunset')).toBe('sky');
  });

  it('ignores a colour it does not know, and works without storage', () => {
    expect(initialPalette('a1', 'neon')).toBe('royal');
    expect(initialPalette('a1', 'teal')).toBe('teal');
    expect(() => rememberPalette('a1', 'teal')).not.toThrow();
  });
});

describe('a failed generation is told in words, never the provider text', () => {
  it('every server code has copy in both languages', () => {
    const at = (o: any, key: string) => key.split('.').reduce((x, k) => x?.[k], o);
    for (const code of GENERATION_ERROR_CODES) {
      const key = generationErrorKey(code);
      expect(typeof at(ar, key)).toBe('string');
      expect(typeof at(en, key)).toBe('string');
    }
  });

  it('an unknown code (or none) falls back to the generic sentence', () => {
    expect(generationErrorKey('OpenAI request failed (429): You exceeded your quota')).toBe(
      'studio.generate.failedGeneric',
    );
    expect(generationErrorKey(null)).toBe('studio.generate.failedGeneric');
  });

  it('says when trying again right now will not help', () => {
    expect(retryHelps('AI_PROVIDER_UNAVAILABLE')).toBe(false);
    expect(retryHelps('SITE_FACTS_MISSING')).toBe(false);
    expect(retryHelps('AI_PROVIDER_TIMEOUT')).toBe(true);
    expect(retryHelps(null)).toBe(true);
  });
});
