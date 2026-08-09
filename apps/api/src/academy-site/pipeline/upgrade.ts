import { SectionSpec } from '../schema/design-spec';
import { RENDERER_COMPOSITION, SiteDocument } from '../schema/site-document';
import { choosePattern } from '../renderer/compose';
import { blockContentCount, blockMediaId } from './block-content';
import { ContentProfile, EMPTY_PROFILE, fitFor } from './content-profile';
import { designFor } from './design-lift';
import { fingerprint } from './fingerprint';

/**
 * Moving a document forward a renderer generation, with no model call.
 *
 * Every page published before the composition engine existed carries a Design
 * DNA preset. This lifts that into a full design system and picks, for every
 * section, the best pattern its content can carry — so an old academy gets the
 * new layouts, the new typography and the smaller page weight without paying for
 * a generation and without the design changing out from under them.
 *
 * It is deliberately a separate, explicit step rather than something the
 * renderer does on the fly. Publishing bakes HTML; quietly repainting a page a
 * teacher already approved is a surprise, not an upgrade.
 */
export function upgradeToComposition(
  doc: SiteDocument,
  profile: ContentProfile = EMPTY_PROFILE,
): SiteDocument {
  const design = designFor(doc);
  const archetype = doc.theme.archetype ?? 'general';

  const blocks = doc.blocks.map((block, index) => {
    const fit = fitFor(profile, archetype, {
      items: blockContentCount(block),
      hasMedia: !!blockMediaId(block),
      textLength: block.type === 'about' ? profile.bioLength : 0,
    });
    const pattern = choosePattern(block.type, fit);
    const section: SectionSpec = {
      pattern: pattern?.id ?? '',
      // The first section is the page's peak; the rest carry their own weight.
      emphasis: index === 0 ? 'feature' : 'normal',
      width: pattern?.fullBleed ? 'full' : design.rhythm.containerWidth,
      // Alternating bands would change how the page reads, and this is an
      // upgrade, not a redesign. Everything stays on the page's own surface and
      // the design's own rhythm decides the rest.
      surface: 'page',
      align: block.type === 'contact' ? 'center' : 'start',
      columns: 3,
      accents: design.decoration.accents.slice(0, 2),
      imageTreatment: design.decoration.imageTreatment,
    };
    return { ...block, section };
  });

  const upgraded: SiteDocument = {
    ...doc,
    renderer: { version: RENDERER_COMPOSITION },
    theme: { ...doc.theme, designSpec: design },
    blocks,
  };
  upgraded.fingerprint = fingerprint(design, upgraded);
  return upgraded;
}

/** Whether this document would gain anything from being upgraded. */
export function needsUpgrade(doc: SiteDocument): boolean {
  return !doc.theme.designSpec;
}
