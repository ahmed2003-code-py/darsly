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
  /**
   * What goes at the top of a printed paper: who set it, for which subject
   * and year, and the numbers a student checks before starting. All optional
   * so a paper with none of it still prints — just without that line.
   */
  header?: {
    academy?: string | null;
    teacher?: string | null;
    course?: string | null;
    subject?: string | null;
    grade?: string | null;
    questionCount: number;
    passingScore?: number | null;
  };
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

/** The printed words of a paper, in its own language. The server never
 *  composes a sentence in a language the paper is not written in. */
export const PAPER_LABELS = {
  ar: {
    teacher: 'المدرس',
    subject: 'المادة',
    grade: 'الصف',
    questions: 'عدد الأسئلة',
    time: 'الزمن',
    total: 'الدرجة الكلية',
    pass: 'درجة النجاح',
    student: 'اسم الطالب',
    klass: 'الفصل',
    seat: 'رقم الجلوس',
    instructions: 'تعليمات',
    answerAll: 'أجب عن جميع الأسئلة التالية.',
    minutes: 'دقيقة',
    open: 'غير محدد',
    mark: 'درجة',
    q: 'س',
    end: 'انتهت الأسئلة — مع تمنياتنا بالتوفيق',
    page: 'صفحة',
    of: 'من',
    optionLabels: ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح'],
  },
  en: {
    teacher: 'Teacher',
    subject: 'Subject',
    grade: 'Grade',
    questions: 'Questions',
    time: 'Time',
    total: 'Total marks',
    pass: 'Pass mark',
    student: 'Student name',
    klass: 'Class',
    seat: 'Seat no.',
    instructions: 'Instructions',
    answerAll: 'Answer all of the following questions.',
    minutes: 'minutes',
    open: 'Untimed',
    mark: 'marks',
    q: 'Q',
    end: 'End of the exam — good luck',
    page: 'Page',
    of: 'of',
    optionLabels: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
  },
} as const;

/** An option that already carries its letter ("A) …", "ب- …") keeps it;
 *  lettering it again printed "A) A) Developers…". */
export function optionHasLabel(text: string): boolean {
  return /^\s*\(?[A-Za-z\u0621-\u064A0-9\u0660-\u0669]{1,2}\s*[)\].:\-–]\s*/.test(text);
}

const BORDER = (edge: string, size = 8) =>
  `<w:${edge} w:val="single" w:sz="${size}" w:space="0" w:color="444444"/>`;
const NO_BORDER = (edge: string) => `<w:${edge} w:val="nil"/>`;

