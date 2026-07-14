import { BadRequestException } from '@nestjs/common';

const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Validate a base64 data-URL image (client-resized before upload). Returns the
 * mime on success; throws a 400 otherwise. Kept small so avatars/thumbnails
 * survive the host's ephemeral filesystem by living in the DB.
 */
export function validateImageDataUrl(dataUrl: string, maxBytes: number): { mime: string; bytes: number } {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new BadRequestException({ message: 'Invalid image', code: 'IMAGE_INVALID' });
  }
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) throw new BadRequestException({ message: 'Invalid image', code: 'IMAGE_INVALID' });
  const header = dataUrl.slice(5, commaIdx);
  if (!header.includes(';base64')) throw new BadRequestException({ message: 'Invalid image', code: 'IMAGE_INVALID' });
  const mime = header.split(';')[0].trim().toLowerCase();
  if (!ALLOWED_MIMES.has(mime)) {
    throw new BadRequestException({ message: 'Unsupported image type', code: 'IMAGE_TYPE' });
  }
  let bytes: number;
  try {
    bytes = Buffer.from(dataUrl.slice(commaIdx + 1), 'base64').length;
  } catch {
    throw new BadRequestException({ message: 'Invalid image', code: 'IMAGE_INVALID' });
  }
  if (bytes === 0) throw new BadRequestException({ message: 'Invalid image', code: 'IMAGE_INVALID' });
  if (bytes > maxBytes) throw new BadRequestException({ message: 'Image too large', code: 'IMAGE_TOO_LARGE' });
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
