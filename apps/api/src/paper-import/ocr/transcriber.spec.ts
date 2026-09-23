import { AiClient } from '../../academy-site/ai/ai.client';
import { PaperImportConfig } from '../paper-import.config';
import { ImageVariantsService } from './image-variants.service';
import { TranscriberService } from './transcriber.service';
import { PageTranscript } from './transcript.schema';
import { FIXTURES, renderFixture } from './eval/fixtures';

const config = new PaperImportConfig();
const fixture = (id: string) => FIXTURES.find((f) => f.id === id)!;

const page = (over: Partial<PageTranscript> = {}): PageTranscript => ({
  language: 'ar',
  confidence: 0.95,
  blank: false,
  regions: [
    { label: '1', text: 'ما هي عاصمة مصر؟', confidence: 0.96, uncertain: [], math: [] },
    { label: '2', text: 'اذكر ثلاثة من حالات المادة.', confidence: 0.95, uncertain: [], math: [] },
    {
      label: '3',
      text: 'عرّف التمثيل الضوئي في سطرين.',
      confidence: 0.94,
      uncertain: [],
      math: [],
    },
  ],
  ...over,
});

/**
 * How many looks a page costs, and where they are spent.
 *
 * Nothing here reaches a provider: `completeStructured` is a mock, so the
 * suite runs offline and no test can spend money. What is asserted is the
 * decision — how many calls, on which model, of the page or of a crop —
 * because that decision is both the accuracy and the bill.
 */
