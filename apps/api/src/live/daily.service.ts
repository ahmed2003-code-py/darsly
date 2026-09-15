import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * The video provider, and the only place its key exists.
 *
 * Every privileged call to Daily happens here, server-side: the browser is
 * handed a room URL and a short-lived token for one room, and never anything it
 * could use to create a room, read another room, or act as an owner somewhere
 * it was not invited. That is the whole reason this sits behind a service
 * rather than being called from the page.
 *
 * Failures are translated on the way out. A teacher whose class is about to
 * start does not need to read Daily's JSON at them, and the raw body can carry
 * account details that are ours, not theirs.
 */

const API = 'https://api.daily.co/v1';
/** A class is not a broadcast station; rooms expire rather than linger open. */
const ROOM_GRACE_MIN = 30;
/** Long enough to sit through the class, short enough to be worth stealing. */
const TOKEN_GRACE_MIN = 30;

export interface DailyRoom {
  name: string;
  url: string;
}

@Injectable()
export class DailyService {
  private readonly logger = new Logger(DailyService.name);

  private get apiKey(): string | undefined {
    return process.env.DAILY_API_KEY?.trim() || undefined;
  }

  /** Whether the platform is configured to host its own classrooms at all. */
  get configured(): boolean {
    return !!this.apiKey;
  }

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    const key = this.apiKey;
    if (!key) {
      // Not an outage — a deployment that was never given a key. Said plainly
      // so the operator reads it in the logs and the user reads something else.
      this.logger.error('DAILY_API_KEY is not set — live classrooms are unavailable');
      throw new ServiceUnavailableException({
        message: 'الفصل المباشر غير مفعّل على المنصّة حالياً',
        code: 'LIVE_NOT_CONFIGURED',
      });
    }
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
        // A class is waiting: fail fast rather than hold the request open.
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      this.logger.error(`Daily ${path} unreachable: ${(e as Error).message}`);
      throw new ServiceUnavailableException({
        message: 'تعذّر الاتصال بخدمة البث. حاول بعد لحظات.',
        code: 'LIVE_PROVIDER_UNREACHABLE',
      });
    }
    if (!res.ok) {
      // Logged in full for us; never returned, because the body is Daily's
      // account-level detail and not something a student should read.
      const body = await res.text().catch(() => '');
      this.logger.error(`Daily ${path} failed (${res.status}): ${body.slice(0, 500)}`);
      throw new ServiceUnavailableException({
        message: 'تعذّر تجهيز غرفة البث. حاول بعد لحظات.',
        code: 'LIVE_PROVIDER_ERROR',
      });
    }
    return (await res.json()) as T;
  }

  /**
   * A private room for exactly one session.
   *
   * Private is the point: the URL alone opens nothing, so a link forwarded to a
   * friend is a link to a locked door. Entry is the token, which this service
   * only ever mints for someone the caller has already authorised.
   */
  async createRoom(name: string, endsAtMs: number): Promise<DailyRoom> {
    const exp = Math.floor(endsAtMs / 1000) + ROOM_GRACE_MIN * 60;
    const room = await this.call<{ name: string; url: string }>('/rooms', {
      method: 'POST',
      body: JSON.stringify({
        name,
        privacy: 'private',
        properties: {
          exp,
          enable_screenshare: true,
          enable_chat: true,
          // Recording is the teacher's to start, never automatic: a class
          // recorded without anyone asking is a class recorded without anyone
          // consenting. The room merely allows it.
          enable_recording: 'cloud',
          // Nobody is broadcast the instant they arrive: the pre-join screen is
          // where they decide, and the browser's own permission prompt is where
          // they mean it.
          start_video_off: true,
          start_audio_off: true,
          // Leaving the room does not leave it running.
          eject_at_room_exp: true,
        },
      }),
    });
    this.assertExpectedDomain(room.url);
    return { name: room.name, url: room.url };
  }

  /**
   * The room came back on the domain we think we are using.
   *
   * A key belongs to a team, and a team owns a domain — so pasting the wrong
   * key does not fail, it quietly hosts your classes somewhere else. That is
   * the one provider mistake that looks like success, and it is most likely to
   * happen in the minute after someone rotates a key. Checked rather than
   * assumed, and skipped entirely when the variable is unset so the platform
   * still runs for anyone who never set it.
   */
  private assertExpectedDomain(url: string) {
    const expected = process.env.DAILY_DOMAIN?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!expected) return;
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return;
    }
    if (host === expected) return;
    this.logger.error(
      `Daily returned a room on "${host}" but DAILY_DOMAIN is "${expected}" — the API key probably belongs to a different Daily team`,
    );
    throw new ServiceUnavailableException({
      message: 'إعدادات خدمة البث غير متطابقة. راجع إعدادات المنصّة.',
      code: 'LIVE_DOMAIN_MISMATCH',
    });
  }

  /**
   * One person's key to one room.
   *
   * `isOwner` is decided by the caller from the database, never from the
   * request: it is what lets someone mute and remove other people, and a client
   * that could ask for it would be a client that could grant it to itself.
   */
  async meetingToken(input: {
    roomName: string;
    userName: string;
    userId: string;
    isOwner: boolean;
    endsAtMs: number;
  }): Promise<string> {
    const exp = Math.floor(input.endsAtMs / 1000) + TOKEN_GRACE_MIN * 60;
    const res = await this.call<{ token: string }>('/meeting-tokens', {
      method: 'POST',
      body: JSON.stringify({
        properties: {
          room_name: input.roomName,
          user_name: input.userName,
          user_id: input.userId,
          is_owner: input.isOwner,
          // Only the owner may record, and the token is where that is decided.
          enable_recording: input.isOwner ? 'cloud' : false,
          exp,
          start_video_off: true,
          start_audio_off: true,
        },
      }),
    });
    return res.token;
  }

  /**
   * What the provider knows about a recording.
   *
   * `status` is theirs: recordings finish some time after the class does, so a
   * request the moment the teacher leaves usually answers "in-progress".
   */
  async recording(id: string): Promise<{ status: string; duration?: number } | null> {
    try {
      return await this.call<{ status: string; duration?: number }>(`/recordings/${encodeURIComponent(id)}`, {
        method: 'GET',
      });
    } catch {
      return null;
    }
  }

  /**
   * A short-lived link to watch a recording.
   *
   * Fetched when someone is allowed to watch and never stored: a recording URL
   * that lives in our database is a permanent public one the first time a row
   * leaks. Daily issues these with their own expiry, which is the property
   * worth having.
   */
  async recordingLink(id: string): Promise<{ url: string; expiresAt: Date } | null> {
    try {
      const res = await this.call<{ download_link?: string; link?: string; expires: number }>(
        `/recordings/${encodeURIComponent(id)}/access-link`,
        { method: 'GET' },
      );
      const url = res.download_link ?? res.link;
      if (!url) return null;
      return { url, expiresAt: new Date(res.expires * 1000) };
    } catch {
      return null;
    }
  }

  /**
   * The words that were spoken, if the provider captured them.
   *
   * Returns null rather than throwing when transcription is not on the plan —
   * the summary is a bonus on top of a class that already happened, and a
   * missing transcript must not read as a broken lesson.
   */
  async transcriptFor(roomName: string): Promise<string | null> {
    try {
      const list = await this.call<{ data?: { id: string; status: string; roomName?: string }[] }>(
        `/transcript?roomName=${encodeURIComponent(roomName)}`,
        { method: 'GET' },
      );
      // Daily prefixes these ("t_in_progress", "t_finished"), and has changed
      // the spelling before. Matching on the word rather than the exact string
      // means a rename does not silently turn every lesson into "no transcript".
      const done = (list.data ?? []).find((t) => /finish/i.test(t.status ?? ''));
      if (!done) return null;
      const link = await this.call<{ link?: string }>(
        `/transcript/${encodeURIComponent(done.id)}/access-link`,
        { method: 'GET' },
      );
      if (!link.link) return null;
      const res = await fetch(link.link, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return null;
      const text = await res.text();
      return text.trim() || null;
    } catch (e) {
      this.logger.warn(`No transcript for room ${roomName}: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Best-effort teardown when a session ends.
   *
   * Deliberately swallows its failure: the session is over in Darsly's records
   * either way, and the room carries its own `exp` so a delete we never managed
   * to make is a room that closes itself within the hour.
   */
  async deleteRoom(name: string): Promise<void> {
    try {
      await this.call(`/rooms/${encodeURIComponent(name)}`, { method: 'DELETE' });
    } catch {
      this.logger.warn(`Could not delete Daily room ${name}; it will expire on its own`);
    }
  }
}
