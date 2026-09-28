/**
 * Initials for an avatar with no picture: the first letter of the first and
 * the last name — "Ahmed Mohamed" → "AM", "Ahmed" → "A", "أحمد محمد" → "أم".
 *
 * Titles are skipped so "أ. عمرو فاروق" is "عف", not "أف", and anything that
 * is not a word ("·", "(smoke)"'s bracket) is looked through to its first
 * letter or digit. Never empty: a name with no letters at all gets "؟".
 */
const HONORIFICS =
  /^(أ|أ\.|د|د\.|م|م\.|mr\.?|mrs\.?|ms\.?|dr\.?|prof\.?|أستاذ|الأستاذ|أستاذة|الأستاذة|دكتور|الدكتور|دكتورة|الدكتورة|مستر|مس)$/i;

function firstLetter(word: string): string {
  const m = word.match(/[\p{L}\p{N}]/u);
  return m ? m[0] : '';
}

export function initials(name: string | null | undefined): string {
  const words = (name ?? '')
    .trim()
    .split(/\s+/)
    .filter((w) => w && !HONORIFICS.test(w) && firstLetter(w));
  if (!words.length) return '؟';
  const first = firstLetter(words[0]);
  const last = words.length > 1 ? firstLetter(words[words.length - 1]) : '';
  return (first + last).toLocaleUpperCase();
}

/**
 * A stable colour slot (0–3) for someone, from their id — the same person is
 * always the same colour, and the colour never depends on their name.
 */
export function avatarTone(id: string | null | undefined): 0 | 1 | 2 | 3 {
  let h = 0;
  for (const ch of id ?? '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 4) as 0 | 1 | 2 | 3;
}
