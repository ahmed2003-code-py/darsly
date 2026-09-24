import { PrismaClient } from '@prisma/client';
import { PAPERS } from './ground-truth';
import { score } from './run';
const ids: Record<string, string> = {
  'p1-islamic-notes': 'cmufa9b4j001kmnohq2394e0g',
  'p2-math-notes': 'cmufadfx8002fmnoh0r2kvl4b',
  'p3-arithmetic-1927': 'cmufagqml003gmnohh0u9oxao',
};
(async () => {
  const p = new PrismaClient();
  for (const paper of PAPERS) {
    const imp = await p.paperImport.findUnique({ where: { id: ids[paper.id] } });
    const qs = ((imp!.draft as any).sections ?? []).flatMap((s: any) => s.questions ?? []);
    const s = score(paper, qs);
    console.log('\n##', paper.id, JSON.stringify({ ...s, perQuestion: undefined }));
    for (const q of s.perQuestion)
      console.log(
        '  ',
        q.n,
        q.found ? 'FOUND' : 'miss ',
        q.similarity.toFixed(2),
        '|',
        q.gotText.slice(0, 90),
      );
    console.log(
      '   extracted:',
      qs
        .map((q: any) => `[${q.number ?? '-'}|${q.type}] ${(q.text ?? '').slice(0, 60)}`)
        .join('\n              '),
    );
  }
  await p.$disconnect();
})();