/** A table spanning the page. `widths` are fractions of the text width. */
function table(
  rows: string[][],
  opts: { rtl: boolean; widths: number[]; borders: boolean; shadeFirstRow?: boolean },
): string {
  const TEXT_WIDTH = 9638; // A4 (11906) minus 2 × 1134 margins, in twips
  const cols = opts.widths.map((w) => Math.round(w * TEXT_WIDTH));
  const edges = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];
  const borders = `<w:tblBorders>${edges.map((e) => (opts.borders ? BORDER(e) : NO_BORDER(e))).join('')}</w:tblBorders>`;
  const grid = `<w:tblGrid>${cols.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
  const body = rows
    .map(
      (cells, r) =>
        `<w:tr>${cells
          .map(
            (cell, c) =>
              `<w:tc><w:tcPr><w:tcW w:w="${cols[c]}" w:type="dxa"/>` +
              (opts.shadeFirstRow && r === 0
                ? '<w:shd w:val="clear" w:color="auto" w:fill="EDEDED"/>'
                : '') +
              '<w:vAlign w:val="center"/></w:tcPr>' +
              cell +
              '</w:tc>',
          )
          .join('')}</w:tr>`,
    )
    .join('');
  return (
    `<w:tbl><w:tblPr>${opts.rtl ? '<w:bidiVisual/>' : ''}<w:tblW w:w="${TEXT_WIDTH}" w:type="dxa"/>` +
    `${borders}<w:tblLayout w:type="fixed"/>` +
    '<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/>' +
    '<w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>' +
    `</w:tblPr>${grid}${body}</w:tbl>`
  );
}

/** A paragraph aligned to `align`, one or more runs. */
function para(
  runs: string,
  opts: {
    rtl: boolean;
    align?: 'start' | 'center' | 'end';
    after?: number;
    before?: number;
    indent?: number;
    keepNext?: boolean;
    border?: 'bottom' | 'box';
  },
): string {
  const side = (a: 'start' | 'end') =>
    a === 'start' ? (opts.rtl ? 'right' : 'left') : opts.rtl ? 'left' : 'right';
  const jc = opts.align === 'center' ? 'center' : side(opts.align ?? 'start');
  const props = [
    opts.keepNext ? '<w:keepNext/>' : '',
    opts.border === 'bottom'
      ? `<w:pBdr>${BORDER('bottom', 12)}</w:pBdr>`
      : opts.border === 'box'
        ? `<w:pBdr>${['top', 'left', 'bottom', 'right'].map((e) => BORDER(e, 6)).join('')}</w:pBdr>`
        : '',
    `<w:spacing w:before="${opts.before ?? 0}" w:after="${opts.after ?? 0}"/>`,
    opts.indent ? `<w:ind w:${opts.rtl ? 'right' : 'left'}="${opts.indent}"/>` : '',
    opts.rtl ? '<w:bidi/>' : '',
    `<w:jc w:val="${jc}"/>`,
  ].join('');
  return `<w:p><w:pPr>${props}</w:pPr>${runs}</w:p>`;
}

function run(
  text: string,
  opts: { rtl: boolean; bold?: boolean; size?: number; color?: string },
): string {
  const props = [
    '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>',
    opts.bold ? '<w:b/><w:bCs/>' : '',
    opts.color ? `<w:color w:val="${opts.color}"/>` : '',
    opts.size ? `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>` : '',
    opts.rtl ? '<w:rtl/>' : '',
  ].join('');
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
}

/** "label: value" in one paragraph, the label bold. */
function fact(label: string, value: string, rtl: boolean, align: 'start' | 'center' | 'end') {
  return para(run(`${label}: `, { rtl, bold: true, size: 20 }) + run(value, { rtl, size: 20 }), {
    rtl,
    align,
    after: 20,
  });
}

const marksText = (n: number, rtl: boolean) =>
  rtl ? `(${n} ${PAPER_LABELS.ar.mark})` : `(${n} ${n === 1 ? 'mark' : 'marks'})`;

/**
 * Builds the document body — a paper as it is handed to a class.
 *
 * It used to be a title, a few loose lines and the questions: nothing a
 * teacher could print and give out. Now, top to bottom: who set it and for
 * what (academy and teacher, the title, subject and year), the numbers a
 * student checks before starting (questions, time, total, pass mark), the
 * boxes they fill in (name, class, seat), the instructions, the questions
 * numbered «س١» with their marks and lettered options, room to write under
 * a written question, a closing line, and «صفحة ١ من ٣» in the footer.
 *
 * Exported so its output can be asserted on directly, without unzipping.
 */
export function documentXml(doc: ExamDocument): string {
  const rtl = doc.rtl;
  const L = rtl ? PAPER_LABELS.ar : PAPER_LABELS.en;
  const h = doc.header;
  const body: string[] = [];

  // ── masthead: who, what, for whom ────────────────────────────────────────
  const who = [h?.academy, h?.teacher ? `${L.teacher}: ${h.teacher}` : null].filter(
    (x): x is string => !!x,
  );
  const what = [
    h?.subject ? `${L.subject}: ${h.subject}` : (h?.course ?? null),
    h?.grade ? `${L.grade}: ${h.grade}` : null,
  ].filter((x): x is string => !!x);
  const cell = (lines: string[], align: 'start' | 'center' | 'end', bold = false) =>
    (lines.length ? lines : [''])
      .map((l) => para(run(l, { rtl, bold, size: 20 }), { rtl, align }))
      .join('');
  body.push(
    table(
      [
        [
          cell(who, 'start', true),
          para(run(doc.title, { rtl, bold: true, size: 32 }), { rtl, align: 'center' }),
          cell(what, 'end', true),
        ],
      ],
      { rtl, widths: [0.3, 0.4, 0.3], borders: false },
    ),
  );
  body.push(para('', { rtl, after: 120, border: 'bottom' }));

  // ── the numbers a student checks first ──────────────────────────────────
  const facts: [string, string][] = [
    [
      L.questions,
      String(h?.questionCount ?? doc.sections.reduce((n, s) => n + s.questions.length, 0)),
    ],
    [L.time, doc.timeLimitMin ? `${doc.timeLimitMin} ${L.minutes}` : L.open],
    [L.total, String(doc.totalMarks)],
    ...(h?.passingScore != null ? [[L.pass, `${h.passingScore}%`] as [string, string]] : []),
  ];
  body.push(
    table(
      [
        facts.map(([label]) =>
          para(run(label, { rtl, bold: true, size: 20 }), { rtl, align: 'center' }),
        ),
        facts.map(([, value]) => para(run(value, { rtl, size: 22 }), { rtl, align: 'center' })),
      ],
      { rtl, widths: facts.map(() => 1 / facts.length), borders: true, shadeFirstRow: true },
    ),
  );
  body.push(para('', { rtl, after: 160 }));

  // ── what the student fills in ───────────────────────────────────────────
  const blank = '………………………………';
  body.push(
    table(
      [
        [
          fact(L.student, `${blank}${blank}`, rtl, 'start'),
          fact(L.klass, '…………', rtl, 'start'),
          fact(L.seat, '…………', rtl, 'start'),
        ],
      ],
      { rtl, widths: [0.56, 0.22, 0.22], borders: true },
    ),
  );
  body.push(para('', { rtl, after: 160 }));

  // ── instructions ────────────────────────────────────────────────────────
  const instructions = doc.instructions.length ? doc.instructions : [L.answerAll];
  body.push(
    para(run(L.instructions, { rtl, bold: true, size: 22 }), { rtl, after: 60, keepNext: true }),
  );
  for (const line of instructions) {
    body.push(para(run(`• ${line}`, { rtl, size: 20 }), { rtl, after: 40, indent: 240 }));
  }
  body.push(para('', { rtl, after: 200 }));

  // ── the questions ───────────────────────────────────────────────────────
  for (const section of doc.sections) {
    if (section.title) {
      body.push(
        para(run(section.title, { rtl, bold: true, size: 26 }), {
          rtl,
          after: 120,
          keepNext: true,
          border: 'bottom',
        }),
      );
    }
    for (const q of section.questions) {
      // Each question in the direction it is written in. An English question
      // on an Arabic paper laid out right-to-left came out scrambled —
      // "<Which is a vector? <a & b :2س" — because the bidi algorithm put the
      // punctuation on the wrong side of the Latin text.
      const qRtl = looksRtl(q.text) || (!/[A-Za-z]/.test(q.text) && rtl);
      // Numbered and marked in the question's own language: "2س." and
      // "(1 درجة)" inside an English line read as noise.
      const number = qRtl
        ? `${PAPER_LABELS.ar.q}${q.number}: `
        : `${PAPER_LABELS.en.q}${q.number}. `;
      body.push(
        para(
          run(number, { rtl: qRtl, bold: true, size: 23 }) +
            run(q.text, { rtl: qRtl, bold: true, size: 23 }) +
            (q.marks != null
              ? run(`  ${marksText(q.marks, qRtl)}`, { rtl: qRtl, size: 19, color: '555555' })
              : ''),
          { rtl: qRtl, before: 120, after: 80, keepNext: q.options.length > 0 || q.writtenAnswer },
        ),
      );
      const labels = qRtl ? PAPER_LABELS.ar.optionLabels : PAPER_LABELS.en.optionLabels;
      q.options.forEach((option, i) => {
        const label = optionHasLabel(option) ? '' : `${labels[i] ?? String(i + 1)}) `;
        body.push(
          para(
            run(label, { rtl: qRtl, bold: true, size: 22 }) + run(option, { rtl: qRtl, size: 22 }),
            { rtl: qRtl, indent: 480, after: 50, keepNext: i < q.options.length - 1 },
          ),
        );
      });
      if (q.writtenAnswer) {
        // Dotted lines across the page to write on. Separate bordered
        // paragraphs were merged by Word into one box, so four lines printed
        // as a single rule far below the question; a dot-leader tab is one
        // line per paragraph, always.
        for (let i = 0; i < 4; i++) body.push(answerLine(qRtl));
      }
      body.push(para('', { rtl, after: 120 }));
    }
  }

  body.push(para(run(L.end, { rtl, bold: true, size: 22 }), { rtl, align: 'center', before: 240 }));

  // A4 portrait with 2cm margins, the section marked RTL so Word puts the
  // binding edge on the right, and the page-number footer.
  const sectPr =
    '<w:sectPr>' +
    '<w:footerReference w:type="default" r:id="rIdFooter1"/>' +
    (rtl ? '<w:bidi/>' : '') +
    '<w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/>' +
    '</w:sectPr>';

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<w:body>${body.join('')}${sectPr}</w:body></w:document>`
  );
}

