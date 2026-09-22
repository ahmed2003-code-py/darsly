import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { validateImageDataUrl } from '../common/image.util';
import { StorageProvider } from './storage.provider';

/**
 * Proof-of-payment screenshots, as objects rather than as rows.
 *
 * They were base64 data URLs in a text column — every listing of the payments
 * queue pulled every screenshot through Postgres, and the database carried the
 * one kind of data a database is worst at. They are objects now, under
 * `payment-proofs/`, and the column holds the key.
 *
 * The screenshot is still shown with a plain `<img>`, which cannot send a
 * bearer token. So what a reader is handed is a short-lived signed URL: the
 * key and an expiry, HMAC'd with the same secret that signs playback. The
 * endpoint checks the signature, not the session, and streams the object.
 * Ten minutes is long enough to review a queue and short enough that a URL
 * copied out of it is not a permanent leak.
 *
 * A row written before this — a `data:` URL — is returned exactly as it is.
 * Nothing about the API changes for the screens that show proofs; the value
 * just stops being a megabyte.
 */
const PREFIX = 'payment-proofs';
const TTL_SEC = 10 * 60;

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

@Injectable()
export class ProofStorageService {
  constructor(private readonly storage: StorageProvider) {}

  private get secret(): string {
    const s = process.env.VIDEO_SIGNING_SECRET ?? process.env.JWT_ACCESS_SECRET;
    if (!s) throw new Error('VIDEO_SIGNING_SECRET (or JWT_ACCESS_SECRET) must be set to sign proof URLs');
    return s;
  }

  /** Is this value a key of ours, rather than a legacy data URL or nothing? */
  static isKey(value: string | null | undefined): value is string {
    // Only keys this service minted have this shape: the prefix, then plain
    // path segments. `..`, empty segments, backslashes and control characters
    // are refused here as well as by the storage root guard — the link is a
    // capability, and a capability must never name anything outside its box.
    if (!value || !value.startsWith(PREFIX + '/')) return false;
    for (let c = 0; c < value.length; c++) {
      const code = value.charCodeAt(c);
      if (code < 0x20 || code === 0x7f || value[c] === String.fromCharCode(92)) return false;
    }
    return value.split('/').every((seg, i) => (i === 0 ? true : seg.length > 0 && seg !== '.' && seg !== '..'));
  }

  /**
   * Validate and store a screenshot the client sent as a data URL.
   *
   * Stored *before* the row that will point at it exists, so the object is
   * named by a random id rather than the row's: `payment-proofs/payments/
   * <uuid>.jpg`. The row keeps the key. If the row is never written, the
   * caller drops the object.
   */
  async store(kind: 'payments' | 'topups', dataUrl: string, maxBytes: number): Promise<string> {
    const { mime } = validateImageDataUrl(dataUrl, maxBytes);
    const body = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    const key = `${PREFIX}/${kind}/${randomUUID()}.${EXT[mime] ?? 'bin'}`;
    await this.storage.put(key, body, { contentType: mime, cacheControl: 'private, max-age=600' });
    return key;
  }

  /**
   * What to hand a screen that will put this in an `<img>`.
   *
   * A stored key becomes a signed URL. A legacy data URL, or nothing, comes
   * back untouched — the screens that render proofs do not have to know which
   * era a row is from.
   */
  urlFor(value: string | null | undefined): string | null {
    if (!value) return null;
    if (!ProofStorageService.isKey(value)) return value;
    const exp = Math.floor(Date.now() / 1000) + TTL_SEC;
    const token = this.sign(value, exp);
    const base = (process.env.API_URL ?? '').replace(/\/$/, '');
    return `${base}/api/v1/files/payment-proofs?k=${encodeURIComponent(value)}&e=${exp}&t=${token}`;
  }

  /** Best-effort removal, for a proof whose row was never written. */
  async discard(key: string): Promise<void> {
    await this.storage.delete(key).catch(() => undefined);
  }

  /** The object, once the URL's signature and expiry have been checked. */
  async open(key: string, exp: number, token: string) {
    if (!ProofStorageService.isKey(key)) throw new BadRequestException('Not a proof');
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('Proof link expired');
    }
    const expected = Buffer.from(this.sign(key, exp));
    const given = Buffer.from(token);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new UnauthorizedException('Invalid proof link');
    }
    return this.storage.getStream(key);
  }

  private sign(key: string, exp: number): string {
    return b64url(createHmac('sha256', this.secret).update(`${key}\n${exp}`).digest());
  }
}
