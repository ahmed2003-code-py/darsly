/**
 * When Enter sends.
 *
 * - With a hardware keyboard: Enter sends, Shift+Enter is a new line.
 * - On a touch device the on-screen Enter is the only way to start a new
 *   line, so it never sends — the send button does (Ctrl/⌘+Enter still does,
 *   for a tablet with a keyboard attached).
 * - Never while an input method is composing: Arabic and other IME keyboards
 *   press Enter to accept a suggestion, and that must not fire a half-typed
 *   message. `keyCode 229` is how some browsers report it instead.
 */
export function shouldSendOnKey(
  e: {
    key: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    isComposing?: boolean;
    keyCode?: number;
  },
  touchFirst: boolean,
): boolean {
  if (e.key !== 'Enter') return false;
  if (e.isComposing || e.keyCode === 229) return false;
  if (e.ctrlKey || e.metaKey) return true;
  if (touchFirst) return false;
  return !e.shiftKey;
}
