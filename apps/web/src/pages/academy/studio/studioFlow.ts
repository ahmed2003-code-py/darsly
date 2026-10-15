/**
 * The Studio's build flow, as rules a page can ask.
 *
 * The bug this exists for: in the guided flow a teacher picked a colour on the
 * Generate step and pressed "Next" — the step's own Next, always enabled —
 * which opened Preview with no page made: "no page to preview yet". Going
 * back reset the colour to the first one. Nothing was wrong with the colour;
 * the flow let Preview open before anything had been generated.
 *
 *  - Preview, the editor and Publish need a generated draft.
 *  - On the Generate step, Next means "my page is made" — not "I chose a colour".
 *  - The colour the teacher chose is kept across steps and reloads, and a
 *    returning teacher starts from the colour of their last generation.
 *  - A failed generation is told by its stable code, never the provider's text.
 */
export const PALETTE_KEYS = [
  'royal',
  'teal',
  'sunset',
  'forest',
  'berry',
  'amber',
  'sky',
  'slate',
] as const;
export type PaletteKey = (typeof PALETTE_KEYS)[number];

export type StudioStep =
  'facts' | 'media' | 'generate' | 'editor' | 'preview' | 'publish' | 'settings';

/** Steps that show or change a generated page. */
const NEEDS_DRAFT: StudioStep[] = ['editor', 'preview', 'publish'];

export interface FlowState {
  /** A generated draft exists (the overview's `hasDraft`). */
  hasDraft: boolean;
  /** A generation is queued or running. */
  generating: boolean;
}

/** Whether a step can be opened now. */
export function stepOpen(step: StudioStep, s: FlowState): boolean {
  return !NEEDS_DRAFT.includes(step) || s.hasDraft;
}

/** Whether "Next" may leave this step; the reason when it may not. */
export function canAdvance(
  step: StudioStep,
  s: FlowState,
): { ok: true } | { ok: false; reason: 'GENERATE_FIRST' | 'GENERATING' } {
  if (step === 'generate') {
    if (s.generating) return { ok: false, reason: 'GENERATING' };
    if (!s.hasDraft) return { ok: false, reason: 'GENERATE_FIRST' };
  }
  return { ok: true };
}

const isPalette = (k: unknown): k is PaletteKey =>
  typeof k === 'string' && (PALETTE_KEYS as readonly string[]).includes(k);

const storageKey = (academy: string) => `darsly-studio-palette:${academy}`;

/** The colour to start from: this session's pick, else the last generation's, else the first. */
export function initialPalette(academy: string, lastJobPalette?: string | null): PaletteKey {
  try {
    const kept = sessionStorage.getItem(storageKey(academy));
    if (isPalette(kept)) return kept;
  } catch {
    /* no storage: fall through */
  }
  return isPalette(lastJobPalette) ? lastJobPalette : 'royal';
}

export function rememberPalette(academy: string, key: PaletteKey): void {
  try {
    sessionStorage.setItem(storageKey(academy), key);
  } catch {
    /* best effort */
  }
}

/** Codes the server sends for a failed generation (job-error-code.ts), each with its own copy. */
export const GENERATION_ERROR_CODES = [
  'AI_PROVIDER_UNAVAILABLE',
  'AI_PROVIDER_BUSY',
  'AI_PROVIDER_TIMEOUT',
  'AI_PROVIDER_ERROR',
  'AI_REQUEST_REFUSED',
  'AI_OUTPUT_INVALID',
  'AI_DISABLED',
  'AI_FAILED',
  'SITE_FACTS_MISSING',
  'SITE_GENERATION_FAILED',
] as const;

/** The translation key for a failed generation — a known code's own, or the generic one. */
export function generationErrorKey(code: string | null | undefined): string {
  return code && (GENERATION_ERROR_CODES as readonly string[]).includes(code)
    ? `studio.generate.errors.${code}`
    : 'studio.generate.failedGeneric';
}

/** Whether trying again can help (an account problem or missing facts will not fix itself). */
export function retryHelps(code: string | null | undefined): boolean {
  return !['AI_PROVIDER_UNAVAILABLE', 'AI_DISABLED', 'SITE_FACTS_MISSING'].includes(code ?? '');
}
