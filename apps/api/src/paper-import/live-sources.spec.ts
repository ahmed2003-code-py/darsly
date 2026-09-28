import { normalizeSpec } from './exam-spec';
import { GenerationRun } from './generation-run';
import {
  dropClassroomTalk,
  mergeSources,
  questionProvenance,
  sourceEmphasis,
  transcriptChunks,
  TRANSCRIPT_FILE,
} from './live-sources';
import { PaperImportConfig } from './paper-import.config';
import { GenerationRequest, QuestionGeneratorService } from './question-generator.service';
import { chunkSource, SourceChunk } from './source-text';

/**
 * An exam from a Live class: its transcript, uploaded slides, or both.
 * Deterministic parts only; no model is called anywhere here.
 */

const CLASS = [
  'السلام عليكم يا شباب. سامعيني؟ الصوت واضح؟ طيب استنوا دقيقة واحدة.',
  'النهارده هنتكلم عن الـ overfitting، يعني الموديل بيحفظ الـ training data بدل ما يتعلم منها، وده بيخلي الأداء على الـ test data وحش جدًا.',
  'مين موجود؟ اكتبوا في الشات.',
  'عشان نكتشف الـ overfitting بنقسم الـ data لـ training و validation ونقارن الـ loss في الاتنين، ولو الفرق كبير يبقى الموديل حافظ مش فاهم.',
].join(' ');

const SLIDES = [
  'Overfitting: the model memorises the training data instead of learning from it; performance on test data drops. Detect it by comparing training and validation loss.',
  'Gradient descent updates the weights in the direction that reduces the loss; the learning rate controls the step size, and a very large learning rate makes training diverge instead of converge.',
];

const doc = (text: string, i: number): SourceChunk => ({
  index: i,
  text,
  sourceFile: 'lecture.pdf',
  page: i + 1,
  tokensApprox: Math.ceil(text.length / 3.2),
  sourceKind: 'DOCUMENT',
});

describe('the teaching in a spoken class', () => {
  it('drops greetings, "can you hear me", attendance and waiting; keeps every taught sentence word for word', () => {
    const out = dropClassroomTalk(CLASS);
    expect(out).not.toMatch(/السلام عليكم|سامعيني|الصوت واضح|استنوا|مين موجود|الشات/);
    // Nothing taught is dropped or reworded (no summarising).
    expect(out).toContain('النهارده هنتكلم عن الـ overfitting، يعني الموديل بيحفظ الـ training data بدل ما يتعلم منها');
    expect(out).toContain('ولو الفرق كبير يبقى الموديل حافظ مش فاهم.');
  });

  it('a long sentence that mentions the screen is teaching, and stays', () => {
    const s = 'بصوا على الشاشة: المعادلة دي بتقول إن الـ loss بيقل كل ما الـ learning rate يكون مناسب، ولو كبير جدًا الموديل مش هيوصل للحل.';
    expect(dropClassroomTalk(s)).toBe(s);
  });

  it('transcript chunks are named and marked as the class', () => {
    const chunks = transcriptChunks([{ text: CLASS }, { text: 'سامعيني؟' }]);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.sourceKind === 'LIVE_TRANSCRIPT' && c.sourceFile === TRANSCRIPT_FILE)).toBe(true);
    expect(chunks.map((c) => c.text).join(' ')).not.toMatch(/سامعيني/);
  });
});

describe('two sources side by side', () => {
  it('interleaves by position in each source, and renumbers', () => {
    const d = [0, 1, 2].map((i) => doc(`slide ${i} `.repeat(30), i));
    const t = [0, 1].map((i) => ({ ...doc(`كلام ${i} `.repeat(30), i), sourceKind: 'LIVE_TRANSCRIPT' as const }));
    const m = mergeSources(d, t);
    expect(m.map((c) => c.index)).toEqual([0, 1, 2, 3, 4]);
    expect(m.map((c) => c.sourceKind)).toEqual(['DOCUMENT', 'LIVE_TRANSCRIPT', 'DOCUMENT', 'DOCUMENT', 'LIVE_TRANSCRIPT']);
  });

  it('one source: every chunk weighs the same (every existing exam unchanged)', () => {
    expect(sourceEmphasis(SLIDES.map(doc))).toEqual([1, 1]);
    expect(sourceEmphasis(transcriptChunks([{ text: CLASS }]))).toEqual(transcriptChunks([{ text: CLASS }]).map(() => 1));
  });

  it('both: what the teacher both wrote and explained weighs more than a slide never explained', () => {
    const m = mergeSources(SLIDES.map(doc), transcriptChunks([{ text: CLASS }]));
    const w = sourceEmphasis(m);
    const overfitSlide = m.findIndex((c) => c.sourceKind === 'DOCUMENT' && /Overfitting/.test(c.text));
    const gradientSlide = m.findIndex((c) => c.sourceKind === 'DOCUMENT' && /Gradient/.test(c.text));
    expect(w[overfitSlide]).toBeGreaterThan(w[gradientSlide]);
    expect(Math.max(...w)).toBeLessThanOrEqual(2);
  });
});

