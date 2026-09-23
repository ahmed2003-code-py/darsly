import { AiClient } from '../../academy-site/ai/ai.client';
import { PaperImportConfig } from '../paper-import.config';
import { PaperExtractionService } from '../paper-extraction.service';
import { TranscriberService } from './transcriber.service';
import { PageTranscript, UNCLEAR } from './transcript.schema';
import { structurePrompt, transcriptAsFallback } from './structure.schema';
import { PageExtraction } from '../extraction.schema';

const config = new PaperImportConfig();

const transcript = (over: Partial<PageTranscript> = {}): PageTranscript => ({
  language: 'ar',
  confidence: 0.94,
  blank: false,
  regions: [
    {
      label: '1',
      text: 'بلغ معاشه ١٢٨ جنيهًا. ما معاشه في السنة الحادية والعشرين؟',
      confidence: 0.95,
      uncertain: [],
      math: [],
    },
    {
      label: '2',
      text: 'أوجد قيمة الكسر إلى أربعة أرقام عشرية.',
      confidence: 0.92,
      uncertain: [],
      math: [{ raw: '√7 / (2 - √7)', latex: '\\frac{\\sqrt{7}}{2-\\sqrt{7}}' }],
    },
  ],
  ...over,
});

const extraction = (): PageExtraction => ({
  examTitle: 'الحساب',
  instructions: [],
  sectionTitle: '',
  blank: false,
  questions: [
    {
      number: 1,
      type: 'SHORT_ANSWER',
      text: 'بلغ معاشه ١٢٨ جنيهًا. ما معاشه في السنة الحادية والعشرين؟',
      options: [],
      modelAnswer: '',
      marks: null,
      unsupportedKind: '',
      continuedFromPrevious: false,
      lowConfidence: false,
    },
  ],
});

/**
 * Reading the page, then working out its shape from what was read.
 *
 * Two stages because they are two jobs with different failure modes. Reading
 * faded handwriting is visual, expensive and irreversible; deciding that three
 * lines are the options of question four is textual and costs a twentieth as
 * much. Doing them in one call — which is what this did — meant a layout
 * mistake and a reading mistake arrived indistinguishable from each other.
 */
