import { segment } from '../../src/paper-import/ocr/segmentation';
import { estimateSkew } from '../../src/paper-import/ocr/image-analysis';
import { chunkLines, withoutRules } from '../../src/paper-import/ocr/chunking';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp');
(async () => {
  const out = process.env.OUT;
  for (const f of process.argv.slice(2)) {
    const base = await sharp(f)
      .rotate()
      .greyscale()
      .resize({ width: 520 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const skew = estimateSkew(new Uint8Array(base.data), base.info.width, base.info.height, 6);
    for (const sign of [-1, 1]) {
      const straight = await sharp(f)
        .rotate()
        .rotate(sign * skew, { background: '#ffffff' })
        .toBuffer();
      const s = await sharp(straight)
        .greyscale()
        .resize({ width: 520 })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const w = s.info.width,
        h = s.info.height;
      const raw = withoutRules(new Uint8Array(s.data), w, h);
      const r = segment(raw, w, h);
      const meta = await sharp(straight).metadata();
      const k = meta.width / w;
      const chunks = chunkLines(r.lines, h, { maxLines: 6 });
      console.log(
        `${f.split('/').slice(-3)[0]} skew=${skew} sign=${sign} lines=${r.lines.length} chunks=${chunks.length}: ` +
          chunks
            .map((c) => `${Math.round(c.top * k)}+${Math.round(c.height * k)}(${c.lines})`)
            .join(' '),
      );
      if (out && sign === -1) {
        const small = await sharp(straight)
          .resize({ width: 700 })
          .toBuffer({ resolveWithObject: true });
        const W = small.info.width,
          H = small.info.height,
          kk = W / w;
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${chunks
          .map((c, i) => {
            const y = Math.round(c.top * kk);
            const hh = Math.max(1, Math.min(H - y - 1, Math.round(c.height * kk)));
            return `<rect x="3" y="${y}" width="${W - 6}" height="${hh}" fill="none" stroke="${['red', 'blue', 'green', 'orange'][i % 4]}" stroke-width="3"/>`;
          })
          .join('')}</svg>`;
        await sharp(small.data)
          .composite([{ input: Buffer.from(svg) }])
          .jpeg()
          .toFile(`${out}/${f.split('/').slice(-3)[0]}.jpg`);
      }
    }
  }
})();
