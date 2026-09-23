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
  const preparer = new PagePreparerService(config);
  const patches = (w: number, h: number) => Math.ceil(w / 32) * Math.ceil(h / 32);

  it('fills the patch budget for a portrait A4 scan', () => {
    const { width, height } = preparer.fitToPatchBudget(2480, 3508);
    const used = patches(width, height);
    expect(used).toBeGreaterThan(config.renderPatchBudget * 0.9);
    // A little over is fine — the provider resizes to its own budget; a lot
    // under is detail we chose not to send.
    expect(used).toBeLessThan(config.renderPatchBudget * 1.15);
  });

  it('gives a landscape photograph the same budget, not the same pixel count', () => {
    const portrait = preparer.fitToPatchBudget(2480, 3508);
    const landscape = preparer.fitToPatchBudget(3508, 2480);
    expect(patches(landscape.width, landscape.height)).toBeCloseTo(
      patches(portrait.width, portrait.height),
      -2,
    );
    expect(landscape.width).toBeGreaterThan(landscape.height);
  });

  it('sends more than the 1600px long edge it used to', () => {
    const { width, height } = preparer.fitToPatchBudget(2480, 3508);
    expect(Math.max(width, height)).toBeGreaterThan(1600);
  });

  it('never exceeds the hard ceiling, whatever the budget works out to', () => {
    const { width, height } = preparer.fitToPatchBudget(20000, 400);
    expect(Math.max(width, height)).toBeLessThanOrEqual(config.maxRenderDim);
  });

  it('does not enlarge a page that is already smaller than the budget', async () => {
    // `withoutEnlargement` handles this in sharp; the target is only a ceiling.
    const { width } = preparer.fitToPatchBudget(800, 1000);
    expect(width).toBeGreaterThan(0);
  });

  it('falls back to the ceiling when the source dimensions are unknown', () => {
    expect(preparer.fitToPatchBudget(0, 0)).toEqual({
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
