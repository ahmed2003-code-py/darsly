import { AiClient } from '../../academy-site/ai/ai.client';
import { PaperImportConfig } from '../paper-import.config';
import { AdaptiveReaderService } from './adaptive-reader.service';
import { FIXTURES, renderFixture } from './eval/fixtures';
import { ImageVariantsService } from './image-variants.service';

/**
 * The adaptive reader's decisions, with the model replaced by a script.
 *
 * What is tested is the routing, not the reading: which rung each crop is
 * sent to, and why. The model is scripted per rung (cheap / low / medium /
 * high), and every call is recorded with the effort it was made at.
 */
describe('reading a page adaptively', () => {
  jest.setTimeout(60_000);

  type Script = (ctx: { model: string; effort: string; images: number; content: string }) => {
    blank?: boolean;
    regions: { label?: string; text: string; confidence?: number; uncertain?: any[] }[];
  };

  const build = (script: Script, overrides: Partial<PaperImportConfig> = {}) => {
    const config = Object.assign(new PaperImportConfig(), overrides);
    const calls: { model: string; effort: string; images: number; content: string }[] = [];
    const ai = {
      completeStructured: jest.fn(async (opts: any) => {
        const ctx = {
          model: opts.model,
          effort: opts.reasoningEffort,
          images: opts.messages[0].images?.length ?? 0,
          content: opts.messages[0].content,
        };
        calls.push(ctx);
        const out = script(ctx);
        return {
          data: {
            language: 'ar',
            confidence: 0.5,
            blank: !!out.blank,
            regions: out.regions.map((r) => ({
              label: r.label ?? '',
              text: r.text,
              confidence: r.confidence ?? 0.5,
              uncertain: r.uncertain ?? [],
              math: [],
            })),
          },
          inputTokens: 1000,
          outputTokens: 300,
          costCents: 1,
        };
      }),
      // About what one low-effort crop read costs on the real pages: 0.9¢.
      costMillicents: () => 900,
    } as unknown as AiClient;
    const reader = new AdaptiveReaderService(ai, new ImageVariantsService(config), config);
    return { reader, calls, config };
  };

  const page = async () => renderFixture(FIXTURES.find((f) => f.id === 'dense-seven')!.render);

  const line = (n: number) => `(${n}) السؤال رقم ${n} عن الحساب والأرقام مثل ${n * 128}.`;

  /** A reader that reads every crop cleanly, numbering from the prompt's part. */
  const clearReader: Script = (ctx) => {
    if (ctx.images === 1 && /Transcribe every region/.test(ctx.content)) {
      return { regions: [{ text: '[UNCLEAR] [UNCLEAR] [UNCLEAR]' }] }; // the probe
    }
    const part = Number(/Part (\d+)/.exec(ctx.content)?.[1] ?? 1);
    return { regions: [{ text: line(part) }] };
  };

  it('does not give crops to the cheap model when it could not read the page', async () => {
    const { reader, calls, config } = build(clearReader);
    const result = await reader.transcribe(await page(), { pageNumber: 1 });

    const cropCalls = calls.slice(1);
    expect(cropCalls.length).toBeGreaterThan(0);
    expect(cropCalls.every((c) => c.model === config.fallbackModel)).toBe(true);
    expect(cropCalls.every((c) => c.effort === 'low')).toBe(true);
    expect(reader.lastRun!.reader).toBe('reader');
    expect(result.transcript!.regions.length).toBeGreaterThan(0);
  });

  it('never reaches high effort when low effort read everything', async () => {
    const { reader, calls } = build(clearReader);
    await reader.transcribe(await page(), { pageNumber: 1 });
    expect(calls.some((c) => c.effort === 'high' || c.effort === 'medium')).toBe(false);
  });

  it('keeps the cheap model as the reader for a page it can read', async () => {
    const { reader, calls, config } = build((ctx) => ({
      regions: [
        {
          text: /Transcribe every region/.test(ctx.content)
            ? 'نص مقروء بالكامل من أول الصفحة لآخرها '.repeat(3)
            : line(1),
        },
      ],
    }));
    await reader.transcribe(await page(), { pageNumber: 1 });
    expect(calls.every((c) => c.model === config.primaryModel)).toBe(true);
    expect(reader.lastRun!.reader).toBe('cheap');
  });

  it('puts a question number the model moved into the label back into the text', async () => {
    const { reader } = build((ctx) => {
      if (/Transcribe every region/.test(ctx.content)) return { regions: [{ text: '[UNCLEAR]' }] };
      return { regions: [{ label: '٢', text: 'اوجد قيمة الكسر الى ٤ أرقام عشرية مضبوطة' }] };
    });
    const result = await reader.transcribe(await page(), { pageNumber: 1 });
    expect(result.transcript!.regions[0].text.startsWith('(٢)')).toBe(true);
  });

  it('re-reads an unread number on its line, cheapest first, and says why', async () => {
    const { reader, calls } = build((ctx) => {
      if (/Transcribe every region/.test(ctx.content)) return { regions: [{ text: '[UNCLEAR]' }] };
      if (/One line/.test(ctx.content)) {
        // The enlarged line settles it at low effort.
        return { regions: [{ text: '(١) السؤال رقم 1 عن الحساب والأرقام مثل ٩٢٦١.' }] };
      }
      const part = Number(/Part (\d+)/.exec(ctx.content)?.[1] ?? 1);
      return part === 1
        ? {
            regions: [
              {
                text: '(١) السؤال رقم 1 عن الحساب والأرقام مثل [UNCLEAR].',
                uncertain: [{ text: '[UNCLEAR]', confidence: 0.2, reason: 'faint', numeric: true }],
              },
            ],
          }
        : { regions: [{ text: line(part) }] };
    });
    const result = await reader.transcribe(await page(), { pageNumber: 1 });

    expect(result.transcript!.regions.map((r) => r.text).join('\n')).toContain('٩٢٦١');
    const zooms = calls.filter((c) => /One line/.test(c.content));
    expect(zooms.length).toBeGreaterThan(0);
    expect(zooms.every((c) => c.effort === 'low')).toBe(true);
    expect(reader.lastRun!.escalations.some((e) => /UNREAD_TEXT/.test(String(e.reason)))).toBe(
      true,
    );
  });

  it('reads enlarged lines one per call — a batched line comes back as one region', async () => {
    // Production, 2026-09-24: both batched zoom calls answered one region for
    // four and for two images, were thrown away, and the lines were read one
    // by one anyway. Singly from the start is the same reading, minus the
    // wasted call.
    const { reader, calls } = build((ctx) => {
      if (/Transcribe every region/.test(ctx.content)) return { regions: [{ text: '[UNCLEAR]' }] };
      if (/One line/.test(ctx.content)) return { regions: [{ text: '(١) مثل ٩٢٦١.' }] };
      const part = Number(/Part (\d+)/.exec(ctx.content)?.[1] ?? 1);
      return part <= 3
        ? {
            regions: [
              {
                text: `(${part}) السؤال رقم ${part} عن الحساب والأرقام مثل [UNCLEAR].`,
                uncertain: [{ text: '[UNCLEAR]', confidence: 0.2, reason: 'faint', numeric: true }],
              },
            ],
          }
        : { regions: [{ text: line(part) }] };
    });
    await reader.transcribe(await page(), { pageNumber: 1 });
    const zooms = calls.filter((c) => /One line|single lines/.test(c.content));
    expect(zooms.length).toBeGreaterThan(1);
    expect(zooms.every((c) => c.images === 1)).toBe(true);
  });

  it('re-reads a batch that did not line up side by side, not one after another', async () => {
    let inflight = 0;
    let peak = 0;
    const { reader, calls } = build((ctx) => {
      if (/Transcribe every region/.test(ctx.content)) return { regions: [{ text: '[UNCLEAR]' }] };
      const part = Number(/Part (\d+)/.exec(ctx.content)?.[1] ?? 1);
      // A batch answers with one region for all its images: a mismatch.
      return { regions: [{ text: line(part) }] };
    });
    const ai = (reader as any).ai;
    const inner = ai.completeStructured;
    ai.completeStructured = jest.fn(async (opts: any) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      // Slower than rendering a crop, so calls that can overlap do.
      await new Promise((r) => setTimeout(r, 300));
      try {
        return await inner(opts);
      } finally {
        inflight -= 1;
      }
    });
    await reader.transcribe(await page(), { pageNumber: 1 });
    const batched = calls.filter((c) => c.images > 1);
    const singles = calls.filter((c) => c.images === 1 && /Part \d+/.test(c.content));
    expect(batched.length).toBeGreaterThan(0);
    expect(singles.length).toBeGreaterThan(1);
    expect(peak).toBeGreaterThan(1);
  });

  it('climbs past low effort only for an unread number, and never past the page budget', async () => {
    const stubborn: Script = (ctx) => {
      if (/Transcribe every region/.test(ctx.content)) return { regions: [{ text: '[UNCLEAR]' }] };
      return {
        regions: [
          {
            text: '(١) السؤال رقم 1 عن الحساب مثل [UNCLEAR].',
            uncertain: [{ text: '[UNCLEAR]', confidence: 0.1, reason: 'faint', numeric: true }],
          },
        ],
      };
    };
    const generous = build(stubborn, {
      adaptivePageBudgetCents: 1000,
      adaptiveMaxLinesPerChunk: 1,
    } as never);
    await generous.reader.transcribe(await page(), { pageNumber: 1 });
    // With money to spend: low, then medium, then high — on lines only.
    expect(generous.calls.some((c) => c.effort === 'medium')).toBe(true);
    expect(generous.calls.some((c) => c.effort === 'high')).toBe(true);
    expect(
      generous.calls.filter((c) => c.effort === 'high').every((c) => /One line/.test(c.content)),
    ).toBe(true);

    const tight = build(stubborn, {
      adaptivePageBudgetCents: 1,
      adaptiveMaxLinesPerChunk: 1,
    } as never);
    const result = await tight.reader.transcribe(await page(), { pageNumber: 1 });
    expect(tight.calls.some((c) => c.effort === 'high' || c.effort === 'medium')).toBe(false);
    // What could not be afforded is flagged, not hidden.
    expect(result.needsReview).toBe(true);
  });

  it('does not climb for an unread word that is not a number', async () => {
    const { reader, calls } = build((ctx) => {
      if (/Transcribe every region/.test(ctx.content)) return { regions: [{ text: '[UNCLEAR]' }] };
      return {
        regions: [
          {
            text: '(١) السؤال رقم 1 عن [UNCLEAR] والأرقام مثل ١٢٨.',
            uncertain: [{ text: '[UNCLEAR]', confidence: 0.1, reason: 'smudge', numeric: false }],
          },
        ],
      };
    });
    const result = await reader.transcribe(await page(), { pageNumber: 1 });
    expect(calls.some((c) => c.effort === 'medium' || c.effort === 'high')).toBe(false);
    expect(result.needsReview).toBe(true);
  });

  it('cuts the same page into the same crops every time', async () => {
    const a = build(clearReader);
    const b = build(clearReader);
    const img = await page();
    const la = await a.reader.layout(img);
    const lb = await b.reader.layout(img);
    expect(la.chunks).toEqual(lb.chunks);
    expect(la.chunks.length).toBeGreaterThan(1);
  });
});
