import { SiteBlock } from '../../schema/site-document';
import { cleanList } from '../../text.util';
import { escapeAttr, escapeHtml, safeUrl } from '../html.util';
import { head, i18n, skeleton } from '../shared';
import { RenderContext, RenderMedia } from '../types';
import { registerVariant } from './registry';

/**
 * The `*_01` default variants — the current editorial look, one per section.
 * Extracted verbatim from the old renderer switch so Phase 1 output is
 * unchanged, except that fact lists (toolkit / credentials) now pass through
 * `cleanList` to strip Markdown noise and de-duplicate fragments.
 *
 * Phase 3 registers additional premium variants alongside these.
 */
type Of<T extends SiteBlock['type']> = Extract<SiteBlock, { type: T }>;

registerVariant('hero', 'hero_01', (b, ctx: RenderContext) => {
  const block = b as Of<'hero'>;
  const cover = block.mediaId ? ctx.media(block.mediaId) : undefined;
  const bg = cover && safeUrl(cover.url)
    ? ` style="background-image:url('${escapeAttr(safeUrl(cover.url))}')"`
    : '';
  return `<section class="block hero${bg ? ' hero-img' : ''}"${bg}><div class="wrap">
        <h1>${i18n(block.headline)}</h1>
        <p class="sub">${i18n(block.subheadline)}</p>
        <div class="hero-actions"><a class="btn" href="#courses-${block.id}">${i18n(block.ctaLabel)}</a></div>
      </div></section>`;
});

registerVariant('about', 'about_01', (b, ctx: RenderContext) => {
  const block = b as Of<'about'>;
  const img = block.mediaId ? ctx.media(block.mediaId) : undefined;
  const imgHtml = img && safeUrl(img.url)
    ? `<img class="about-img" src="${escapeAttr(safeUrl(img.url))}" alt="" loading="lazy">`
    : '';
  return `<section class="block numbered about"><div class="wrap about-grid">
        <div>${head('about', block.heading)}<p>${i18n(block.body)}</p></div>${imgHtml}
      </div></section>`;
});

registerVariant('toolkit', 'toolkit_01', (b) => {
  const block = b as Of<'toolkit'>;
  const items = cleanList(block.items, { min: 2, maxLen: 60, cap: 20 });
  const tags = items.map((s) => `<span class="tag">${escapeHtml(s)}</span>`).join('');
  if (!tags) return '';
  return `<section class="block numbered toolkit"><div class="wrap">
        ${head('toolkit', block.heading)}<div class="tags">${tags}</div>
      </div></section>`;
});

registerVariant('credentials', 'credentials_01', (b) => {
  const block = b as Of<'credentials'>;
  const items = cleanList(block.items, { min: 2, maxLen: 240, cap: 12 });
  const li = items.map((s) => `<li><span>${escapeHtml(s)}</span></li>`).join('');
  if (!li) return '';
  return `<section class="block numbered credentials"><div class="wrap">
        ${head('credentials', block.heading)}<ol class="record">${li}</ol>
      </div></section>`;
});

registerVariant('stats', 'stats_01', (b) => {
  const block = b as Of<'stats'>;
  return `<section class="block numbered stats"><div class="wrap">
        ${head('stats', block.heading)}
        <div class="stat-grid">${block.items
          .map((s) => `<div class="stat"><span class="v">${escapeHtml(s.value)}</span><span class="l">${i18n(s.label)}</span></div>`)
          .join('')}</div>
      </div></section>`;
});

registerVariant('faq', 'faq_01', (b) => {
  const block = b as Of<'faq'>;
  return `<section class="block numbered faq"><div class="wrap">
        ${head('faq', block.heading)}
        <div class="faq-list">${block.items
          .map((f) => `<details><summary>${i18n(f.q)}</summary><div>${i18n(f.a)}</div></details>`)
          .join('')}</div>
      </div></section>`;
});

registerVariant('cta', 'cta_01', (b) => {
  const block = b as Of<'cta'>;
  return `<section class="block cta"><div class="wrap">
        <h2>${i18n(block.headline)}</h2>
        <a class="btn" href="#top">${i18n(block.buttonLabel)}</a>
      </div></section>`;
});

registerVariant('courses', 'courses_01', (b) => {
  const block = b as Of<'courses'>;
  return `<section id="courses-${block.id}" class="block numbered courses" data-hydrate="courses" data-limit="${block.limit}"><div class="wrap">
        ${head('courses', block.heading)}
        <div class="cards" data-slot>${skeleton(3)}</div>
      </div></section>`;
});

registerVariant('reviews', 'reviews_01', (b) => {
  const block = b as Of<'reviews'>;
  return `<section class="block numbered reviews" data-hydrate="reviews" data-limit="${block.limit}"><div class="wrap">
        ${head('reviews', block.heading)}
        <div class="cards" data-slot>${skeleton(3)}</div>
      </div></section>`;
});

registerVariant('gallery', 'gallery_01', (b, ctx: RenderContext) => {
  const block = b as Of<'gallery'>;
  const imgs = block.mediaIds
    .map((id) => ctx.media(id))
    .filter((m): m is RenderMedia => !!m && !!safeUrl(m.url))
    .map((m) => `<img src="${escapeAttr(safeUrl(m.url))}" alt="" loading="lazy">`)
    .join('');
  if (!imgs) return '';
  return `<section class="block numbered gallery"><div class="wrap">
        ${head('gallery', block.heading)}<div class="gallery-grid">${imgs}</div>
      </div></section>`;
});

registerVariant('contact', 'contact_01', (b) => {
  const block = b as Of<'contact'>;
  const links = block.socials
    .filter((s) => safeUrl(s.url))
    .map(
      (s) =>
        `<a class="social" href="${escapeAttr(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(s.platform)}</a>`,
    )
    .join('');
  return `<section class="block contact"><div class="wrap">
        <h2>${i18n(block.heading)}</h2><div class="socials">${links}</div>
      </div></section>`;
});
