import { BadRequestException } from '@nestjs/common';
import { AcademyMediaProcessor } from './academy-media.processor';

const REAL_PNG_HEADER = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de', 'hex');
// A correct PNG signature and IHDR, but the IDAT stream is truncated garbage —
// exactly what a valid-looking-but-corrupted upload (an interrupted download,
// a damaged file) produces. `sharp().metadata()` reads only the header and
// accepts this; the real decode does not.
const CORRUPT_BUT_SIGNED_PNG = Buffer.concat([REAL_PNG_HEADER, Buffer.from('ffffffffffffffffffffffff', 'hex')]);

describe('AcademyMediaProcessor — a corrupted image never reaches the client as a 500', () => {
  it('rejects a PNG with a valid signature but an undecodable body as a 400, not an unhandled throw', async () => {
    const processor = new AcademyMediaProcessor();
    await expect(processor.process(CORRUPT_BUT_SIGNED_PNG, 'image/png', 'GALLERY')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('still accepts a real, fully-decodable PNG', async () => {
    const processor = new AcademyMediaProcessor();
    const sharp = require('sharp');
    const real = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 10, b: 10 } } })
      .png()
      .toBuffer();
    const result = await processor.process(real, 'image/png', 'GALLERY');
    expect(result.format).toBe('webp');
    expect(result.width).toBeGreaterThan(0);
  });
});
