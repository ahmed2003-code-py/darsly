import { BadRequestException } from '@nestjs/common';
import { assertMagicMatchesMime, validateImageDataUrl } from './image.util';

/**
 * Refusing bytes that are not the type they were declared as.
 *
 * The declared MIME is a string the caller chose; the bytes are the thing that
 * gets decoded. Nothing downstream consults the string — sharp reads the magic
 * number and picks a decoder from it — so as long as only the string was
 * checked, the two were free to disagree.
 *
 * That gap was not theoretical. The installed sharp reports libheif support
 * with `heif.input.buffer === true`, so an upload declared `image/png` carrying
 * HEIF bytes passed the MIME gate and was handed to libheif: the decoder behind
 * this project's own HIGH-severity advisories, and one no upload path in Darsly
 * is meant to reach at all (the accepted list is PNG, JPEG and WebP).
 *
 * The previous audit rated the MIME/content gap INFO on the grounds that
 * `X-Content-Type-Options: nosniff` mitigated it. That was wrong in one
 * direction: nosniff governs how a *browser* treats the file on the way out,
 * and does nothing about what the *server* decodes on the way in.
 */

// Real signatures, written as the bytes a decoder actually looks at.
const PNG  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBP', 'latin1'),
]);
/**
 * An ISO-BMFF box declaring the HEIC brand — what a .heic file starts with, and
 * what routes a buffer to libheif inside sharp.
 */
const HEIF = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'),
  Buffer.from([0, 0, 0, 0]), Buffer.from('mif1heic', 'latin1'),
]);
const GIF  = Buffer.from('GIF89a________', 'latin1');
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>', 'latin1');

const asDataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`;

describe('bytes that match what they claim', () => {
  it('accepts each format this platform actually supports', () => {
    expect(() => assertMagicMatchesMime('image/png', PNG)).not.toThrow();
    expect(() => assertMagicMatchesMime('image/jpeg', JPEG)).not.toThrow();
    expect(() => assertMagicMatchesMime('image/webp', WEBP)).not.toThrow();
  });

  it('lets a real image through the data-URL path unchanged', () => {
    expect(validateImageDataUrl(asDataUrl('image/png', PNG), 1_000_000))
      .toEqual({ mime: 'image/png', bytes: PNG.length });
  });
});

describe('bytes that do not match what they claim', () => {
  /** The regression this was written for. */
  it('refuses HEIF bytes declared as PNG, so libheif is never reached', () => {
    expect(() => assertMagicMatchesMime('image/png', HEIF)).toThrow(BadRequestException);
    expect(() => validateImageDataUrl(asDataUrl('image/png', HEIF), 1_000_000)).toThrow(BadRequestException);
  });

  it('refuses HEIF declared as any other accepted type', () => {
    for (const mime of ['image/jpeg', 'image/webp']) {
      expect(() => assertMagicMatchesMime(mime, HEIF)).toThrow(BadRequestException);
    }
  });

  it('refuses markup wearing an image MIME', () => {
    expect(() => validateImageDataUrl(asDataUrl('image/png', HTML), 1_000_000)).toThrow(BadRequestException);
  });

  it('refuses a format that is merely not on the accepted list', () => {
    // GIF is a real image and still not something this platform decodes.
    expect(() => assertMagicMatchesMime('image/png', GIF)).toThrow(BadRequestException);
  });

  it('refuses one accepted type wearing another accepted type\'s label', () => {
    expect(() => assertMagicMatchesMime('image/png', JPEG)).toThrow(BadRequestException);
    expect(() => assertMagicMatchesMime('image/webp', PNG)).toThrow(BadRequestException);
  });

  it('says what is wrong without describing the file back to the caller', () => {
    const err: any = (() => {
      try { assertMagicMatchesMime('image/png', HEIF); } catch (e) { return e; }
    })();
    expect(err.getResponse()).toMatchObject({ code: 'IMAGE_CONTENT_MISMATCH' });
  });

  it('refuses a buffer too short to carry a signature at all', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(() => assertMagicMatchesMime(mime, Buffer.from([0xff]))).toThrow(BadRequestException);
    }
  });
});

describe('the order the checks run in', () => {
  it('rejects an oversized file on size, without inspecting its contents', () => {
    // Size first: an oversized upload should not be examined byte by byte.
    const big = Buffer.concat([HEIF, Buffer.alloc(5000)]);
    const err: any = (() => {
      try { validateImageDataUrl(asDataUrl('image/png', big), 100); } catch (e) { return e; }
    })();
    expect(err.getResponse()).toMatchObject({ code: 'IMAGE_TOO_LARGE' });
  });
});
