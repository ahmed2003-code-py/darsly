import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { IceServer } from './live-provider';

/**
 * Cloudflare Realtime SFU, over its HTTPS API — and the only place its secret
 * is used.
 *
 * The browser never calls Cloudflare: it calls Darsly's RTC endpoints, which
 * decide whether the request is allowed and then call this. So the app secret
 * travels Railway → this process → Cloudflare and nowhere else — not to the
 * page, not into a log line, not into the database.
 *
 * API: https://developers.cloudflare.com/realtime/sfu/https-api/
 * (sessions/new, tracks/new, renegotiate, tracks/close, GET session).
 */

const API = 'https://rtc.live.cloudflare.com/v1';
/** A class is waiting on most of these calls: fail fast, never hang. */
const CALL_TIMEOUT_MS = 8_000;
/**
 * The public STUN server Cloudflare documents for the SFU. TURN (relay for
 * networks that block UDP) needs a separate TURN key — see `iceServers`.
 */
export const CF_STUN: IceServer = { urls: 'stun:stun.cloudflare.com:3478' };
/** Short-lived TURN credentials: comfortably past the longest class. */
const TURN_TTL_SEC = 13 * 60 * 60;

export interface CfSessionDescription {
  sdp: string;
  type: 'offer' | 'answer';
}

export interface CfTrackResult {
  mid?: string;
  trackName?: string;
  sessionId?: string;
  location?: 'local' | 'remote';
  errorCode?: string;
  errorDescription?: string;
}

export interface CfTracksResponse {
  requiresImmediateRenegotiation?: boolean;
  sessionDescription?: CfSessionDescription;
  tracks?: CfTrackResult[];
  errorCode?: string;
  errorDescription?: string;
}

export interface CfSessionState {
  tracks?: (CfTrackResult & { status?: 'active' | 'inactive' | 'initializing' })[];
}

/** Why a call failed, for logs and for the caller's decision to retry. */
export type CfFailure = 'config' | 'timeout' | 'unreachable' | 'rejected' | 'auth' | 'server';

export class CloudflareRealtimeError extends Error {
  constructor(
    readonly failure: CfFailure,
    readonly status: number | null,
    message: string,
    readonly errorCode?: string,
  ) {
    super(message);
  }
}

/** Cloudflare ids are long hex; logs keep the shape and drop the value. */
export function redactPath(path: string): string {
  return path.replace(/[0-9a-f]{16,}/gi, '<id>');
}

export function cloudflareConfig(env: NodeJS.ProcessEnv = process.env) {
  const appId = env.CF_REALTIME_APP_ID?.trim() || undefined;
  const secret = env.CF_REALTIME_APP_SECRET?.trim() || undefined;
  const turnKeyId = env.CF_TURN_KEY_ID?.trim() || undefined;
  const turnToken = env.CF_TURN_KEY_API_TOKEN?.trim() || undefined;
  return { appId, secret, turnKeyId, turnToken };
}

@Injectable()
export class CloudflareRealtimeClient {
  private readonly logger = new Logger('CloudflareRealtime');
  /** Injected in tests; the global fetch otherwise. */
  fetchImpl: typeof fetch = (...a) => fetch(...a);

  get configured(): boolean {
    const c = cloudflareConfig();
    return !!(c.appId && c.secret);
  }

  get turnConfigured(): boolean {
    const c = cloudflareConfig();
    return !!(c.turnKeyId && c.turnToken);
  }

