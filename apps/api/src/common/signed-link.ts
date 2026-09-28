import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Short-lived capability links for things an `<img>` or a download has to
 * fetch without a bearer header (avatars, chat attachments).
 *
 * A link is `subject + expiry`, HMAC'd with the same secret that signs
 * playback and payment proofs, and bound to a PURPOSE — so a token minted for
 * one user's avatar can never open an attachment, even if the subject strings
 * happened to collide. Access is decided by whoever MINTS the link (after the
 * normal authorization); the endpoint that serves it only checks the signature.
 *
 * Expiries are rounded up to a window so the same object keeps the same URL
 * for a while and the browser can cache it, instead of every page load
 * producing a new URL for the same bytes.
 */
export type LinkPurpose = 'avatar' | 'chat-file';

function secret(): string {
  const s = process.env.VIDEO_SIGNING_SECRET ?? process.env.JWT_ACCESS_SECRET;
  if (!s) throw new Error('VIDEO_SIGNING_SECRET (or JWT_ACCESS_SECRET) must be set to sign links');
  return s;
}

const b64url = (b: Buffer) =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * An expiry at least `minTtlSec` away, rounded up to a multiple of `windowSec`,
 * so every link minted inside the same window is identical.
 */
export function windowedExpiry(minTtlSec: number, windowSec: number, now = Date.now()): number {
  const earliest = Math.floor(now / 1000) + minTtlSec;
  return Math.ceil(earliest / windowSec) * windowSec;
}

export function signLink(purpose: LinkPurpose, subject: string, exp: number): string {
  return b64url(createHmac('sha256', secret()).update(`${purpose}\n${subject}\n${exp}`).digest());
}

/** True only for an unexpired link minted for exactly this purpose and subject. */
export function verifyLink(
  purpose: LinkPurpose,
  subject: string,
  exp: number,
  token: string,
  now = Date.now(),
): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(now / 1000)) return false;
  if (typeof token !== 'string' || !token) return false;
  const expected = Buffer.from(signLink(purpose, subject, exp));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** `/api/v1/…` under API_URL when set (split deployments), same-origin otherwise. */
export function apiPath(path: string): string {
  const base = (process.env.API_URL ?? '').replace(/\/$/, '');
  return `${base}/api/v1${path}`;
}

// ── Avatars ──────────────────────────────────────────────────────────────────

/** A day-stable signed URL for a user's avatar, or null when there is none. */
export function avatarUrl(user: {
  id: string;
  avatarUrl?: string | null;
  updatedAt?: Date | null;
}): string | null {
  if (!user.avatarUrl) return null;
  // A remote URL is already an image URL; only our stored data URLs need serving.
  if (/^https?:\/\//i.test(user.avatarUrl)) return user.avatarUrl;
  const v = (user.updatedAt?.getTime() ?? 0).toString(36);
  const exp = windowedExpiry(24 * 3600, 24 * 3600);
  const t = signLink('avatar', `${user.id}:${v}`, exp);
  return apiPath(`/files/avatars/${encodeURIComponent(user.id)}?v=${v}&e=${exp}&t=${t}`);
}

// ── Chat files ───────────────────────────────────────────────────────────────

export type ChatFileVariant = 'full' | 'preview' | 'download';

/** A signed URL for one attachment variant — mint only after the thread gate. */
export function chatFileUrl(attachmentId: string, variant: ChatFileVariant): string {
  const exp = windowedExpiry(6 * 3600, 6 * 3600);
  const t = signLink('chat-file', `${attachmentId}:${variant}`, exp);
  return apiPath(`/files/chat/${encodeURIComponent(attachmentId)}?v=${variant}&e=${exp}&t=${t}`);
}
