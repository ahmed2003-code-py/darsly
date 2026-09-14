import { SiteDocument } from '../../schema/site-document';
import { RenderContext } from '../types';
import { renderFixedSite } from './fixed-template';

function doc(): SiteDocument {
  return {
    version: 1,
    theme: { primary: '#4f46e5', accent: '#06b6d4' },
    seo: { title: { ar: 'عنوان الصفحة', en: 'Page title' }, description: { ar: 'وصف', en: 'Description' } },
    blocks: [
      {
        type: 'hero',
        id: 'h1',
        headline: { ar: 'مرحبًا بيكم', en: 'Welcome aboard' },
        subheadline: { ar: 'تعلّم معايا خطوة بخطوة كل يوم', en: 'Learn with me step by step every day' },
        ctaLabel: { ar: 'سجّل الآن', en: 'Sign up now' },
      },
      {
        type: 'about',
        id: 'a1',
        heading: { ar: 'نبذة عني', en: 'About me' },
        body: {
          ar: 'فقرة أولى بالعربي.\n\nفقرة ثانية بالعربي.',
          en: 'First paragraph in English.\n\nSecond paragraph in English.',
        },
      },
      {
        type: 'toolkit',
        id: 't1',
        heading: { ar: 'المهارات', en: 'Skills' },
        items: [{ ar: 'رياضيات', en: 'Math' }, 'Physics'],
      },
      {
        type: 'credentials',
        id: 'c1',
        heading: { ar: 'الإنجازات', en: 'Achievements' },
        items: [{ ar: 'خبرة ١٠ سنين', en: '10 years experience' }],
      },
    ],
  } as SiteDocument;
}

function ctx(): RenderContext {
  return {
    academyName: 'أكاديمية أحمد',
    slug: 'ahmed',
    defaultLang: 'ar',
    media: () => undefined,
  };
}

describe('renderFixedSite — language toggle', () => {
  it('renders without throwing and stays on the Arabic default', () => {
    const html = renderFixedSite(doc(), ctx());
    expect(html).toContain('<html lang="ar" dir="rtl">');
  });

  it('bakes both languages in for authored fields, toggled by <html lang>', () => {
    const html = renderFixedSite(doc(), ctx());
    expect(html).toContain('id="langToggle"');
    expect(html).toContain('class="lang-ar"');
    expect(html).toContain('class="lang-en"');
    expect(html).toContain('مرحبًا بيكم');
    expect(html).toContain('Welcome aboard');
    expect(html).toContain('First paragraph in English.');
    expect(html).toContain('فقرة أولى بالعربي.');
  });

  it('never leaks HTML markup into <title> or meta description', () => {
    const html = renderFixedSite(doc(), ctx());
    const title = html.match(/<title>(.*?)<\/title>/)?.[1];
    expect(title).toBe('عنوان الصفحة');
    expect(title).not.toContain('<span');
    const desc = html.match(/name="description" content="(.*?)"/)?.[1];
    expect(desc).toBe('وصف');
  });

  it('renders a plain legacy string list item the same in both languages', () => {
    const html = renderFixedSite(doc(), ctx());
    // "Physics" (the plain-string toolkit item) should appear once, not
    // duplicated into lang-ar/lang-en spans since it has no translation.
    expect(html.match(/Physics/g)?.length).toBe(2); // doubled for the marquee loop
  });
});
