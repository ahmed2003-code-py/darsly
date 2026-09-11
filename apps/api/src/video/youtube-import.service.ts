import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';

export interface YoutubeMeta {
  title: string;
  description: string;
}

const METADATA_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
/** Matches the manual-upload cap in uploads.controller.ts. */
const MAX_FILESIZE = '2G';
const YT_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com']);

/**
 * Client order decides the quality ceiling, not just whether an import works.
 * As of 2026-09-11 YouTube's SABR rollout withholds every separate
 * video/audio stream from "web" (it wants a proof-of-origin token it only
 * mints for a real browser) and from "android" (which is left with itag 18,
 * a single pre-merged 360p stream) — so both cap an import at 360p. Only
 * "visionos" still serves the full DASH ladder up to 2160p, verified live
 * against real videos. It doesn't resolve every video ("made for kids" ones,
 * and at least one real teacher upload that answers "This video is not
 * available"), which is why the other two stay behind it as fallbacks:
 * yt-dlp walks the list and takes the formats from the first client that
 * answers. This is a moving target — if imports start coming in at 360p
 * again, this list is the first thing to re-test.
 */
const PLAYER_CLIENT_ARGS = ['--extractor-args', 'youtube:player_client=visionos,android,web'];

/**
 * Only "web" needs a real JS run (to solve YouTube's signature/"n"
 * challenges), and yt-dlp won't fetch its own solver script without this
 * flag — without it the web fallback fails with "Requested format is not
 * available". Costs one GitHub fetch, cached after, per container.
 */
const JS_CHALLENGE_ARGS = ['--remote-components', 'ejs:github'];

/** The Netscape cookie file's row in PlatformSetting. */
const COOKIES_SETTING_KEY = 'youtube_cookies';
/** Re-read the DB row this often, so a rotated cookie file takes effect
 *  without a redeploy — cheap next to a 20s+ yt-dlp call either way. */
const COOKIES_CACHE_MS = 5 * 60_000;

/**
 * Turns a YouTube link into a real, owned VideoAsset — same encrypted-HLS
 * pipeline as a manual upload, just sourced from yt-dlp instead of multer.
 *
 * yt-dlp is a generic extractor for hundreds of sites and, left unchecked, is
 * an SSRF vector — a teacher could hand it a URL that hits an internal
 * address. `resolveVideoId` is the only thing standing between a user string
 * and a shelled-out process: it accepts nothing but a real YouTube hostname,
 * and everything downstream re-derives a canonical `watch?v=` URL from the
 * extracted 11-char id rather than ever touching the original string again.
 */
@Injectable()
export class YoutubeImportService {
  private readonly logger = new Logger(YoutubeImportService.name);
  private cookiesPath: string | null = null;
  private cookiesCheckedAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * A logged-in session is the standard fix for YouTube's "Sign in to
   * confirm you're not a bot" wall, which it puts up far more readily for
   * requests from a datacenter IP (Railway) than a residential one —
   * confirmed live on 2026-09-11: a real teacher-uploaded video failed with
   * that exact message from production while succeeding from a home
   * connection with an identical command. The account behind this cookie
   * jar is a dedicated one with nothing else on it, specifically so a leak
   * of this value exposes nothing but a throwaway YouTube login.
   *
   * Stored in `PlatformSetting` (DB), not an env var: it can be rotated by
   * writing a new row, no redeploy required, and it never touches the repo.
   *
   * Used only by `withCookieFallback` — never on a first attempt. See there
   * for why handing these to every call makes imports worse, not better.
   */
  private async cookiesArgs(): Promise<string[]> {
    const now = Date.now();
    if (now - this.cookiesCheckedAt > COOKIES_CACHE_MS) {
      this.cookiesCheckedAt = now;
      try {
        const row = await this.prisma.platformSetting.findUnique({ where: { key: COOKIES_SETTING_KEY } });
        const text = typeof row?.value === 'string' ? row.value : null;
        if (text) {
          const p = path.join(os.tmpdir(), 'darsly-yt-cookies.txt');
          await fs.writeFile(p, text, { mode: 0o600 });
          this.cookiesPath = p;
        } else {
          this.cookiesPath = null;
        }
      } catch (err: any) {
        this.logger.warn(`Could not load YouTube cookies setting: ${err.message}`);
      }
    }
    return this.cookiesPath ? ['--cookies', this.cookiesPath] : [];
  }

