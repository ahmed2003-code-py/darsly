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

/** Stable anchor for the contact section, for the same reason as the above. */
export const CONTACT_ANCHOR = 'contact';

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

/**
 * Split a headline so its closing words can carry the brand gradient.
 *
 * A headline set in one flat colour is the single thing that most makes a page
 * read as a document rather than as a designed page — every portfolio worth
 * copying accents part of its opening line. Splitting on words rather than
 * characters keeps the break meaningful in both scripts.
 *
 * Returns `[lead, accent]`, with an empty accent when the line is too short to
 * survive the split (two words with one of them recoloured looks like a mistake).
 */
function accentTail(text: string): [string, string] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 3) return [text.trim(), ''];
  const n = words.length >= 7 ? 2 : 1;
  return [words.slice(0, -n).join(' '), words.slice(-n).join(' ')];
}

/**
 * A headline whose final word or two are gradient-filled.
 *
 * The two languages are split independently — Arabic and English rarely put the
 * emphatic word in the same place — but the split is only applied when *both*
 * lines can take it, so toggling language can never leave a stray empty span
 * where the accent used to be.
 */
export function headline(lt: LT): string {
  const ar = lt?.ar ?? '';
  const en = lt?.en ?? '';
  const [arLead, arTail] = accentTail(ar);
  const [enLead, enTail] = accentTail(en);
  // en may legitimately be absent; only a *present* en that resists the split
  // should veto it.
  if (!arTail || (en.trim() && !enTail)) return i18n(lt);
  return `${i18n({ ar: arLead, en: enLead })} <span class="grad">${i18n({ ar: arTail, en: enTail })}</span>`;
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
