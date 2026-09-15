import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';

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
/** Account settings change when a human changes them — not by the minute. */
const DOMAIN_CACHE_MIN = 10;

export interface DailyRoom {
  name: string;
  url: string;
}

/**
 * What the provider has for a room's words. Four answers, because the caller
 * does four different things with them: summarise, wait, give up, or try
 * later — and "give up" is the only one that should be rare.
 */
export type TranscriptLookup =
  | { state: 'ready'; text: string }
  /** Transcription ran and Daily is still writing the file. */
  | { state: 'pending' }
  /** No transcript was ever made for this room, or it came out empty. */
  | { state: 'none' }
  /** We could not ask. Says nothing about the transcript. */
  | { state: 'error' };

/**
 * The words out of a WebVTT file.
 *
 * Daily hands transcripts back as subtitles — a header, cue numbers and
 * timecodes around the speech. A summary is written from what was said, so the
 * scaffolding is dropped: it is noise to the model and it is paid for by the
 * token.
 *
 * Speaker labels are kept where Deepgram wrote them ("Speaker 0: ..."), because
 * who said a thing is what separates a student's question from the answer.
 */
export function plainTextFromVtt(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  const spoken: string[] = [];
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    if (l === 'WEBVTT' || l.startsWith('NOTE ')) continue;
    // "00:00:01.000 --> 00:00:04.000", and the bare cue numbers beside them.
    if (l.includes('-->') || /^\d+$/.test(l)) continue;
    spoken.push(l);
  }
  const text = spoken.join('\n').trim();
  return text || null;
}

@Injectable()
export class DailyService implements OnModuleInit {
  private readonly logger = new Logger(DailyService.name);

  /**
   * Wire the provider at boot, not only at the first class.
   *
   * So that the deploy log answers "did the variable take?" the moment the
   * container is up, rather than at the next lesson — which is when the
   * operator has stopped watching. Fire-and-forget: a slow provider must not
   * hold up the application, and the first class re-asks anyway.
   */
  onModuleInit() {
    if (this.deepgramKey) void this.ensureTranscriptionProvider();
  }

  private get apiKey(): string | undefined {
    return process.env.DAILY_API_KEY?.trim() || undefined;
  }