/** One full-width dotted line to write on. */
function answerLine(rtl: boolean): string {
  return (
    '<w:p><w:pPr>' +
    '<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9500"/></w:tabs>' +
    '<w:spacing w:before="220" w:after="0"/>' +
    (rtl ? '<w:bidi/>' : '') +
    '</w:pPr><w:r><w:rPr><w:color w:val="999999"/></w:rPr><w:tab/></w:r></w:p>'
  );
}

/** «صفحة ١ من ٣» — Word fills the numbers in from its own PAGE fields. */
export function footerXml(rtl: boolean): string {
  const L = rtl ? PAPER_LABELS.ar : PAPER_LABELS.en;
  const field = (code: string) =>
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve"> ${code} </w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r><w:t>1</w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    para(
      run(`${L.page} `, { rtl, size: 18, color: '666666' }) +
        field('PAGE') +
        run(` ${L.of} `, { rtl, size: 18, color: '666666' }) +
        field('NUMPAGES'),
      { rtl, align: 'center' },
    ) +
    '</w:ftr>'
  );
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
  '</Types>';

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

const DOCUMENT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' +
  '</Relationships>';

/** The finished .docx. */
export function buildDocx(doc: ExamDocument): Buffer {
  return zip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(DOCUMENT_RELS, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml(doc), 'utf8') },
    { name: 'word/footer1.xml', data: Buffer.from(footerXml(doc.rtl), 'utf8') },
  ]);
}