describe('where each question came from (teacher review only)', () => {
  const m = mergeSources(SLIDES.map(doc), transcriptChunks([{ text: CLASS }]));
  const ids = { liveSessionId: 'ls1' };
  const tIdx = m.find((c) => c.sourceKind === 'LIVE_TRANSCRIPT')!.index;
  const overfit = m.find((c) => /Overfitting/.test(c.text))!.index;
  const gradient = m.find((c) => /Gradient/.test(c.text))!.index;

  it('from the slides only / from the class only / from both', () => {
    expect(questionProvenance({ text: 'What does a very large learning rate do to gradient descent training?', modelAnswer: 'It makes training diverge.', sourceChunk: gradient }, m, ids)?.kind).toBe('UPLOADED_DOCUMENT');
    const both = questionProvenance({ text: 'ما هو الـ overfitting؟', modelAnswer: 'الموديل بيحفظ الـ training data بدل ما يتعلم منها', sourceChunk: tIdx }, m, ids)!;
    expect(both.kind).toBe('BOTH');
    expect(both.evidence.map((e) => e.sourceKind).sort()).toEqual(['LIVE_TRANSCRIPT', 'UPLOADED_DOCUMENT']);
    expect(both.evidence.find((e) => e.sourceKind === 'LIVE_TRANSCRIPT')?.sourceId).toBe('ls1');
    const onlyClass = questionProvenance({ text: 'متى يكون الموديل حافظ مش فاهم حسب الشرح؟', modelAnswer: 'لما الفرق كبير', sourceChunk: tIdx }, m, ids)!;
    expect(onlyClass.kind).toBe('LIVE_TRANSCRIPT');
    expect(questionProvenance({ text: 'x', sourceChunk: overfit }, m, ids)?.evidence[0].sourceId).toBe('lecture.pdf');
  });

  it('a question with no recorded chunk has no provenance', () => {
    expect(questionProvenance({ text: 'x', sourceChunk: null }, m, ids)).toBeNull();
  });
});

describe('the writer is told what a transcript is, and may report disagreements', () => {
  const config = new PaperImportConfig();
  const tier = config.generationProfileOf().primary;
  const call = async (chunks: SourceChunk[]) => {
    const ai = {
      completeStructured: jest.fn(async () => ({ data: { questions: [], insufficient: false, supportable: 0, sourceConflicts: ['الشرح قال 3 والعرض قال 4'] }, inputTokens: 1, outputTokens: 1 })),
      costMillicents: jest.fn(() => 0),
    };
    const gen = new QuestionGeneratorService(ai as never, config);
    const res = await gen.generate({ tier, mode: 'DISTINCT', plan: [{ index: 1, type: 'MCQ', difficulty: 'MEDIUM', marks: 1 }], chunks, language: 'AUTO', avoid: [] });
    const args = (ai.completeStructured.mock.calls[0] as unknown as [{ schema: { required: string[] }; messages: { content: string }[] }])[0];
    return { res, prompt: args.messages[0].content, schema: args.schema };
  };

  it('slides only: prompt and schema exactly as before', async () => {
    const { prompt, schema, res } = await call(SLIDES.map(doc));
    expect(prompt).not.toMatch(/TRANSCRIPT/);
    expect(schema.required).not.toContain('sourceConflicts');
    expect(res.sourceConflicts).toEqual(['الشرح قال 3 والعرض قال 4']); // passed through if ever present
  });

  it('transcript only: told to ignore classroom talk and never correct the teacher; no conflicts field', async () => {
    const { prompt, schema } = await call(transcriptChunks([{ text: CLASS }]));
    expect(prompt).toMatch(/TRANSCRIPT of the live class/);
    expect(prompt).toMatch(/Ignore greetings/);
    expect(prompt).toMatch(/never add, change or correct a fact the teacher stated/);
    expect(schema.required).not.toContain('sourceConflicts');
  });

  it('both: told to prefer what both cover, never settle a disagreement, and report it', async () => {
    const { prompt, schema } = await call(mergeSources(SLIDES.map(doc), transcriptChunks([{ text: CLASS }])));
    expect(prompt).toMatch(/never settle it with your own knowledge/);
    expect(schema.required).toContain('sourceConflicts');
  });
});

