import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface RenditionSpec {
  height: number;
  /** total bitrate budget in kbps (video+audio) */
  bitrateKbps: number;
}

// Standard adaptive ladder; only rungs at/below the source height are produced.
const LADDER: RenditionSpec[] = [
  { height: 360, bitrateKbps: 800 },
  { height: 480, bitrateKbps: 1400 },
  { height: 720, bitrateKbps: 2800 },
  { height: 1080, bitrateKbps: 5000 },
];

export const KEY_URI_PLACEHOLDER = 'darsly:key';

export interface TranscodeOutput {
  /** temp working dir holding master.m3u8 + <h>p/ segment dirs (caller uploads then cleans) */
  workDir: string;
  masterName: string;
  renditions: { height: number; bandwidth: number; playlistName: string }[];
  durationSec: number;
}

/**
 * ffmpeg → AES-128 encrypted HLS packager. Produces a multi-rendition adaptive
 * stream where every segment is AES-128 encrypted with the supplied content
 * key. The key URI written into each media playlist is a placeholder that the
 * serving layer rewrites to a per-session signed key URL — so the key is never
 * embedded in, or discoverable from, the delivered playlists. Raw MP4 is never
 * emitted.
 */
@Injectable()
export class TranscodeService {
  private readonly logger = new Logger(TranscodeService.name);

  async probe(sourcePath: string): Promise<{ height: number; durationSec: number }> {
    const out = await this.run(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=height',
        '-show_entries', 'format=duration',
        '-of', 'json',
        sourcePath,
      ],
      true,
    );
    const json = JSON.parse(out);
    return {
      height: json.streams?.[0]?.height ?? 720,
      durationSec: Math.round(Number(json.format?.duration ?? 0)),
    };
  }

  /**
   * Package `sourcePath` into encrypted HLS using `keyBytes`. `keyUriInPlaylist`
   * is baked into the playlists (a placeholder rewritten at serve time).
   */
  async packageHls(
    sourcePath: string,
    keyBytes: Buffer,
    keyUriInPlaylist = KEY_URI_PLACEHOLDER,
  ): Promise<TranscodeOutput> {
    const { height: srcHeight, durationSec } = await this.probe(sourcePath);
    const rungs = LADDER.filter((r) => r.height <= srcHeight);
    if (rungs.length === 0) rungs.push(LADDER[0]);

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'darsly-hls-'));
    const iv = require('crypto').randomBytes(16).toString('hex');

    // ffmpeg -hls_key_info_file wants: <uri line>\n<local key path>\n<iv>
    const keyPath = path.join(workDir, 'enc.key');
    const keyInfoPath = path.join(workDir, 'enc.keyinfo');
    await fs.writeFile(keyPath, keyBytes);
    await fs.writeFile(keyInfoPath, `${keyUriInPlaylist}\n${keyPath}\n${iv}\n`);

    const renditions: TranscodeOutput['renditions'] = [];
    for (const rung of rungs) {
      const dir = path.join(workDir, `${rung.height}p`);
      await fs.mkdir(dir, { recursive: true });
      const audioKbps = 128;
      const videoKbps = Math.max(200, rung.bitrateKbps - audioKbps);
      await this.run('ffmpeg', [
        '-y', '-i', sourcePath,
        '-vf', `scale=-2:${rung.height}`,
        '-c:v', 'h264', '-profile:v', 'main', '-preset', 'veryfast',
        '-b:v', `${videoKbps}k`, '-maxrate', `${Math.round(videoKbps * 1.07)}k`,
        '-bufsize', `${videoKbps * 2}k`,
        '-c:a', 'aac', '-b:a', `${audioKbps}k`,
        '-hls_time', '6',
        '-hls_playlist_type', 'vod',
        '-hls_key_info_file', keyInfoPath,
        '-hls_segment_filename', path.join(dir, 'seg_%03d.ts'),
        path.join(dir, 'index.m3u8'),
      ]);
      renditions.push({
        height: rung.height,
        bandwidth: rung.bitrateKbps * 1000,
        playlistName: `${rung.height}p/index.m3u8`,
      });
    }

    // Master playlist referencing each rendition.
    const master =
      '#EXTM3U\n#EXT-X-VERSION:3\n' +
      renditions
        .map(
          (r) =>
            `#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},RESOLUTION=x${r.height}\n${r.playlistName}`,
        )
        .join('\n') +
      '\n';
    await fs.writeFile(path.join(workDir, 'master.m3u8'), master);

    // The key file must never ship to storage — remove it from the work dir now.
    await fs.rm(keyPath, { force: true });
    await fs.rm(keyInfoPath, { force: true });

    return { workDir, masterName: 'master.m3u8', renditions, durationSec };
  }

  private run(cmd: string, args: string[], capture = false): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args);
      let stdout = '';
      let stderr = '';
      if (capture) child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (err) =>
        reject(new Error(`${cmd} failed to start: ${err.message} (is ${cmd} installed?)`)),
      );
      child.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-800)}`));
      });
    });
  }
}
