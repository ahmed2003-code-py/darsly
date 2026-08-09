import { ImageTreatment } from '../../schema/design-spec';
import { ListItem } from '../../text.util';
import { escapeAttr, escapeHtml, safeUrl } from '../html.util';
import { LT } from '../types';
import { ComposeContext } from './types';
import { ResolvedSection } from './registry';

/**
 * The shared vocabulary every pattern builds from.
 *
 * Two things matter here and nowhere else: all human text goes through `i18n`,
 * which escapes it into both a text node and two data attributes; and no pattern
 * ever constructs a URL. Together those are the entire reason a model can be
 * given this much creative freedom safely.
 */

/** A bilingual span: shows Arabic, carries English for the toggle. */
export function i18n(lt: LT | undefined): string {
  const ar = lt?.ar ?? '';
  const en = lt?.en ?? '';
  return `<span class="i18n" data-ar="${escapeAttr(ar)}" data-en="${escapeAttr(en)}">${escapeHtml(ar)}</span>`;
}

export function itemText(it: ListItem): string {
  return typeof it === 'string' ? escapeHtml(it) : i18n(it);
}

const hasText = (lt: LT | undefined) => !!(lt && (lt.ar?.trim() || lt.en?.trim()));

/**
 * Split a headline so its closing words carry the brand gradient.
 *
 * Both languages are split independently — the emphatic word rarely lands in the
 * same place — but only when *both* can take it, so toggling language can never
 * leave a stray empty span where the accent used to be.
 */
function accentTail(text: string): [string, string] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 3) return [text.trim(), ''];
  const n = words.length >= 7 ? 2 : 1;
  return [words.slice(0, -n).join(' '), words.slice(-n).join(' ')];
}

export function headline(lt: LT): string {
  const ar = lt?.ar ?? '';
  const en = lt?.en ?? '';
  const [arLead, arTail] = accentTail(ar);
  const [enLead, enTail] = accentTail(en);
  if (!arTail || (en.trim() && !enTail)) return i18n(lt);
  return `${i18n({ ar: arLead, en: enLead })} <span class="grad">${i18n({ ar: arTail, en: enTail })}</span>`;
}

export const SECTION_LABEL: Record<string, LT> = {
  about: { ar: 'نبذة', en: 'About' },
  toolkit: { ar: 'المنهج', en: 'Toolkit' },
  credentials: { ar: 'السجل', en: 'Track record' },
  courses: { ar: 'الدورات', en: 'Courses' },
  reviews: { ar: 'الآراء', en: 'Reviews' },
  faq: { ar: 'الأسئلة', en: 'FAQ' },
  gallery: { ar: 'المعرض', en: 'Gallery' },
  stats: { ar: 'أرقام', en: 'By the numbers' },
  timeline: { ar: 'المسيرة', en: 'Journey' },
  process: { ar: 'الطريقة', en: 'How it works' },
  quote: { ar: 'اقتباس', en: 'Quote' },
  contact: { ar: 'تواصل', en: 'Contact' },
};

/** Eyebrow + heading, the standard opening of a section. */
export function sectionHead(type: string, heading: LT | undefined, opts: { eyebrow?: boolean } = {}): string {
  const label = opts.eyebrow === false ? undefined : SECTION_LABEL[type];
  const eyebrow = label ? `<p class="eyebrow">${i18n(label)}</p>` : '';
  const h = hasText(heading) ? `<h2>${i18n(heading!)}</h2>` : '';
  return `${eyebrow}${h}`;
}

