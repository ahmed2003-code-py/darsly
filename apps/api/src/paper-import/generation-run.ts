import { Logger } from '@nestjs/common';
import { withAiTrace } from '../academy-site/ai/ai-trace';
import { DraftQuestion } from './extraction.schema';
import {
  apportion,
  ExamSpec,
  planQuestions,
  PlannedQuestion,
  scaleSpec,
  SPEC_QUESTION_TYPES,
} from './exam-spec';
import { GenerationBudget } from './generation-budget';
import { GenerationProfile, GenerationTier, PaperImportConfig } from './paper-import.config';
import {
  GeneratedQuestion,
  GenerationMode,
  GenerationRequest,
  GenerationResult,
  QuestionGeneratorService,
} from './question-generator.service';
import {
  findDuplicates,
  GradedQuestion,
  isQualityReason,
  questionProblem,
  repeatsPoint,
  variantNumbersProblem,
  RejectReason,
} from './question-quality';
import {
  chunkCapacity,
  selectChunksForBatch,
  SourceChunk,
  supportableQuestions,
  teachableLines,
} from './source-text';

let counter = 0;
const nextId = (): string =>
  `g${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * One exam, written slot by slot.
 *
 * The teacher's request becomes a list of slots — one per question, each with
 * the type, difficulty and marks it was ordered with — and the run's only job
 * is to fill them. That one idea is what the rules below follow from:
 *
 * - A question that passes is kept, in its slot, for good. Seven good and one
 *   bad is seven kept and one slot asked for again — never eight rewritten.
 * - A later round asks only for the empty slots, in the types they were
 *   ordered in, so the mix the teacher chose survives a rejection.
 * - Slots the material cannot carry as new questions are written as variants
 *   of what it did carry, and only as many as are missing.
 * - Nothing escalates to the flagship. A profile may name one fallback model,
 *   and only a slot that has failed deterministic checks on the first model
 *   is handed to it — alone, not with its batch.
 * - Every call reserves its worst case against a budget before it starts;
 *   one that could exceed it is not started, and the run ends partial and
 *   says so.
 *
 * Kept free of the database so it can be driven, unchanged, by the service
 * and by an offline comparison script.
 */

export type GenerationStopReason =
  'BUDGET' | 'CALLS' | 'ROUNDS' | 'MATERIAL' | 'NO_PROGRESS' | 'CANCELED';

type TypeCounts = Record<string, number>;

export interface GenerationCallLog {
  importId: string;
  profile: string;
  stage: 'INITIAL' | 'REPLACEMENT' | 'VARIANT';
  round: number;
  batch: number | null;
  mode: GenerationMode;
  model: string;
  effort: string;
  requested: number;
  requestedTypes: TypeCounts;
  /** How many of the requested slots had been asked for before. */
  replacements: number;
  returned: number;
  accepted: number;
  rejected: number;
  reasons: Partial<Record<RejectReason, number>>;
  /** What was rejected, abbreviated — and for a duplicate, what it repeated
   *  and how alike the two scored — so a rejection can be judged afterwards
   *  instead of taken on trust. */
  rejectedSamples: RejectedSample[];
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** From the provider's usage report, at configured prices. */
  millicents: number;
  /** What the budget counted — the recorded cost, or the reserved worst case
   *  for a call that failed with no usage report and may have been billed. */
  chargedMillicents: number;
  usageUnknown: boolean;
  durationMs: number;
  cumulativeMillicents: number;
  remainingBudgetMillicents: number;
  error: string | null;
}

export interface RejectedSample {
  reason: RejectReason;
  type: string;
  text: string;
  duplicateOf?: string;
  score?: number;
}

export interface GenerationReport {
  importId: string;
  profile: string;
  requested: number;
  /** How many distinct questions the material can carry, by chunkCapacity,
   *  and whether that covers what was asked for. */
  sourceCapacity: number;
  sourceSufficient: boolean;
  accepted: number;
  distinct: number;
  variants: number;
  requestedByType: TypeCounts;
  acceptedByType: TypeCounts;
  missingByType: TypeCounts;
  complete: boolean;
  stopReason: GenerationStopReason | null;
  /** Recorded: the sum of the calls' provider-reported usage at configured
   *  prices. Not the provider's invoice. */
  millicents: number;
  /** What the budget saw, which also holds worst cases for calls whose cost
   *  nobody could report. */
  chargedMillicents: number;
  budgetMillicents: number;
  calls: number;
  callsByModel: Record<string, number>;
  skippedForBudget: number;
  rounds: number;
  rejections: Partial<Record<RejectReason, number>>;
  durationMs: number;
  callLog: GenerationCallLog[];
}

export interface GenerationRunInput {
  importId: string;
  asked: ExamSpec;
  chunks: SourceChunk[];
  profile: GenerationProfile;
  budgetMillicents: number;
  /** False once the session has been stopped; checked before every call. */
  isLive?: () => Promise<boolean>;
  /** After each round, with how many slots are filled and calls made. */
  onProgress?: (accepted: number, calls: number) => Promise<void>;
}

interface Slot {
  /** Position in the exam that was ordered. */
  id: number;
  plan: PlannedQuestion;
  mode: GenerationMode;
  /** The call a DISTINCT slot is written in. */
  batch: number;
  /** The chunk a DISTINCT slot is to be written from. Spread over the
   *  material in proportion to what each chunk can carry, so one page is not
   *  asked for eight questions while the next is asked for one. */
  target: number | null;
  /** The numbered statement of that chunk it is to test (1-based), spread
   *  so no two slots share one while the chunk has statements left. */
  line: number | null;
  /** The accepted question a VARIANT slot varies, by id. */
  source: string | null;
  question: GradedQuestion | null;
  attempts: number;
  qualityFailures: number;
  lastReason: RejectReason | null;
  lastModel: string | null;
  /** Not asked for again: the material cannot carry it and variants are off,
   *  or there is nothing to vary. */
  dropped: boolean;
}

interface PlannedRequest {
  slots: Slot[];
  req: GenerationRequest;
  batch: number | null;
  fallback: boolean;
}

type Outcome =
  | { kind: 'done'; result: GenerationResult; charged: number }
  | { kind: 'skipped'; why: 'BUDGET' | 'CALLS' | 'CANCELED' };

type Generator = Pick<QuestionGeneratorService, 'generate' | 'worstCase'>;

export class GenerationRun {
  private readonly logger = new Logger('GenerationRun');

  constructor(
    private readonly generator: Generator,
    private readonly config: PaperImportConfig,
  ) {}

  async run(input: GenerationRunInput): Promise<{
    questions: GradedQuestion[];
    report: GenerationReport;
  }> {
    const started = Date.now();
    const { asked, chunks, profile } = input;
    const budget = new GenerationBudget(input.budgetMillicents);
    const variantsOn = this.config.generationVariantRounds > 0;
    const anchor = asked.language === 'AUTO';

    const capacity = supportableQuestions(chunks);
    const { slots, windows } = this.slotsFor(asked, chunks, capacity);
    const sourceUse = new Map<string, number>();
    if (!variantsOn) for (const s of slots) if (s.mode === 'VARIANT') s.dropped = true;

    const log: GenerationCallLog[] = [];
    const rejections: Partial<Record<RejectReason, number>> = {};
    const callsByModel: Record<string, number> = {};
    let calls = 0;
    let fallbackCalls = 0;
    let recorded = 0;
    let skippedForBudget = 0;
    let cappedByCalls = false;
    let canceled = false;
    let noProgress = false;
    let roundsRun = 0;

    for (let round = 0; round < this.config.generationRounds; round++) {
      const open = slots.filter((s) => !s.question && !s.dropped);
      if (!open.length) break;

      // Variants vary something. With nothing accepted yet there is nothing,
      // and asking anyway is a call for questions about nothing.
      const sources = slots.filter((s) => s.question && s.mode === 'DISTINCT');
      if (round > 0 && !sources.length) {
        for (const s of open) if (s.mode === 'VARIANT') s.dropped = true;
      }
      const wanted = open.filter((s) => !s.dropped && (round > 0 || s.mode === 'DISTINCT'));
      if (!wanted.length) break;

      const requests = this.requestsFor({
        round,
        slots: wanted,
        all: slots,
        windows,
        chunks,
        language: asked.language,
        profile,
        fallbackLeft: this.config.generationMaxFallbackCalls - fallbackCalls,
        sourceUse,
      });
      if (!requests.length) break;
      roundsRun += 1;

      const outcomes = await this.execute(requests, budget, input, round, {
        callsLeft: () => this.config.generationMaxCalls - calls,
        onStart: (r) => {
          calls += 1;
          callsByModel[r.req.tier.model] = (callsByModel[r.req.tier.model] ?? 0) + 1;
          if (r.fallback) fallbackCalls += 1;
        },
      });

      let acceptedThisRound = 0;
      requests.forEach((r, i) => {
        const outcome = outcomes[i];
        if (outcome.kind === 'skipped') {
          if (outcome.why === 'BUDGET') skippedForBudget += 1;
          if (outcome.why === 'CALLS') cappedByCalls = true;
          if (outcome.why === 'CANCELED') canceled = true;
          return;
        }
        const { result, charged } = outcome;
        recorded += result.millicents;
        const tally = this.absorb(r, result, slots, { anchor, variantsOn });
        acceptedThisRound += tally.accepted;
        for (const [k, n] of Object.entries(tally.reasons)) {
          rejections[k as RejectReason] = (rejections[k as RejectReason] ?? 0) + (n ?? 0);
        }
        const entry: GenerationCallLog = {
          importId: input.importId,
          profile: profile.name,
          stage: round === 0 ? 'INITIAL' : r.req.mode === 'VARIANT' ? 'VARIANT' : 'REPLACEMENT',
          round,
          batch: r.batch,
          mode: r.req.mode,
          model: result.model,
          effort: r.req.tier.effort,
          requested: r.slots.length,
          requestedTypes: countTypes(r.slots.map((s) => s.plan)),
          replacements: r.slots.filter((s) => s.attempts > 1).length,
          returned: result.questions.length,
          accepted: tally.accepted,
          rejected: result.questions.length - tally.accepted,
          reasons: tally.reasons,
          rejectedSamples: tally.samples,
          inputTokens: result.inputTokens,
          cachedInputTokens: result.cachedInputTokens ?? 0,
          outputTokens: result.outputTokens,
          reasoningTokens: result.reasoningTokens ?? 0,
          millicents: result.millicents,
          chargedMillicents: charged,
          usageUnknown: !!result.usageUnknown,
          durationMs: result.durationMs ?? 0,
          cumulativeMillicents: recorded,
          remainingBudgetMillicents: budget.remainingMillicents,
          error: result.error,
        };
        log.push(entry);
        this.logger.log(`GEN_CALL ${JSON.stringify(entry)}`);
      });

      await input.onProgress?.(slots.filter((s) => s.question).length, calls);
      if (canceled) break;

      // A round that added nothing, and whose next round would ask the same
      // model the same thing, is a round the next one would repeat.
      if (round > 0 && acceptedThisRound === 0) {
        const next = slots.filter((s) => !s.question && !s.dropped);
        const changesTier = next.some(
          (s) => this.tierFor(s, profile, Infinity).model !== s.lastModel,
        );
        if (!changesTier) {
          noProgress = true;
          break;
        }
      }
      if (skippedForBudget || cappedByCalls) break;
    }

    const filled = slots.filter((s) => s.question);
    const missing = slots.filter((s) => !s.question);
    let stopReason: GenerationStopReason | null = null;
    if (missing.length) {
      stopReason = canceled
        ? 'CANCELED'
        : skippedForBudget
          ? 'BUDGET'
          : cappedByCalls
            ? 'CALLS'
            : missing.every((s) => s.dropped)
              ? 'MATERIAL'
              : noProgress
                ? 'NO_PROGRESS'
                : 'ROUNDS';
    }

    const report: GenerationReport = {
      importId: input.importId,
      profile: profile.name,
      requested: slots.length,
      sourceCapacity: capacity,
      sourceSufficient: capacity >= slots.length,
      accepted: filled.length,
      distinct: filled.filter((s) => !s.question!.variant).length,
      variants: filled.filter((s) => s.question!.variant).length,
      requestedByType: countTypes(slots.map((s) => s.plan)),
      acceptedByType: countTypes(filled.map((s) => s.plan)),
      missingByType: countTypes(missing.map((s) => s.plan)),
      complete: !missing.length,
      stopReason,
      millicents: recorded,
      chargedMillicents: budget.spentMillicents,
      budgetMillicents: input.budgetMillicents,
      calls,
      callsByModel,
      skippedForBudget,
      rounds: roundsRun,
      rejections,
      durationMs: Date.now() - started,
      callLog: log,
    };
    const { callLog: _omit, ...summary } = report;
    this.logger.log(`GEN_SUMMARY ${JSON.stringify(summary)}`);

    return { questions: filled.map((s) => s.question!), report };
  }

  // ── planning ─────────────────────────────────────────────────────────────

  /**
   * The exam as ordered, as slots. As many of them as the material can carry
   * — by type, in proportion — are written as new questions; the rest, when
   * it is too short, as variants.
   *
   * Each new-question slot is given a chunk to be written from, in proportion
   * to what each chunk can carry, and the slots are cut into batches of even
   * size by chunk. Without this the first batch took the first chunk and all
   * its slots: a seven-problem arithmetic page was asked for eight questions
   * (two came back as repeats of each other) while a fourteen-fact revision
   * sheet beside it was asked for one — and every later variant came from the
   * arithmetic page too.
   */
  private slotsFor(
    asked: ExamSpec,
    chunks: SourceChunk[],
    capacity: number,
  ): { slots: Slot[]; windows: SourceChunk[][] } {
    const plan = planQuestions(asked);
    const distinct = scaleSpec(asked, capacity).types;
    const left: Record<string, number> = { ...distinct };
    const slots: Slot[] = plan.map((p, i) => {
      const isDistinct = (left[p.type] ?? 0) > 0;
      if (isDistinct) left[p.type] -= 1;
      return {
        id: i,
        plan: p,
        mode: isDistinct ? 'DISTINCT' : 'VARIANT',
        batch: -1,
        target: null,
        line: null,
        source: null,
        question: null,
        attempts: 0,
        qualityFailures: 0,
        lastReason: null,
        lastModel: null,
        dropped: false,
      };
    });

    const fresh = slots.filter((s) => s.mode === 'DISTINCT');
    const quota = quotas(fresh.length, chunks.map(chunkCapacity));
    const remaining = [...quota];
    for (const slot of fresh) {
      // The chunk furthest behind its share, so types spread across chunks
      // rather than one chunk taking every multiple choice.
      let best = -1;
      for (let i = 0; i < chunks.length; i++) {
        if (!remaining[i]) continue;
        if (best < 0 || remaining[i] / quota[i] > remaining[best] / quota[best]) best = i;
      }
      if (best < 0) best = 0;
      remaining[best] = Math.max(0, remaining[best] - 1);
      slot.target = chunks[best]?.index ?? null;
    }

    // A statement per slot within each chunk: spread over the whole chunk
    // when it has more statements than slots, in turn when it has fewer.
    for (const chunk of chunks) {
      const mine = fresh.filter((s) => s.target === chunk.index);
      const n = teachableLines(chunk.text);
      if (!n) continue;
      mine.forEach((s, k) => {
        s.line = mine.length <= n ? Math.floor((k * n) / mine.length) + 1 : (k % n) + 1;
      });
    }

    // Even batches, in the material's order: ten slots are 5 + 5, not 8 + 2,
    // because batches run side by side and the slowest one is the wait.
    const order = new Map(chunks.map((c, i) => [c.index, i]));
    const byChunk = [...fresh].sort(
      (a, b) => (order.get(a.target ?? -1) ?? 0) - (order.get(b.target ?? -1) ?? 0) || a.id - b.id,
    );
    const count = Math.max(1, Math.ceil(byChunk.length / this.config.generationBatchSize));
    const windows: SourceChunk[][] = [];
    let at = 0;
    for (let b = 0; b < count; b++) {
      const size = Math.floor(byChunk.length / count) + (b < byChunk.length % count ? 1 : 0);
      const group = byChunk.slice(at, at + size);
      at += size;
      for (const s of group) s.batch = b;
      const wanted = new Set(group.map((s) => s.target));
      const window = chunks.filter((c) => wanted.has(c.index));
      windows.push(
        window.length
          ? window
          : selectChunksForBatch(chunks, b, count, this.config.generationSourceTokens),
      );
    }
    return { slots, windows };
  }

  /** The first model, unless this slot has failed its checks on it often
   *  enough and the profile has somewhere else to send it. */
  private tierFor(slot: Slot, profile: GenerationProfile, fallbackLeft: number): GenerationTier {
    if (
      profile.fallback &&
      fallbackLeft > 0 &&
      slot.qualityFailures >= this.config.generationEscalateAfter
    ) {
      return profile.fallback;
    }
    return profile.primary;
  }

  private requestsFor(opts: {
    round: number;
    slots: Slot[];
    all: Slot[];
    windows: SourceChunk[][];
    chunks: SourceChunk[];
    language: ExamSpec['language'];
    profile: GenerationProfile;
    fallbackLeft: number;
    sourceUse: Map<string, number>;
  }): PlannedRequest[] {
    const size = this.config.generationBatchSize;
    const accepted = opts.all.filter((s) => s.question);
    const groups = new Map<string, { slots: Slot[]; tier: GenerationTier; batch: number | null }>();
    for (const slot of opts.slots) {
      const tier = this.tierFor(slot, opts.profile, Infinity);
      const key = `${slot.mode}|${slot.mode === 'DISTINCT' ? slot.batch : 'v'}|${tier.model}`;
      const group = groups.get(key) ?? {
        slots: [],
        tier,
        batch: slot.mode === 'DISTINCT' ? slot.batch : null,
      };
      group.slots.push(slot);
      groups.set(key, group);
    }
    // Fallback calls are capped per exam; past the cap a slot stays on the
    // first model rather than going anywhere dearer.
    let fallbackLeft = opts.fallbackLeft;
    const tierOf = (group: { tier: GenerationTier }): GenerationTier => {
      if (group.tier === opts.profile.primary) return group.tier;
      if (fallbackLeft <= 0) return opts.profile.primary;
      fallbackLeft -= 1;
      return group.tier;
    };

    const out: PlannedRequest[] = [];
    for (const group of groups.values()) {
      const pieces: Slot[][] = [];
      for (let i = 0; i < group.slots.length; i += size)
        pieces.push(group.slots.slice(i, i + size));
      const mode = group.slots[0].mode;

      if (mode === 'DISTINCT') {
        const material = opts.windows[group.batch ?? 0] ?? opts.windows[0];
        for (const piece of pieces) {
          const tier = tierOf(group);
          out.push({
            slots: piece,
            batch: group.batch,
            fallback: tier !== opts.profile.primary,
            req: {
              tier,
              mode,
              plan: piece.map((s) => s.plan),
              targets: piece.map((s) => s.target),
              lines: piece.map((s) => s.line),
              chunks: material,
              language: opts.language,
              avoid: avoidFor(accepted, material, []),
              reason: reasonFor(piece),
            },
          });
        }
        continue;
      }

      // Variants: each slot is given one accepted question to vary — the
      // least-varied so far, and from a chunk this call has not used yet when
      // there is one — so twelve variants are not five versions of the same
      // pension problem, and two calls at once are not varying the same one.
      const sources = accepted.filter((s) => s.mode === 'DISTINCT').map((s) => s.question!);
      for (const piece of pieces) {
        const chunksHere = new Set<number | null | undefined>();
        const own: GradedQuestion[] = [];
        const variantOf: number[] = [];
        for (const slot of piece) {
          const pick = [...sources].sort(
            (a, b) =>
              (opts.sourceUse.get(a.id) ?? 0) - (opts.sourceUse.get(b.id) ?? 0) ||
              Number(chunksHere.has(a.chunkIndex)) - Number(chunksHere.has(b.chunkIndex)),
          )[0];
          opts.sourceUse.set(pick.id, (opts.sourceUse.get(pick.id) ?? 0) + 1);
          chunksHere.add(pick.chunkIndex);
          slot.source = pick.id;
          if (!own.includes(pick)) own.push(pick);
          variantOf.push(own.indexOf(pick) + 1);
        }
        const material = materialFor(own, opts.chunks, this.config.generationSourceTokens);
        const tier = tierOf(group);
        out.push({
          slots: piece,
          batch: null,
          fallback: tier !== opts.profile.primary,
          req: {
            tier,
            mode,
            plan: piece.map((s) => s.plan),
            variantOf,
            chunks: material,
            language: opts.language,
            source: own.map((q) => ({ text: q.text, modelAnswer: q.modelAnswer })),
            avoid: avoidFor(accepted, material, own),
            reason: reasonFor(piece),
          },
        });
      }
    }
    return out;
  }

  // ── running ──────────────────────────────────────────────────────────────

  /**
   * Run one round's calls, a few at a time, each only once its worst case
   * fits in what the budget has left. A call that does not fit waits for one
   * in flight to settle — which usually frees most of what it held — and is
   * skipped only when nothing is left in flight to wait for.
   */
  private async execute(
    requests: PlannedRequest[],
    budget: GenerationBudget,
    input: GenerationRunInput,
    round: number,
    hooks: { callsLeft: () => number; onStart: (r: PlannedRequest) => void },
  ): Promise<Outcome[]> {
    const outcomes: Outcome[] = new Array(requests.length);
    const queue = requests.map((_, i) => i);
    const inflight = new Set<Promise<void>>();
    let stopped = false;

    while (queue.length || inflight.size) {
      for (const i of [...queue]) {
        if (inflight.size >= this.config.generationConcurrency) break;
        const drop = (why: 'BUDGET' | 'CALLS' | 'CANCELED') => {
          outcomes[i] = { kind: 'skipped', why };
          queue.splice(queue.indexOf(i), 1);
        };
        if (stopped) {
          drop('CANCELED');
          continue;
        }
        if (hooks.callsLeft() <= 0) {
          drop('CALLS');
          continue;
        }
        if (input.isLive && !(await input.isLive())) {
          stopped = true;
          drop('CANCELED');
          continue;
        }
        const r = requests[i];
        const worst = this.generator.worstCase(r.req);
        const hold = budget.reserve(worst);
        if (!hold) {
          if (!inflight.size) drop('BUDGET');
          continue;
        }
        queue.splice(queue.indexOf(i), 1);
        hooks.onStart(r);
        r.slots.forEach((s) => {
          s.attempts += 1;
          s.lastModel = r.req.tier.model;
        });
        const p: Promise<void> = withAiTrace(
          {
            stage:
              round === 0
                ? 'QUESTION_GENERATION'
                : r.req.mode === 'VARIANT'
                  ? 'QUESTION_VARIANTS'
                  : 'QUESTION_REPLACEMENT',
            batch: r.batch ?? undefined,
            attempt: round,
            meta: {
              profile: input.profile.name,
              planned: countTypes(r.req.plan),
              slots: r.slots.map((s) => s.id),
              fallback: r.fallback,
            },
          },
          () => this.generator.generate(r.req),
        )
          .then((result) => {
            // A call that failed with no usage report may still have been
            // billed (a timeout the provider finished anyway). The budget
            // assumes the worst of it; the recorded cost does not invent it.
            const charged =
              result.usageUnknown && result.error && /time ?out|timed out|abort/i.test(result.error)
                ? hold.amount
                : result.millicents;
            budget.settle(hold, charged);
            outcomes[i] = { kind: 'done', result, charged };
          })
          .finally(() => inflight.delete(p));
        inflight.add(p);
      }
      if (inflight.size) await Promise.race(inflight);
    }
    return outcomes;
  }

  // ── accepting ────────────────────────────────────────────────────────────

  /**
   * Put what came back into the slots it can fill, one question at a time.
   *
   * By type, not by position: a model that writes the true/false before the
   * multiple choice has still written both. A question of a type nobody in
   * this request ordered is refused, whatever else is right with it.
   */
  private absorb(
    r: PlannedRequest,
    result: GenerationResult,
    all: Slot[],
    opts: { anchor: boolean; variantsOn: boolean },
  ): {
    accepted: number;
    reasons: Partial<Record<RejectReason, number>>;
    samples: RejectedSample[];
  } {
    const reasons: Partial<Record<RejectReason, number>> = {};
    const samples: RejectedSample[] = [];
    const sample = (
      reason: RejectReason,
      w: GeneratedQuestion,
      extra: Partial<RejectedSample> = {},
    ) => {
      if (samples.length < 12) {
        samples.push({
          reason,
          type: String(w?.type ?? ''),
          text: (w?.text ?? '').slice(0, 120),
          ...extra,
        });
      }
    };
    const blame = (slot: Slot | undefined, reason: RejectReason) => {
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      if (!slot || slot.question) return;
      slot.lastReason = reason;
      if (isQualityReason(reason)) slot.qualityFailures += 1;
    };

    if (result.error) {
      for (const s of r.slots) blame(s, 'CALL_FAILED');
      return { accepted: 0, reasons, samples };
    }

    const open = [...r.slots];
    const touched = new Set<Slot>();
    let accepted = 0;
    const byIndex = new Map(r.req.chunks.map((c) => [c.index, c]));

    result.questions.forEach((w, i) => {
      const positional = r.slots[i];
      const type = w?.type;
      // Its own type first, then the chunk its line named, then difficulty.
      const same = (s: Slot) => s.plan.type === type;
      const target =
        open.find(
          (s) => same(s) && s.target === w.chunkIndex && s.plan.difficulty === w.difficulty,
        ) ??
        open.find((s) => same(s) && s.target === w.chunkIndex) ??
        open.find((s) => same(s) && s.plan.difficulty === w.difficulty) ??
        open.find(same);
      // Every question that comes back uses up the slot it was written for,
      // pass or fail — otherwise a rejected question's reason lands on a slot
      // the next question then fills, and the slot left empty is blamed for
      // nothing.
      const use = (slot: Slot) => {
        touched.add(slot);
        const at = open.indexOf(slot);
        if (at >= 0) open.splice(at, 1);
      };
      if (!target) {
        const reason = r.slots.some((s) => s.plan.type === type) ? 'SURPLUS' : 'TYPE_MISMATCH';
        const slot = positional && open.includes(positional) ? positional : undefined;
        blame(slot, reason);
        sample(reason, w);
        if (slot) use(slot);
        return;
      }
      use(target);
      const question = build(w, target, byIndex);
      const chunk = question.chunkIndex != null ? byIndex.get(question.chunkIndex) : undefined;
      const problem = questionProblem(question, {
        chunkText: chunk?.text ?? null,
        anchor: opts.anchor,
        numbers: target.mode !== 'VARIANT',
      });
      if (problem) {
        blame(target, problem);
        sample(problem, w);
        return;
      }
      if (target.mode === 'VARIANT') {
        const original = all.find((s) => s.question?.id === target.source)?.question ?? null;
        if (variantNumbersProblem(question, original, chunk?.text ?? '')) {
          blame(target, 'UNSUPPORTED_NUMBER');
          sample('UNSUPPORTED_NUMBER', w);
          return;
        }
      }
      const onExam = all.filter((s) => s.question).map((s) => s.question!);
      const dup = findDuplicates(
        [...onExam, question].map((q) => ({ id: q.id, text: q.text })),
      ).find((d) => d.id === question.id);
      if (dup) {
        blame(target, 'DUPLICATE');
        sample('DUPLICATE', w, {
          duplicateOf: onExam.find((q) => q.id === dup.duplicateOfId)?.text.slice(0, 120),
          score: Math.round(dup.score * 100) / 100,
        });
        return;
      }
      // After DUPLICATE, never instead of it: a reworded question is a
      // duplicate; a different question on a fact already tested is
      // SAME_POINT. A variant tests an existing question's idea on purpose,
      // so only new questions are held to it.
      const samePoint =
        target.mode === 'DISTINCT' ? onExam.find((q) => repeatsPoint(question, q)) : undefined;
      if (samePoint) {
        blame(target, 'SAME_POINT');
        sample('SAME_POINT', w, { duplicateOf: samePoint.text.slice(0, 120) });
        return;
      }
      target.question = target.mode === 'VARIANT' ? { ...question, variant: true } : question;
      target.lastReason = null;
      accepted += 1;
    });

    for (const s of open) if (!touched.has(s)) blame(s, 'NOT_RETURNED');
    const unfilled = r.slots.filter((s) => !s.question);

    // A new-question slot the material would not fill — the model said so,
    // or wrote nothing for it, or wrote a repeat — is not going to be filled
    // by asking the same material again. It becomes a variant, or, with
    // variants off, a shortfall.
    if (r.req.mode === 'DISTINCT') {
      for (const s of unfilled) {
        const exhausted =
          result.insufficient ||
          s.lastReason === 'NOT_RETURNED' ||
          s.lastReason === 'DUPLICATE' ||
          s.lastReason === 'SAME_POINT' ||
          s.lastReason === 'SURPLUS';
        if (!exhausted) continue;
        if (opts.variantsOn) {
          s.mode = 'VARIANT';
          s.qualityFailures = 0;
        } else {
          s.dropped = true;
        }
      }
    }
    return { accepted, reasons, samples };
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * One question outside a run — the review screen's "write this one again" —
 * through exactly the checks a run applies: its type, its form, its anchor in
 * the material, and not a repeat of anything else on the exam.
 */
export function acceptOne(
  w: GeneratedQuestion,
  planned: PlannedQuestion,
  material: SourceChunk[],
  others: { id: string; text: string }[],
  anchor: boolean,
): { question: GradedQuestion | null; reason: RejectReason | null } {
  if (w.type !== planned.type) return { question: null, reason: 'TYPE_MISMATCH' };
  const byIndex = new Map(material.map((c) => [c.index, c]));
  const question = build(w, { plan: planned }, byIndex);
  const chunk = question.chunkIndex != null ? byIndex.get(question.chunkIndex) : undefined;
  const problem = questionProblem(question, {
    chunkText: chunk?.text ?? null,
    anchor,
    numbers: true,
  });
  if (problem) return { question: null, reason: problem };
  const dup = findDuplicates([...others, { id: question.id, text: question.text }]).some(
    (d) => d.id === question.id,
  );
  return dup ? { question: null, reason: 'DUPLICATE' } : { question, reason: null };
}

function build(
  w: GeneratedQuestion,
  slot: Pick<Slot, 'plan'>,
  chunks: Map<number, SourceChunk>,
): GradedQuestion {
  const chunk = chunks.get(w.chunkIndex);
  const type = slot.plan.type as DraftQuestion['type'];
  return {
    id: nextId(),
    number: 0,
    type,
    text: (w.text ?? '').trim(),
    options:
      type === 'SHORT_ANSWER'
        ? []
        : (w.options ?? [])
            .filter((o) => (o?.text ?? '').trim())
            .map((o) => ({
              id: nextId(),
              label: (o.label ?? '').trim(),
              text: o.text.trim(),
              correct: !!o.correct,
            })),
    modelAnswer: (w.modelAnswer ?? '').trim(),
    // What was ordered for this slot, whatever the model wrote.
    marks: slot.plan.marks,
    // The page of the uploaded material this came off, so the review
    // screen can say "biology.pdf — page 8" and mean it.
    sourcePages: chunk?.page ? [chunk.page] : [],
    sourceFile: chunk?.sourceFile ?? '',
    unsupportedKind: '',
    needsReview: false,
    chunkIndex: chunk ? chunk.index : null,
  };
}

/** The questions already on the exam that this call could plausibly repeat:
 *  those written from the material it is being given. Not the whole exam —
 *  a question about chapter 1 is not a risk for a batch on chapter 4. */
function avoidFor(accepted: Slot[], material: SourceChunk[], exclude: GradedQuestion[]): string[] {
  const inMaterial = new Set(material.map((c) => c.index));
  const skip = new Set(exclude.map((q) => q.id));
  return accepted
    .map((s) => s.question!)
    .filter((q) => !skip.has(q.id) && q.chunkIndex != null && inMaterial.has(q.chunkIndex))
    .map((q) => q.text);
}

/** For variants, the chunks the questions being varied came from — enough
 *  to ground a variant, a fraction of the whole lecture. */
function materialFor(
  sources: GradedQuestion[],
  chunks: SourceChunk[],
  maxTokens: number,
): SourceChunk[] {
  const wanted = new Set(sources.map((q) => q.chunkIndex).filter((n) => n != null));
  const own = chunks.filter((c) => wanted.has(c.index));
  const pool = own.length ? own : chunks;
  const out: SourceChunk[] = [];
  let tokens = 0;
  for (const chunk of pool) {
    if (tokens + chunk.tokensApprox > maxTokens && out.length) break;
    out.push(chunk);
    tokens += chunk.tokensApprox;
  }
  return out.length ? out : selectChunksForBatch(chunks, 0, 1, maxTokens);
}

/** What went wrong last time with the slots being asked for again, in words
 *  the model can act on. Only the reasons it can act on. */
function reasonFor(slots: Slot[]): string | undefined {
  const words: Partial<Record<RejectReason, string>> = {
    NO_KEY: 'it had no correct answer marked or no model answer',
    MULTIPLE_KEYS: 'more than one option was marked correct',
    BAD_OPTIONS: 'its options were the wrong number or repeated each other',
    NO_OPTIONS: 'it had no options',
    UNGROUNDED: 'it was not answerable from the chunk it named',
    TYPE_MISMATCH: 'it was not the question type asked for',
    EMPTY_TEXT: 'it was empty or a fragment',
    PLACEHOLDER: 'it was a placeholder, not a question',
    DUPLICATE: 'it repeated a question already on the exam',
    SAME_POINT: 'it tested a fact another question on the exam already tests',
    UNSUPPORTED_NUMBER: 'it gave a number the material does not state',
  };
  const said = [...new Set(slots.map((s) => s.lastReason).filter(Boolean))]
    .map((r) => words[r as RejectReason])
    .filter(Boolean);
  return said.length ? said.join('; ') : undefined;
}

/**
 * `total` shared over chunks in proportion to what each can carry, never
 * more than a chunk can carry while another still has room.
 */
function quotas(total: number, capacities: number[]): number[] {
  if (!capacities.length) return [];
  const share = apportion(
    total,
    Object.fromEntries(capacities.map((c, i) => [String(i), Math.max(0, c)])),
  );
  const out = capacities.map((_, i) => share[String(i)] ?? 0);
  let over = 0;
  out.forEach((n, i) => {
    if (n > capacities[i]) {
      over += n - capacities[i];
      out[i] = capacities[i];
    }
  });
  while (over > 0) {
    let roomiest = -1;
    out.forEach((n, i) => {
      const room = capacities[i] - n;
      if (room > 0 && (roomiest < 0 || room > capacities[roomiest] - out[roomiest])) roomiest = i;
    });
    if (roomiest < 0) {
      // More asked for than the material carries: the rest goes where it
      // would have gone anyway; variants are for the difference.
      out[0] += over;
      break;
    }
    out[roomiest] += 1;
    over -= 1;
  }
  return out;
}

function countTypes(plan: { type: string }[]): TypeCounts {
  const out: TypeCounts = {};
  for (const t of SPEC_QUESTION_TYPES) out[t] = 0;
  for (const q of plan) out[q.type] = (out[q.type] ?? 0) + 1;
  return out;
}
