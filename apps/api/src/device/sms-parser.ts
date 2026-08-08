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
  return incoming.test(body);
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
