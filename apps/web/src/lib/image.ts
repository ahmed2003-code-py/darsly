/**
 * Read an image File, resize it to fit within maxW×maxH (cover-cropped for
 * avatars when square=true), and return a compact JPEG/WEBP data URL. Resizing
 * on the client keeps uploads small enough to live inline in the DB.
 */
import i18n from '../i18n';
export function imageToDataUrl(
  file: File,
  opts: { maxW: number; maxH: number; quality?: number; square?: boolean } = { maxW: 800, maxH: 800 },
): Promise<string> {
  const { maxW, maxH, quality = 0.82, square = false } = opts;
  // Reject very large source files before decoding — decoding a 100 MP phone
  // photo into an <img> spikes memory and can freeze/crash low-end mobiles.
  const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
  const MAX_SOURCE_PIXELS = 40_000_000; // ~40 MP
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('not an image'));
    if (file.size > MAX_SOURCE_BYTES) {
      return reject(new Error(i18n.t('image.tooLarge')));
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      if (img.width * img.height > MAX_SOURCE_PIXELS) {
        return reject(new Error(i18n.t('image.tooManyPixels')));
      }
      let sx = 0, sy = 0, sw = img.width, sh = img.height;
      let dw = img.width, dh = img.height;

      if (square) {
        const side = Math.min(img.width, img.height);
        sx = (img.width - side) / 2;
        sy = (img.height - side) / 2;
        sw = sh = side;
        dw = dh = Math.min(side, maxW);
      } else {
        const ratio = Math.min(1, maxW / img.width, maxH / img.height);
        dw = Math.round(img.width * ratio);
        dh = Math.round(img.height * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width = dw;
      canvas.height = dh;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('no canvas'));
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
      // WEBP where supported (smaller); fall back to JPEG.
      const webp = canvas.toDataURL('image/webp', quality);
      resolve(webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('load failed')); };
    img.src = url;
  });
}

/**
 * The same resize, handed back as a file ready to upload.
 *
 * A photo off a modern phone is eight to twelve megapixels — several megabytes
 * of detail nobody will ever see in a logo slot. Sending it whole means the
 * teacher watches a progress bar for the time it takes to push all of it over
 * a mobile connection, and the server then throws most of it away. Shrinking
 * first turns that into a fraction of a second.
 *
 * Anything that is not an image — the gallery takes video too — comes back
 * untouched, as does a file already small enough that re-encoding would cost
 * quality for nothing.
 */
const SMALL_ENOUGH_BYTES = 400 * 1024;

export async function imageForUpload(
  file: File,
  opts: { maxW: number; maxH: number; quality?: number } = { maxW: 2000, maxH: 2000 },
): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  // An SVG is instructions, not pixels; drawing it to a canvas would rasterise
  // a logo that was chosen precisely because it does not have a resolution.
  if (file.type === 'image/svg+xml') return file;
  if (file.size <= SMALL_ENOUGH_BYTES) return file;
  try {
    const dataUrl = await imageToDataUrl(file, opts);
    const blob = await (await fetch(dataUrl)).blob();
    // No gain is not worth a re-encode — a photo already well compressed can
    // come out of the canvas larger than it went in.
    if (blob.size >= file.size) return file;
    const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.' + ext, { type: blob.type });
  } catch {
    // A file the canvas would not take is still a file the server might; let it
    // decide rather than failing the upload here.
    return file;
  }
}
