import { phoneDigits, telUrl, WHATSAPP_TEMPLATE, whatsappUrl } from './followUp';

describe('follow-up contact handoffs', () => {
  it('tel: and wa.me carry the number as digits and nothing else', () => {
    expect(phoneDigits('+20 100 123 4567')).toBe('201001234567');
    expect(telUrl('+201001234567')).toBe('tel:+201001234567');
    expect(phoneDigits('12')).toBeNull();
    expect(telUrl('abc')).toBeNull();
    expect(whatsappUrl('', 'ar')).toBeNull();
  });

  it('the WhatsApp opening is privacy-safe: the fixed template only, in the reader’s language', () => {
    const ar = whatsappUrl('+201001234567', 'ar')!;
    const en = whatsappUrl('+201001234567', 'en')!;
    expect(ar.startsWith('https://wa.me/201001234567?text=')).toBe(true);
    expect(decodeURIComponent(ar.split('text=')[1])).toBe(WHATSAPP_TEMPLATE.ar);
    expect(decodeURIComponent(en.split('text=')[1])).toBe(WHATSAPP_TEMPLATE.en);
    for (const t of Object.values(WHATSAPP_TEMPLATE)) {
      expect(t).not.toMatch(/\d/); // no amount, no date, no count
      expect(t).not.toMatch(/ج\.م|EGP|غياب|غاب|absent|late|متأخر|grade|درجة/i);
    }
  });
});
