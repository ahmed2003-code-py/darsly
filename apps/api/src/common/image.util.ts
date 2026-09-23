import { BadRequestException } from '@nestjs/common';

const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Does this buffer actually start like the type it claims to be?
 *
 * The declared MIME is a string the caller chose; the bytes are the thing that
 * gets decoded. Checking only the string leaves the two free to disagree, and
 * what reads the bytes afterwards does not consult the string at all: sharp
 * sniffs the magic number and picks a decoder from it. So an upload declared
 * `image/png` carrying HEIF bytes passed the MIME gate and reached libheif —
 * which is where this codebase's own dependency advisories live.
 *
 * Signatures are checked rather than parsed. This is not image validation (the
 * decoder still does that); it is the narrower job of refusing to hand the
 * decoder a format nobody asked for.
 */
function looksLike(mime: string, bytes: Buffer): boolean {
  switch (mime) {
    case 'image/png':
      // The 8-byte PNG signature.
      return (
        bytes.length >= 8 &&
        bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      );
    case 'image/jpeg':
      // SOI marker; every JPEG variant begins with it.
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/webp':
      // "RIFF" .... "WEBP" — the size field between them is not ours to check.
      return (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
        bytes.subarray(8, 12).toString('latin1') === 'WEBP'
      );
    default:
      return false;
  }
}

/**
 * Refuse bytes that are not the type they were declared as.
 *
 * Exported because two paths accept image bytes — the base64 data-URL route and
 * the multipart academy-media route — and a check that only one of them makes
 * is a check an attacker uses the other one to skip.
 */
export function assertMagicMatchesMime(mime: string, bytes: Buffer): void {
  if (!looksLike(mime, bytes)) {
    throw new BadRequestException({
      message: 'This file is not the image type it claims to be',
      code: 'IMAGE_CONTENT_MISMATCH',
    });
  }
}

/**
 * Validate a base64 data-URL image (client-resized before upload). Returns the
 * mime on success; throws a 400 otherwise. Kept small so avatars/thumbnails
 * survive the host's ephemeral filesystem by living in the DB.
 */
export function validateImageDataUrl(
  dataUrl: string,
  maxBytes: number,
): { mime: string; bytes: number } {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new BadRequestException({ message: 'Invalid image', code: 'IMAGE_INVALID' });
  }
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0)
    throw new BadRequestException({ message: 'Invalid image', code: 'IMAGE_INVALID' });
  const header = dataUrl.slice(5, commaIdx);
  if (!header.includes(';base64'))
    throw new BadRequestException({ message: 'Invalid image', code: 'IMAGE_INVALID' });
  const mime = header.split(';')[0].trim().toLowerCase();
  if (!ALLOWED_MIMES.has(mime)) {
    throw new BadRequestException({ message: 'Unsupported image type', code: 'IMAGE_TYPE' });
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(dataUrl.slice(commaIdx + 1), 'base64');
  } catch {
    throw new BadRequestException({ message: 'Invalid image', code: 'IMAGE_INVALID' });
  }
  const bytes = buf.length;
  if (bytes === 0)
    throw new BadRequestException({ message: 'Invalid image', code: 'IMAGE_INVALID' });
  if (bytes > maxBytes)
    throw new BadRequestException({ message: 'Image too large', code: 'IMAGE_TOO_LARGE' });
  // Size is checked before the signature so an oversized file is rejected
  // without inspecting it, and the declared type is checked against the actual
  // bytes last — see assertMagicMatchesMime.
  assertMagicMatchesMime(mime, buf);
  return { mime, bytes };
}

/**
 * Validate a thumbnail reference, which may be EITHER a base64 image data-URL OR
 * an external http(s) image URL. Rejects everything else — `javascript:` URIs,
 * `data:text/html` and other non-image data-URLs, and any other protocol — so a
 * stored thumbnail can never become a script/content-injection sink on the public
 * course page. Applied at the service layer so every write path is covered, not
 * just the dedicated thumbnail endpoint.
 */
export function validateThumbnailUrl(value: string, maxBytes: number): void {
  if (!value || typeof value !== 'string') {
    throw new BadRequestException({ message: 'Invalid image', code: 'IMAGE_INVALID' });
  }
  const trimmed = value.trim();
  if (trimmed.startsWith('data:')) {
    // Data-URL → must be an allowed image type within the size cap.
    validateImageDataUrl(trimmed, maxBytes);
    return;
  }
  // Otherwise it must be a well-formed http(s) URL.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BadRequestException({ message: 'Invalid image URL', code: 'IMAGE_URL_INVALID' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException({ message: 'Unsupported image URL', code: 'IMAGE_URL_PROTOCOL' });
  }
}