/** The opening and closing tags of a section, carrying its composition. */
export function sectionOpen(
  type: string,
  spec: ResolvedSection,
  ctx: ComposeContext,
  opts: { id?: string; extraClass?: string; hydrate?: string; limit?: number } = {},
): string {
  const style = [`--i:${Math.max(0, Math.min(99, spec.index))}`];
  if (spec.width && spec.width !== ctx.design.rhythm.containerWidth) {
    const w = WIDTH_VALUE[spec.width];
    if (w) style.push(`--w:${w}`);
  }
  if (spec.columns) style.push(`--cols:${Math.max(1, Math.min(4, spec.columns))}`);

  const attrs = [
    `class="${['block', type, spec.align === 'center' ? 'center' : '', opts.extraClass ?? ''].filter(Boolean).join(' ')}"`,
    opts.id ? `id="${escapeAttr(opts.id)}"` : '',
    `data-emph="${escapeAttr(spec.emphasis)}"`,
    `data-surface="${escapeAttr(spec.surface)}"`,
    `data-width="${escapeAttr(spec.width)}"`,
    spec.accents.length ? `data-accent="${escapeAttr(spec.accents.join(' '))}"` : '',
    opts.hydrate ? `data-hydrate="${escapeAttr(opts.hydrate)}" data-limit="${Number(opts.limit) || 6}"` : '',
    `style="${style.join(';')}"`,
  ].filter(Boolean).join(' ');
  return `<section ${attrs}><div class="wrap">`;
}

export const SECTION_CLOSE = '</div></section>';

const WIDTH_VALUE: Record<string, string> = {
  narrow: '860px', standard: '1120px', wide: '1340px', full: '100%',
};

/** An image, with the treatment the composition asked for. Never a raw URL. */
export function image(
  mediaId: string | undefined,
  ctx: ComposeContext,
  opts: { ratio?: string; treatment?: ImageTreatment; eager?: boolean; className?: string } = {},
): string {
  if (!mediaId) return '';
  const m = ctx.media(mediaId);
  const url = safeUrl(m?.url);
  if (!url) return '';
  const t = opts.treatment ?? ctx.design.decoration.imageTreatment;
  const ratio = opts.ratio ? ` data-ratio="${escapeAttr(opts.ratio)}"` : '';
  const img = `<img class="img ${opts.className ?? ''}" data-t="${escapeAttr(t)}"${ratio} src="${escapeAttr(url)}" alt="" ${opts.eager ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"'}>`;
  // Treatments that need a wrapper to paint over the image get one; the rest are
  // a single element, so a plain page stays a plain page.
  const WRAPPED = new Set(['duotone', 'tilt', 'grid-overlay']);
  if (!WRAPPED.has(t)) return img;
  ctx.useDecor(`img:${t}`);
  if (t === 'tilt') ctx.useEffect('tilt');
  return `<div class="img-wrap" data-t="${escapeAttr(t)}">${img}</div>`;
}

/** Does this block have a usable image? Patterns declare `needs.media` on it. */
export function hasImage(mediaId: string | undefined, ctx: ComposeContext): boolean {
  return !!mediaId && !!safeUrl(ctx.media(mediaId)?.url);
}

/**
 * The page's calls to action.
 *
 * The primary one goes where the compiler decided. The secondary is an in-page
 * scroll to contact, because a visitor who is interested but not ready to enrol
 * otherwise has nothing on the first screen to click.
 */
export function actions(ctx: ComposeContext, label: LT, opts: { secondary?: boolean } = {}): string {
  const second = opts.secondary === false
    ? ''
    : `<a class="btn btn-ghost" href="#${CONTACT_ANCHOR}">${i18n({ ar: 'تواصل معي', en: 'Get in touch' })}</a>`;
  return `<div class="actions">
    <a class="btn" data-cta target="_top" href="${escapeAttr(ctx.ctaHref)}">${i18n(label)}<span class="btn-arrow" aria-hidden="true">→</span></a>
    ${second}</div>`;
}

export const COURSES_ANCHOR = 'courses';
export const CONTACT_ANCHOR = 'contact';

export const ENROLLING_BADGE = `<p class="badge"><span class="dot" aria-hidden="true"></span>${i18n({
  ar: 'الحجز مفتوح الآن',
  en: 'Now enrolling',
})}</p>`;

export function skeleton(n: number): string {
  return Array.from({ length: n }, () => '<div class="skeleton"></div>').join('');
}

/** Glyphs for the platforms teachers actually link to. */
export const SOCIAL_GLYPH: Record<string, string> = {
  whatsapp: '💬', telegram: '✈️', facebook: 'f', instagram: '◎', youtube: '▶',
  tiktok: '♪', linkedin: 'in', twitter: '𝕏', x: '𝕏', email: '✉', mail: '✉',
  phone: '☎', website: '⌂', site: '⌂',
};
