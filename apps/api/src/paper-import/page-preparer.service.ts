import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { PaperImportConfig } from './paper-import.config';

const execFileAsync = promisify(execFile);

/** What an upload is allowed to be. Anything else is refused before a byte is
 *  stored — the allow-list decides *what*, `assertMagicMatchesMime` decides
 *  whether it really is that. */
export const PAPER_IMAGE_MIME = /^image\/(png|jpe?g|webp)$/;
export const PAPER_PDF_MIME = 'application/pdf';

/** Beyond this a "photo of an exam" is a decompression bomb. */
const MAX_INPUT_DIM = 12_000;

export interface PreparedPage {
  /** JPEG bytes, upright, grey, downscaled — what the model is sent. */
  data: Buffer;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
}

/**
 * Everything that happens to a page before a model ever sees it.
 *
 * This service is the cheap half of the pipeline and the reason the expensive
 * half is small. Three deterministic things happen here, in order of how much
 * money they save:
 *
 *  1. **A PDF's text layer is read for free.** A PDF exported from Word
 *     carries the entire exam as text. Sending a *picture* of that page to a
 *     vision model is paying image tokens for something `pdftotext` hands over
 *     in milliseconds for nothing.
 *  2. **Pages are rasterised once, at the size the model needs.** Image tokens
 *     scale with area, so the render dimension is the single biggest lever on
 *     what an import costs.
 *  3. **The picture is normalised** — EXIF rotation applied, greyscaled,
 *     re-encoded as JPEG. A phone photo lying on its side is the commonest
 *     cause of a page coming back unreadable, and it costs nothing to fix.
 *
 * Nothing here calls the network, so all of it is testable and none of it is
 * billed.
 */
@Injectable()
export class PagePreparerService {
  private readonly logger = new Logger(PagePreparerService.name);
  // sharp is already a dependency (AcademyMediaProcessor); native, so required
  // rather than imported, exactly as that service does it.
  private readonly sharp = require('sharp');

  constructor(private readonly config: PaperImportConfig) {}