describe('turning a page into questions, in two stages', () => {
  let completeStructured: jest.Mock;
  let transcribe: jest.Mock;
  let service: PaperExtractionService;

  beforeEach(() => {
    completeStructured = jest.fn();
    transcribe = jest.fn();
    const ai = {
      completeStructured,
      costMillicents: (i: number, o: number) => Math.round((i + o) / 100),
    } as unknown as AiClient;
    service = new PaperExtractionService(ai, config, {
      transcribe,
    } as unknown as TranscriberService);
  });

  const read = (t: PageTranscript | null, over = {}) => ({
    transcript: t,
    cost: {
      inputTokens: 3000,
      outputTokens: 900,
      millicents: 40,
      calls: 1,
      cropCalls: 0,
      escalated: false,
    },
    error: null,
    needsReview: false,
    ...over,
  });

  it('reads the page first, then shapes it from the words', async () => {
    transcribe.mockResolvedValue(read(transcript()));
    completeStructured.mockResolvedValue({
      data: extraction(),
      inputTokens: 900,
      outputTokens: 400,
      costCents: 0,
    });

    const out = await service.extractPage({ pageNumber: 1, image: Buffer.from('jpeg') });

    expect(transcribe).toHaveBeenCalledTimes(1);
    // The shaping call carries no image at all: it is text in, structure out.
    const shaping = completeStructured.mock.calls[0][0];
    expect(shaping.messages[0].images).toBeUndefined();
    expect(shaping.messages[0].content).toContain('١٢٨');
    expect(out.extraction?.questions).toHaveLength(1);
  });

  it('bills both stages', async () => {
    transcribe.mockResolvedValue(read(transcript()));
    completeStructured.mockResolvedValue({
      data: extraction(),
      inputTokens: 900,
      outputTokens: 400,
      costCents: 0,
    });

    const out = await service.extractPage({ pageNumber: 1, image: Buffer.from('jpeg') });

    expect(out.inputTokens).toBe(3000 + 900);
    expect(out.outputTokens).toBe(900 + 400);
  });

  it('keeps the transcript when the shaping call fails', async () => {
    // The expensive half succeeded. Throwing it away because the cheap half
    // failed would be the worst trade in the pipeline — a teacher can retype
    // a paragraph far faster than they can re-photograph a page.
    transcribe.mockResolvedValue(read(transcript()));
    completeStructured.mockRejectedValue(new Error('structuring failed'));

    const out = await service.extractPage({ pageNumber: 1, image: Buffer.from('jpeg') });

    expect(out.extraction?.questions).toHaveLength(2);
    expect(out.extraction?.questions[0].text).toContain('١٢٨');
    expect(out.error).toBeNull();
  });

  it('marks every question when the reading itself was doubtful', async () => {
    transcribe.mockResolvedValue(read(transcript(), { needsReview: true }));
    completeStructured.mockResolvedValue({
      data: extraction(),
      inputTokens: 900,
      outputTokens: 400,
      costCents: 0,
    });

    const out = await service.extractPage({ pageNumber: 1, image: Buffer.from('jpeg') });

    expect(out.extraction?.questions.every((q) => q.lowConfidence)).toBe(true);
  });

  it('reports a page nobody could read as failed rather than as empty', async () => {
    transcribe.mockResolvedValue(read(null, { error: 'provider down', needsReview: true }));

    const out = await service.extractPage({ pageNumber: 1, image: Buffer.from('jpeg') });

    expect(out.extraction).toBeNull();
    expect(out.error).toContain('provider down');
    expect(completeStructured).not.toHaveBeenCalled();
  });

  it('spends nothing shaping a blank page', async () => {
    transcribe.mockResolvedValue(read(transcript({ blank: true, regions: [] })));

    const out = await service.extractPage({ pageNumber: 1, image: Buffer.from('jpeg') });

    expect(out.extraction?.blank).toBe(true);
    expect(completeStructured).not.toHaveBeenCalled();
  });

  it('sends a text-layer page straight to shaping, with nothing to read', async () => {
    // A PDF that carries its own text has no pixels worth a vision call.
    completeStructured.mockResolvedValue({
      data: extraction(),
      inputTokens: 500,
      outputTokens: 300,
      costCents: 0,
    });

    await service.extractPage({ pageNumber: 1, text: 'Question 1: state the first law.' });

    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe('what the shaping call is told', () => {
  it('carries the mathematics through as mathematics', () => {
    const prompt = structurePrompt(transcript(), 1);
    expect(prompt).toContain('\\frac{\\sqrt{7}}{2-\\sqrt{7}}');
  });

  it('tells it which parts nobody could read', () => {
    const t = transcript({
      regions: [
        {
          label: '1',
          text: `بلغ معاشه ${UNCLEAR} جنيهًا`,
          confidence: 0.5,
          uncertain: [{ text: '١٢٨', confidence: 0.4, reason: 'faded', numeric: true }],
          math: [],
        },
      ],
    });
    const prompt = structurePrompt(t, 1);
    expect(prompt).toContain(UNCLEAR);
    expect(prompt).toContain('nobody could read');
  });
});

describe('the transcript as a last resort', () => {
  it('keeps every region as a written question rather than losing the page', () => {
    const out = transcriptAsFallback(transcript());
    expect(out.questions).toHaveLength(2);
    expect(out.questions[0].number).toBe(1);
    expect(out.questions[0].type).toBe('SHORT_ANSWER');
  });

  it('flags them all, because a paragraph that survived is not a question yet', () => {
    expect(transcriptAsFallback(transcript()).questions.every((q) => q.lowConfidence)).toBe(true);
  });

  it('keeps a blank page blank', () => {
    expect(transcriptAsFallback(transcript({ blank: true, regions: [] })).blank).toBe(true);
  });
});
