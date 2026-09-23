import { BadRequestException } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertFileMatchesMime } from './file-signature';

/**
 * The gap this closes: `file.mimetype` is a string the client chose, and the
 * upload filters believed it. `common/image.util.ts` already refuses to
 * believe it for images — its comment records an upload declared `image/png`
 * carrying HEIF bytes reaching libheif — and the video and attachment paths
 * had no equivalent.
 */
const dir = path.join(os.tmpdir(), `darsly-sig-${Date.now()}`);
const made: string[] = [];

async function write(name: string, bytes: number[] | Buffer): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  made.push(p);
  return p;
}

/** A plausible body after the signature, so nothing passes on length alone. */
const pad = (head: number[], n = 64) => Buffer.concat([Buffer.from(head), Buffer.alloc(n, 0x41)]);

const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x20]),
  Buffer.from('ftypisom'),
  Buffer.alloc(48, 0),
]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PDF = pad([0x25, 0x50, 0x44, 0x46, 0x2d]);
const ZIP = pad([0x50, 0x4b, 0x03, 0x04]);
const WEBM = pad([0x1a, 0x45, 0xdf, 0xa3]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4, 1),
  Buffer.from('WEBP'),
  Buffer.alloc(32, 0),
]);

beforeAll(async () => {
  await fs.mkdir(dir, { recursive: true });
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe('assertFileMatchesMime', () => {
  describe('accepts a file that is what it says', () => {
    it.each([
      ['video/mp4', MP4],
      ['video/quicktime', MP4],
      ['video/webm', WEBM],
      ['video/x-matroska', WEBM],
      ['application/pdf', PDF],
      ['application/zip', ZIP],
      ['image/png', PNG],
      ['image/jpeg', JPEG],
      ['image/webp', WEBP],
    ])('%s', async (mime, bytes) => {
      const p = await write(`ok-${mime.replace(/\W/g, '_')}`, bytes);
      await expect(assertFileMatchesMime(p, mime)).resolves.toBeUndefined();
    });

    it('every OpenXML office type, which are all ZIPs', async () => {
      const p = await write('doc.docx', ZIP);
      await expect(
        assertFileMatchesMime(
          p,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      ).resolves.toBeUndefined();
    });

    it('plain text', async () => {
      const p = await write('notes.txt', Buffer.from('مرحبا — a perfectly ordinary note\n'));
      await expect(assertFileMatchesMime(p, 'text/plain')).resolves.toBeUndefined();
    });
  });

  describe('refuses a file that is something else', () => {
    it('a ZIP declared as an mp4 — the video path', async () => {
      const p = await write('trojan.mp4', ZIP);
      await expect(assertFileMatchesMime(p, 'video/mp4')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('an executable-ish blob declared as a PDF', async () => {
      const p = await write('invoice.pdf', pad([0x4d, 0x5a, 0x90, 0x00])); // MZ
      await expect(assertFileMatchesMime(p, 'application/pdf')).rejects.toMatchObject({
        response: { code: 'FILE_CONTENT_MISMATCH' },
      });
    });

    /**
     * The case image.util.ts documents: PNG declared, other bytes delivered.
     */
    it('HEIF bytes declared as image/png', async () => {
      const heif = Buffer.concat([
        Buffer.from([0, 0, 0, 0x18]),
        Buffer.from('ftypheic'),
        Buffer.alloc(32, 0),
      ]);
      const p = await write('photo.png', heif);
      await expect(assertFileMatchesMime(p, 'image/png')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('a ZIP renamed to .txt — binary cannot pass as plain text', async () => {
      const p = await write('readme.txt', ZIP);
      await expect(assertFileMatchesMime(p, 'text/plain')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('anything with a NUL byte declared as plain text', async () => {
      const p = await write('binary.txt', Buffer.from([0x41, 0x00, 0x42]));
      await expect(assertFileMatchesMime(p, 'text/plain')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('an empty file', async () => {
      const p = await write('empty.pdf', Buffer.alloc(0));
      await expect(assertFileMatchesMime(p, 'application/pdf')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('a path that cannot be read', async () => {
      await expect(
        assertFileMatchesMime(path.join(dir, 'does-not-exist'), 'application/pdf'),
      ).rejects.toMatchObject({ response: { code: 'UPLOAD_UNREADABLE' } });
    });
  });

  /**
   * This is a second gate behind an allow-list that has already decided which
   * types are acceptable. Failing closed on a type the table has not learned
   * would reject uploads the product means to accept.
   */
  it('passes a MIME it has no signature for, rather than failing closed', async () => {
    const p = await write('thing.bin', pad([0x00, 0x01, 0x02]));
    await expect(assertFileMatchesMime(p, 'application/x-unheard-of')).resolves.toBeUndefined();
  });
});