  /**
   * Turn an uploaded picture into the one that is stored to read from.
   *
   * What this no longer does is as important as what it does. It used to
   * greyscale every page unconditionally, refuse to enlarge a small one, and
   * hand the result to the model as the only copy that existed. All three were
   * wrong: greyscale is destructive and saves nothing (image tokens come from
   * the pixel dimensions, not the channels), a photograph of small handwriting
   * is exactly the case where enlarging is the point, and having one processed
   * copy meant a question that needed a closer look could only be re-examined
   * at the same resolution it had already failed at.
   *
   * The repairs a page actually needs — deskew, flat-field, contrast — are now
   * measured and applied by ImageVariantsService, per page, on the way to the
   * model. This stage only normalises orientation and size for storage, and
   * the untouched original is kept beside it, because every crop the
   * transcriber takes later is taken from that.
   */
  async normalizeImage(input: Buffer): Promise<PreparedPage> {
    let meta: { width?: number; height?: number };
    try {
      meta = await this.sharp(input).metadata();
    } catch {
      throw new BadRequestException({
        message: 'That image could not be read',
        code: 'PAPER_IMAGE_UNREADABLE',
      });
    }
    if ((meta.width ?? 0) > MAX_INPUT_DIM || (meta.height ?? 0) > MAX_INPUT_DIM) {
      throw new BadRequestException({
        message: 'That image is too large to process',
        code: 'PAPER_IMAGE_TOO_LARGE',
      });
    }

    // Generous compared to what one call can use, because this copy is what
    // crops are taken from and a crop wants the detail the page pass did not.
    const cap = this.config.storedPageDim;
    const { data, info } = await this.sharp(input)
      // EXIF orientation applied and the metadata dropped, which is both the
      // rotation fix and the EXIF/GPS scrub.
      .rotate()
      .resize({ width: cap, height: cap, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: this.config.storedPageQuality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { data, mimeType: 'image/jpeg', width: info.width, height: info.height };
  }

  /**
   * Stage a PDF on disk once and hand back a handle to it.
   *
   * Every poppler call needs the file on disk. Writing it per page meant a
   * 40 MB upload was written to the temp dir fifty times for a twenty-five
   * page import — once to count, once to read the text, once to render, per
   * page. It is written once, used, and removed in a `finally` that runs
   * whether the import succeeded, failed, or threw halfway through a page.
   */
  async withPdf<T>(pdf: Buffer, fn: (handle: PdfHandle) => Promise<T>): Promise<T> {
    const file = path.join(os.tmpdir(), `paper-import-${randomUUID()}.pdf`);
    await fs.writeFile(file, pdf);
    try {
      return await fn(new PdfHandle(file, this, this.config, this.logger));
    } finally {
      await fs.unlink(file).catch(() => undefined);
    }
  }
}

/**
 * One staged PDF, and the three things this pipeline asks of it. Short-lived:
 * valid only inside the `withPdf` callback that created it.
 */
export class PdfHandle {
  constructor(
    private readonly file: string,
    private readonly preparer: PagePreparerService,
    private readonly config: PaperImportConfig,
    private readonly logger: Logger,
  ) {}

  /** How many pages, refusing anything that is not a readable PDF. Counted
   *  before a single page is rendered, so an 800-page book is refused in
   *  milliseconds rather than after eight minutes of rasterising. */
  async pageCount(): Promise<number> {
    const { stdout } = await execFileAsync('pdfinfo', [this.file], { timeout: 30_000 }).catch(
      (e: Error) => {
        throw new BadRequestException({
          message: 'That PDF could not be read',
          code: 'PAPER_PDF_UNREADABLE',
          detail: e.message.slice(0, 200),
        });
      },
    );
    const pages = Number(/^Pages:\s+(\d+)$/m.exec(stdout)?.[1]);
    if (!Number.isFinite(pages) || pages < 1) {
      throw new BadRequestException({ message: 'That PDF has no pages', code: 'PAPER_PDF_EMPTY' });
    }
    return pages;
  }

  /**
   * Render one page as the picture the model gets.
   *
   * `pdftoppm` rather than a JS PDF library: poppler is a single apt package,
   * it is the same "shell out to the tool that does this properly" shape the
   * video pipeline already uses for ffmpeg, and a PDF parser running in this
   * process on an untrusted upload is a much larger attack surface than a
   * short-lived child process reading a file.
   */
  async render(pageNumber: number): Promise<PreparedPage> {
    const out = `${this.file}-p${pageNumber}`;
    try {
      await execFileAsync(
        'pdftoppm',
        [
          '-f',
          String(pageNumber),
          '-l',
          String(pageNumber),
          '-r',
          '150',
          '-gray',
          '-jpeg',
          '-singlefile',
          this.file,
          out,
        ],
        { timeout: 60_000 },
      );
      const rendered = await fs.readFile(`${out}.jpg`);
      return await this.preparer.normalizeImage(rendered);
    } catch (e) {
      throw new BadRequestException({
        message: `Page ${pageNumber} of that PDF could not be rendered`,
        code: 'PAPER_PDF_PAGE_FAILED',
        detail: (e as Error).message.slice(0, 200),
      });
    } finally {
      await fs.unlink(`${out}.jpg`).catch(() => undefined);
    }
  }

  /**
   * The page's text, when the PDF already carries it.
   *
   * Returns null for a scan — a scanned page's "text layer" is either absent
   * or a handful of characters of noise, and `textLayerMinChars` is the line
   * between the two. When this returns text, the page costs no image tokens
   * at all, which is the difference between a tenth of a cent and two.
   */
  async text(pageNumber: number): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        'pdftotext',
        ['-f', String(pageNumber), '-l', String(pageNumber), '-layout', this.file, '-'],
        { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      );
      const text = stdout
        .replace(/\f/g, '')
        // Poppler wraps every right-to-left run in bidirectional embedding
        // marks. They are invisible, they are two or three tokens per line of
        // an Arabic exam, and the model does not need them to know the text is
        // Arabic — the Arabic letters already say so.
        .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
        .trim();
      return text.length >= this.config.textLayerMinChars ? text : null;
    } catch (e) {
      // Not fatal: no text layer just means the page is read as a picture.
      this.logger.debug(`pdftotext failed on page ${pageNumber}: ${(e as Error).message}`);
      return null;
    }
  }
}
