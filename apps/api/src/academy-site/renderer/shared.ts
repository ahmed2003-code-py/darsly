import { escapeAttr, escapeHtml, safeUrl } from './html.util';
import { LT, RenderContext } from './types';

/**
 * Small pure helpers shared by every section variant: bilingual spans, the
 * numbered editorial section head, the logo, and card skeletons. Variants
 * compose these so the visual language stays consistent across the registry.
 */

// Short section eyebrow labels, numbered in the editorial layout.
/**
 * Stable anchor for the courses section.
 *
 * Deliberately not derived from a block id: a hero rendering earlier on the page
 * has no way to know the courses block's id, and inventing one gave every CTA a
 * link to an element that did not exist.
 */
export const COURSES_ANCHOR = 'courses';

export const SECTION_LABEL: Record<string, LT> = {
  about: { ar: 'نبذة', en: 'About' },
  toolkit: { ar: 'المنهج', en: 'Toolkit' },
  credentials: { ar: 'السجل', en: 'Track record' },
  courses: { ar: 'الدورات', en: 'Courses' },
  reviews: { ar: 'الآراء', en: 'Reviews' },
  faq: { ar: 'الأسئلة', en: 'FAQ' },
  gallery: { ar: 'المعرض', en: 'Gallery' },
  stats: { ar: 'أرقام', en: 'By the numbers' },
};

/** A bilingual span: renders Arabic, carries English in data-en for the toggle. */
export function i18n(lt: LT): string {
  const ar = escapeAttr(lt?.ar ?? '');
  const en = escapeAttr(lt?.en ?? '');
  return `<span class="i18n" data-ar="${ar}" data-en="${en}">${escapeHtml(lt?.ar ?? '')}</span>`;
}

/** Numbered eyebrow + big heading for an editorial section. */
export function head(type: string, heading: LT): string {
  const label = SECTION_LABEL[type];
  const eyebrow = label ? `<p class="eyebrow">${i18n(label)}</p>` : '';
  return `${eyebrow}<h2>${i18n(heading)}</h2>`;
}

export function logo(id: string | undefined, ctx: RenderContext): string {
  if (!id) return '';
  const m = ctx.media(id);
  const url = safeUrl(m?.url);
  if (!url) return '';
  return `<img class="logo" src="${escapeAttr(url)}" alt="" width="40" height="40">`;
}

export function skeleton(n: number): string {
  return Array.from({ length: n }, () => '<div class="card skeleton"></div>').join('');
}
