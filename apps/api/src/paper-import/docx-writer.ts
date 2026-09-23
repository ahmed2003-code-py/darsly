import { deflateRawSync } from 'zlib';

/**
 * A .docx, written by hand.
 *
 * A Word document is a ZIP of XML parts, and that is the whole of it — so the
 * alternative to these ~150 lines was a dependency with its own tree, its own
 * advisories and its own opinions about bidirectional text. The one thing this
 * file has to get right that a library would fight us on is Arabic: every
 * paragraph carries `w:bidi` and every run `w:rtl`, which is what makes a
 * right-to-left exam open right-to-left instead of as reversed gibberish.
 *
 * Deliberately not a document framework. It writes exam papers. If a second
 * feature ever needs a different document, the right move is another small
 * builder beside this one, not a generalisation of this one.
 */

// ── ZIP ──────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Minimal ZIP writer: deflate, no directories, no zip64.
 *
 * A .docx never needs any of what is missing — the parts are a handful of
 * small XML files with fixed names. The timestamp is fixed rather than `now`
 * so the same exam exports byte-identical twice, which is what makes the
 * output testable at all.
 */
export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01, fixed for reproducibility
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, deflated);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + deflated.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, end]);
}

// ── WordprocessingML ─────────────────────────────────────────────────────────

/** XML text escaping. Exam text is teacher-authored and may contain anything;
 *  an unescaped `&` is a document Word refuses to open. */
export function xml(text: string): string {
  return (
    String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // Control characters are not valid in XML 1.0 at all, and OCR output
      // occasionally carries one. Dropped rather than escaped.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  );
}

export interface ExamDocumentQuestion {
  number: number;
  text: string;
  options: string[];
  marks: number | null;
  /** Leaves ruled space under the question, for a written answer. */
  writtenAnswer: boolean;
}

export interface ExamDocumentSection {
  title: string;
  questions: ExamDocumentQuestion[];
}

export interface ExamDocument {
  title: string;
  /** Teacher / course / date — the line under the title. */
  meta: string[];
  /** The teacher's own words, in whatever language they wrote them. */
  instructions: string[];
  /** The two facts every paper prints, as numbers rather than as sentences.
   *  An Arabic exam that said "Total marks: 8" in English did so because the
   *  server had composed the sentence; composing it where the language is
   *  known is the fix. */
  timeLimitMin: number | null;
  totalMarks: number;
  sections: ExamDocumentSection[];
  /** Right-to-left layout. Decided from the text, not from the user's locale:
   *  an Arabic paper printed by an English-speaking admin is still Arabic. */
  rtl: boolean;
}

/** Does this exam read right to left? Any Arabic letter is enough — a mixed
 *  paper is still an Arabic paper with English terms in it. */
export function looksRtl(text: string): boolean {
  return /[؀-ۿݐ-ݿ]/.test(text);
}

/** The time and the total, written the way the paper reads. */
export function statLines(
  doc: Pick<ExamDocument, 'rtl' | 'timeLimitMin' | 'totalMarks'>,
): string[] {
  const lines: string[] = [];
  if (doc.timeLimitMin) {
    lines.push(doc.rtl ? `الزمن: ${doc.timeLimitMin} دقيقة` : `Time: ${doc.timeLimitMin} minutes`);
  }
  lines.push(doc.rtl ? `الدرجة الكلية: ${doc.totalMarks}` : `Total marks: ${doc.totalMarks}`);
  return lines;
}

function paragraph(
  runs: string,
  opts: { rtl: boolean; style?: string; spacingAfter?: number; indent?: number } = { rtl: false },
): string {
  const props = [
    opts.style ? `<w:pStyle w:val="${opts.style}"/>` : '',
    opts.rtl ? '<w:bidi/><w:jc w:val="right"/>' : '<w:jc w:val="left"/>',
    opts.indent ? `<w:ind w:${opts.rtl ? 'right' : 'left'}="${opts.indent}"/>` : '',
    opts.spacingAfter != null ? `<w:spacing w:after="${opts.spacingAfter}"/>` : '',
  ].join('');
  return `<w:p><w:pPr>${props}</w:pPr>${runs}</w:p>`;
}

function run(text: string, opts: { rtl: boolean; bold?: boolean; size?: number }): string {
  const props = [
    '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>',
    opts.bold ? '<w:b/><w:bCs/>' : '',
    opts.size ? `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>` : '',
    opts.rtl ? '<w:rtl/>' : '',
  ].join('');
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
}

/** Builds the document body. Exported so its output can be asserted on
 *  directly, without unzipping anything. */
export function documentXml(doc: ExamDocument): string {
  const rtl = doc.rtl;
  const body: string[] = [];

  body.push(paragraph(run(doc.title, { rtl, bold: true, size: 36 }), { rtl, spacingAfter: 120 }));
  for (const line of doc.meta) {
    body.push(paragraph(run(line, { rtl, size: 20 }), { rtl, spacingAfter: 60 }));
  }
  for (const line of doc.instructions) {
    body.push(paragraph(run(line, { rtl, size: 20 }), { rtl, spacingAfter: 60 }));
  }
  // Composed here, in the paper's own language — see ExamDocument.totalMarks.
  for (const line of statLines(doc)) {
    body.push(paragraph(run(line, { rtl, size: 20 }), { rtl, spacingAfter: 60 }));
  }
  body.push(paragraph('', { rtl, spacingAfter: 240 }));

  for (const section of doc.sections) {
    if (section.title) {
      body.push(
        paragraph(run(section.title, { rtl, bold: true, size: 26 }), { rtl, spacingAfter: 120 }),
      );
    }
    for (const q of section.questions) {
      const marks = q.marks != null ? `   [${q.marks}]` : '';
      body.push(
        paragraph(run(`${q.number}. ${q.text}${marks}`, { rtl, bold: true, size: 22 }), {
          rtl,
          spacingAfter: 60,
        }),
      );
      for (const option of q.options) {
        body.push(
          paragraph(run(option, { rtl, size: 22 }), { rtl, indent: 480, spacingAfter: 40 }),
        );
      }
      if (q.writtenAnswer) {
        // Two empty lines, so the paper has somewhere to write the answer.
        body.push(paragraph(run('', { rtl }), { rtl, spacingAfter: 240 }));
        body.push(paragraph(run('', { rtl }), { rtl, spacingAfter: 240 }));
      }
      body.push(paragraph('', { rtl, spacingAfter: 120 }));
    }
  }

  // A4 portrait with 2cm margins, and the section itself marked RTL so Word
  // puts the binding edge and the page numbers on the right side.
  const sectPr =
    '<w:sectPr>' +
    (rtl ? '<w:bidi/>' : '') +
    '<w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/>' +
    '</w:sectPr>';

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body.join('')}${sectPr}</w:body></w:document>`
  );
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

const DOCUMENT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>';

/** The finished .docx. */
export function buildDocx(doc: ExamDocument): Buffer {
  return zip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(DOCUMENT_RELS, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml(doc), 'utf8') },
  ]);
}
