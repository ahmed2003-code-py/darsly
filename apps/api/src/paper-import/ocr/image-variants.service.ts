import { Injectable, Logger } from '@nestjs/common';
import { PaperImportConfig } from '../paper-import.config';
import {
  ANALYSIS_TARGET_WIDTH,
  ImageQuality,
  VariantPlan,
  analyse,
  decideVariants,
} from './image-analysis';

export interface RenderedImage {
  data: Buffer;
  width: number;
  height: number;
  /** What was done to it, for the log and for the prompt. */
  label: 'base' | 'enhanced' | 'crop';
}

export interface PreparedSource {
  quality: ImageQuality;
  plan: VariantPlan;
  /** The image the model is sent first. Deskewed and flat-fielded where the
   *  measurements asked for it, sized to the patch budget. */
  base: RenderedImage;
  /** A differently-processed copy, only when the page is hard enough to be
   *  worth the extra image tokens. */
  enhanced: RenderedImage | null;
}

/**
 * Turning one photograph into the images the pipeline actually looks at.
 *
 * The rule that runs this file: **nothing destructive happens to the only
 * copy.** The upload is kept in storage untouched, and every crop taken later
 * is taken from it rather than from a processed derivative — so a question
 * that needs a closer look gets the real pixels, not a re-enlargement of
 * something already squeezed to a page-sized budget.
 *
 * The operations are the ones the measurements asked for and no others. A
 * clean scan is deskewed by nothing, flattened not at all, and left in colour.
 */
@Injectable()
export class ImageVariantsService {
  private readonly logger = new Logger(ImageVariantsService.name);
  private readonly sharp = require('sharp');

  constructor(private readonly config: PaperImportConfig) {}

  /** Measure a page without producing anything. Cheap enough to call on its
   *  own when only the numbers are wanted. */
  async measure(original: Buffer): Promise<ImageQuality> {
    const meta = await this.sharp(original).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    const small = await this.sharp(original)
      .rotate()
      .greyscale()
      .resize({ width: Math.min(ANALYSIS_TARGET_WIDTH, width || ANALYSIS_TARGET_WIDTH) })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // How far apart the colour channels are: if they agree, there is no
    // colour to preserve and greyscale costs nothing.
    let channelSpread = 0;
    try {
      const stats = await this.sharp(original).stats();
      const means = stats.channels.slice(0, 3).map((c: { mean: number }) => c.mean);
      channelSpread = means.length >= 3 ? Math.max(...means) - Math.min(...means) : 0;
    } catch {
      channelSpread = 0;
    }

    return analyse(
      new Uint8Array(small.data),
      { width: small.info.width, height: small.info.height },
      { width, height, channelSpread },
    );
  }

  /** Measure, decide, and render what was decided. */
  async prepare(original: Buffer): Promise<PreparedSource> {
    const quality = await this.measure(original);
    const plan = decideVariants(quality);
    this.logger.debug(
      `page ${quality.width}x${quality.height} sharp=${quality.sharpness.toFixed(2)} ` +
        `contrast=${quality.contrast.toFixed(2)} light=${quality.lighting.toFixed(2)} ` +
        `skew=${quality.skewDegrees}° text=${quality.textHeightPx}px → ` +
        Object.entries(plan)
          .filter(([, on]) => on)
          .map(([k]) => k)
          .join(',') || 'nothing',
    );

    const base = await this.render(original, quality, plan, 'base');
    const enhanced = plan.sendSecondVariant
      ? await this.render(original, quality, plan, 'enhanced')
      : null;
    return { quality, plan, base, enhanced };
  }

