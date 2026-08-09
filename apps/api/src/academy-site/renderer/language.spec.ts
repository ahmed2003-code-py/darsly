import { DesignRulesService } from '../pipeline/design-rules.service';
import { QualityGateService } from '../pipeline/quality-gate.service';
import { SiteBrainService } from '../pipeline/site-brain.service';
import { SiteBlock } from '../schema/site-document';
import { PROFILE, WARM_DESIGN, buildComposition } from '../__fixtures__/composition.fixture';
import { buildFixtureDoc, fixtureContext } from '../__fixtures__/site-doc.fixture';
import { composeSite } from './compose/compile';
import { compileSite } from './site-compiler';
import './compose/patterns';

/**
 * A field written in only one language used to erase itself.
 *
 * `applyLang` set every bilingual span's text to `dataset[lang]`, and an empty
 * string is a perfectly valid value to assign — so the moment a visitor was on
 * the language the writer had skipped, the words vanished. The layout stayed:
 * a credentials list rendered as seven numbered rules with nothing beside them,
 * on a page whose HTML contained every word.
 *
 * The page now shows the language it has. These tests run the real emitted
 * script against a real DOM, because every string assertion in this file would
 * have passed while the page was blank.
 */

const brain = new SiteBrainService(new DesignRulesService());
const script = (html: string) => html.match(/<script>([\s\S]*?)<\/script>/)![1];

/**
 * Run the page's own `applyLang` over a set of spans and report what a visitor
 * would actually read.
 */
function readAs(html: string, lang: 'ar' | 'en'): string[] {
  const src = script(html);
  // The two renderers named this function differently; the behaviour under test
  // is the same in both.
  const m = src.match(/function (apply(?:Lang)?)\(l\)\{/)!;
  const fn = m[1];
  const start = src.indexOf(m[0]);
  // Brace-matched rather than sliced to the next line starting with `}`: the two
  // renderers indent this function differently.
  let depth = 0;
  let end = start;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  const body = src.slice(start, end);

  const spans = [...html.matchAll(/<span class="i18n" data-ar="([^"]*)" data-en="([^"]*)"/g)].map(
    ([, ar, en]) => ({ dataset: { ar, en }, textContent: ar }),
  );
  const doc = {
    documentElement: { lang: '', dir: '' },
    querySelectorAll: (sel: string) => (sel === '.i18n' ? spans : []),
    getElementById: () => null,
  };
  new Function('document', 'localStorage', `${body}\n${fn}(${JSON.stringify(lang)});`)(doc, {
    setItem() {},
  });
  return spans.map((s) => s.textContent);
}

/** A page whose credentials were written in Arabic only. */
function halfWritten() {
  const doc = buildComposition({ design: WARM_DESIGN });
  const creds = doc.blocks.find((b) => b.type === 'credentials')!;
  if (creds.type === 'credentials') {
    creds.items = [
      { ar: 'ثماني سنوات في التدريس', en: '' },
      { ar: 'مؤلف مذكرات مراجعة', en: '' },
      { ar: 'درّبت أكثر من ٤٠٠ طالب', en: '' },
    ];
  }
  return doc;
}

describe('a field written in one language shows that language', () => {
  const html = composeSite(brain.compose(halfWritten(), PROFILE), fixtureContext());

  it('does not blank the text for a visitor on the other language', () => {
    const read = readAs(html, 'en');
    expect(read).toContain('ثماني سنوات في التدريس');
    expect(read.filter((t) => t === '')).toHaveLength(0);
  });

  it('still prefers the visitor\'s language wherever it exists', () => {
    const read = readAs(html, 'en');
    expect(read.some((t) => /[A-Za-z]/.test(t))).toBe(true);
  });

  it('works in the other direction too', () => {
    const doc = buildComposition({ design: WARM_DESIGN });
    const about = doc.blocks.find((b) => b.type === 'about')!;
    if (about.type === 'about') about.heading = { ar: '', en: 'About me' };
    const read = readAs(composeSite(brain.compose(doc, PROFILE), fixtureContext()), 'ar');
    expect(read).toContain('About me');
    expect(read.filter((t) => t === '')).toHaveLength(0);
  });

  it('holds on the legacy renderer as well', () => {
    // Every page published before the composition engine runs through that one,
    // and the bug was identical there.
    const doc = buildFixtureDoc({ dna: 'warm_mentor', persona: 'programming' });
    const creds = doc.blocks.find((b) => b.type === 'credentials')!;
    if (creds.type === 'credentials') creds.items = [{ ar: 'ثماني سنوات', en: '' }];
    const read = readAs(compileSite(brain.plan(doc), fixtureContext()), 'en');
    expect(read).toContain('ثماني سنوات');
    expect(read.filter((t) => t === '')).toHaveLength(0);
  });
});

describe('the teacher is told which half is missing', () => {
  const gate = new QualityGateService(new DesignRulesService());

  it('warns, and names the fields', () => {
    const { errors, warnings } = gate.evaluate(halfWritten());
    const warn = warnings.find((w) => w.code === 'single-language');
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('credentials');
    // A half-written page is still a publishable page.
    expect(errors.map((e) => e.code)).not.toContain('single-language');
  });

  it('stays quiet when both languages are there', () => {
    const codes = gate.evaluate(buildComposition({ design: WARM_DESIGN })).warnings.map((w) => w.code);
    expect(codes).not.toContain('single-language');
  });

  it('looks inside every kind of section, not just headings', () => {
    const doc = buildComposition({ design: WARM_DESIGN });
    const hit = (type: SiteBlock['type'], mutate: (b: never) => void) => {
      const b = doc.blocks.find((x) => x.type === type);
      if (b) mutate(b as never);
    };
    hit('faq', (b: SiteBlock) => {
      if (b.type === 'faq') b.items[0].a = { ar: 'إجابة', en: '' };
    });
    hit('timeline', (b: SiteBlock) => {
      if (b.type === 'timeline') b.items[0].title = { ar: '', en: 'Started' };
    });
    hit('process', (b: SiteBlock) => {
      if (b.type === 'process') b.steps[0].body = { ar: 'شرح', en: '' };
    });
    const warn = gate.evaluate(doc).warnings.find((w) => w.code === 'single-language')!;
    expect(warn.message).toMatch(/answer/);
    expect(warn.message).toMatch(/timeline|step/);
  });
});
