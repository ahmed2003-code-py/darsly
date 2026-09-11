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
 * YouTube increasingly withholds playable format URLs from the plain "web"
 * client behind a proof-of-origin token it won't hand out without a real
 * browser session (the "SABR-only streaming" experiment) — confirmed on
 * 2026-09-11 against a real teacher-uploaded video that failed with "This
 * video is not available" until the client list below was added. Trying
 * android first (rarely gated the same way, so it resolves most videos on
 * its own) and falling back to web covers the rest; this is a moving target
 * as YouTube's rollout and yt-dlp's countermeasures both keep changing, so
 * it is a list to widen later, not a one-time fix.
 */
const PLAYER_CLIENT_ARGS = ['--extractor-args', 'youtube:player_client=android,web'];

/**
 * yt-dlp refuses to run the "android" client at all once cookies are set (it
 * doesn't support cookie auth, full stop — confirmed 2026-09-11), so every
 * import falls back to "web" for as long as cookiesArgs() below returns
 * something, i.e. for every import once cookies are configured at all, not
 * just the ones that actually needed them. "web" needs a real JS run to
 * solve YouTube's signature/"n" challenges, and yt-dlp won't fetch its own
 * solver script without this flag — without it, cookies+web fails even
 * ordinary videos with "Requested format is not available", which is worse
 * than not having cookies configured at all. Costs one GitHub fetch (cached
 * after) the first time it runs per container.
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

  async fetchMetadata(videoId: string): Promise<YoutubeMeta> {
    const out = await this.run(
      [
        ...PLAYER_CLIENT_ARGS,
        ...JS_CHALLENGE_ARGS,
        ...(await this.cookiesArgs()),
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
   * A video that needs cookies to get past the bot-check (see cookiesArgs())
   * can still fail here even once authenticated: android — the client that
   * usually dodges the SABR gate — categorically refuses to run with cookies
   * (yt-dlp skips it outright), and every client that does accept cookies
   * (web/tv/mweb/...) requires a real proof-of-origin token YouTube's server
   * withholds without one, cookies or not. That combination has no fix short
   * of standing up a PO-token generator — a reverse-engineered, third-party
   * emulation of Google's anti-bot challenge — which is a real trust/
   * maintenance tradeoff, not a one-line change. Left unimplemented on
   * purpose: this call just fails cleanly, the caller already marks the
   * VideoAsset FAILED, and the teacher falls back to the existing
   * replace-video upload for that one lesson.
   */
  async download(videoId: string, destPath: string): Promise<void> {
    await this.run(
      [
        ...PLAYER_CLIENT_ARGS,
        ...JS_CHALLENGE_ARGS,
        ...(await this.cookiesArgs()),
        '-f',
        // The SABR gate above often leaves only a single progressive stream
        // (audio+video already combined, typically format 18) actually
        // servable — the separate-streams tiers are kept first because they
        // are better quality on a video where the split ones are still
        // exposed, and `best` alone is the guaranteed-available last resort.
        `bestvideo[ext=mp4][filesize<${MAX_FILESIZE}]+bestaudio[ext=m4a]/best[ext=mp4][filesize<${MAX_FILESIZE}]/best[filesize<${MAX_FILESIZE}]/best`,
        '--merge-output-format', 'mp4',
        '--max-filesize', MAX_FILESIZE,
        '--no-playlist',
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
