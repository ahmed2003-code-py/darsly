import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

export interface PlaybackClaims {
  /** playback session id */
  sid: string;
  /** user id */
  uid: string;
  /** video asset id — the token only unlocks files under hls/<aid>/ */
  aid: string;
  /** lesson id (for logging/enforcement) */
  lid: string;
  /** forensic watermark id */
  wm: string;
  /** 1 for teacher/admin preview (no DB PlaybackSession row to re-check) */
  pv?: 1;
  /** expiry, epoch seconds */
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Stateless, expiring, HMAC-signed playback tokens. A token authorizes access
 * to exactly one asset's encrypted HLS files for a short window and is bound to
 * the playback session + user + watermark. Segments, playlists, and the key
 * endpoint all verify the same token; the key endpoint additionally re-checks
 * live session state in the DB (belt and suspenders).
 *
 * The signing secret is dedicated (VIDEO_SIGNING_SECRET), independent of the
 * JWT secrets, so leaking a playback URL can never affect auth tokens.
 */
@Injectable()
export class SignedUrlService {
  private get secret(): string {
    // Dedicated secret, falling back to the (boot-validated) JWT access secret.
    // No hardcoded fallback: a missing secret must fail, not sign with a public
    // string. validateConfig() guarantees at least one of these is strong in prod.
    const s = process.env.VIDEO_SIGNING_SECRET ?? process.env.JWT_ACCESS_SECRET;
    if (!s) {
      throw new Error('VIDEO_SIGNING_SECRET (or JWT_ACCESS_SECRET) must be set to sign playback tokens');
    }
    return s;
  }

  private get ttl(): number {
    return Number(process.env.SIGNED_URL_TTL_SECONDS ?? 300);
  }

  sign(claims: Omit<PlaybackClaims, 'exp'>, ttlSec?: number): string {
    const full: PlaybackClaims = {
      ...claims,
      exp: Math.floor(Date.now() / 1000) + (ttlSec ?? this.ttl),
    };
    const body = b64url(Buffer.from(JSON.stringify(full)));
    const sig = b64url(createHmac('sha256', this.secret).update(body).digest());
    return `${body}.${sig}`;
  }

  verify(token: string): PlaybackClaims {
    const dot = token.lastIndexOf('.');
    if (dot < 0) throw new BadRequestException('Malformed playback token');
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = b64url(createHmac('sha256', this.secret).update(body).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid playback signature');
    }
    let claims: PlaybackClaims;
    try {
      claims = JSON.parse(unb64url(body).toString());
    } catch {
      throw new BadRequestException('Malformed playback token');
    }
    if (claims.exp * 1000 < Date.now()) {
      throw new UnauthorizedException('Playback URL expired');
    }
    return claims;
  }

  /** Guard against path traversal / cross-asset access from a valid token. */
  assertKeyBelongsToAsset(claims: PlaybackClaims, storageKey: string): void {
    const prefix = `hls/${claims.aid}/`;
    if (!storageKey.startsWith(prefix) || storageKey.includes('..')) {
      throw new UnauthorizedException('Token does not authorize this object');
    }
  }
}
