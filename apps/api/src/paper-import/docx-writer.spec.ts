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
    expect(documentXml(doc())).toContain('[2]');
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
