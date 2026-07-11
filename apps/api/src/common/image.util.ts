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
