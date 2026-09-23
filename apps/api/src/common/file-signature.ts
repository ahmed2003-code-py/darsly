import { BadRequestException } from '@nestjs/common';
import { promises as fs } from 'fs';

/**
 * Does this file's content match the type it says it is?
 *
 * The upload filters trusted `file.mimetype`, which is a string the client
 * chose. `common/image.util.ts` already refuses to trust it for images — with
 * a comment explaining that an upload declared `image/png` carrying HEIF bytes
 * reached libheif, the decoder behind this project's own HIGH advisories. The
 * video and attachment paths had no equivalent, so anything at all could be
 * stored under a respectable-looking type.
 *
 * What this is worth, honestly: downloads already go out with
 * `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, so
 * a mislabelled file is storage abuse rather than stored XSS. The reason to
 * close it anyway is that those two headers are the only thing standing
 * between the two, and neither is visible from the code that accepts the file.
 *
 * Signatures, not a parsing library: a magic number is a fixed prefix, the
 * list is short, and a dependency that opens the file to identify it is a
 * larger attack surface than the check it performs.
 */

/** Longest prefix any signature below needs. */
const SNIFF_BYTES = 64;

type Test = (b: Buffer) => boolean;

const startsWith =
  (...bytes: number[]): Test =>
  (b) =>
    bytes.every((v, i) => b[i] === v);

/** ISO-BMFF ("ftyp" at offset 4) — mp4, m4v, mov all share it. */
const isoBmff: Test = (b) => b.length > 11 && b.toString('latin1', 4, 8) === 'ftyp';

/** Matroska/WebM are both EBML. */
const ebml: Test = startsWith(0x1a, 0x45, 0xdf, 0xa3);

/** Any ZIP container: .zip itself and every OpenXML office file. */
const zip: Test = (b) =>
  startsWith(0x50, 0x4b, 0x03, 0x04)(b) || // normal
  startsWith(0x50, 0x4b, 0x05, 0x06)(b) || // empty archive
  startsWith(0x50, 0x4b, 0x07, 0x08)(b); // spanned

const webp: Test = (b) =>
  b.length > 11 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';

/**
 * Plain text has no signature, so the test is the other way round: it must not
 * be something else. A NUL byte in the first block is the classic "this is
 * binary" tell, and the known containers are rejected by name so a ZIP cannot
 * be filed as a .txt.
 */
const plainText: Test = (b) =>
  !b.includes(0x00) && !zip(b) && !isoBmff(b) && !ebml(b) && !startsWith(0x25, 0x50, 0x44, 0x46)(b);

const SIGNATURES: Record<string, Test> = {
  'video/mp4': isoBmff,
  'video/quicktime': isoBmff,
  'video/webm': ebml,
  'video/x-matroska': ebml,
  'application/pdf': startsWith(0x25, 0x50, 0x44, 0x46), // %PDF
  'application/zip': zip,
  'application/msword': startsWith(0xd0, 0xcf, 0x11, 0xe0), // OLE2 compound file
  'image/png': startsWith(0x89, 0x50, 0x4e, 0x47),
  'image/jpeg': startsWith(0xff, 0xd8, 0xff),
  'image/jpg': startsWith(0xff, 0xd8, 0xff),
  'image/webp': webp,
  'text/plain': plainText,
};

/** Every OpenXML type (docx, xlsx, pptx…) is a ZIP; matching them by prefix
 *  keeps the table from listing a dozen near-identical entries. */
function testFor(mime: string): Test | null {
  if (SIGNATURES[mime]) return SIGNATURES[mime];
  if (mime.startsWith('application/vnd.openxmlformats-officedocument.')) return zip;
  return null;
}

/**
 * Read enough of `filePath` to identify it and refuse the mismatch.
 *
 * An unrecognised MIME passes: this is a second gate behind an allow-list that
 * has already decided which types are acceptable, and failing closed on a type
 * the table has not learned yet would reject uploads the product means to
 * accept. The allow-list is the authority on *what*; this is the check on
 * *whether it really is*.
 */
export async function assertFileMatchesMime(filePath: string, mime: string): Promise<void> {
  const test = testFor(mime.toLowerCase());
  if (!test) return;

  let head: Buffer;
  try {
    const fh = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(SNIFF_BYTES);
      const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
      head = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    throw new BadRequestException({
      message: 'Could not read the uploaded file',
      code: 'UPLOAD_UNREADABLE',
    });
  }

  if (!head.length || !test(head)) {
    throw new BadRequestException({
      message: 'This file is not the type it claims to be',
      code: 'FILE_CONTENT_MISMATCH',
    });
  }
}