  /**
   * A piece of the page, at the resolution the model can actually use.
   *
   * This is the single most valuable operation in the pipeline and it costs
   * nothing extra. A whole A4 page sized to the patch budget gives a model
   * about fifty pixels per line of text. The same budget spent on one question
   * — a sixth of the page — gives it six times the linear detail, for exactly
   * the same number of image tokens. Cropping is free magnification.
   *
   * Taken from the ORIGINAL, so it is real detail rather than an enlargement
   * of an already-shrunk copy.
   */
  async crop(
    original: Buffer,
    box: { left: number; top: number; width: number; height: number },
    opts: { upscale?: boolean } = {},
  ): Promise<RenderedImage> {
    const meta = await this.sharp(original).rotate().metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    const left = Math.max(0, Math.min(Math.round(box.left), W - 1));
    const top = Math.max(0, Math.min(Math.round(box.top), H - 1));
    const width = Math.max(1, Math.min(Math.round(box.width), W - left));
    const height = Math.max(1, Math.min(Math.round(box.height), H - top));

    const target = this.fitToBudget(width, height, {
      allowEnlargement: opts.upscale !== false,
      // A crop of one exam question is a wide, thin strip, and a strip hits
      // the long-edge ceiling long before it hits the patch budget — the
      // first real crop measured used 375 patches of the 2500 available.
      // Letting a strip run longer spends the budget that was already paid
      // for on the only thing it can buy here, which is detail.
      thin: true,
    });
    const { data, info } = await this.sharp(original)
      .rotate()
      .extract({ left, top, width, height })
      .resize({
        width: target.width,
        height: target.height,
        fit: 'inside',
        // A crop of small handwriting is exactly the case where enlarging is
        // the point: the model reads pixels, and there were not enough.
        withoutEnlargement: opts.upscale === false,
        kernel: 'lanczos3',
      })
      .jpeg({ quality: this.config.renderQuality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, label: 'crop' };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async render(
    original: Buffer,
    quality: ImageQuality,
    plan: VariantPlan,
    label: 'base' | 'enhanced',
  ): Promise<RenderedImage> {
    let pipeline = this.sharp(original).rotate();

    if (plan.deskew) {
      // Rotating against the measured angle. The background is the paper's own
      // colour so the corners it exposes do not read as ink.
      pipeline = pipeline.rotate(-quality.skewDegrees, {
        background: { r: 255, g: 255, b: 255 },
      });
    }

    const wantGrey = !plan.keepColour || label === 'enhanced';
    if (wantGrey) pipeline = pipeline.greyscale();

    if (plan.flatten) {
      pipeline = this.sharp(await this.flatten(await pipeline.toBuffer(), wantGrey));
    }

    if (label === 'enhanced' || plan.enhanceContrast) pipeline = pipeline.normalise();
    if (label === 'enhanced' && plan.denoise) pipeline = pipeline.median(3);

    const target = this.fitToBudget(quality.width, quality.height, {
      // A page whose strokes are too small to read is the one case where
      // enlarging the whole page is worth the extra pixels.
      allowEnlargement: plan.upscale,
    });
    pipeline = pipeline
      .resize({
        width: target.width,
        height: target.height,
        fit: 'inside',
        withoutEnlargement: !plan.upscale,
        kernel: 'lanczos3',
      })
      // A light sharpen after a resample puts back the edge the resampler
      // rounded off. Not applied to a page that was already soft — sharpening
      // blur amplifies the blur.
      .sharpen(quality.sharpness > 0.1 ? { sigma: 0.6 } : { sigma: 0.3 });

    const { data, info } = await pipeline
      .jpeg({ quality: this.config.renderQuality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, label };
  }

  /**
   * Divide out the lighting.
   *
   * A heavy blur of the page is the page's own illumination — the shadow under
   * the hand, the bright patch near the window — with the text averaged away.
   * Dodging the page against it leaves the paper one flat white and the ink
   * where it was, which is what a scanner does optically and a phone does not.
   */
  private async flatten(image: Buffer, grey: boolean): Promise<Buffer> {
    const meta = await this.sharp(image).metadata();
    const sigma = Math.max(8, Math.round(Math.min(meta.width ?? 800, meta.height ?? 800) / 24));
    const background = await this.sharp(image).blur(sigma).toBuffer();
    return this.sharp(image)
      .composite([{ input: background, blend: 'colour-dodge' }])
      .toColourspace(grey ? 'b-w' : 'srgb')
      .toBuffer();
  }

  /**
   * The biggest size worth sending, in the 32x32 patches image tokens are
   * counted in. Shared by pages and crops, which is what makes a crop free
   * magnification rather than a bigger bill.
   */
  fitToBudget(
    width: number,
    height: number,
    opts: { allowEnlargement?: boolean; thin?: boolean } = {},
  ): { width: number; height: number } {
    const cap = this.config.maxRenderDim;
    if (!width || !height) return { width: cap, height: cap };
    const budget = this.config.renderPatchBudget;
    const ratio = width / height;
    let h = Math.floor(Math.sqrt((budget * 1024) / ratio));
    let w = Math.round(h * ratio);
    if (!opts.allowEnlargement && (w > width || h > height)) {
      // Never ask for more than there is unless enlarging was the point.
      const shrink = Math.min(width / w, height / h);
      w = Math.round(w * shrink);
      h = Math.round(h * shrink);
    }
    // A long strip may run past the usual ceiling, because on a strip the
    // ceiling is what binds and the budget is not: the patch count stays well
    // inside what was already going to be paid for.
    const ceiling = opts.thin ? cap * 2 : cap;
    if (Math.max(w, h) > ceiling) {
      const shrink = ceiling / Math.max(w, h);
      w = Math.round(w * shrink);
      h = Math.round(h * shrink);
    }
    return { width: Math.max(1, w), height: Math.max(1, h) };
  }
}