  /**
   * The transcription provider's key, if the operator has supplied one.
   *
   * Read here and handed to Daily by this service, so that it travels
   * Railway → this process → Daily and nowhere else. The alternative — an
   * operator pasting it into a curl command, or into a chat with whoever is
   * helping them — is how the previous one leaked.
   */
  private get deepgramKey(): string | undefined {
    return process.env.DEEPGRAM_API_KEY?.trim() || undefined;
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
      // An error body may quote the property that was rejected — and one of
      // our properties is a provider key.
      const safe = body.replace(/deepgram:[A-Za-z0-9_-]+/g, 'deepgram:[redacted]');
      this.logger.error(`Daily ${path} failed (${res.status}): ${safe.slice(0, 500)}`);
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
    // The class is about to start: make sure the account can listen to it.
    // Never fatal — a room without transcription is still a room, and the
    // summary later says plainly why it has nothing to work from.
    await this.ensureTranscriptionProvider();
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
          // Without this Daily transcribes for live captions and throws the
          // text away — the transcript exists for the length of the call and
          // cannot be fetched afterwards, which is no use to a summary written
          // after the lesson.
          enable_transcription_storage: true,
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
   * Point the Daily domain at the transcription provider we were given.
   *
   * Transcription is not a room setting; it is enabled once on the domain, by
   * telling Daily which Deepgram key to use. Left to a human that is a curl
   * command run once and forgotten — until the key is rotated, when the
   * domain quietly keeps the dead one and every class reports that
   * transcription "failed to start". Done here instead: the domain is read,
   * compared with the key in the environment, and updated only when they
   * differ. Rotation becomes "change the variable and redeploy".
   *
   * Memoised per process so a busy afternoon does not read the domain config
   * once per class; the memo is dropped on failure so the next class retries.
   * Resolves to true when the domain is wired to our key, null when there is
   * no key to wire or the provider could not be reached. The key is never
   * logged, and neither is the domain config — Daily echoes the key back in
   * it, in plain text.
   */
  ensureTranscriptionProvider(): Promise<boolean | null> {
    const key = this.deepgramKey;
    if (!key) return Promise.resolve(null);
    if (!this.providerWiring) {
      this.providerWiring = this.wireTranscriptionProvider(key).catch((e) => {
        this.logger.error(`Could not wire the transcription provider to Daily: ${(e as Error).message}`);
        this.providerWiring = undefined;
        return null;
      });
    }
    return this.providerWiring;
  }

  private providerWiring?: Promise<boolean | null>;

  private async wireTranscriptionProvider(key: string): Promise<boolean> {
    const wanted = `deepgram:${key}`;
    const me = await this.call<{ config?: { enable_transcription?: string | null } }>('/', {
      method: 'GET',
    });
    if (me.config?.enable_transcription === wanted) {
      // Said too, so the deploy log distinguishes "nothing to do" from
      // "never ran" — silence was read as both, and cost an afternoon.
      this.logger.log('Transcription provider already wired to the Daily domain');
      return true;
    }
    const after = await this.call<{ config?: { enable_transcription?: string | null } }>('/', {
      method: 'POST',
      body: JSON.stringify({ properties: { enable_transcription: wanted } }),
    });
    if (after.config?.enable_transcription !== wanted) {
      throw new Error('Daily accepted the update but the domain does not show it');
    }
    // Said once, without the key: the operator reading the deploy log learns
    // the variable was picked up, and nothing else.
    this.logger.log('Transcription provider wired to the Daily domain from DEEPGRAM_API_KEY');
    this.transcriptionCache = { value: true, until: Date.now() + DOMAIN_CACHE_MIN * 60_000 };
    return true;
  }

  /**
   * Whether this Daily account can transcribe at all.
   *
   * Worth asking, because the alternative is guessing. A room created with
   * `enable_transcription_storage` is accepted whether or not the account has
   * transcription — the call only fails later, mid-lesson, in the browser. So
   * an empty transcript has two very different meanings ("nobody spoke" versus
   * "we were never able to listen") and only the account settings separate
   * them. Getting that wrong tells a teacher who talked for an hour that they
   * said nothing.
   *
   * `null` means we could not find out; the caller must not turn that into a
   * claim in either direction.
   */
  async transcriptionAvailable(): Promise<boolean | null> {
    // If we were given a provider, wiring it is the authoritative answer —
    // and fixes the domain on the way, rather than merely reporting on it.
    if (this.deepgramKey && (await this.ensureTranscriptionProvider()) === true) return true;
    const now = Date.now();
    if (this.transcriptionCache && this.transcriptionCache.until > now) {
      return this.transcriptionCache.value;
    }
    try {
      const me = await this.call<{ config?: { enable_transcription?: string | null } }>('/', {
        method: 'GET',
      });
      // A provider name ("deepgram") when it is on; null or empty when the
      // account has never had it enabled.
      const value = !!me.config?.enable_transcription;
      this.transcriptionCache = { value, until: now + DOMAIN_CACHE_MIN * 60_000 };
      return value;
    } catch {
      // Not cached: an outage now must not decide what we believe for an hour.
      return null;
    }
  }

  private transcriptionCache?: { value: boolean; until: number };

  /**
   * The words that were spoken, if the provider captured them.
   *
   * A room can have several transcripts — a teacher who dropped and rejoined
   * started transcription twice — so every finished one is fetched and they
   * are joined oldest first. And a transcript that is still being written is
   * reported as such rather than as absent: the teacher who taps "summary"
   * ten seconds after ending the class is the common case, not the edge.
   */
  async transcriptFor(roomName: string): Promise<TranscriptLookup> {
    try {
      // Listed, then filtered here: Daily's transcript endpoint rejects a
      // `roomName` query outright ("roomName is not allowed"), and the 400 it
      // answers with was being swallowed as "this lesson has no transcript" —
      // which is how every summary came to fail.
      const list = await this.call<{
        data?: { transcriptId?: string; id?: string; status?: string; roomName?: string }[];
      }>('/transcript', { method: 'GET' });
      const mine = (list.data ?? []).filter((t) => t.roomName === roomName);
      if (!mine.length) return { state: 'none' };
      // Daily prefixes these ("t_in_progress", "t_finished"), and has changed
      // the spelling before. Matching on the word rather than the exact string
      // means a rename does not silently turn every lesson into "no transcript".
      if (mine.some((t) => /progress|pending|queued|start/i.test(t.status ?? ''))) {
        return { state: 'pending' };
      }
      const parts: string[] = [];
      // Newest first from Daily; a lesson reads oldest first.
      for (const t of mine.filter((t) => /finish/i.test(t.status ?? '')).reverse()) {
        // The id lives under `transcriptId`; `id` is present but null.
        const transcriptId = t.transcriptId ?? t.id;
        if (!transcriptId) continue;
        const link = await this.call<{ link?: string }>(
          `/transcript/${encodeURIComponent(transcriptId)}/access-link`,
          { method: 'GET' },
        );
        if (!link.link) continue;
        const res = await fetch(link.link, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) continue;
        const text = plainTextFromVtt(await res.text());
        if (text) parts.push(text);
      }
      const text = parts.join('\n').trim();
      return text ? { state: 'ready', text } : { state: 'none' };
    } catch (e) {
      this.logger.warn(`Could not look up transcripts for room ${roomName}: ${(e as Error).message}`);
      return { state: 'error' };
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
