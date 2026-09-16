import { PaymentMethod } from '@darsly/shared-types';

/**
 * Pure SMS parsing + sender classification helpers — no framework/DB deps so they
 * are trivially unit-testable and identical to the logic documented for the app.
 *
 * The backend is authoritative for money-affecting fields: even though the phone
 * classifies and parses locally, the server re-derives provider/amount/reference
 * from the raw body before anything can auto-verify a payment ("never trust the
 * client alone").
 */

export type SenderMatchType = 'EXACT' | 'CONTAINS' | 'REGEX';

export interface SenderRuleLike {
  brand: string;
  matchType: SenderMatchType;
  pattern: string;
  provider: PaymentMethod;
  enabled: boolean;
  forwardToBackend: boolean;
  priority: number;
}

export interface Classification {
  brand: string;
  provider: PaymentMethod;
  forwardToBackend: boolean;
}

/**
 * Normalize an SMS sender id for matching: trim, collapse whitespace, lowercase.
 * Sender ids arrive in many shapes ("CIB", "CIB-Bank", "VodafoneCash", short
 * codes) so matching is done case-insensitively on this normalized form.
 */
export function normalizeSender(sender: string): string {
  return (sender ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Classify a sender against the (backend-driven) rule set. Rules are considered
 * in ascending `priority` (lower wins); the first enabled rule that matches is
 * returned. Returns null when no rule matches — such SMS stay local-only.
 */
export function classifySender(sender: string, rules: SenderRuleLike[]): Classification | null {
  const norm = normalizeSender(sender);
  const ordered = [...rules].filter((r) => r.enabled).sort((a, b) => a.priority - b.priority);
  for (const rule of ordered) {
    if (senderMatches(norm, rule)) {
      return { brand: rule.brand, provider: rule.provider, forwardToBackend: rule.forwardToBackend };
    }
  }
  return null;
}

/**
 * Collapse a sender id to the characters that actually identify it: letters and
 * digits, nothing else.
 *
 * Real sender ids spell the same brand every which way — `VF-Cash`, `VF Cash`,
 * `VFCash`, `CIB-Bank`, `Vodafone.Cash`. Matching on the raw text means a rule
 * written as `vfcash` silently misses `VF-Cash`, and a payment SMS stays
 * local-only. Stripping separators before EXACT/CONTAINS lets one rule cover
 * every spelling. REGEX deliberately still matches the plain normalized id, so a
 * rule author who needs punctuation keeps full control.
 */
export function senderMatchKey(value: string): string {
  return normalizeSender(value).replace(/[^\p{L}\p{N}]/gu, '');
}

function senderMatches(normalizedSender: string, rule: SenderRuleLike): boolean {
  const senderKey = senderMatchKey(normalizedSender);
  const patternKey = senderMatchKey(rule.pattern);
  switch (rule.matchType) {
    case 'EXACT':
      return senderKey === patternKey;
    case 'CONTAINS':
      return !!patternKey && senderKey.includes(patternKey);
    case 'REGEX':
      try {
        // Match against the raw (untrimmed-case) sender via a case-insensitive
        // regex so authors can write natural patterns.
        return new RegExp(rule.pattern, 'i').test(normalizedSender);
      } catch {
        // A malformed backend regex must never crash ingestion — treat as no match.
        return false;
      }
  }
}

/**
 * Extract an EGP amount in integer piasters. Handles Arabic ("استلمت 450 ج.م",
 * "5,000 جنيه") and English ("received EGP 5,000.00", "EGP5000") forms.
 * Returns null when no currency-qualified amount is present (ignores OTP codes,
 * balances embedded without a currency token, etc.).
 */
export function parseAmountCents(body: string): number | null {
  if (!body) return null;
  const currency = '(?:ج\\.?\\s?م|جنيه|جنيهًا|EGP|LE|L\\.E\\.?|E£)';
  const number = '(\\d{1,3}(?:[,\\s]\\d{3})*(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)';
  // amount before OR after the currency token
  const re = new RegExp(`${number}\\s*${currency}|${currency}\\s*${number}`, 'i');
  const m = body.match(re);
  if (!m) return null;
  const raw = (m[1] ?? m[2] ?? '').replace(/[,\s]/g, '');
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

/**
 * Best-effort transaction/reference extraction. Prefers an explicit labelled
 * reference (Arabic "رقم العملية"/"رقم مرجعي" or English ref/txn/transaction),
 * falling back to a standalone 6+ digit run. Returns null when none is found —
 * and without a reference the backend NEVER auto-verifies (manual review only).
 */
/**
 * Is this message money *arriving*, or money *leaving*?
 *
 * The listener sits on a phone that both receives and sends. A bank SMS like
 * "تم تنفيذ تحويل لحظي بمبلغ 15.00 جم **من حسابك**" is an outgoing debit, and
 * booking it as an incoming payment would credit an enrollment nobody paid for.
 * Anything that is not clearly incoming is rejected — the cost of missing a
 * payment (manual review) is far lower than the cost of inventing one.
 */
export function isIncomingTransfer(body: string): boolean {
  if (!body) return false;
  const outgoing = /(?:من\s*حساب[كك]|من\s*محفظت[كك]|تم\s*خصم|خصم\s*مبلغ|debited|sent\s*to|withdrawn)/i;
  if (outgoing.test(body)) return false;
  const incoming =
    /(?:تم\s*استلام|استلمت|تم\s*إضافة|تم\s*اضافة|أضيف|اضيف|received|credited|deposit)/i;
  if (incoming.test(body)) return true;
  // A bank does not say "received". InstaPay and CIB announce an arrival as a
  // transfer that was *executed into* your account — «تم تنفيذ تحويل لحظي
  // بمبلغ 5.00 جم إلى حسابك المنتهي بـ **7717 من ...». The direction is carried
  // entirely by the preposition, and the outgoing test above has already taken
  // «من حسابك» off the table, so this cannot turn a debit into a credit.
  return /(?:إلى|الى|ل)\s*(?:حساب|محفظة|محفظت)[كك]|(?:to|into)\s+your\s+(?:account|wallet)/i.test(
    body,
  );
}

/**
 * Every identifier the message could plausibly be matched on, most trustworthy
 * first.
 *
 * A wallet SMS carries the *sender's mobile number* — the thing the student
 * actually knows and types at checkout. A bank SMS carries a *transaction
 * reference* the student can read off their own receipt. Both appear, and which
 * one the student entered is not ours to guess, so the matcher is given all of
 * them and accepts a hit on any.
 *
 * The receiving wallet's own number is excluded: it appears in every message
 * ("على رقم محفظتك 01002589923") and matching on it would tie every transfer to
 * whichever student happened to type the platform's number.
 */
export function parseIdentities(body: string, receivingNumbers: string[] = []): string[] {
  if (!body) return [];
  const excluded = new Set(receivingNumbers.map((n) => n.replace(/[^0-9]/g, '').slice(-10)));
  const out: string[] = [];
  const push = (value?: string | null) => {
    const v = (value ?? '').trim();
    if (!v) return;
    const digits = v.replace(/[^0-9]/g, '');
    if (digits.length >= 10 && excluded.has(digits.slice(-10))) return;
    if (!out.some((existing) => existing.toLowerCase() === v.toLowerCase())) out.push(v);
  };

  // The sending wallet's mobile number — "من رقم 01029166461".
  for (const m of body.matchAll(/(?:^|[^\d])((?:\+?20|0)?1[0125]\d{8})(?![\d])/g)) push(m[1]);

  // A labelled transaction reference — banks send these.
  const labelled = body.match(
    /(?:رقم\s*العملية|رقم\s*مرجعي|الرقم\s*المرجعي|reference|ref(?:erence)?\.?|txn|transaction|trx)\s*[:#.\-]?\s*([A-Za-z0-9\-]{4,})/i,
  );
  push(labelled?.[1]);

  // Any other long run of digits, as a last resort.
  for (const m of body.matchAll(/\b(\d{6,})\b/g)) push(m[1]);

  return out;
}

/**
 * The single best identifier, for display and for the legacy single-reference
 * path. Matching itself uses [parseIdentities] and accepts any of them.
 */
export function parseReference(body: string): string | null {
  if (!body) return null;

  // 1. An explicitly labelled transaction id, when the sender bothers to send one
  //    (banks usually do).
  const labelled = body.match(
    /(?:رقم\s*العملية|رقم\s*مرجعي|الرقم\s*المرجعي|reference|ref(?:erence)?\.?|txn|transaction|trx)\s*[:#.\-]?\s*([A-Za-z0-9\-]{4,})/i,
  );
  if (labelled?.[1]) return labelled[1];

  // 2. The sending wallet's mobile number. Wallet SMS ("تم استلام مبلغ 5 جنيه من
  //    رقم 01029166461") carry no transaction id at all — the sender's number IS
  //    the transfer's identity, and it is what the student types at checkout.
  //    Preferred over the generic digit run below so a balance or a date printed
  //    earlier in the message cannot be mistaken for the identity.
  const mobile = body.match(/(?:^|[^\d])((?:\+?20|0)?1[0125]\d{8})(?![\d])/);
  if (mobile?.[1]) return mobile[1];

  // 3. Last resort: any long digit run.
  const digits = body.match(/\b(\d{6,})\b/);
  return digits?.[1] ?? null;
}

/**
 * Deterministic idempotency id for an SMS, matching the app's local dedupe key:
 * SHA-256(normalizedSender + ' ' + body + ' ' + receivedAtEpochSeconds).
 * `sha256` is injected so this stays a pure function (Node crypto in prod, any
 * impl in tests).
 */
export function messageHash(
  sender: string,
  body: string,
  receivedAt: Date,
  sha256: (input: string) => string,
): string {
  const epochSec = Math.floor(receivedAt.getTime() / 1000);
  return sha256(`${normalizeSender(sender)} ${body ?? ''} ${epochSec}`);
}

/**
 * Fold an Arabic name to the form two spellings of the same person share.
 *
 * The name on a transfer and the name on an account are the same person spelled
 * by two different systems: «أحمد عبد العزيز هريدي» on the register, «احمد
 * عبدالعزيز هريدى» in the SMS. Neither is wrong, and a comparison that treats
 * them as different people is worse than no comparison at all — so the
 * differences that carry no meaning are folded away first:
 *
 *  - hamza and madda on alif (أ إ آ ٱ → ا), which Egyptians type both ways
 *  - final ya (ى → ي) and final ta marbuta (ة → ه), likewise
 *  - harakat and tatweel, which are decoration
 *  - Arabic-Indic digits, so a name with a number in it still compares
 *  - "عبد العزيز" against "عبدالعزيز": spaces go entirely, because where the
 *    break in a compound name falls is not information
 *  - honorifics, which one side prints and the other does not
 */
export function normalizeArabicName(value: string): string {
  return (value ?? '')
    .normalize('NFKC')
    // Harakat, tatweel, and the zero-width marks that ride along with RTL text.
    .replace(/[\u0610-\u061A\u064B-\u0652\u0640\u200B-\u200F\u0670\u06D6-\u06ED]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/[ىئي]/g, 'ي')
    .replace(/[ؤ]/g, 'و')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    // Anchored on whitespace, not \b: that is an ASCII word boundary and never
    // matches beside an Arabic letter, so this whole list used to do nothing.
    .replace(/(?:^|\s)(?:الاستاذه|الاستاذ|السيده|السيد|الست|دكتور|مهندس|مستر)(?=\s|$)/g, ' ')
    .replace(/\b(?:mr|mrs|ms|dr|eng)\b\.?/gi, '')
    .toLowerCase()
    // Everything that is not a letter or a digit, spaces included.
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** The same name split into its parts, folded, for token-by-token comparison. */
export function nameParts(value: string): string[] {
  return (value ?? '')
    .split(/[\s\u00A0]+/)
    .map(normalizeArabicName)
    .filter((p) => p.length >= 2);
}

/**
 * Does the name on the transfer belong to the person who says they sent it?
 *
 * Not equality. The two names are rarely character-identical even after
 * folding: a bank prints three of four parts and truncates the fourth («ادهم
 * محمد اشرف يسري ابو»), a student registers with two. What does hold is that
 * the parts they do share must agree — so this asks whether the shorter name's
 * parts all appear in the longer one, plus the given names line up.
 *
 * Deliberately not a similarity score. A threshold on a distance metric passes
 * two different people with common Egyptian names («محمد أحمد» and «محمد
 * علي») far too often, and this decides whether to take someone's money for a
 * course they did not buy.
 */
export function namesAgree(a: string, b: string): boolean {
  const left = nameParts(a);
  const right = nameParts(b);
  // One name, or a single-word name, is not evidence either way.
  if (left.length < 2 || right.length < 2) return false;

  // The first part is the given name, and it has to be the same person's.
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter[0] !== longer[0]) return false;

  // Every part of the shorter name appears in the longer one. A bank that
  // truncates the last part still agrees on the parts it printed; an entirely
  // different person does not.
  return shorter.every((part) =>
    longer.some((other) => other === part || other.startsWith(part) || part.startsWith(other)),
  );
}

/**
 * The name of the person who sent the money, when the message says.
 *
 * Both providers print it, in their own shape:
 *
 *   Vodafone Cash  «تم استلام مبلغ 10.00 جنيه من 01284120292؛
 *                   المسجل بإسم احمد عبدالعزيز هريدى على رقم محفظتك …»
 *   CIB / InstaPay «تم تنفيذ تحويل لحظي بمبلغ 2.00 جم إلى حسابك المنتهي بـ
 *                   7717******** من ادهم محمد اشرف يسري ابو برقم مرجعي …»
 *
 * This is the one piece of evidence a student cannot copy off somebody else's
 * receipt: the reference and the amount are on the screenshot they were sent,
 * but the name is whoever actually holds the wallet. It is what turns "a
 * transfer of this size arrived around then" into "this person paid".
 *
 * Returns null rather than a guess. A wrong name is worse than no name, because
 * the matcher weighs a mismatch as evidence against.
 */
/**
 * Words that are never the last part of somebody's name.
 *
 * The bank pattern takes the name greedily up to «برقم», and a real CIB message
 * puts a preposition in between — «من احمد عبدالعزيز هريدى **على** برقم مرجعي
 * 3979e788». That preposition then rode into the name, and `namesAgree` refused
 * the student's own account because the transfer looked like it came from a
 * four-part person who does not exist. Trailing particles are dropped, one at a
 * time; nothing in the middle is touched, because «عبد» belongs there.
 */
const NAME_TAIL_WORDS = new Set(['على', 'علي', 'عل', 'عن', 'من', 'في', 'لدى', 'الى', 'إلى', 'ب', 'بـ']);

function trimNameTail(name: string | undefined): string | undefined {
  if (!name) return name;
  const parts = name.split(/\s+/);
  while (parts.length > 2 && NAME_TAIL_WORDS.has(normalizeArabicName(parts[parts.length - 1]))) {
    parts.pop();
  }
  return parts.join(' ');
}

export function parsePayerName(body: string): string | null {
  if (!body) return null;

  const patterns = [
    // Vodafone Cash: registered-name clause, ending at the next clause.
    /(?:المسجل|المسجله|مسجل)\s*(?:بإسم|باسم|بأسم)\s*([^\d\n]{3,60}?)\s*(?:على|علي|عن|بتاريخ|$)/,
    // Bank / InstaPay: "from <name>" ending at the reference clause.
    // Anchored on start-of-line or whitespace for the same reason, and the name
    // is taken greedily up to a *whitespace-separated* terminator: read lazily,
    // it stopped a letter early and took the "ب" out of "برقم" into the name.
    /(?:^|[\s*\u0640])من\s+((?:[\u0621-\u064A]+\s+){1,5}[\u0621-\u064A]+)(?=\s+(?:برقم|بتاريخ|رقم\s*مرجعي)|\s*$)/m,
    // English-language equivalents, for senders that send them.
    /\bfrom\s+([A-Za-z][A-Za-z.'\-\s]{2,59}?)\s*(?:with|ref|on|at|$)/i,
  ];

  for (const re of patterns) {
    const name = trimNameTail(body.match(re)?.[1]?.trim().replace(/\s+/g, ' '));
    // Two parts minimum: a single word is as likely to be a stray preposition
    // as a name, and namesAgree would refuse it anyway.
    if (name && nameParts(name).length >= 2) return name;
  }
  return null;
}
