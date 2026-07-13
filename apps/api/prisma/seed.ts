/**
 * CLI demo seed — thin wrapper around the shared generator so the CLI and the
 * admin reseed endpoint produce the identical dataset. WIPES all data.
 *
 * Single password for EVERYONE:  Darsly@123
 */
import { PrismaClient } from '@prisma/client';
import { seedDatabase } from '../src/common/demo-seed';

const prisma = new PrismaClient();

seedDatabase(prisma, (m) => console.log('✓ ' + m))
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
