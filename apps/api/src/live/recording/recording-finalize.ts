import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * One file out of a recording's pieces, ready for the video pipeline.
 *
 * MediaRecorder writes WebM without a duration or an index, and a recorder
 * that was restarted mid-lesson leaves several pieces. ffmpeg joins them and
 * rewrites the container properly — first by copying the streams (fast, no
 * quality lost), and only if that fails by re-encoding. The result has a real
 * duration, which the transcoder's probe needs.
 */
export async function finalizeRecording(
  dir: string,
  opts: { ffmpeg?: string; ffprobe?: string } = {},
): Promise<{ file: string; sizeBytes: number; durationSec: number }> {
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  const ffprobe = opts.ffprobe ?? 'ffprobe';
  const segs = (await fs.readdir(dir))
    .filter((f) => /^seg-\d+\.webm$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const nonEmpty: string[] = [];
  for (const s of segs) {
    if ((await fs.stat(path.join(dir, s))).size > 0) nonEmpty.push(s);
  }
  if (!nonEmpty.length) throw new Error('NO_MEDIA');
  const list = path.join(dir, 'list.txt');
  await fs.writeFile(list, nonEmpty.map((s) => `file '${s}'`).join('\n'));
  const out = path.join(dir, 'final.webm');
  try {
    await run(ffmpeg, [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-c',
      'copy',
      out,
    ]);
  } catch {
    // Pieces whose parameters differ cannot be copied end to end.
    await run(ffmpeg, [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-c:v',
      'libvpx',
      '-b:v',
      '1800k',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-c:a',
      'libopus',
      '-b:a',
      '96k',
      out,
    ]);
  }
  const durationSec = await probeDuration(ffprobe, out);
  const { size } = await fs.stat(out);
  return { file: out, sizeBytes: size, durationSec };
}

async function probeDuration(ffprobe: string, file: string): Promise<number> {
  const outp = await run(ffprobe, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    file,
  ]);
  const n = Number(outp.trim());
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((ok, no) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', no);
    p.on('close', (code) =>
      code === 0
        ? ok(out)
        : no(new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(-400)}`)),
    );
  });
}
