/**
 * The text one import already read, saved to a file — so question generation
 * can be compared on it without uploading or reading the pages again.
 *
 *   DATABASE_URL=<read-only url> npx ts-node --transpile-only \
 *     scripts/gen-bench/export-source.ts <importId> --out source.json
 *
 * Reads only: the session's spec and warnings, its pages' recorded OCR cost,
 * and its source chunks. Writes nothing to the database.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

async function main() {
  const importId = process.argv[2];
  if (!importId || importId.startsWith('--'))
    throw new Error('usage: export-source.ts <importId> --out file');
  const out = arg('out', `source-${importId}.json`)!;
  const prisma = new PrismaClient();
  try {
    const record = await prisma.paperImport.findUniqueOrThrow({
      where: { id: importId },
      select: {
        id: true,
        kind: true,
        spec: true,
        warnings: true,
        costCents: true,
        createdAt: true,
      },
    });
    const pages = await prisma.paperImportPage.findMany({
      where: { importId },
      select: { pageNumber: true, model: true, costMillicents: true },
      orderBy: { pageNumber: 'asc' },
    });
    const chunks = await prisma.examSourceChunk.findMany({
      where: { importId },
      select: { index: true, text: true, sourceFile: true, page: true, tokensApprox: true },
      orderBy: { index: 'asc' },
    });
    const ocrMillicents = pages.reduce((n, p) => n + p.costMillicents, 0);
    writeFileSync(
      out,
      JSON.stringify(
        { exportedAt: new Date().toISOString(), record, pages, ocrMillicents, chunks },
        null,
        2,
      ),
    );
    console.log(
      `${importId}: ${chunks.length} chunk(s), ` +
        `${chunks.reduce((n, c) => n + c.tokensApprox, 0)} tokens approx, ` +
        `OCR ${(ocrMillicents / 1000).toFixed(2)}¢ recorded → ${out}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
