import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildDocx, documentXml, ExamDocument, looksRtl, statLines, xml } from './docx-writer';

/** `unzip` is present on every CI image this repo uses and in the Docker
 *  image, but a developer's machine is not a promise — the one test that
 *  shells out to it says so rather than failing for the wrong reason. */
const hasUnzip = (() => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const doc = (over: Partial<ExamDocument> = {}): ExamDocument => ({
  title: 'Biology — Final',
  meta: ['Year 3 Biology', 'Mr Adel'],
  instructions: ['Answer all questions'],
  timeLimitMin: 90,
  totalMarks: 8,
  sections: [
    {
      title: 'Section A',
      questions: [
        {
          number: 1,
          text: 'Which organelle makes ATP?',
          options: ['A) Mitochondrion', 'B) Ribosome'],
          marks: 2,
          writtenAnswer: false,
        },
      ],
    },
  ],
  rtl: false,
  ...over,
});

/**
 * The Word export.
 *
 * Two things are worth testing about a file format written by hand: that the
 * bytes really are a readable ZIP of the right parts, and that the Arabic
 * markers are where Word looks for them. Everything else is cosmetic.
 */
describe('exporting an exam as a Word document', () => {
  (hasUnzip ? it : it.skip)('writes a ZIP holding the four parts Word requires', async () => {
    const bytes = buildDocx(doc());
    const file = path.join(os.tmpdir(), `darsly-exam-${Date.now()}.docx`);
    await fs.writeFile(file, bytes);
    try {
      // `unzip -l` is the honest test: it parses the central directory, the
      // CRCs and the sizes, which is exactly the part hand-written ZIP code
      // gets wrong.
      const listing = execFileSync('unzip', ['-l', file], { encoding: 'utf8' });
      expect(listing).toContain('[Content_Types].xml');
      expect(listing).toContain('_rels/.rels');
      expect(listing).toContain('word/document.xml');

      const extracted = execFileSync('unzip', ['-p', file, 'word/document.xml'], {
        encoding: 'utf8',
      });
      expect(extracted).toContain('Which organelle makes ATP?');
      expect(extracted).toContain('Mitochondrion');
    } finally {
      await fs.unlink(file).catch(() => undefined);
    }
  });

  it('lays an Arabic paper out right to left, in the runs and in the section', () => {
    const body = documentXml(doc({ rtl: true, title: 'امتحان الأحياء' }));
    expect(body).toContain('<w:bidi/>');
    expect(body).toContain('<w:rtl/>');
    expect(body).toContain('<w:jc w:val="right"/>');
    expect(body).toContain('امتحان الأحياء');
  });

  it('leaves an English paper left to right', () => {
    const body = documentXml(doc({ rtl: false }));
    expect(body).not.toContain('<w:rtl/>');
    expect(body).toContain('<w:jc w:val="left"/>');
  });

  it('is A4', () => {
    expect(documentXml(doc())).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
  });

  it('leaves room to write under a written question', () => {
    const written = doc({
      sections: [
        {
          title: '',
          questions: [
            {
              number: 1,
              text: 'Explain photosynthesis.',
              options: [],
              marks: 5,
              writtenAnswer: true,
            },
          ],
        },
      ],
    });
    const body = documentXml(written);
    // The question paragraph plus two blank answer lines plus the spacer.
    expect(body.match(/<w:p>/g)!.length).toBeGreaterThan(4);
  });

  it('prints the marks beside the question when the paper carried them', () => {
    expect(documentXml(doc())).toContain('(2 marks)');
    const arabic = doc({
      rtl: true,
      sections: [
        {
          title: '',
          questions: [
            { number: 1, text: 'ما وحدة القوة؟', options: [], marks: 2, writtenAnswer: false },
          ],
        },
      ],
    });
    expect(documentXml(arabic)).toContain('(2 درجة)');
    // An English question keeps English marks even on an Arabic paper.
    expect(documentXml(doc({ rtl: true }))).toContain('(2 marks)');
  });

  it('opens like a paper handed to a class: who set it, the facts, the student boxes', () => {
    const body = documentXml(
      doc({
        rtl: true,
        header: {
          academy: 'سنتر النور',
          teacher: 'أحمد عبدالعزيز',
          subject: 'الفيزياء',
          grade: 'الثالث الثانوي',
          questionCount: 20,
          passingScore: 50,
        },
      }),
    );
    for (const text of [
      'سنتر النور',
      'المدرس: أحمد عبدالعزيز',
      'المادة: الفيزياء',
      'الصف: الثالث الثانوي',
      'عدد الأسئلة',
      '>20<',
      'الزمن',
      '90 دقيقة',
      'الدرجة الكلية',
      'درجة النجاح',
      '50%',
      'اسم الطالب',
      'رقم الجلوس',
      'انتهت الأسئلة',
    ]) {
      expect(body).toContain(text);
    }
    // The tables read right to left too.
    expect(body).toContain('<w:bidiVisual/>');
  });

  it('numbers a question «س١» in Arabic and "Q1." in English', () => {
    const arabic = doc({
      rtl: true,
      sections: [
        {
          title: '',
          questions: [
            {
              number: 1,
              text: 'ما وحدة القوة؟',
              options: ['النيوتن'],
              marks: 1,
              writtenAnswer: false,
            },
          ],
        },
      ],
    });
    expect(documentXml(arabic)).toContain('س1: ');
    expect(documentXml(doc())).toContain('Q1. ');
  });

  it('an English question on an Arabic paper is laid out left to right, not scrambled', () => {
    const body = documentXml(doc({ rtl: true })); // the fixture's question is English
    const para = body.slice(body.indexOf('Which organelle') - 900, body.indexOf('Which organelle'));
    const props = para.slice(para.lastIndexOf('<w:pPr>'));
    expect(props).not.toContain('<w:bidi/>');
  });

  it('gives a written question lines to write on, one per line', () => {
    const written = doc({
      sections: [
        {
          title: '',
          questions: [{ number: 1, text: 'Explain.', options: [], marks: 5, writtenAnswer: true }],
        },
      ],
    });
    expect(documentXml(written).match(/w:leader="dot"/g)).toHaveLength(4);
  });

  it('letters an option only when it does not already carry its letter', () => {
    const unlabelled = doc({
      sections: [
        {
          title: '',
          questions: [
            { number: 1, text: 'Pick', options: ['Red', 'Blue'], marks: 1, writtenAnswer: false },
          ],
        },
      ],
    });
    expect(documentXml(unlabelled)).toContain('>A) <');
    // The default fixture's options are "A) Mitochondrion": never "A) A) …".
    expect(documentXml(doc())).not.toContain('>A) <');
  });

  it('puts the page count in a footer Word fills in', () => {
    const files = unzipNames(buildDocx(doc({ rtl: true })));
    expect(files).toContain('word/footer1.xml');
    expect(documentXml(doc())).toContain('r:id="rIdFooter1"');
  });

  it('writes the time and the total in the language of the paper', () => {
    // An Arabic exam printing "Total marks: 8" in English was the server
    // composing a sentence for a document it could not read.
    expect(statLines({ rtl: true, timeLimitMin: 90, totalMarks: 20 })).toEqual([
      'الزمن: 90 دقيقة',
      'الدرجة الكلية: 20',
    ]);
    expect(statLines({ rtl: false, timeLimitMin: null, totalMarks: 20 })).toEqual([
      'Total marks: 20',
    ]);
    expect(documentXml(doc({ rtl: true }))).toContain('الدرجة الكلية');
  });

  it('escapes text that would otherwise make the document unopenable', () => {
    expect(xml('a < b & c > d "e"')).toBe('a &lt; b &amp; c &gt; d &quot;e&quot;');
    // OCR output occasionally carries a control character; XML 1.0 has no
    // escape for one, so it is dropped rather than written.
    expect(xml('clean\u0007text')).toBe('cleantext');
  });

  it('survives a question full of angle brackets', () => {
    const risky = doc({
      sections: [
        {
          title: '',
          questions: [
            {
              number: 1,
              text: 'Is 3 < 5 && 5 > 3?',
              options: ['A) Yes & always'],
              marks: null,
              writtenAnswer: false,
            },
          ],
        },
      ],
    });
    const body = documentXml(risky);
    expect(body).toContain('3 &lt; 5 &amp;&amp; 5 &gt; 3');
    expect(body).not.toContain('<w:t xml:space="preserve">Is 3 < 5');
  });

  it('decides direction from the paper, not from who asked for it', () => {
    expect(looksRtl('ما هي عاصمة مصر؟')).toBe(true);
    // A mixed paper is still an Arabic paper.
    expect(looksRtl('اشرح الـ derivative')).toBe(true);
    expect(looksRtl('Explain the derivative')).toBe(false);
  });

  it('produces the same bytes for the same exam twice', () => {
    expect(buildDocx(doc()).equals(buildDocx(doc()))).toBe(true);
  });
});

/** The file names inside a ZIP, read from its central directory. */
function unzipNames(buf: Buffer): string[] {
  const names: string[] = [];
  let at = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(at + 10);
  at = buf.readUInt32LE(at + 16);
  for (let i = 0; i < count; i++) {
    const len = buf.readUInt16LE(at + 28);
    names.push(buf.toString('utf8', at + 46, at + 46 + len));
    at += 46 + len + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return names;
}
