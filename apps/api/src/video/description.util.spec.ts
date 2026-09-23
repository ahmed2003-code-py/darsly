import { cleanYoutubeDescription, looksUsableDescription } from './description.util';

/**
 * The sample is the shape the real ones take: two sentences that belong to the
 * video, then a channel's whole footer.
 */
describe('cleanYoutubeDescription', () => {
  const REAL = `شرح مبسط لدرس الأبنية والصرف للصف الثالث الثانوي.
الدرس بيغطي المصادر والمشتقات بالتفصيل مع أمثلة محلولة.

https://www.noqta.tv
🔗 Instagram
/ omr94
🔗 Snapchat
/ omr94
🔗 TikTok
/ omr94
🔗 X
/ omr94_
🔗 Facebook
/ omrf94

📱 Business Advertising
contact@atnafas.me
WhatsApp https://wa.link/itc0n4

🎬 Production
Atnafas Creative Production
/ atnafas.creative

🧑 Producer
Adel Hassan
Zaid Mohamed

#شرح #ثانوية_عامة #عربي`;

  it('keeps what the video is about', () => {
    const out = cleanYoutubeDescription(REAL);
    expect(out).toContain('شرح مبسط لدرس الأبنية والصرف');
    expect(out).toContain('المصادر والمشتقات');
  });

  it('drops the links, the handles, the credits and the hashtags', () => {
    const out = cleanYoutubeDescription(REAL);
    for (const junk of [
      'noqta.tv',
      'Instagram',
      'omr94',
      'Snapchat',
      'TikTok',
      'Facebook',
      'contact@atnafas.me',
      'wa.link',
      'Production',
      'Producer',
      'Adel Hassan',
      '#شرح',
      'Business',
    ]) {
      expect(out).not.toContain(junk);
    }
  });

  it('is short enough to read', () => {
    expect(cleanYoutubeDescription(REAL).split('\n').length).toBeLessThanOrEqual(4);
  });

  /** Dropping a real sentence is the more expensive mistake, so a line that
   *  merely mentions a link survives if it is saying something. */
  it('keeps a sentence that happens to contain a link', () => {
    const s = 'راجع المنهج كامل على موقع الوزارة https://moe.gov.eg قبل الامتحان بأسبوع';
    expect(cleanYoutubeDescription(s)).toContain('راجع المنهج');
  });

  it('stops at a credits heading and does not resume', () => {
    const out = cleanYoutubeDescription('الدرس الأول.\n\nفريق العمل\nأحمد\nمحمد\n\nملاحظة مهمة');
    expect(out).toContain('الدرس الأول');
    expect(out).not.toContain('أحمد');
    expect(out).not.toContain('ملاحظة مهمة');
  });

  it('survives an empty or all-noise description', () => {
    expect(cleanYoutubeDescription('')).toBe('');
    expect(cleanYoutubeDescription('#a #b\n🔗\n/ handle')).toBe('');
  });
});

describe('is what survived worth showing', () => {
  const ok =
    'في الدرس ده هنشرح قانون نيوتن التاني، ونحل كام مسألة على الكتلة والتسارع خطوة بخطوة عشان تبقى جاهز للامتحان.';

  it('accepts a real paragraph', () => {
    expect(looksUsableDescription(ok)).toBe(true);
  });

  it('refuses the debris a fully-noisy description leaves behind', () => {
    expect(looksUsableDescription('')).toBe(false);
    expect(looksUsableDescription('عادل حسن')).toBe(false);
    expect(looksUsableDescription('- - -\nأحمد\nمحمد')).toBe(false);
  });

  it('refuses a column of handles that each survived on their own', () => {
    expect(looksUsableDescription('محمد علي\nأحمد سيد\nمنة الله\nعمرو خالد')).toBe(false);
  });

  it('refuses text that is mostly decoration', () => {
    expect(looksUsableDescription('🔥🔥🔥 2026 🔥🔥🔥 ⭐⭐⭐ !!!! ⭐⭐⭐ 🎬🎬 ##')).toBe(false);
  });
});
