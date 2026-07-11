/**
 * Read an image File, resize it to fit within maxW×maxH (cover-cropped for
 * avatars when square=true), and return a compact JPEG/WEBP data URL. Resizing
 * on the client keeps uploads small enough to live inline in the DB.
 */
export function imageToDataUrl(
  file: File,
  opts: { maxW: number; maxH: number; quality?: number; square?: boolean } = { maxW: 800, maxH: 800 },
): Promise<string> {
  const { maxW, maxH, quality = 0.82, square = false } = opts;
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('not an image'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
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
