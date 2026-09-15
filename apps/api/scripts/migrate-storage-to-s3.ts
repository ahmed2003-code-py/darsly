/**
 * Carry every file on the local storage disk into the S3-compatible bucket
 * (Cloudflare R2 in production), and move payment proofs out of Postgres
 * into the same bucket.
 *
 *   npm run storage:migrate -- [--dry-run] [--verify]
 *
 * Reads S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY and
 * STORAGE_LOCAL_PATH from the environment. It does NOT read STORAGE_DRIVER:
 * it is meant to run while the app is still serving from the disk, so the
 * switch to `s3` happens only after this has finished and been verified.
 *
 * Idempotent, in both halves. A file already in the bucket at the same key
 * and size is skipped, so a run that is interrupted is simply run again. A
 * proof row that already holds a key is skipped, so the backfill can be
 * repeated too. Nothing on the disk is deleted by this script — that is a
 * separate, deliberate step once the bucket has been verified.
 *
 *   --dry-run   count and list, write nothing
 *   --verify    after copying, confirm every local file exists remotely at
 *               the same size, and report the total
 */
import { PrismaClient } from '@prisma/client';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createReadStream, promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import * as path from 'path';

const DRY = process.argv.includes('--dry-run');
const VERIFY = process.argv.includes('--verify');
const ROOT = path.resolve(process.env.STORAGE_LOCAL_PATH ?? './storage');
const BUCKET = process.env.S3_BUCKET ?? 'darsly-media';

const endpoint = process.env.S3_ENDPOINT;
const s3 = new S3Client({
  region: /\.r2\.cloudflarestorage\.com/i.test(endpoint ?? '') ? 'auto' : (process.env.S3_REGION ?? 'us-east-1'),
  endpoint,
  forcePathStyle: !!endpoint,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY ?? '', secretAccessKey: process.env.S3_SECRET_KEY ?? '' },
});

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.key': 'application/octet-stream',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.opus': 'audio/ogg',
};

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

async function remoteSize(key: string): Promise<number | null> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return Number(head.ContentLength ?? 0);
  } catch {
    return null;
  }
}

async function copyFiles() {
  let copied = 0, skipped = 0, bytes = 0, failed = 0;
  console.log(`${DRY ? '[dry-run] ' : ''}copying ${ROOT} → s3://${BUCKET}`);
  for await (const file of walk(ROOT)) {
    const key = path.relative(ROOT, file).split(path.sep).join('/');
    const size = (await fs.stat(file)).size;
    const remote = await remoteSize(key);
    if (remote === size) { skipped++; continue; }
    if (DRY) { console.log(`  would put ${key} (${size} B)`); copied++; bytes += size; continue; }
    try {
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: key, Body: createReadStream(file),
        ContentType: MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        ContentLength: size,
      }));
      copied++; bytes += size;
      if (copied % 50 === 0) console.log(`  …${copied} files, ${(bytes / 1e6).toFixed(1)} MB`);
    } catch (e) {
      failed++; console.error(`  FAILED ${key}: ${(e as Error).message}`);
    }
  }
  console.log(`files: ${copied} copied (${(bytes / 1e6).toFixed(1)} MB), ${skipped} already there, ${failed} failed`);
  return failed;
}

/** A `data:` proof becomes an object and the row keeps the key. */
async function backfillProofs(prisma: PrismaClient) {
  const ext: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
  let moved = 0, skipped = 0, failed = 0;
  const move = async (kind: 'payments' | 'topups', id: string, dataUrl: string) => {
    const comma = dataUrl.indexOf(',');
    const mime = dataUrl.slice(5, dataUrl.indexOf(';')).toLowerCase();
    const body = Buffer.from(dataUrl.slice(comma + 1), 'base64');
    const key = `payment-proofs/${kind}/${randomUUID()}.${ext[mime] ?? 'bin'}`;
    if (DRY) { console.log(`  would move ${kind}/${id} (${body.length} B) → ${key}`); return key; }
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: mime, CacheControl: 'private, max-age=600' }));
    return key;
  };
  for (const p of await prisma.payment.findMany({ where: { proofImageUrl: { startsWith: 'data:' } }, select: { id: true, proofImageUrl: true } })) {
    try {
      const key = await move('payments', p.id, p.proofImageUrl!);
      if (!DRY) await prisma.payment.update({ where: { id: p.id }, data: { proofImageUrl: key } });
      moved++;
    } catch (e) { failed++; console.error(`  FAILED payment ${p.id}: ${(e as Error).message}`); }
  }
  for (const t of await prisma.walletTopup.findMany({ where: { proofImageUrl: { startsWith: 'data:' } }, select: { id: true, proofImageUrl: true } })) {
    try {
      const key = await move('topups', t.id, t.proofImageUrl);
      if (!DRY) await prisma.walletTopup.update({ where: { id: t.id }, data: { proofImageUrl: key } });
      moved++;
    } catch (e) { failed++; console.error(`  FAILED topup ${t.id}: ${(e as Error).message}`); }
  }
  skipped = await prisma.payment.count({ where: { proofImageUrl: { startsWith: 'payment-proofs/' } } })
    + await prisma.walletTopup.count({ where: { proofImageUrl: { startsWith: 'payment-proofs/' } } });
  console.log(`proofs: ${moved} moved out of Postgres, ${skipped} already objects, ${failed} failed`);
  return failed;
}

async function verify() {
  let ok = 0, missing = 0, sizeMismatch = 0, bytes = 0;
  for await (const file of walk(ROOT)) {
    const key = path.relative(ROOT, file).split(path.sep).join('/');
    const size = (await fs.stat(file)).size;
    const remote = await remoteSize(key);
    if (remote === null) { missing++; console.error(`  MISSING ${key}`); }
    else if (remote !== size) { sizeMismatch++; console.error(`  SIZE ${key}: local ${size} remote ${remote}`); }
    else { ok++; bytes += size; }
  }
  console.log(`verify: ${ok} ok (${(bytes / 1e6).toFixed(1)} MB), ${missing} missing, ${sizeMismatch} size mismatch`);
  return missing + sizeMismatch;
}

(async () => {
  if (!process.env.S3_ACCESS_KEY || !process.env.S3_SECRET_KEY) {
    console.error('S3_ACCESS_KEY / S3_SECRET_KEY are not set'); process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const f1 = await copyFiles();
    const f2 = await backfillProofs(prisma);
    const f3 = VERIFY ? await verify() : 0;
    const failures = f1 + f2 + f3;
    console.log(failures ? `DONE WITH ${failures} PROBLEM(S) — do not switch STORAGE_DRIVER yet` : 'DONE — safe to set STORAGE_DRIVER=s3 and redeploy');
    process.exit(failures ? 1 : 0);
  } finally {
    await prisma.$disconnect();
  }
})();
