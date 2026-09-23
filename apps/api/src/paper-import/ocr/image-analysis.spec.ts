import { ImageVariantsService } from './image-variants.service';
import { PaperImportConfig } from '../paper-import.config';
import { QUALITY_THRESHOLDS, decideVariants } from './image-analysis';
import { FIXTURES, renderFixture } from './eval/fixtures';

const config = new PaperImportConfig();
const service = new ImageVariantsService(config);
const fixture = (id: string) => FIXTURES.find((f) => f.id === id)!;

/**
 * Measuring a page before doing anything to it.
 *
 * The pipeline this replaces applied the same four operations to every image.
 * A clean scan and a shadowed, skewed photograph of faded handwriting went
 * through identically — which is why the second one came back unreadable. So
 * the measurements have to actually distinguish them, and these run against
 * rendered pages that really are skewed, shadowed and shrunk.
 */
describe('measuring what is wrong with a page', () => {
  jest.setTimeout(30_000);

  it('finds the angle a skewed page is lying at', async () => {
    const q = await service.measure(await renderFixture(fixture('skewed').render));
    // Rendered at 3.5°. Within a degree is enough to straighten it.
    expect(Math.abs(q.skewDegrees - 3.5)).toBeLessThan(1.2);
    expect(decideVariants(q).deskew).toBe(true);
  });

  it('leaves a straight page alone', async () => {
    const q = await service.measure(await renderFixture(fixture('clean-print-ar').render));
    expect(Math.abs(q.skewDegrees)).toBeLessThan(QUALITY_THRESHOLDS.skewDegrees);
    expect(decideVariants(q).deskew).toBe(false);
  });

  it('notices a page lit unevenly, and asks for the lighting to be divided out', async () => {
    const shadowed = await service.measure(await renderFixture(fixture('low-light').render));
    const flat = await service.measure(await renderFixture(fixture('clean-print-ar').render));
    expect(shadowed.lighting).toBeGreaterThan(flat.lighting);
    expect(decideVariants(shadowed).flatten).toBe(true);
    expect(decideVariants(flat).flatten).toBe(false);
  });

  it('knows a soft page from a crisp one, measured on the strokes', async () => {
    // Laplacian energy over a mostly-blank page is near zero however sharp
    // the text is, so it is averaged over the ink only. Measured on the page
    // it made every fixture read as soft.
    const low = await service.measure(await renderFixture(fixture('low-resolution').render));
    const fine = await service.measure(await renderFixture(fixture('clean-print-ar').render));
    expect(low.sharpness).toBeLessThan(fine.sharpness);
  });

  it('sees ink that is close to its own paper', async () => {
    // Global standard deviation measured the wrong thing: a page is mostly
    // white, so crisp black print and faded pencil both came out near 0.03.
    const faded = await service.measure(await renderFixture(fixture('handwriting-faded').render));
    const crisp = await service.measure(await renderFixture(fixture('clean-print-ar').render));
    expect(faded.contrast).toBeLessThan(crisp.contrast);
    expect(crisp.contrast).toBeGreaterThan(0.5);
  });

  it('is not fooled by a shadow into calling half the page ink', async () => {
    // The failure that forced the local background: one global threshold on a
    // shadowed page measured 94% ink and a line of text 940 pixels tall.
    const shadowed = await service.measure(await renderFixture(fixture('low-light').render));
    expect(shadowed.inkCoverage).toBeLessThan(0.2);
    expect(shadowed.textHeightPx).toBeLessThan(120);
  });

  it('does nothing at all to a clean scan', async () => {
    // Every operation loses information as well as gaining it. A page that
    // needs none should get none.
    const plan = decideVariants(
      await service.measure(await renderFixture(fixture('clean-print-ar').render)),
    );
    expect(plan.deskew).toBe(false);
    expect(plan.flatten).toBe(false);
    expect(plan.denoise).toBe(false);
    expect(plan.sendSecondVariant).toBe(false);
  });

  it('measures the page in its own pixels, not the downscaled copy it looked at', async () => {
    const spec = fixture('clean-print-ar').render;
    const q = await service.measure(await renderFixture(spec));
    expect(q.width).toBe(spec.width);
    expect(q.height).toBe(spec.height);
    expect(q.textHeightPx).toBeGreaterThan(10);
  });
});

describe('the images that actually get sent', () => {
  jest.setTimeout(40_000);

  it('keeps the original untouched and returns a new one', async () => {
    const original = await renderFixture(fixture('clean-print-ar').render);
    const before = Buffer.from(original);
    const prepared = await service.prepare(original);
    expect(original.equals(before)).toBe(true);
    expect(prepared.base.data.length).toBeGreaterThan(0);
  });

  it('straightens a skewed page before sending it', async () => {
    const skewed = await renderFixture(fixture('skewed').render);
    const prepared = await service.prepare(skewed);
    expect(prepared.plan.deskew).toBe(true);
    // What came out should be measurably straighter than what went in.
    const after = await service.measure(prepared.base.data);
    expect(Math.abs(after.skewDegrees)).toBeLessThan(Math.abs(prepared.quality.skewDegrees));
  });

  it('sends a second copy only for a page that needs two looks', async () => {
    const easy = await service.prepare(await renderFixture(fixture('clean-print-ar').render));
    expect(easy.enhanced).toBeNull();
  });

  it('crops from the original, at the same budget — which is free magnification', async () => {
    // The single most valuable operation in the pipeline. A whole page inside
    // the model's image budget is ~50px per line; one question at the SAME
    // budget is several times that, for the same number of image tokens.
    const original = await renderFixture(fixture('dense-seven').render);
    const page = await service.prepare(original);
    const spec = fixture('dense-seven').render;
    const crop = await service.crop(original, {
      left: 0,
      top: Math.round(spec.height * 0.15),
      width: spec.width,
      height: Math.round(spec.height * 0.12),
    });

    const pagePixelsPerSourcePixel = page.base.width / spec.width;
    const cropPixelsPerSourcePixel = crop.width / spec.width;
    expect(cropPixelsPerSourcePixel).toBeGreaterThan(pagePixelsPerSourcePixel * 1.5);

    // And it costs the same, because image tokens are 32x32 patches.
    const patches = (w: number, h: number) => Math.ceil(w / 32) * Math.ceil(h / 32);
    expect(patches(crop.width, crop.height)).toBeLessThanOrEqual(config.renderPatchBudget * 1.2);
  });

  it('enlarges a crop of small handwriting rather than sending what little there is', async () => {
    const original = await renderFixture(fixture('low-resolution').render);
    const crop = await service.crop(
      original,
      { left: 0, top: 100, width: 1240, height: 160 },
      { upscale: true },
    );
    expect(crop.width).toBeGreaterThan(1240);
  });

  it('refuses to read something that is not an image, rather than guessing', async () => {
    await expect(service.measure(Buffer.from('not an image'))).rejects.toBeTruthy();
  });
});