describe('weighting inside the planner', () => {
  const spec = normalizeSpec({ questionCount: 6, types: { MCQ: 6, TRUE_FALSE: 0, SHORT_ANSWER: 0 }, difficulty: 'MIXED', language: 'AUTO' });
  const targetsOf = async (chunks: SourceChunk[]) => {
    const config = new PaperImportConfig();
    const generator = new QuestionGeneratorService({} as never, config);
    const seen: GenerationRequest[] = [];
    jest.spyOn(generator, 'generate').mockImplementation(async (req) => {
      seen.push(req);
      return { questions: [], insufficient: true, supportable: 0, model: req.tier.model, inputTokens: 0, outputTokens: 0, millicents: 0, error: null };
    });
    await new GenerationRun(generator, config).run({ importId: 'x', asked: spec, chunks, profile: config.generationProfileOf(), budgetMillicents: 100_000 });
    const first = seen.filter((r) => r.mode === 'DISTINCT');
    const counts = new Map<number, number>();
    for (const r of first) for (const t of r.targets ?? []) if (t != null) counts.set(t, (counts.get(t) ?? 0) + 1);
    return counts;
  };

  it('a long slide nobody explained cannot take the exam: the explained concept gets at least as many questions', async () => {
    // A wordy, unexplained slide (large capacity) beside a short explained one.
    const wordy = doc(Array.from({ length: 12 }, (_, i) => `Fact ${i}: the optimiser configuration parameter number ${i} is described here in detail for completeness.`).join('\n'), 0);
    const explained = doc(
      [
        'Overfitting means the model memorises the training data instead of learning from it.',
        'An overfitted model performs well on training data but badly on test data.',
        'Overfitting is detected by comparing training loss with validation loss.',
        'A large gap between training and validation loss is the sign of overfitting.',
      ].join('\n'),
      1,
    );
    const said = [
      'النهارده هنتكلم عن الـ overfitting، يعني الموديل بيحفظ الـ training data بدل ما يتعلم منها.',
      'الموديل اللي عنده overfitting بيبقى ممتاز على الـ training data ووحش على الـ test data.',
      'عشان نكتشف الـ overfitting بنقارن الـ training loss بالـ validation loss.',
      'لو الفرق بين الـ training loss والـ validation loss كبير يبقى عندنا overfitting.',
    ].join('\n');
    const m = mergeSources([wordy, explained], transcriptChunks([{ text: said }]));
    const counts = await targetsOf(m);
    const wordyIdx = m.find((c) => /optimiser/.test(c.text))!.index;
    // Without the weighting the 12-fact slide would take 4–5 of the 6.
    expect(counts.get(wordyIdx) ?? 0).toBeLessThanOrEqual(2);
    const explainedTotal = m.filter((c) => c.index !== wordyIdx).reduce((n, c) => n + (counts.get(c.index) ?? 0), 0);
    expect(explainedTotal).toBeGreaterThanOrEqual(4);
  });

  it('one source: the planner targets exactly what it did before this change', async () => {
    const chunks = chunkSource([{ file: 'a.pdf', page: 1, text: SLIDES.join('\n\n') + '\n\n' + SLIDES.join('\n\n') }]);
    const withKind = chunks.map((c) => ({ ...c, sourceKind: 'DOCUMENT' as const }));
    expect([...(await targetsOf(withKind)).entries()]).toEqual([...(await targetsOf(chunks)).entries()]);
  });
});
