import { AiClient } from '../academy-site/ai/ai.client';
import { PaperExtractionService } from './paper-extraction.service';
import { PaperImportConfig } from './paper-import.config';
import { PageExtraction } from './extraction.schema';

/**
 * The tiered model strategy, which is the feature's cost control.
 *
 * Nothing here touches a provider: `completeStructured` is a jest mock, so the
 * whole suite runs offline and no test can ever spend money. What is asserted
 * is the *decision* — which model was asked, how many times, and with what —
 * because that decision is the bill.
 */
describe('choosing which model reads a page', () => {
  const good: PageExtraction = {
    examTitle: 'Biology',
    instructions: [],
    sectionTitle: '',
    blank: false,
    questions: [
      {
        number: 1,
        type: 'MCQ',
        text: 'Which organelle makes ATP?',
        options: [
          { label: 'A', text: 'Mitochondrion', correct: true },
          { label: 'B', text: 'Ribosome', correct: false },
        ],
        modelAnswer: '',
        marks: 2,
        unsupportedKind: '',
        continuedFromPrevious: false,
        lowConfidence: false,
      },
    ],
  };
  const unreadable: PageExtraction = { ...good, questions: [] };

  let completeStructured: jest.Mock;
  let service: PaperExtractionService;
  const config = new PaperImportConfig();

  beforeEach(() => {
    completeStructured = jest.fn();
    const ai = {
      completeStructured,
      // Real arithmetic, so the cost assertions mean something.
      costMillicents: (i: number, o: number, p?: { inPerMToken: number; outPerMToken: number }) =>
        Math.round(((i / 1e6) * (p?.inPerMToken ?? 0) + (o / 1e6) * (p?.outPerMToken ?? 0)) * 1000),
    } as unknown as AiClient;
    service = new PaperExtractionService(ai, config);
  });

  const answer = (data: PageExtraction, tokens = { inputTokens: 1500, outputTokens: 400 }) => ({
    data,
    ...tokens,
    costCents: 0,
  });

  it('reads a good page on the cheap model and stops there', async () => {
    completeStructured.mockResolvedValueOnce(answer(good));

    const result = await service.extractPage({ pageNumber: 1, image: Buffer.from('jpeg') });

    expect(completeStructured).toHaveBeenCalledTimes(1);
    expect(completeStructured.mock.calls[0][0].model).toBe(config.primaryModel);
    expect(result.escalated).toBe(false);
    expect(result.escalationReason).toBeNull();
    expect(result.extraction).toEqual(good);
  });

  it('never sends a good page to the expensive model — the whole point', async () => {
    completeStructured.mockResolvedValue(answer(good));

    for (let page = 1; page <= 10; page++) {
      await service.extractPage({ pageNumber: page, image: Buffer.from('jpeg') });
    }

    expect(completeStructured).toHaveBeenCalledTimes(10);
    const models = completeStructured.mock.calls.map((c) => c[0].model);
    expect(models.every((m) => m === config.primaryModel)).toBe(true);
    expect(models).not.toContain(config.fallbackModel);
  });

  it('escalates only the page that failed, and says why', async () => {
    completeStructured
      .mockResolvedValueOnce(answer(unreadable))
      .mockResolvedValueOnce(answer(good));

    const result = await service.extractPage({ pageNumber: 4, image: Buffer.from('jpeg') });

    expect(completeStructured).toHaveBeenCalledTimes(2);
    expect(completeStructured.mock.calls[1][0].model).toBe(config.fallbackModel);
    expect(result.escalated).toBe(true);
    expect(result.escalationReason).toBe('EMPTY');
    expect(result.extraction).toEqual(good);
  });

  it('bills both calls when it escalates, rather than hiding the first', async () => {
    completeStructured
      .mockResolvedValueOnce(answer(unreadable, { inputTokens: 1000, outputTokens: 100 }))
      .mockResolvedValueOnce(answer(good, { inputTokens: 1000, outputTokens: 100 }));

    const result = await service.extractPage({ pageNumber: 1, image: Buffer.from('jpeg') });

    expect(result.inputTokens).toBe(2000);
    expect(result.outputTokens).toBe(200);
    // Cheap pass + expensive pass, and the expensive one dominates.
    const cheap =
      (1000 / 1e6) * config.primaryPrice.inPerMToken +
      (100 / 1e6) * config.primaryPrice.outPerMToken;
    const dear =
      (1000 / 1e6) * config.fallbackPrice.inPerMToken +
      (100 / 1e6) * config.fallbackPrice.outPerMToken;
    expect(result.millicents).toBe(Math.round(cheap * 1000) + Math.round(dear * 1000));
  });

  it('keeps the cheap answer when the expensive model does no better', async () => {
    const partial: PageExtraction = {
      ...good,
      questions: [{ ...good.questions[0], lowConfidence: true }],
    };
    completeStructured
      .mockResolvedValueOnce(answer(partial))
      .mockResolvedValueOnce(answer(unreadable));

    const result = await service.extractPage({ pageNumber: 1, image: Buffer.from('jpeg') });

    // A partial page a teacher can edit beats an empty one.
    expect(result.extraction).toEqual(partial);
    expect(result.escalated).toBe(true);
  });

  it('escalates a provider failure rather than losing the page', async () => {
    completeStructured
      .mockRejectedValueOnce(new Error('OpenAI request failed (503)'))
      .mockResolvedValueOnce(answer(good));

    const result = await service.extractPage({ pageNumber: 1, image: Buffer.from('jpeg') });

    expect(result.escalationReason).toBe('ERROR');
    expect(result.extraction).toEqual(good);
  });

  it('reports the page as failed when both models fail, without throwing', async () => {
    completeStructured.mockRejectedValue(new Error('provider down'));

    const result = await service.extractPage({ pageNumber: 7, image: Buffer.from('jpeg') });

    expect(result.extraction).toBeNull();
    expect(result.error).toContain('provider down');
  });

  it('sends the text layer instead of the picture when the PDF had one', async () => {
    completeStructured.mockResolvedValueOnce(answer(good));

    await service.extractPage({
      pageNumber: 1,
      image: Buffer.from('jpeg'),
      text: 'Question 1: which organelle makes ATP? A) Mitochondrion B) Ribosome',
    });

    const message = completeStructured.mock.calls[0][0].messages[0];
    expect(message.images).toBeUndefined();
    expect(message.content).toContain('Mitochondrion');
  });

  it('asks the cheap model to think as little as the job needs', async () => {
    completeStructured.mockResolvedValueOnce(answer(good));
    await service.extractPage({ pageNumber: 1, image: Buffer.from('jpeg') });
    expect(completeStructured.mock.calls[0][0].reasoningEffort).toBe(config.primaryEffort);
  });
});
