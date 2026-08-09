import { SiteBlock } from '../schema/site-document';
import { normalizeItems } from '../text.util';

/**
 * How much content a block actually has.
 *
 * Two different jobs depend on this. Pattern selection needs it to know whether
 * a timeline has enough entries to be a timeline. And the quality gate needs it
 * to catch a section that will render to an empty string — the old gate counted
 * blocks rather than rendered sections, so a document could satisfy it and still
 * compile to a hero followed by white space.
 */

/** The number of display items a block carries, after cleaning. */
export function blockContentCount(block: SiteBlock): number {
  switch (block.type) {
    case 'toolkit':
      return normalizeItems(block.items, { min: 2, maxLen: 60, cap: 20 }).length;
    case 'credentials':
      return normalizeItems(block.items, { min: 2, maxLen: 240, cap: 12 }).length;
    case 'stats':
      return block.items.length;
    case 'faq':
      return block.items.length;
    case 'gallery':
      return block.mediaIds.length;
    case 'contact':
      return block.socials.length;
    case 'timeline':
      return block.items.length;
    case 'process':
      return block.steps.length;
    default:
      return 0;
  }
}

const filled = (lt: { ar?: string; en?: string } | undefined) =>
  !!(lt && ((lt.ar ?? '').trim() || (lt.en ?? '').trim()));

/**
 * Whether this block will render to anything at all.
 *
 * A section that renders to an empty string is worse than one that is absent: it
 * still occupies a slot in the section numbering and still contributes its
 * padding, so the page grows a silent gap nobody put there.
 */
export function blockHasContent(block: SiteBlock): boolean {
  switch (block.type) {
    case 'hero':
      return filled(block.headline);
    case 'about':
      return filled(block.body);
    case 'quote':
      return filled(block.text);
    case 'cta':
      return filled(block.headline);
    // Live sections are always kept: their content arrives at view time, and the
    // page hides them itself if the fetch comes back empty.
    case 'courses':
    case 'reviews':
      return true;
    default:
      return blockContentCount(block) > 0;
  }
}

/** The media a block would render, if it has one. */
export function blockMediaId(block: SiteBlock): string | undefined {
  if (block.type === 'hero' || block.type === 'about') return block.mediaId;
  return undefined;
}

/** How much prose a block carries, for patterns that need a substantial body. */
export function blockTextLength(block: SiteBlock): number {
  if (block.type === 'about') return block.body.ar.length || block.body.en.length;
  if (block.type === 'quote') return block.text.ar.length || block.text.en.length;
  return 0;
}

/**
 * Every bilingual field on the page, as (label, value) pairs.
 *
 * Used to catch a field the writer filled in only one language. That used to be
 * invisible until a visitor toggled: the text simply vanished, and a credentials
 * list would render as seven numbered rules with nothing beside them. The page
 * now falls back to the language it has, and this is what tells the teacher the
 * other half is missing.
 */
export function localizedFields(block: SiteBlock): { label: string; value: { ar?: string; en?: string } }[] {
  const at = (label: string, value: unknown) =>
    ({ label, value: (value ?? {}) as { ar?: string; en?: string } });
  const items = (label: string, list: unknown[]) =>
    list.flatMap((it, i) =>
      it && typeof it === 'object' ? [at(`${label} ${i + 1}`, it)] : [],
    );

  switch (block.type) {
    case 'hero':
      return [at('hero headline', block.headline), at('hero subheadline', block.subheadline), at('hero button', block.ctaLabel)];
    case 'about':
      return [at('about heading', block.heading), at('about text', block.body)];
    case 'quote':
      return [at('quote', block.text), at('quote attribution', block.attribution)];
    case 'cta':
      return [at('closing headline', block.headline), at('closing button', block.buttonLabel)];
    case 'toolkit':
    case 'credentials':
      return [at(`${block.type} heading`, block.heading), ...items(block.type, block.items)];
    case 'stats':
      return [at('stats heading', block.heading), ...block.items.map((s, i) => at(`stat ${i + 1}`, s.label))];
    case 'faq':
      return [
        at('faq heading', block.heading),
        ...block.items.flatMap((f, i) => [at(`question ${i + 1}`, f.q), at(`answer ${i + 1}`, f.a)]),
      ];
    case 'timeline':
      return [
        at('timeline heading', block.heading),
        ...block.items.flatMap((it, i) => [at(`timeline ${i + 1} title`, it.title), at(`timeline ${i + 1} text`, it.body)]),
      ];
    case 'process':
      return [
        at('method heading', block.heading),
        ...block.steps.flatMap((s, i) => [at(`step ${i + 1} title`, s.title), at(`step ${i + 1} text`, s.body)]),
      ];
    default:
      return 'heading' in block ? [at(`${block.type} heading`, block.heading)] : [];
  }
}

/** Fields that carry one language but not the other. */
export function singleLanguageFields(block: SiteBlock): string[] {
  return localizedFields(block)
    .filter(({ value }) => {
      const ar = (value.ar ?? '').trim();
      const en = (value.en ?? '').trim();
      return (!!ar || !!en) && !(ar && en);
    })
    .map(({ label }) => label);
}