describe('reading a page in as many looks as it needs', () => {
  jest.setTimeout(40_000);

  let completeStructured: jest.Mock;
  let service: TranscriberService;
  let images: ImageVariantsService;

  beforeEach(() => {
    completeStructured = jest.fn();
    const ai = {
      completeStructured,
      costMillicents: (i: number, o: number) => Math.round((i + o) / 100),
    } as unknown as AiClient;
    images = new ImageVariantsService(config);
    service = new TranscriberService(ai, images, config);
  });

  const answer = (data: PageTranscript) => ({
    data,
    inputTokens: 2000,
    outputTokens: 600,
    costCents: 0,
  });

  it('reads a clean page in one call', async () => {
    // The cheap case has to stay cheap. A page the model could read is a page
    // nobody should be cropping.
    completeStructured.mockResolvedValue(answer(page()));
    const image = await renderFixture(fixture('clean-print-ar').render);

    const out = await service.transcribe(image, { pageNumber: 1 });

    expect(completeStructured).toHaveBeenCalledTimes(1);
    expect(out.cost.cropCalls).toBe(0);
    expect(out.transcript?.regions).toHaveLength(3);
    expect(out.needsReview).toBe(false);
  });

  it('crops and re-reads only the region it could not read', async () => {
    const doubtful = page({
      confidence: 0.7,
      regions: [
        { label: '1', text: 'ما هي عاصمة مصر؟', confidence: 0.96, uncertain: [], math: [] },
        { label: '2', text: 'شيء ما', confidence: 0.4, uncertain: [], math: [] },
        { label: '3', text: 'عرّف التمثيل الضوئي.', confidence: 0.95, uncertain: [], math: [] },
      ],
    });
    completeStructured.mockResolvedValueOnce(answer(doubtful)).mockResolvedValue(
      answer(
        page({
          regions: [
            {
              label: '2',
              text: 'اذكر ثلاثة من حالات المادة.',
              confidence: 0.95,
              uncertain: [],
              math: [],
            },
          ],
        }),
      ),
    );
    const image = await renderFixture(fixture('clean-print-ar').render);

    const out = await service.transcribe(image, { pageNumber: 1 });

    expect(out.cost.cropCalls).toBeGreaterThan(0);
    // The two good regions are untouched — that is the point of cropping one.
    expect(out.transcript?.regions[0].text).toBe('ما هي عاصمة مصر؟');
    expect(out.transcript?.regions[1].text).toContain('حالات المادة');
  });

  it('starts a re-read on the same model — resolution first, not a bigger model', async () => {
    // A crop is several times the resolution for the same tokens. Buying a
    // better model at the same resolution is the expensive way to not fix it.
    const doubtful = page({
      regions: [{ label: '1', text: 'x', confidence: 0.3, uncertain: [], math: [] }],
    });
    completeStructured.mockResolvedValue(answer(doubtful));
    const image = await renderFixture(fixture('clean-print-ar').render);

    await service.transcribe(image, { pageNumber: 1 });

    const models = completeStructured.mock.calls.map((c) => c[0].model);
    expect(models[0]).toBe(config.primaryModel);
    expect(models[1]).toBe(config.primaryModel);
  });

  it('buys a better model only after the closer look also failed', async () => {
    const doubtful = page({
      regions: [{ label: '1', text: 'x', confidence: 0.3, uncertain: [], math: [] }],
    });
    completeStructured.mockResolvedValue(answer(doubtful));
    const image = await renderFixture(fixture('clean-print-ar').render);

    await service.transcribe(image, { pageNumber: 1 });

    expect(completeStructured.mock.calls.map((c) => c[0].model)).toContain(config.fallbackModel);
  });

  it('reads the page again rather than cropping all of it', async () => {
    // A page where everything is doubtful is a bad page, not a good page with
    // a bad question on it, and eleven crops cost more than one better look.
    const allBad = page({
      confidence: 0.3,
      regions: Array.from({ length: 12 }, (_, i) => ({
        label: String(i + 1),
        text: 'x',
        confidence: 0.3,
        uncertain: [],
        math: [],
      })),
    });
    completeStructured.mockResolvedValue(answer(allBad));
    const image = await renderFixture(fixture('dense-seven').render);

    const out = await service.transcribe(image, { pageNumber: 1 });

    expect(out.cost.cropCalls).toBe(0);
    expect(completeStructured.mock.calls.map((c) => c[0].model)).toContain(config.fallbackModel);
  });

  it('crops a flagged number on its own, even inside a region it could read', async () => {
    // A digit is the highest-risk thing on an exam paper and the cheapest
    // thing to check.
    const withNumber = page({
      regions: [
        {
          label: '1',
          text: 'بلغ معاشه ١٢٨٠ جنيهًا',
          confidence: 0.95,
          uncertain: [{ text: '١٢٨٠', confidence: 0.45, reason: 'faded', numeric: true }],
          math: [],
        },
      ],
    });
    completeStructured.mockResolvedValueOnce(answer(withNumber)).mockResolvedValue(
      answer(
        page({
          regions: [{ label: '', text: '١٢٨', confidence: 0.95, uncertain: [], math: [] }],
        }),
      ),
    );
    const image = await renderFixture(fixture('arabic-numerals').render);

    const out = await service.transcribe(image, { pageNumber: 1 });

    expect(out.cost.cropCalls).toBeGreaterThan(0);
    expect(out.transcript?.regions[0].text).toContain('١٢٨');
    expect(out.transcript?.regions[0].text).not.toContain('١٢٨٠');
  });

  it('accepts a blank page without spending another call on it', async () => {
    completeStructured.mockResolvedValue(answer(page({ blank: true, regions: [] })));
    const image = await renderFixture(fixture('clean-print-ar').render);

    const out = await service.transcribe(image, { pageNumber: 1 });

    expect(completeStructured).toHaveBeenCalledTimes(1);
    expect(out.needsReview).toBe(false);
  });

  it('reports what is still unreadable rather than hiding it', async () => {
    completeStructured.mockResolvedValue(
      answer(
        page({
          regions: [
            {
              label: '1',
              text: 'شيء [UNCLEAR] آخر',
              confidence: 0.95,
              uncertain: [{ text: 'شيء', confidence: 0.3, reason: 'faded', numeric: false }],
              math: [],
            },
          ],
        }),
      ),
    );
    const image = await renderFixture(fixture('clean-print-ar').render);

    expect((await service.transcribe(image, { pageNumber: 1 })).needsReview).toBe(true);
  });

  it('survives a provider that fails, and says so', async () => {
    completeStructured.mockRejectedValue(new Error('provider down'));
    const image = await renderFixture(fixture('clean-print-ar').render);

    const out = await service.transcribe(image, { pageNumber: 1 });

    expect(out.transcript).toBeNull();
    expect(out.error).toContain('provider down');
    expect(out.needsReview).toBe(true);
  });

  it('bills every call it made, including the ones that were re-reads', async () => {
    const doubtful = page({
      regions: [{ label: '1', text: 'x', confidence: 0.3, uncertain: [], math: [] }],
    });
    completeStructured.mockResolvedValue(answer(doubtful));
    const image = await renderFixture(fixture('clean-print-ar').render);

    const out = await service.transcribe(image, { pageNumber: 1 });

    expect(out.cost.calls).toBeGreaterThan(1);
    expect(out.cost.inputTokens).toBe(2000 * out.cost.calls);
  });

  it('re-reads a page it could not divide, rather than doing nothing', async () => {
    // The first version fell through both branches here — no boxes to crop
    // and not enough wrong to trigger the whole-page retry — and did nothing
    // at all, which is the worst outcome available when the reading is known
    // to be poor and a better look is still on the table.
    completeStructured.mockResolvedValue(
      answer(
        page({ regions: [{ label: '', text: 'x', confidence: 0.3, uncertain: [], math: [] }] }),
      ),
    );
    // A blank image divides into nothing, so there is nothing to aim a crop at.
    const blank = await require('sharp')({
      create: { width: 600, height: 800, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();

    const out = await service.transcribe(blank, { pageNumber: 1 });

    expect(out.cost.cropCalls).toBe(0);
    expect(completeStructured.mock.calls.map((c) => c[0].model)).toContain(config.fallbackModel);
  });

  it('can be switched back to one call per page', async () => {
    // A way back, for the day a provider changes under us.
    const single = new PaperImportConfig();
    (single as { ocrMultiPass: boolean }).ocrMultiPass = false;
    const ai = {
      completeStructured,
      costMillicents: () => 0,
    } as unknown as AiClient;
    const plain = new TranscriberService(ai, new ImageVariantsService(single), single);
    completeStructured.mockResolvedValue(
      answer(
        page({ regions: [{ label: '1', text: 'x', confidence: 0.2, uncertain: [], math: [] }] }),
      ),
    );

    await plain.transcribe(await renderFixture(fixture('clean-print-ar').render), {
      pageNumber: 1,
    });

    expect(completeStructured).toHaveBeenCalledTimes(1);
  });
});
