/**
 * Read one transfer receipt with the real model — `npm run proof:read -- <image>`.
 *
 * The one part of this path that no unit test can prove: whether the model
 * actually reads an Egyptian receipt correctly. Point it at a real screenshot.
 */
import { readFileSync } from 'fs';
import { extname } from 'path';
import { AcademySiteConfig } from '../src/academy-site/academy-site.config';
import { AiClient } from '../src/academy-site/ai/ai.client';
import { ProofReaderService } from '../src/payments/proof-reader.service';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run proof:read -- <image>');
  process.exit(1);
}
const mime = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}[extname(file).toLowerCase()];
if (!mime) {
  console.error('image must be .png, .jpg or .webp');
  process.exit(1);
}
const dataUrl = `data:${mime};base64,${readFileSync(file).toString('base64')}`;

new ProofReaderService(new AiClient(new AcademySiteConfig()))
  .read(dataUrl)
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
    if (!r) process.exit(1);
  })
  .catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
  });