  /** A real YouTube video id, or null for anything else — including lookalike hosts. */
  resolveVideoId(raw: string): string | null {
    let u: URL;
    try {
      u = new URL(raw.trim());
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.hostname.toLowerCase();
    if (!YT_HOSTS.has(host)) return null;

    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return YT_VIDEO_ID.test(id) ? id : null;
    }
    if (u.pathname === '/watch') {
      const id = u.searchParams.get('v');
      return id && YT_VIDEO_ID.test(id) ? id : null;
    }
    const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  /**
   * Runs yt-dlp without cookies first and only retries with them if that
   * fails. The order matters more than it looks: yt-dlp refuses to run any
   * app client — visionos and android both — the moment cookies are present,
   * because neither supports cookie auth. Handing cookies to every call
   * therefore forces every import down the "web" path, which SABR caps at
   * 360p; that is exactly how a fix for one bot-walled video quietly became
   * a quality ceiling on all of them (2026-09-11). Cookies are worth it only
   * when the clean attempt got nothing at all — a bot wall, where a 360p
   * import still beats no import.
   */
  private async withCookieFallback(
    buildArgs: (cookies: string[]) => string[],
    timeoutMs: number,
  ): Promise<string> {
    try {
      return await this.run(buildArgs([]), timeoutMs);
    } catch (err: any) {
      const cookies = await this.cookiesArgs();
      if (!cookies.length) throw err;
      this.logger.warn(`yt-dlp failed without cookies, retrying signed in: ${err.message.slice(-200)}`);
      return await this.run(buildArgs(cookies), timeoutMs);
    }
  }

  async fetchMetadata(videoId: string): Promise<YoutubeMeta> {
    const out = await this.withCookieFallback(
      (cookies) => [
        ...PLAYER_CLIENT_ARGS,
        ...JS_CHALLENGE_ARGS,
        ...cookies,
        // Title/description live in the info dict regardless of whether any
        // playable format resolved — without this flag yt-dlp refuses to dump
        // JSON at all for a video with none (e.g. one under YouTube's
        // cookie-only SABR gate, see the download()-side comment). Letting
        // metadata succeed anyway means the lesson still gets created with
        // its real title, and only the video itself falls back to the
        // existing FAILED-status "replace video" flow instead of blocking
        // the whole import.
        '--ignore-no-formats-error',
        '--dump-json', '--skip-download', '--no-warnings', '--no-playlist',
        this.canonicalUrl(videoId),
      ],
      METADATA_TIMEOUT_MS,
    );
    const json = JSON.parse(out);
    return {
      title: String(json.title ?? '').trim().slice(0, 200) || 'فيديو مستورد من يوتيوب',
      description: String(json.description ?? '').trim().slice(0, 1000),
    };
  }

  /**
   * A video that only the cookie fallback can reach comes down at 360p: the
   * clients that still serve the full ladder can't run signed in (see
   * `withCookieFallback`). That is accepted rather than fixed — the one tool
   * that mints the token "web" needs, bgutil, was built and tested in an
   * isolated container on 2026-09-11 and YouTube rejected its tokens anyway,
   * so it would have added a long-running third-party process for nothing.
   * When even the fallback fails, this throws, the caller marks the
   * VideoAsset FAILED, and the teacher uses the replace-video upload — which
   * has no quality ceiling at all.
   */
  async download(videoId: string, destPath: string): Promise<void> {
    await this.withCookieFallback(
      (cookies) => [
        ...PLAYER_CLIENT_ARGS,
        ...JS_CHALLENGE_ARGS,
        ...cookies,
        '-f',
        // Separate video+audio first: that tier is the whole reason the
        // visionos client is tried first, since it's what carries 720p and
        // up. The pre-merged tiers below it are what a SABR-gated client is
        // left with (typically itag 18, 360p) — a floor, not a preference.
        `bestvideo[ext=mp4][filesize<${MAX_FILESIZE}]+bestaudio[ext=m4a]/best[ext=mp4][filesize<${MAX_FILESIZE}]/best[filesize<${MAX_FILESIZE}]/best`,
        '--merge-output-format', 'mp4',
        '--max-filesize', MAX_FILESIZE,
        '--no-playlist',
        // The retry re-downloads rather than tripping over what the failed
        // attempt left behind.
        '--force-overwrites',
        '-o', destPath,
        this.canonicalUrl(videoId),
      ],
      DOWNLOAD_TIMEOUT_MS,
    );
  }

  /** A fresh temp path this instance owns; the caller deletes it once done. */
  tempPath(assetId: string): string {
    return path.join(os.tmpdir(), `darsly-yt-${assetId}.mp4`);
  }

  private canonicalUrl(videoId: string): string {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  private run(args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('yt-dlp', args);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('yt-dlp timed out'));
      }, timeoutMs);
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`yt-dlp failed to start: ${err.message} (is yt-dlp installed?)`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(-800)}`));
      });
    });
  }

  /** Cleanup helper for the caller's finally block. */
  async cleanup(filePath: string): Promise<void> {
    await fs.rm(filePath, { force: true }).catch(() => undefined);
  }
}
