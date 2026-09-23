import { ImageVariantsService } from './ocr/image-variants.service';
import { PagePreparerService } from './page-preparer.service';
import { PaperImportConfig } from './paper-import.config';

/**
 * How big a page is worth sending.
 *
 * Image tokens are 32x32 patches, so this function is the cost model and the
 * accuracy model at once: too small wastes the model's budget on a blurrier
 * photograph than it could have had, too big is resized by the provider
 * anyway. It used to be a flat 1600px long edge, which was ~1,900 tokens
 * against a budget of ~3,000 — detail given up to save a fifth of a cent.
 */
describe('sizing a page to the model that reads it', () => {
  const config = new PaperImportConfig();
  // The budget arithmetic moved to the service that sends images — it is now
  // shared by pages and by crops, which is what makes a crop free
  // magnification rather than a bigger bill.
  const preparer = new ImageVariantsService(config);
  const patches = (w: number, h: number) => Math.ceil(w / 32) * Math.ceil(h / 32);

  it('fills the patch budget for a portrait A4 scan', () => {
    const { width, height } = preparer.fitToBudget(2480, 3508);
    const used = patches(width, height);
    expect(used).toBeGreaterThan(config.renderPatchBudget * 0.9);
    // A little over is fine — the provider resizes to its own budget; a lot
    // under is detail we chose not to send.
    expect(used).toBeLessThan(config.renderPatchBudget * 1.15);
  });

  it('gives a landscape photograph the same budget, not the same pixel count', () => {
    const portrait = preparer.fitToBudget(2480, 3508);
    const landscape = preparer.fitToBudget(3508, 2480);
    expect(patches(landscape.width, landscape.height)).toBeCloseTo(
      patches(portrait.width, portrait.height),
      -2,
    );
    expect(landscape.width).toBeGreaterThan(landscape.height);
  });

  it('sends more than the 1600px long edge it used to', () => {
    const { width, height } = preparer.fitToBudget(2480, 3508);
    expect(Math.max(width, height)).toBeGreaterThan(1600);
  });

  it('never asks for more pixels than the source has, unless enlarging is the point', () => {
    // A page is not made sharper by being stretched. A crop of small
    // handwriting is the one case where it is, and it says so.
    const small = preparer.fitToBudget(600, 800);
    expect(small.width).toBeLessThanOrEqual(600);
    const crop = preparer.fitToBudget(600, 800, { allowEnlargement: true });
    expect(crop.width).toBeGreaterThan(600);
  });

  it('never exceeds the hard ceiling, whatever the budget works out to', () => {
    const { width, height } = preparer.fitToBudget(20000, 400);
    expect(Math.max(width, height)).toBeLessThanOrEqual(config.maxRenderDim);
  });

  it('falls back to the ceiling when the source dimensions are unknown', () => {
    expect(preparer.fitToBudget(0, 0)).toEqual({
      width: config.maxRenderDim,
      height: config.maxRenderDim,
    });
  });

  it('sends the page at a quality that does not eat the strokes', () => {
    // Free: image tokens are counted from pixel dimensions, not file size, so
    // a more compressed page costs the same and only loses handwriting.
    expect(config.renderQuality).toBeGreaterThanOrEqual(90);
  });
});
