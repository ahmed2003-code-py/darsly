import { PrismaClient } from '@prisma/client';
const p = new PrismaClient({ datasources: { db: { url: process.env.PROD_URL } } });
(async () => {
  const items: any[] = await p.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "CosmeticItem"`);
  const owned: any[] = await p.$queryRawUnsafe(
    `SELECT count(*)::int AS n, COALESCE(sum("costCoins"),0)::int AS spent FROM "StudentCosmetic"`);
  const paid: any[] = await p.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "StudentCosmetic" WHERE "costCoins" > 0`);
  const worn: any[] = await p.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "StudentCustomization"`);
  console.log('catalogue items:', items[0].n);
  console.log('ownership rows:', owned[0].n, '| bought with coins:', paid[0].n, '| coins spent:', owned[0].spent);
  console.log('students wearing something:', worn[0].n);
  await p.$disconnect();
})();
