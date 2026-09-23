/**
 * The part of a YouTube description that is about the video.
 *
 * Most of a channel's description is not: handles, affiliate links, a credits
 * roll, a mailing address, hashtags, "subscribe and hit the bell". Importing it
 * whole put somebody else's Snapchat and a list of producers into a lesson,
 * which is worse than no description — a teacher then has to read it all to
 * find the two sentences worth keeping.
 *
 * This keeps prose and drops the rest. It is deliberately conservative: a line
 * it is unsure about is kept, because dropping a real sentence is the more
 * expensive mistake.
 */

/** A line that exists to point somewhere else rather than to say something. */
const LINKISH = [
  /https?:\/\//i,
  /www\.[a-z0-9-]+\./i,
  /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i, // an email address
  /\bwa\.me\b|\bwa\.link\b|\bt\.me\b|\bbit\.ly\b/i,
];

/** A line that is a social handle, a platform name, or a credit. */
const CHANNEL_FURNITURE = [
  /^\s*[-–—•*]?\s*\/?\s*@?[a-z0-9._-]{2,40}\s*$/i, // a bare handle: "/ omr94"
  /^\s*(instagram|snapchat|tiktok|facebook|twitter|x|youtube|telegram|whatsapp|linkedin|threads|discord|pinterest|reddit|twitch)\b/i,
  /^\s*(انستجرام|انستغرام|سناب|سناب شات|تيك توك|فيس ?بوك|تويتر|تليجرام|تليغرام|واتس ?اب|واتساب|يوتيوب)\b/,
  /^\s*(producer|production|director|videographer|editor|montage|composer|camera|dop|graphic|sound|mixing|mastering|voice ?over|presenter|host|writer|script)\b/i,
  /^\s*(إنتاج|انتاج|إخراج|اخراج|تصوير|مونتاج|مكساج|تأليف|إعداد|اعداد|تقديم|صوت|جرافيك|مخرج|منتج|مصور)\b/,
  /^\s*(business|for business|business advertising|for ads|advertis|sponsor|partnership|contact|للإعلان|للاعلان|للتواصل|إعلانات|اعلانات|رعاية)\b/i,
  /^\s*(subscribe|like and subscribe|hit the bell|turn on notifications)\b/i,
  /^\s*(اشترك|اشتركوا|فعّل الجرس|فعل الجرس|لايك|شير|اشترك في القناة)\b/,
  /^\s*(copyright|all rights reserved|©|جميع الحقوق)\b/i,
  /^\s*(music|track|song|beat)\s*[:：-]/i,
];

/** A line that is only hashtags, or only punctuation and emoji. */
function isDecoration(line: string): boolean {
  const bare = line.trim();
  if (!bare) return false;
  if (/^#[^\s#]+(\s+#[^\s#]+)*$/.test(bare)) return true;
  // Nothing a person reads: no letter and no digit anywhere in it.
  return !/[\p{L}\p{N}]/u.test(bare);
}

/**
 * A heading that marks where the description stops being about the video.
 * Everything from here down is dropped, because credits do not resume.
 */
const TAIL_MARKERS = [
  /^\s*[-–—=_*•\s]{3,}\s*$/, // a divider rule
  /^\s*(business advertising|for business)\s*$/i,
  /^\s*(credits|crew|team|cast|staff)\s*[:：]?\s*$/i,
  /^\s*(فريق العمل|طاقم العمل|الفريق|الكريدت)\s*[:：]?\s*$/,
  /^\s*(follow (me|us)|social|socials|my links|links?)\s*[:：]?\s*$/i,
  /^\s*(تابعني|تابعونا|حساباتي|روابط|السوشيال)\s*[:：]?\s*$/,
  // A role on a line of its own is a credits heading, and the names under it
  // are what made the first pass keep "Adel Hassan" as though it were prose.
  // Anchored at both ends, so a sentence that merely mentions production stays.
  /^\s*(production|producer|director|videographer|editor|montage|camera|dop|graphic design|sound|mixing|mastering|voice ?over|presenter|host|writer|script)\s*[:：]?\s*$/i,
  /^\s*(إنتاج|انتاج|إخراج|اخراج|تصوير|مونتاج|مكساج|تأليف|إعداد|اعداد|تقديم|جرافيك|مخرج|منتج|مصور)\s*[:：]?\s*$/,
];

/**
 * The line with its ornaments taken off.
 *
 * These lines almost always open with an emoji or a bullet — "🔗 Instagram",
 * "📱 Business" — and an anchored pattern never sees past it.
 */
function bareOf(line: string): string {
  return line
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
    .trim();
}

function isNoise(line: string): boolean {
  const raw = line.trim();
  if (!raw) return false;
  if (isDecoration(raw)) return true;
  const bare = bareOf(raw) || raw;
  if (CHANNEL_FURNITURE.some((re) => re.test(bare))) return true;
  // A line that is mostly a link, rather than a sentence that contains one.
  if (LINKISH.some((re) => re.test(raw))) {
    const withoutLinks = raw.replace(/https?:\/\/\S+|www\.\S+|\S+@\S+/gi, '').trim();
    const words = withoutLinks.split(/\s+/).filter(Boolean);
    return words.length < 5;
  }
  return false;
}

export function cleanYoutubeDescription(raw: string, maxChars = 1000): string {
  if (!raw) return '';
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');

  const kept: string[] = [];
  for (const line of lines) {
    // Tested with the ornaments off too: these headings arrive as "🎬 Production".
    const bare = bareOf(line);
    if (TAIL_MARKERS.some((re) => re.test(line) || (bare && re.test(bare)))) break;
    if (isNoise(line)) continue;
    kept.push(line.trimEnd());
  }

  const text = kept
    .join('\n')
    // Three blank lines where a block was removed should read as one break.
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (text.length <= maxChars) return text;
  // Cut on a sentence if there is one nearby, so it does not end mid-word.
  const cut = text.slice(0, maxChars);
  const stop = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('۔'), cut.lastIndexOf('\n'));
  return (stop > maxChars * 0.6 ? cut.slice(0, stop + 1) : cut).trim();
}

/**
 * Is what survived the clean actually worth showing a student?
 *
 * The rules above remove noise line by line, and on a description that was
 * *all* noise they leave debris: two stray words, a leftover fragment of a
 * credits block, a row of dashes with a name after it. That debris then became
 * the lesson's description, which is worse than an empty one — a teacher sees a
 * filled field and does not think to write anything, and the student reads
 * somebody's abandoned hashtag.
 *
 * So the output has to clear a floor to be used at all. Nothing here tries to
 * judge whether the prose is *good*; it only refuses text that is plainly not
 * prose.
 */
export function looksUsableDescription(text: string): boolean {
  const t = (text ?? '').trim();
  if (t.length < 40) return false; // a fragment, not a description

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 8) return false;

  // Mostly symbols and emoji rather than letters: decoration that survived
  // because it had a digit in it.
  const letters = (t.match(/[\p{L}]/gu) ?? []).length;
  if (letters / t.length < 0.5) return false;

  // A wall of very short lines is a list of handles or credits, not a paragraph.
  const lines = t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length >= 3 && lines.every((l) => l.split(/\s+/).length <= 3)) return false;

  return true;
}
