import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';

const jwt = new JwtService();

/**
 * Rate limits count per signed-in user, and per IP only for anonymous calls.
 *
 * Counting everything per IP punished people for sharing a network: Egyptian
 * mobile carriers put many subscribers behind one address, and a class in a
 * school lab shares one too. A group chat made that concrete — every message
 * refreshes every open member's conversation list, so thirty students on one
 * connection used up one IP's budget in seconds and got 429s.
 *
 * The user key is taken only from a token that VERIFIES: an unverified `sub`
 * would let anyone mint a fresh bucket per request by sending made-up tokens.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const header: unknown = req.headers?.authorization;
    const secret = process.env.JWT_ACCESS_SECRET;
    if (secret && typeof header === 'string' && header.startsWith('Bearer ')) {
      try {
        const payload = await jwt.verifyAsync<{ sub?: string }>(header.slice(7), {
          secret,
          algorithms: ['HS256'],
        });
        if (payload?.sub) return `u:${payload.sub}`;
      } catch {
        // An invalid or expired token is anonymous here — the IP counts.
      }
    }
    return super.getTracker(req);
  }
}