  /**
   * One call to the SFU API.
   *
   * `retries` only for calls that are safe to repeat: reading a session,
   * closing tracks, opening a fresh session (an unused one expires on its own).
   * Never for tracks/new or renegotiate, where a repeat after a lost answer
   * would add tracks twice or apply an answer to the wrong offer.
   */
  private async call<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    opts: { retries?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    const { appId, secret } = cloudflareConfig();
    if (!appId || !secret) {
      throw new CloudflareRealtimeError('config', null, 'CF_REALTIME_APP_ID/SECRET not set');
    }
    const url = `${API}/apps/${appId}${path}`;
    const safe = redactPath(path);
    const attempts = 1 + (opts.retries ?? 0);
    let last: CloudflareRealtimeError | undefined;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 200 * 2 ** (i - 1)));
      const t0 = Date.now();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? CALL_TIMEOUT_MS),
        });
      } catch (e) {
        const timeout = (e as Error)?.name === 'TimeoutError';
        last = new CloudflareRealtimeError(
          timeout ? 'timeout' : 'unreachable',
          null,
          `${method} ${safe} ${timeout ? 'timed out' : 'unreachable'}`,
        );
        this.logger.warn(`${last.message} (attempt ${i + 1}/${attempts})`);
        continue;
      }
      const ms = Date.now() - t0;
      const text = await res.text().catch(() => '');
      let json: any = undefined;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = {};
      }
      if (res.ok) {
        this.logger.debug?.(`${method} ${safe} ${res.status} ${ms}ms`);
        return json as T;
      }
      // Cloudflare's error body is its own vocabulary (errorCode +
      // errorDescription); kept to those two fields and length-capped, so
      // nothing else it echoes ends up in a log.
      const code = typeof json?.errorCode === 'string' ? json.errorCode : undefined;
      // Whatever it says, it never carries our secret into a log.
      const desc =
        typeof json?.errorDescription === 'string'
          ? redactPath(
              json.errorDescription.split(secret).join('[redacted]').split(appId).join('<app>'),
            ).slice(0, 200)
          : '';
      const failure: CfFailure =
        res.status === 401 || res.status === 403
          ? 'auth'
          : res.status >= 500 || res.status === 429
            ? 'server'
            : 'rejected';
      last = new CloudflareRealtimeError(
        failure,
        res.status,
        `${method} ${safe} → ${res.status}${code ? ` ${code}` : ''}${desc ? `: ${desc}` : ''}`,
        code,
      );
      if (failure === 'auth') {
        this.logger.error(`${last.message} — the Cloudflare Realtime app secret was rejected`);
        break;
      }
      this.logger.warn(`${last.message} (${ms}ms, attempt ${i + 1}/${attempts})`);
      if (failure === 'rejected') break;
    }
    throw last!;
  }

  /** A new SFU session: one per browser PeerConnection. */
  async newSession(): Promise<string> {
    const r = await this.call<{ sessionId?: string }>('POST', '/sessions/new', undefined, {
      retries: 1,
    });
    if (!r.sessionId) {
      throw new CloudflareRealtimeError('server', null, 'sessions/new returned no sessionId');
    }
    return r.sessionId;
  }

  /** Push local tracks (the browser's offer); answers with the SFU's answer. */
  pushTracks(
    sessionId: string,
    offer: CfSessionDescription,
    tracks: { mid: string; trackName: string }[],
  ): Promise<CfTracksResponse> {
    return this.call('POST', `/sessions/${sessionId}/tracks/new`, {
      sessionDescription: offer,
      tracks: tracks.map((t) => ({ location: 'local', mid: t.mid, trackName: t.trackName })),
    });
  }

  /**
   * Pull other sessions' tracks. Usually answers with an offer to be answered
   * through `renegotiate`. `preferredRid` picks a simulcast layer when the
   * publisher sent one.
   */
  pullTracks(
    sessionId: string,
    tracks: { sessionId: string; trackName: string; preferredRid?: string }[],
  ): Promise<CfTracksResponse> {
    return this.call('POST', `/sessions/${sessionId}/tracks/new`, {
      tracks: tracks.map((t) => ({
        location: 'remote',
        sessionId: t.sessionId,
        trackName: t.trackName,
        ...(t.preferredRid ? { simulcast: { preferredRid: t.preferredRid } } : {}),
      })),
    });
  }

  /**
   * Change what a pulled track receives — the simulcast layer. Takes effect
   * without renegotiation (verified against the real SFU: 320×180 ⇄ 1280×720).
   */
  selectLayer(
    sessionId: string,
    track: { sessionId: string; trackName: string; mid: string; preferredRid: string },
  ): Promise<CfTracksResponse> {
    return this.call('PUT', `/sessions/${sessionId}/tracks/update`, {
      tracks: [
        {
          location: 'remote',
          sessionId: track.sessionId,
          trackName: track.trackName,
          mid: track.mid,
          simulcast: { preferredRid: track.preferredRid },
        },
      ],
    });
  }

  renegotiate(sessionId: string, answer: CfSessionDescription): Promise<CfTracksResponse> {
    return this.call('PUT', `/sessions/${sessionId}/renegotiate`, { sessionDescription: answer });
  }

  /**
   * Close tracks. `force` closes them at the SFU without waiting for the
   * browser to renegotiate — what the server uses to take away a revoked
   * speaker's microphone or end a class, whatever the browser does next.
   */
  closeTracks(
    sessionId: string,
    mids: string[],
    opts: { force: boolean; sessionDescription?: CfSessionDescription },
  ): Promise<CfTracksResponse> {
    return this.call(
      'PUT',
      `/sessions/${sessionId}/tracks/close`,
      {
        tracks: mids.map((mid) => ({ mid })),
        force: opts.force,
        ...(opts.sessionDescription ? { sessionDescription: opts.sessionDescription } : {}),
      },
      // Idempotent for the same mids; worth one more try when tearing down.
      { retries: opts.force ? 1 : 0 },
    );
  }

  getSession(sessionId: string): Promise<CfSessionState> {
    return this.call('GET', `/sessions/${sessionId}`, undefined, { retries: 1 });
  }

  /**
   * ICE servers for a browser: Cloudflare's STUN always, and TURN with
   * short-lived credentials when a TURN key is configured.
   *
   * TURN needs its own key (CF_TURN_KEY_ID + CF_TURN_KEY_API_TOKEN) — the SFU
   * app secret is not accepted by the TURN service. Without it, a network that
   * blocks UDP cannot reach the class; that is an operator action, reported,
   * never faked. A TURN failure falls back to STUN only: the many who do not
   * need a relay should not be kept out by the few who do.
   */
  async iceServers(): Promise<IceServer[]> {
    const { turnKeyId, turnToken } = cloudflareConfig();
    if (!turnKeyId || !turnToken) return [CF_STUN];
    try {
      const res = await this.fetchImpl(
        `${API}/turn/keys/${encodeURIComponent(turnKeyId)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${turnToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: TURN_TTL_SEC }),
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!res.ok) {
        this.logger.warn(`TURN credentials → ${res.status}; continuing with STUN only`);
        return [CF_STUN];
      }
      const body = (await res.json()) as { iceServers?: IceServer | IceServer[] };
      const list = Array.isArray(body.iceServers)
        ? body.iceServers
        : body.iceServers
          ? [body.iceServers]
          : [];
      return list.length ? list : [CF_STUN];
    } catch (e) {
      this.logger.warn(`TURN credentials unavailable (${(e as Error).name}); STUN only`);
      return [CF_STUN];
    }
  }
}

/**
 * The HTTP answer for a failed SFU call. The browser gets Darsly's codes (the
 * same ones the classroom page already explains), never Cloudflare's body.
 */
export function toHttpError(e: unknown): HttpException {
  if (e instanceof HttpException) return e;
  if (!(e instanceof CloudflareRealtimeError)) {
    return new ServiceUnavailableException({
      message: 'تعذّر تجهيز غرفة البث. حاول بعد لحظات.',
      code: 'LIVE_PROVIDER_ERROR',
    });
  }
  switch (e.failure) {
    case 'config':
      return new ServiceUnavailableException({
        message: 'الفصل المباشر غير مفعّل على المنصّة حالياً',
        code: 'LIVE_NOT_CONFIGURED',
      });
    case 'timeout':
    case 'unreachable':
    case 'server':
      return new ServiceUnavailableException({
        message: 'تعذّر الاتصال بخدمة البث. حاول بعد لحظات.',
        code: 'LIVE_PROVIDER_UNREACHABLE',
      });
    case 'rejected':
      // The SFU session behind this connection is gone (Cloudflare ends one
      // that sat unconnected): the page opens a new connection and retries.
      if (e.status === 410) {
        return new ConflictException({
          message: 'The connection expired; reconnecting',
          code: 'RTC_SESSION_EXPIRED',
        });
      }
      // A bad offer, a track that no longer exists: the browser's request,
      // not an outage. Retrying the same thing will fail the same way.
      return new BadRequestException({
        message: 'تعذّر الاتصال بالفصل. أعد المحاولة.',
        code: 'LIVE_RTC_REJECTED',
      });
    default:
      return new ServiceUnavailableException({
        message: 'تعذّر تجهيز غرفة البث. حاول بعد لحظات.',
        code: 'LIVE_PROVIDER_ERROR',
      });
  }
}
