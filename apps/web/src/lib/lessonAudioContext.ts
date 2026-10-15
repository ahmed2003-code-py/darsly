/**
 * The one AudioContext the lesson's audio capture runs on.
 *
 * Per-speaker capture used to make a new AudioContext for every microphone,
 * from inside a timer — never from a click. A browser may start such a
 * context suspended (Safari does, Chrome can), and a suspended context hears
 * nothing: every piece measured as silence and was thrown away, while the
 * classroom still said the lesson was being transcribed.
 *
 * So there is one context, primed from the teacher's own click (the record
 * button, the capture switch), resumed again on any later click, and asked
 * whether it is really running — what the capture reports as its health.
 */
let ctx: AudioContext | null = null;
let gestureHooked = false;

function create(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  if (!ctx || ctx.state === 'closed') ctx = new AudioContext();
  return ctx;
}

/** Any click on the page is a chance to resume a context the browser held back. */
function hookGestures() {
  if (gestureHooked || typeof window === 'undefined') return;
  gestureHooked = true;
  const resume = () => {
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  };
  window.addEventListener('pointerdown', resume, true);
  window.addEventListener('keydown', resume, true);
}

/** Call from inside a click handler: the browser lets a context start there. */
export function primeLessonAudio(): void {
  const c = create();
  hookGestures();
  if (c && c.state === 'suspended') void c.resume().catch(() => undefined);
}

/** The shared context (created on first use; resumed if it can be). */
export function lessonAudioContext(): AudioContext | null {
  const c = create();
  hookGestures();
  if (c && c.state === 'suspended') void c.resume().catch(() => undefined);
  return c;
}

/** Whether audio is really being processed right now. */
export function lessonAudioRunning(): boolean {
  return !!ctx && ctx.state === 'running';
}

/** Tests only. */
export function resetLessonAudioContext(): void {
  ctx = null;
}
